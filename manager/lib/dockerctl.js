import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { COMPOSE_FILE, CONF_DIR, PORTS_OVERRIDE, STACK_LOCAL } from './paths.js';
import { jobContext } from './jobcontext.js';

/**
 * Processes spawned by a job that is still running, so cancelling has something
 * to kill. Only `run` registers here -- `streamLogs` follows a container's
 * output and stopping a job has no business stopping that.
 */
const LIVE = new Set();

/**
 * Ends the processes a job started. SIGTERM, because docker and certbot both
 * clean up on it; a build that is killed leaves its finished layers in the
 * cache, so starting again picks up where this left off rather than at the
 * beginning.
 */
export function killJob(jobId) {
    let killed = 0;
    for (const entry of LIVE) {
        if (entry.jobId !== jobId) continue;
        try {
            entry.child.kill('SIGTERM');
            killed += 1;
        } catch {
            /* already gone */
        }
    }
    return killed;
}

const KASPAD_CONTAINER = process.env.KASPAD_CONTAINER || 'kaspa-node-kaspad';
const PROXY_CONTAINER = process.env.PROXY_CONTAINER || 'kaspa-node-proxy';
const BRIDGE_CONTAINER = process.env.BRIDGE_CONTAINER || 'kaspa-node-bridge';
const KACHAT_CONTAINER = process.env.KACHAT_CONTAINER || 'kaspa-node-kachat';
const NEXTCLOUD_CONTAINER = process.env.NEXTCLOUD_CONTAINER || 'kaspa-node-nextcloud';

export { KASPAD_CONTAINER, PROXY_CONTAINER, BRIDGE_CONTAINER, KACHAT_CONTAINER, NEXTCLOUD_CONTAINER };

/** Every container this stack can run, in the order worth reading them. */
export const STACK_CONTAINERS = [
    { key: 'kaspad', label: 'kaspad', name: KASPAD_CONTAINER },
    { key: 'bridge', label: 'stratum bridge', name: BRIDGE_CONTAINER },
    { key: 'kachat', label: 'kachat indexer', name: KACHAT_CONTAINER },
    { key: 'kachat-db', label: 'kachat postgres', name: 'kaspa-node-kachat-db' },
    { key: 'nextcloud', label: 'nextcloud', name: NEXTCLOUD_CONTAINER },
    { key: 'nextcloud-db', label: 'nextcloud mariadb', name: 'kaspa-node-nextcloud-db' },
    { key: 'proxy', label: 'nginx proxy', name: PROXY_CONTAINER },
    { key: 'manager', label: 'control panel', name: 'kaspa-node-manager' },
];

export class CommandError extends Error {
    constructor(message, { code, stdout, stderr }) {
        super(message);
        this.name = 'CommandError';
        this.code = code;
        this.stdout = stdout;
        this.stderr = stderr;
    }
}

/**
 * Runs a command, optionally streaming output line by line to `onLine`.
 * Never uses a shell, so arguments carrying user input cannot be re-parsed.
 */
export function run(cmd, args, { onLine, timeoutMs = 15 * 60_000, cwd = STACK_LOCAL, env } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env } });
        // Whichever job's function this was called from, however far down.
        const entry = { child, jobId: jobContext.getStore()?.id ?? null };
        if (entry.jobId) LIVE.add(entry);
        let stdout = '';
        let stderr = '';
        let pending = '';

        const emit = (chunk) => {
            if (!onLine) return;
            pending += chunk;
            const lines = pending.split('\n');
            pending = lines.pop() ?? '';
            for (const line of lines) onLine(line);
        };

        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            reject(new CommandError(`${cmd} timed out after ${timeoutMs}ms`, { code: -1, stdout, stderr }));
        }, timeoutMs);

        child.stdout.on('data', (d) => {
            stdout += d;
            emit(d.toString());
        });
        child.stderr.on('data', (d) => {
            stderr += d;
            emit(d.toString());
        });
        child.on('error', (err) => {
            clearTimeout(timer);
            LIVE.delete(entry);
            reject(new CommandError(`failed to run ${cmd}: ${err.message}`, { code: -1, stdout, stderr }));
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            LIVE.delete(entry);
            if (pending && onLine) onLine(pending);
            if (code === 0) resolve({ stdout, stderr, code });
            else reject(new CommandError(`${cmd} exited with code ${code}: ${stderr.trim() || stdout.trim()}`, { code, stdout, stderr }));
        });
    });
}

export const docker = (args, opts) => run('docker', args, opts);

function composeFiles() {
    const files = ['-f', COMPOSE_FILE];
    if (fs.existsSync(PORTS_OVERRIDE)) files.push('-f', PORTS_OVERRIDE);
    for (const name of ['bridge-ports.yml', 'apps-ports.yml']) {
        const override = path.join(CONF_DIR, name);
        if (fs.existsSync(override)) files.push('-f', override);
    }
    return files;
}

/**
 * `profile: 'mining'` is what makes the bridge service visible to compose. It
 * sits behind a profile so that a bare `up -d` -- what the installer runs, and
 * what any node-only operation does -- never starts a stratum server nobody
 * asked for.
 */
export const compose = (args, { profile, ...opts } = {}) =>
    run(
        'docker',
        [
            'compose',
            ...composeFiles(),
            ...(profile ? ['--profile', profile] : []),
            '--project-directory',
            STACK_LOCAL,
            ...args,
        ],
        opts,
    );

// ------------------------------------------------------------- inspection --

export async function containerState(name) {
    try {
        const { stdout } = await docker([
            'inspect',
            '--format',
            // `.State.Health` only exists when the image declares a HEALTHCHECK.
            // Referencing it unguarded makes `docker inspect` fail outright, so
            // every container without one looked like it did not exist at all.
            '{{.State.Status}}|{{.State.Running}}|{{.State.StartedAt}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.Config.Image}}|{{.RestartCount}}',
            name,
        ]);
        const [status, running, startedAt, health, image, restarts] = stdout.trim().split('|');
        return {
            exists: true,
            status,
            running: running === 'true',
            startedAt,
            health: health === 'none' || health === '<no value>' ? null : health,
            image,
            restarts: Number(restarts) || 0,
        };
    } catch {
        return { exists: false, status: 'absent', running: false, startedAt: null, health: null, image: null, restarts: 0 };
    }
}

export async function publishedPorts(name) {
    try {
        const { stdout } = await docker(['port', name]);
        return stdout
            .trim()
            .split('\n')
            .filter(Boolean)
            .map((line) => {
                const [container, host] = line.split(' -> ');
                return { container: container?.trim(), host: host?.trim() };
            });
    } catch {
        return [];
    }
}

export async function logs(name, tail = 300) {
    try {
        const { stdout, stderr } = await docker(['logs', '--tail', String(tail), name]);
        return `${stdout}${stderr}`;
    } catch (err) {
        return err instanceof CommandError ? `${err.stdout || ''}${err.stderr || ''}` : String(err);
    }
}

export function streamLogs(name, onLine, { tail = 200, timestamps = false } = {}) {
    const args = ['logs', '--tail', String(tail), '--follow'];
    if (timestamps) args.push('--timestamps');
    const child = spawn('docker', [...args, name]);
    let pending = '';
    const emit = (chunk) => {
        pending += chunk;
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) onLine(line);
    };
    child.stdout.on('data', (d) => emit(d.toString()));
    child.stderr.on('data', (d) => emit(d.toString()));
    child.on('error', (err) => onLine(`[manager] log stream error: ${err.message}`));
    return () => child.kill('SIGKILL');
}

export async function diskUsage(volume = 'kaspa-node-data') {
    try {
        const { stdout } = await docker(['system', 'df', '-v', '--format', '{{json .}}']);
        const parsed = JSON.parse(stdout.trim().split('\n').pop());
        const match = (parsed.Volumes || []).find((v) => v.Name === volume);
        return match ? { name: volume, size: match.Size } : null;
    } catch {
        return null;
    }
}

/**
 * Exact byte counts for the parts of the node's data directory.
 *
 * `docker system df` reports a volume as text like "19.58GB", which is four
 * significant figures and far too coarse to watch something grow. Walking the
 * volume gives real bytes, and splits it where it matters:
 *
 *   consensus  blocks, headers and the DAG, which is what pruning drops
 *   utxoindex  the current UTXO set, which pruning does not touch
 *
 * Keeping those apart is the difference between a believable figure for what a
 * prune frees and one inflated by five gigabytes of index that is never going
 * anywhere.
 *
 * The walk only stats files and takes about a quarter of a second on a 20 GB
 * database, but it does start a container, so the answer is held for a minute.
 */
let breakdownCache = { at: 0, value: null };
const BREAKDOWN_CACHE_MS = 60_000;

export async function dataBreakdown({ volume = 'kaspa-node-data', force = false } = {}) {
    if (!force && breakdownCache.value && Date.now() - breakdownCache.at < BREAKDOWN_CACHE_MS) {
        return breakdownCache.value;
    }
    try {
        const { stdout } = await docker(
            [
                'run',
                '--rm',
                '-v',
                `${volume}:/d:ro`,
                'alpine:3.21',
                'sh',
                '-c',
                // One `du` per path, not one call with all three: busybox counts
                // each inode once per invocation, so passing the parent
                // alongside its own subdirectories reports the parent and
                // nothing else.
                //
                // The network suffix in the path varies (kaspa-mainnet,
                // kaspa-testnet-10), so it is matched rather than assumed.
                'du -sb /d/*/datadir/consensus 2>/dev/null; du -sb /d/*/datadir/utxoindex 2>/dev/null; du -sb /d 2>/dev/null',
            ],
            { timeoutMs: 120_000 },
        );

        const seen = {};
        for (const line of stdout.split('\n')) {
            const m = /^(\d+)\s+(\S+)/.exec(line.trim());
            if (!m) continue;
            const bytes = Number(m[1]);
            if (m[2].endsWith('/consensus')) seen.consensus = bytes;
            else if (m[2].endsWith('/utxoindex')) seen.utxoindex = bytes;
            else if (m[2] === '/d') seen.total = bytes;
        }
        if (!Number.isFinite(seen.total)) return null;

        breakdownCache = { at: Date.now(), value: seen };
        return seen;
    } catch {
        return null;
    }
}

/** Reads the version baked into the running kaspad image label. */
export async function imageVersion(name = KASPAD_CONTAINER) {
    try {
        const { stdout } = await docker([
            'inspect',
            '--format',
            '{{index .Config.Labels "io.kaspa.oneclick.version"}}',
            name,
        ]);
        const value = stdout.trim();
        return value && value !== '<no value>' ? value : null;
    } catch {
        return null;
    }
}
