import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { COMPOSE_FILE, CONF_DIR, PORTS_OVERRIDE, STACK_LOCAL } from './paths.js';

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
            reject(new CommandError(`failed to run ${cmd}: ${err.message}`, { code: -1, stdout, stderr }));
        });
        child.on('close', (code) => {
            clearTimeout(timer);
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
