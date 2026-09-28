// KaChat automatic backup: one combined, importable file per run — the KaPosts database
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
import { readJson, writeJson } from './store.js';

const BACKUP_CONFIG = path.join(CONF_DIR, 'backup.json');
const IMG = 'postgres:17-alpine';
const NET = 'kaspa-node-net';
const DB = 'kaspa-node-kachat-db';
const CHAT_EXPORT_URL = 'http://kachat-app:8600/export';
const CHAT_IMPORT_URL = 'http://kachat-app:8600/import-file';
const DEFAULTS = { enabled: false, dest: '', keep: 14, last: null };

let running = false;
let timer = null;
let progress = null; // { step, of, label } while a backup is in flight; null when idle

export function loadConfig() {
    return { ...DEFAULTS, ...(readJson(BACKUP_CONFIG, {}) || {}) };
}

export function status() {
    const c = loadConfig();
    return { enabled: c.enabled, dest: c.dest, keep: c.keep, last: c.last, running, progress };
}

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
function spawnP(cmd, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args);
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

/** `docker exec DB pg_dump` (local, no password) piped into a helper that writes to the HDD stage. */
function dumpDbToStage(mount, stage) {
    return new Promise((resolve, reject) => {
        const dump = spawn('docker', ['exec', DB, 'pg_dump', '-U', 'kachat', '-Fc', 'kachat']);
        const write = spawn('docker', ['run', '--rm', '-i', '-v', mount, IMG, 'sh', '-c', `cat > "${stage}/kaposts.dump"`]);
        let err = '';
        dump.stderr.on('data', (d) => (err += d));
        write.stderr.on('data', (d) => (err += d));
        dump.on('error', reject);
        write.on('error', reject);
        dump.stdout.pipe(write.stdin);
        write.on('close', (code) =>
            code === 0 ? resolve() : reject(new Error('pg_dump → stage failed: ' + err.trim().slice(0, 600))),
        );
    });
}

/** Build one combined backup file (DB + chat store) on the configured host destination. */
export async function runBackup(log = () => {}) {
    const cfg = loadConfig();
    if (!cfg.dest) throw new Error('No backup destination configured.');
    if (running) throw new Error('A backup is already running.');
    running = true;
    const started = Date.now();
    const stamp = new Date().toISOString().replace(/:/g, '').replace('T', '-').slice(0, 15); // 20260927-0400
    const name = `kachat-backup-${stamp}.tar.gz`;
    const mount = `${cfg.dest}:/w`;
    const stage = `/w/.kstage-${stamp}`;
    const keep = Math.max(1, Number(cfg.keep) || 14);
    try {
        log(`[backup] starting → ${cfg.dest}/${name}`);
        // 1) chat store export → stage (streamed straight onto the destination, not the SSD)
        progress = { step: 1, of: 3, label: 'Exporting chat store…' };
        await spawnP('docker', [
            'run', '--rm', '--network', NET, '-v', mount, IMG, 'sh', '-c',
            `rm -rf "${stage}" && mkdir -p "${stage}" && wget -q -O "${stage}/chat-store.export" "${CHAT_EXPORT_URL}"`,
        ]);
        // 2) KaPosts DB dump → stage
        progress = { step: 2, of: 3, label: 'Dumping KaPosts database…' };
        await dumpDbToStage(mount, stage);
        // 3) tar both into one file, then prune to the newest `keep`
        progress = { step: 3, of: 3, label: 'Compressing into one file…' };
        await spawnP('docker', [
            'run', '--rm', '-v', mount, IMG, 'sh', '-c',
            `tar -czf "/w/${name}" -C "${stage}" kaposts.dump chat-store.export && rm -rf "${stage}" && ` +
                `ls -t /w/kachat-backup-*.tar.gz 2>/dev/null | tail -n +${keep + 1} | xargs -r rm -f`,
        ]);
        const last = { ok: true, at: Date.now(), date: new Date().toISOString().slice(0, 10), file: name, ms: Date.now() - started };
        saveConfig({ last });
        log(`[backup] done: ${name} (${last.ms} ms)`);
        return last;
    } catch (e) {
        await spawnP('docker', ['run', '--rm', '-v', mount, IMG, 'sh', '-c', `rm -rf "${stage}"`]).catch(() => {});
        const last = { ok: false, at: Date.now(), date: new Date().toISOString().slice(0, 10), error: e.message, ms: Date.now() - started };
        saveConfig({ last });
        log(`[backup] FAILED: ${e.message}`);
        throw e;
    } finally {
        running = false;
        progress = null;
    }
}

/** Restore a combined backup file (host path) — pg_restore the DB and re-import the chat store. */
export async function restoreBackup(filePath, log = () => {}) {
    if (!filePath) throw new Error('No backup file path given.');
    const dir = path.dirname(filePath);
    const file = path.basename(filePath);
    const mount = `${dir}:/w`;
    const stage = `/w/.krestore-${Date.now()}`;
    try {
        log(`[restore] extracting ${file}`);
        await spawnP('docker', [
            'run', '--rm', '-v', mount, IMG, 'sh', '-c',
            `rm -rf "${stage}" && mkdir -p "${stage}" && tar -xzf "/w/${file}" -C "${stage}"`,
        ]);
        // DB: helper cats the dump → local pg_restore in the DB container (no password)
        log('[restore] restoring KaPosts database');
        await new Promise((resolve, reject) => {
            const cat = spawn('docker', ['run', '--rm', '-v', mount, IMG, 'cat', `${stage}/kaposts.dump`]);
            const restore = spawn('docker', ['exec', '-i', DB, 'pg_restore', '-U', 'kachat', '-d', 'kachat', '--clean', '--if-exists']);
            let err = '';
            cat.stderr.on('data', (d) => (err += d));
            restore.stderr.on('data', (d) => (err += d));
            cat.on('error', reject);
            restore.on('error', reject);
            cat.stdout.pipe(restore.stdin);
            // pg_restore --clean warns noisily on a fresh DB; only a non-zero exit is fatal.
            restore.on('close', (code) => (code === 0 ? resolve() : reject(new Error('pg_restore failed: ' + err.trim().slice(0, 600)))));
        });
        // Chat store: POST the export back to the indexer's /import-file
        log('[restore] restoring chat store');
        await spawnP('docker', [
            'run', '--rm', '--network', NET, '-v', mount, IMG, 'sh', '-c',
            `wget -q -O - --header="Content-Type: application/octet-stream" --post-file="${stage}/chat-store.export" "${CHAT_IMPORT_URL}" >/dev/null`,
        ]);
        await spawnP('docker', ['run', '--rm', '-v', mount, IMG, 'sh', '-c', `rm -rf "${stage}"`]).catch(() => {});
        log(`[restore] done from ${file}`);
        return { ok: true, file };
    } catch (e) {
        await spawnP('docker', ['run', '--rm', '-v', mount, IMG, 'sh', '-c', `rm -rf "${stage}"`]).catch(() => {});
        throw e;
    }
}

/** Start the nightly scheduler: fire in the local 00:00 hour once per day (with missed-night catch-up). */
export function scheduleBackup(log = () => {}) {
    if (timer) clearInterval(timer);
    const tick = async () => {
        const cfg = loadConfig();
        if (!cfg.enabled || !cfg.dest || running) return;
        const now = new Date();
        const today = now.toISOString().slice(0, 10);
        const alreadyToday = cfg.last && cfg.last.ok && cfg.last.date === today;
        const missed = !cfg.last || Date.now() - (cfg.last.at || 0) > 25 * 3600 * 1000;
        if (!alreadyToday && (now.getHours() === 0 || missed)) {
            await runBackup(log).catch((e) => log(`[backup] ${e.message}`));
        }
    };
    timer = setInterval(tick, 5 * 60_000);
    tick().catch(() => {});
}
