import http from 'node:http';

import { docker } from './dockerctl.js';
import { machine } from './host.js';

/**
 * NFC Card (github.com/KaspaSilver/KaChat-NFC): loads the KaChat-NFC applet onto a Java Card, so
 * KaChat can back up a seed phrase the user already has to it. The card work is done by
 * `kachat-nfc`, a small helper that talks to a PC/SC reader. Its API is KaChat-NFC's
 * docs/HELPER-API.md; that file is the contract.
 *
 * Where the helper runs depends on where the reader can be reached:
 *
 *   - On the computer the browser is on (any OS): the user installs the helper there and the
 *     page calls it at http://127.0.0.1:18421 itself. Nothing passes through this server, which
 *     matters because a secure call returns the card's new admin key.
 *   - On this server, when it is a Linux host with Docker's own engine: the helper runs in a
 *     container here, on the stack's private network with no published port, and the panel
 *     proxies the three calls the page needs. Docker Desktop (macOS, Windows) has no USB access,
 *     so this path is never offered there.
 *
 * Rules this file keeps (from the KaChat-NFC hand-off): the panel never stores or logs an admin
 * key, never starts a load or secure by itself and never retries one, and never supplies card
 * software. The helper can only write the applet built into it.
 */

export const REPO = 'KaspaSilver/KaChat-NFC';
// The release the server-side helper is built from. The browser-side helper is installed by the
// user from releases/latest, and the Updates tab says when that is newer than what they run.
export const TAG = 'v0.1.0';
const IMAGE = `kaspa-quick-start/kachat-nfc:${TAG}`;
export const CONTAINER = 'kaspa-node-kachat-nfc';
const NETWORK = 'kaspa-node-net';
const HELPER_PORT = 18421;
// Where the server helper answers; the override is for testing the panel against a stand-in.
const [HELPER_HOST, HELPER_HOST_PORT] = (process.env.KACHAT_NFC_HELPER || `${CONTAINER}:${HELPER_PORT}`).split(':');
// The helper's own Dockerfile, used as the whole build context (it downloads the release binary
// and checks it against SHA256SUMS). Pinned to the tag, so the image is exactly that release.
const DOCKERFILE_URL = `https://raw.githubusercontent.com/${REPO}/${TAG}/docker/Dockerfile`;

/** Where the reader can be: 'linux' (a container here can reach USB) or 'desktop' (it cannot). */
export async function hostKind() {
    const m = await machine().catch(() => null);
    const system = String(m?.system || '');
    // No hostname means Docker didn't answer and `system` is this container's own OS (always
    // Linux, even on Docker Desktop), so it says nothing about USB.
    if (!m?.hostname || /docker desktop/i.test(system)) return 'desktop';
    // Docker's own engine on Linux reports the distribution (Ubuntu, Debian, ...).
    return 'linux';
}

async function imageExists() {
    try {
        await docker(['image', 'inspect', IMAGE], { timeoutMs: 30_000 });
        return true;
    } catch {
        return false;
    }
}

async function containerRunning() {
    try {
        const { stdout } = await docker(['inspect', '-f', '{{.State.Running}}', CONTAINER], { timeoutMs: 15_000 });
        return stdout.trim() === 'true';
    } catch {
        return false;
    }
}

export async function serverState() {
    const [image, running] = await Promise.all([imageExists(), containerRunning()]);
    return { tag: TAG, image, running };
}

/** Builds the helper image once, pinned to TAG. */
async function ensureImage(onLine) {
    if (await imageExists()) return;
    onLine(`Building the NFC helper ${TAG} (once). It downloads the release and checks its hash.`);
    await docker(['build', '--build-arg', `VERSION=${TAG}`, '-t', IMAGE, DOCKERFILE_URL], {
        onLine,
        timeoutMs: 15 * 60_000,
    });
}

/**
 * Starts the helper here, with the USB bus passed in. A reader plugged in after the container
 * started may not be seen, so starting again always replaces a running one.
 */
export async function startServerHelper(onLine = () => {}) {
    if ((await hostKind()) !== 'linux') {
        throw new Error('This server runs Docker Desktop, which cannot reach USB. Use the helper on your computer.');
    }
    await ensureImage(onLine);
    await docker(['rm', '-f', CONTAINER], { timeoutMs: 30_000 }).catch(() => {});
    onLine('Starting the NFC helper with access to USB...');
    await docker(
        [
            'run', '--detach', '--rm',
            '--name', CONTAINER,
            '--network', NETWORK,
            '--device', '/dev/bus/usb',
            IMAGE,
        ],
        { timeoutMs: 60_000 },
    );
    lastUsed = Date.now();
    scheduleIdleStop();
    onLine('The NFC helper is running. Nothing is published outside this server.');
}

export async function stopServerHelper() {
    clearTimeout(idleTimer);
    idleTimer = null;
    await docker(['rm', '-f', CONTAINER], { timeoutMs: 30_000 }).catch(() => {});
}

/** Removes the helper container and its image. No card is changed. */
export async function removeServerHelper(onLine = () => {}) {
    await stopServerHelper();
    onLine('Removing the NFC helper image...');
    await docker(['image', 'rm', '-f', IMAGE], { timeoutMs: 60_000 }).catch(() => {});
    onLine('Removed. Cards you loaded are not affected.');
}

// The server helper runs only while the page is open: the page polls status every 2 seconds,
// and with no request for a minute the container is stopped.
const IDLE_MS = 60_000;
let lastUsed = 0;
let idleTimer = null;
function scheduleIdleStop() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(async () => {
        if (busy || Date.now() - lastUsed < IDLE_MS) return scheduleIdleStop();
        idleTimer = null;
        await docker(['rm', '-f', CONTAINER], { timeoutMs: 30_000 }).catch(() => {});
    }, IDLE_MS);
    idleTimer.unref?.();
}

// The three calls the page may make, and how long each may take (a load is about 20 seconds).
const CALLS = {
    'GET /v1/status': 10_000,
    'POST /v1/card/load': 180_000,
    'POST /v1/card/secure': 120_000,
};
let busy = false;

/**
 * Passes one call to the server helper and hands back its status and body untouched. The body
 * can hold an admin key (a secure, or an admin key the user typed for a load), so neither the
 * request nor the response is ever logged or kept.
 */
export function proxy(method, path, body) {
    const timeout = CALLS[`${method} ${path}`];
    if (!timeout) return Promise.resolve({ status: 404, body: JSON.stringify({ error: { code: 'bad_request', message: 'Unknown helper call.' } }) });
    lastUsed = Date.now();
    const write = method === 'POST';
    if (write && busy) {
        return Promise.resolve({ status: 409, body: JSON.stringify({ error: { code: 'card_error', message: 'The card is already busy with another request.' } }) });
    }
    if (write) busy = true;
    return new Promise((resolve) => {
        const req = http.request(
            {
                host: HELPER_HOST,
                port: Number(HELPER_HOST_PORT) || HELPER_PORT,
                method,
                path,
                timeout,
                headers: write ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body || '{}') } : {},
            },
            (res) => {
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => {
                    if (write) busy = false;
                    lastUsed = Date.now();
                    resolve({ status: res.statusCode || 502, body: Buffer.concat(chunks).toString('utf8') });
                });
            },
        );
        const down = (message) => {
            if (write) busy = false;
            resolve({ status: 502, body: JSON.stringify({ error: { code: 'helper_down', message } }), down: true });
        };
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', (err) =>
            down(err.message === 'timeout' ? 'The NFC helper took too long to answer.' : 'The NFC helper on this server is not running.'),
        );
        if (write) req.write(body || '{}');
        req.end();
    });
}

let releaseCache = { at: 0, value: null };

/** The newest KaChat-NFC release, cached for 10 minutes (GitHub's API limit is per address). */
export async function latestRelease({ force = false } = {}) {
    if (!force && releaseCache.value && Date.now() - releaseCache.at < 10 * 60_000) return releaseCache.value;
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'kaspa-quick-start' },
        signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
        const hint = res.status === 403 ? ' (GitHub API rate limit, try again shortly)' : '';
        throw new Error(`GitHub returned ${res.status} for ${REPO} releases${hint}`);
    }
    const r = await res.json();
    const value = { tag: String(r.tag_name || ''), url: r.html_url, publishedAt: r.published_at };
    releaseCache = { at: Date.now(), value };
    return value;
}
