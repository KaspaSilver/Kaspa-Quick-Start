// KaChat automatic backup: one combined, importable file per run — the Posts database
// (pg_dump) AND the chat store (handshakes, 1:1 chats, groups, push registrations) — written to a
// host path the operator chooses, nightly at (server-local) 00:00.
//
// The manager container only mounts /stack and the docker socket, so it cannot see arbitrary host
// disks (e.g. an external HDD). Every read/write of the destination therefore goes through a
// throwaway `postgres:17-alpine` helper container that bind-mounts the chosen host path — nothing
// is ever staged on the manager's own (SSD-backed) filesystem. That image already ships sh, wget
// (with --post-file), tar, pg_dump and pg_restore, and it is already present on the box.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { CONF_DIR } from './paths.js';
import { readEnvFile, readJson, writeJson } from './store.js';

const BACKUP_CONFIG = path.join(CONF_DIR, 'backup.json');
const IMG = 'postgres:17-alpine';
const NET = 'kaspa-node-net';
const DB = 'kaspa-node-kachat-db';
// The indexer that writes into DB. Stopped while a restore replaces the database under it.
const APP = 'kaspa-node-kachat';
const CHAT_EXPORT_URL = 'http://kachat-app:8600/export';
const CHAT_IMPORT_URL = 'http://kachat-app:8600/import-file';
const DEFAULTS = { enabled: false, dest: '', keep: 14, last: null };

// Host paths go into `-v` and file names into shell scripts, so both are checked first, and
// every script takes them as positional arguments ("$1"), never pasted into its text (KQS-019).
// A ':' in the destination would also change the bind mount's options.
const DEST_RE = /^\/[A-Za-z0-9._\/ -]+$/;
// A finished backup only. One being written is a dot-file ending in .tmp (see runBackup), which
// neither this nor the `kachat-backup-*.tar.gz` retention glob can ever match.
const FILE_RE = /^kachat-backup-[0-9-]+\.tar\.gz$/;
export const destProblem = (dest) =>
    !DEST_RE.test(dest) || dest.split('/').includes('..')
        ? 'Destination must be an absolute host path made of letters, digits, spaces, ".", "_", "-" and "/".'
        : null;
export const fileProblem = (filePath) =>
    !filePath.startsWith('/') || destProblem(path.dirname(filePath)) || !FILE_RE.test(path.basename(filePath))
        ? 'Give the absolute host path to a kachat-backup-*.tar.gz file this panel wrote.'
        : null;

// The chat indexer's /export and /import-file need its internal secret (kachat-audits IDX-001).
// Passed by name (`-e KACHAT_INTERNAL_SECRET`), valued from the spawn's environment, so it is
// never on a command line.
const secretEnv = () => ({ ...process.env, KACHAT_INTERNAL_SECRET: readEnvFile().KACHAT_PUSH_SECRET || '' });

let running = false;
let restoring = false;
let timer = null;
let progress = null; // { step, of, label } while a backup is in flight; null when idle

// The server's own calendar date (YYYY-MM-DD). The nightly run is decided by the local hour, so
// "already backed up today" must be the local day too: a UTC date made a daytime manual backup
// count for the coming local night wherever UTC is already a day ahead (audit #29).
const localDate = (d = new Date()) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

export function loadConfig() {
    return { ...DEFAULTS, ...(readJson(BACKUP_CONFIG, {}) || {}) };
}

export function status() {
    const c = loadConfig();
    return { enabled: c.enabled, dest: c.dest, keep: c.keep, last: c.last, running, restoring, progress };
}

/** A backup or a restore is in flight (a panel restart now would cut it off). */
export const busy = () => running || restoring;

export function saveConfig(patch) {
    const cfg = { ...loadConfig(), ...patch };
    writeJson(BACKUP_CONFIG, cfg);
    return cfg;
}

/**
 * Enumerate mounted drives/folders on the HOST so the UI can offer a pick-list instead of
 * manual typing. The manager container can't see the host filesystem directly, so a helper
 * bind-mounts the usual mount roots at the SAME path (read-only) — every path it prints back is
 * therefore a real host path. Returns [{ path, label }].
 */
export function listDrives() {
    return new Promise((resolve) => {
        const child = spawn('docker', [
            'run', '--rm',
            '-v', '/media:/media:ro',
            '-v', '/mnt:/mnt:ro',
            IMG, 'sh', '-c',
            // /media/<user>/<label> (udisks removable drives) and /mnt/<name> (manual mounts).
            'for d in /media/*/* /mnt/*; do [ -d "$d" ] && echo "$d"; done 2>/dev/null',
        ]);
        let out = '';
        child.stdout.on('data', (d) => (out += d));
        child.on('error', () => resolve([]));
        child.on('close', () => {
            const seen = new Set();
            const drives = out
                .split('\n')
                .map((s) => s.trim())
                .filter((p) => p && !seen.has(p) && seen.add(p))
                .map((p) => ({ path: p, label: p.split('/').filter(Boolean).pop() || p }));
            resolve(drives);
        });
    });
}

/** Spawn a command, capturing stderr; resolve on exit 0, reject otherwise. */
function spawnP(cmd, args, { env } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, env ? { env } : {});
        let err = '';
        if (child.stderr) child.stderr.on('data', (d) => { if (err.length < 4000) err += d.toString(); });
        child.on('error', reject);
        child.on('close', (code) =>
            code === 0
                ? resolve()
                : reject(new Error(`docker ${args.slice(0, 2).join(' ')} exited ${code}: ${err.trim().slice(0, 600)}`)),
        );
    });
}

/**
 * `docker <from>` piped into `docker <to>`. Resolves only when both exit 0, so a dump that
 * died halfway is never taken for a good one. A side that quits early breaks the pipe
 * (EPIPE); that is caught here, because unhandled it takes the whole panel down.
 */
function pipeP(fromArgs, toArgs, what) {
    return new Promise((resolve, reject) => {
        const from = spawn('docker', fromArgs);
        const to = spawn('docker', toArgs);
        let err = '';
        const codes = [];
        const keep = (d) => { if (err.length < 4000) err += d.toString(); };
        from.stderr.on('data', keep);
        to.stderr.on('data', keep);
        for (const s of [from.stdout, to.stdin]) s.on('error', () => {});
        from.on('error', reject);
        to.on('error', reject);
        from.stdout.pipe(to.stdin);
        const done = (code) => {
            codes.push(code);
            if (codes.length < 2) return;
            if (codes.every((c) => c === 0)) resolve();
            else reject(new Error(`${what} failed: ${err.trim().slice(0, 600)}`));
        };
        from.on('close', done);
        // The reader gone means nothing will drain the writer; stop it rather than wait forever.
        to.on('close', (code) => {
            if (from.exitCode === null) from.kill();
            done(code);
        });
    });
}

/** `docker exec DB pg_dump` (local, no password) piped into a helper that writes to the HDD stage. */
const dumpDbToStage = (mount, stage) =>
    pipeP(
        ['exec', DB, 'pg_dump', '-U', 'kachat', '-Fc', 'kachat'],
        ['run', '--rm', '-i', '-v', mount, IMG, 'sh', '-c', 'umask 077 && cat > "$1/kaposts.dump"', 'sh', stage],
        'pg_dump → stage',
    );

/** Build one combined backup file (DB + chat store) on the configured host destination. */
export async function runBackup(log = () => {}) {
    const cfg = loadConfig();
    if (!cfg.dest) throw new Error('No backup destination configured.');
    const bad = destProblem(cfg.dest);
    if (bad) throw new Error(bad);
    if (running) throw new Error('A backup is already running.');
    if (restoring) throw new Error('A restore is running. Back up once it has finished.');
    running = true;
    const started = Date.now();
    const stamp = new Date().toISOString().replace(/:/g, '').replace('T', '-').slice(0, 15); // 20260927-0400
    const name = `kachat-backup-${stamp}.tar.gz`;
    // The archive is written under this name and renamed to `name` only once tar has finished, so
    // a full disk or a killed helper never leaves a cut-off file that looks like a good backup,
    // gets restored, and pushes good ones out of the retention window (audit #30).
    const tmp = `.${name}.tmp`;
    const mount = `${cfg.dest}:/w`;
    const stage = `/w/.kstage-${stamp}`;
    const keep = Math.max(1, Number(cfg.keep) || 14);
    try {
        log(`[backup] starting → ${cfg.dest}/${name}`);
        // 1) chat store export → stage (streamed straight onto the destination, not the SSD)
        progress = { step: 1, of: 3, label: 'Exporting chat store…' };
        // umask 077: the archive holds every chat and push token, so only its owner may read it.
        await spawnP(
            'docker',
            [
                'run', '--rm', '--network', NET, '-e', 'KACHAT_INTERNAL_SECRET', '-v', mount, IMG, 'sh', '-c',
                // Also clears .tmp archives a killed run left behind (never seen by retention).
                'umask 077 && rm -rf "$1" /w/.kachat-backup-*.tar.gz.tmp && mkdir -p "$1" && ' +
                    'wget -q --header="x-internal-secret: $KACHAT_INTERNAL_SECRET" -O "$1/chat-store.export" "$2"',
                'sh', stage, CHAT_EXPORT_URL,
            ],
            { env: secretEnv() },
        );
        // 2) Posts DB dump → stage
        progress = { step: 2, of: 3, label: 'Dumping Posts database…' };
        await dumpDbToStage(mount, stage);
        // 3) tar both into one file, then prune to the newest `keep`
        progress = { step: 3, of: 3, label: 'Compressing into one file…' };
        await spawnP('docker', [
            'run', '--rm', '-v', mount, IMG, 'sh', '-c',
            // An empty part means its export failed quietly: no file then, rather than a bad one.
            'test -s "$2/kaposts.dump" && test -s "$2/chat-store.export" && ' +
                'umask 077 && tar -czf "/w/$4" -C "$2" kaposts.dump chat-store.export && chmod 600 "/w/$4" && ' +
                'mv -f "/w/$4" "/w/$1" && rm -rf "$2" && ' +
                'ls -t /w/kachat-backup-*.tar.gz 2>/dev/null | tail -n +"$3" | xargs -r rm -f',
            'sh', name, stage, String(keep + 1), tmp,
        ]);
        const last = { ok: true, at: Date.now(), date: localDate(), file: name, ms: Date.now() - started };
        saveConfig({ last });
        log(`[backup] done: ${name} (${last.ms} ms)`);
        return last;
    } catch (e) {
        await spawnP('docker', ['run', '--rm', '-v', mount, IMG, 'sh', '-c', 'rm -rf "$1" "/w/$2"', 'sh', stage, tmp]).catch(() => {});
        const last = { ok: false, at: Date.now(), date: localDate(), error: e.message, ms: Date.now() - started };
        saveConfig({ last });
        log(`[backup] FAILED: ${e.message}`);
        throw e;
    } finally {
        running = false;
        progress = null;
    }
}

/**
 * Wait until the chat indexer answers HTTP again after a start (any status will do: it is
 * listening). The chat-store import needs it up; the indexer replays a while before it is.
 */
const waitForApp = () =>
    spawnP('docker', [
        'run', '--rm', '--network', NET, IMG, 'sh', '-c',
        'i=0; while [ $i -lt 90 ]; do wget -q -S -O /dev/null "$1" 2>&1 | grep -q "HTTP/" && exit 0; ' +
            'i=$((i+1)); sleep 2; done; echo "the chat indexer did not answer within 3 minutes" >&2; exit 1',
        'sh', 'http://kachat-app:8600/',
    ]);

/**
 * Restore a combined backup file (host path) — pg_restore the DB and re-import the chat store.
 *
 * `--clean` drops what is there before recreating it, so this used to be able to leave the live
 * database with its tables dropped: a bad dump, or a lock held by the indexer that kept writing
 * the whole time, stopped it halfway (audit #4). Now, in order: the dump is checked to be one
 * pg_restore can read before anything is touched; the indexer (the only writer) is stopped; the
 * restore runs as one transaction that stops at the first error, so it lands whole or not at
 * all; and the indexer is started again whatever happened. Refusing a restore while the Update
 * Queue may be rebuilding KaChat is the caller's part (server.js).
 */
export async function restoreBackup(filePath, log = () => {}) {
    if (!filePath) throw new Error('No backup file path given.');
    const bad = fileProblem(filePath);
    if (bad) throw new Error(bad);
    const dir = path.dirname(filePath);
    const file = path.basename(filePath);
    const mount = `${dir}:/w`;
    const stage = `/w/.krestore-${Date.now()}`;
    if (running || restoring) throw new Error('A backup or restore is already running.');
    restoring = true;
    try {
        log(`[restore] extracting ${file}`);
        await spawnP('docker', [
            'run', '--rm', '-v', mount, IMG, 'sh', '-c',
            'umask 077 && rm -rf "$2" && mkdir -p "$2" && tar -xzf "/w/$1" -C "$2"',
            'sh', file, stage,
        ]);
        // Both parts there, and the dump readable from end to end (--list walks its table of
        // contents), while the live database is still untouched.
        log('[restore] checking the backup');
        await spawnP('docker', [
            'run', '--rm', '-v', mount, IMG, 'sh', '-c',
            'test -s "$1/chat-store.export" || { echo "the backup has no chat store" >&2; exit 1; }; ' +
                'test -s "$1/kaposts.dump" || { echo "the backup has no database dump" >&2; exit 1; }; ' +
                'pg_restore --list "$1/kaposts.dump" >/dev/null',
            'sh', stage,
        ]).catch((e) => {
            throw new Error(`The backup file is damaged or incomplete; nothing was changed. (${e.message})`);
        });

        // DB: helper cats the dump → local pg_restore in the DB container (no password)
        log('[restore] stopping the KaChat indexer for the database restore');
        try {
            // -t 90: the compose file's stop_grace_period. Killing it mid-compaction corrupts its store.
            await spawnP('docker', ['stop', '-t', '90', APP]);
            log('[restore] restoring Posts database');
            // --clean warns noisily on a fresh DB; only a non-zero exit is fatal. One
            // transaction, first error ends it: a failure rolls back to the database as it was.
            await pipeP(
                ['run', '--rm', '-v', mount, IMG, 'cat', `${stage}/kaposts.dump`],
                [
                    'exec', '-i', DB, 'pg_restore', '-U', 'kachat', '-d', 'kachat',
                    '--clean', '--if-exists', '--single-transaction', '--exit-on-error',
                ],
                'pg_restore',
            );
        } finally {
            // Always, even when the stop itself failed: one that fails partway may still have stopped it.
            log('[restore] starting the KaChat indexer again');
            await spawnP('docker', ['start', APP]).catch((e) =>
                log(`[restore] could not start the KaChat indexer: ${e.message}. Start KaChat from the panel.`),
            );
        }

        // Chat store: POST the export back to the indexer's /import-file, once it answers again
        log('[restore] waiting for the KaChat indexer');
        await waitForApp().catch((e) => {
            throw new Error(`The database is restored, but the chat store is not: ${e.message}. Restore again once KaChat is running.`);
        });
        log('[restore] restoring chat store');
        await spawnP(
            'docker',
            [
                'run', '--rm', '--network', NET, '-e', 'KACHAT_INTERNAL_SECRET', '-v', mount, IMG, 'sh', '-c',
                'wget -q -O - --header="Content-Type: application/octet-stream" ' +
                    '--header="x-internal-secret: $KACHAT_INTERNAL_SECRET" --post-file="$1/chat-store.export" "$2" >/dev/null',
                'sh', stage, CHAT_IMPORT_URL,
            ],
            { env: secretEnv() },
        );
        await spawnP('docker', ['run', '--rm', '-v', mount, IMG, 'sh', '-c', 'rm -rf "$1"', 'sh', stage]).catch(() => {});
        log(`[restore] done from ${file}`);
        return { ok: true, file };
    } catch (e) {
        await spawnP('docker', ['run', '--rm', '-v', mount, IMG, 'sh', '-c', 'rm -rf "$1"', 'sh', stage]).catch(() => {});
        throw e;
    } finally {
        restoring = false;
    }
}

/**
 * Start the nightly scheduler: fire in the local 00:00 hour once per day (with missed-night
 * catch-up). `deferWhile` holds it off while something else may recreate the database (an
 * indexer update in the Update Queue); the next tick tries again.
 */
export function scheduleBackup(log = () => {}, { deferWhile = () => false } = {}) {
    if (timer) clearInterval(timer);
    const tick = async () => {
        const cfg = loadConfig();
        if (!cfg.enabled || !cfg.dest || running || restoring || deferWhile()) return;
        const now = new Date();
        const today = localDate(now);
        const alreadyToday = cfg.last && cfg.last.ok && cfg.last.date === today;
        const missed = !cfg.last || Date.now() - (cfg.last.at || 0) > 25 * 3600 * 1000;
        if (!alreadyToday && (now.getHours() === 0 || missed)) {
            await runBackup(log).catch((e) => log(`[backup] ${e.message}`));
        }
    };
    timer = setInterval(tick, 5 * 60_000);
    tick().catch(() => {});
}
