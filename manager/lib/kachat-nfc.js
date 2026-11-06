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
// The server-side helper is built from KaChat-NFC's latest release, like the browser-side one the
// user installs from releases/latest, so a new release there reaches the panel with no change
// here. Each release gets its own image, tagged with the release.
const IMAGE_NAME = 'kaspa-quick-start/kachat-nfc';
export const CONTAINER = 'kaspa-node-kachat-nfc';
const NETWORK = 'kaspa-node-net';
const HELPER_PORT = 18421;
// Where the server helper answers; the override is for testing the panel against a stand-in.
const [HELPER_HOST, HELPER_HOST_PORT] = (process.env.KACHAT_NFC_HELPER || `${CONTAINER}:${HELPER_PORT}`).split(':');
// A release tag goes into a docker tag and a URL, so only plain ones are used.
const TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
// The helper's own Dockerfile at a release, used as the whole build context (it downloads that
// release's binary and checks it against SHA256SUMS), so the image is exactly that release.
const dockerfileUrl = (tag) => `https://raw.githubusercontent.com/${REPO}/${tag}/docker/Dockerfile`;

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

/** Release tags of the helper images built here, newest first. */
async function builtTags() {
    try {
        const { stdout } = await docker(['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}', IMAGE_NAME], { timeoutMs: 30_000 });
        return stdout
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l.startsWith(`${IMAGE_NAME}:`))
            .map((l) => l.slice(IMAGE_NAME.length + 1))
            .filter((t) => TAG_RE.test(t))
            .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    } catch {
        return [];
    }
}

/** The latest release's tag, or null when GitHub can't be reached. */
async function latestTag() {
    const tag = (await latestRelease().catch(() => null))?.tag;
    return tag && TAG_RE.test(tag) ? tag : null;
}

/** The release the running helper was built from, or null when none runs. */
async function runningTag() {
    try {
        const { stdout } = await docker(['inspect', '-f', '{{.State.Running}}|{{.Config.Image}}', CONTAINER], { timeoutMs: 15_000 });
        const [running, image] = stdout.trim().split('|');
        if (running !== 'true') return null;
        return image.startsWith(`${IMAGE_NAME}:`) ? image.slice(IMAGE_NAME.length + 1) : '';
    } catch {
        return null;
    }
}

export async function serverState() {
    const [tags, running, latest] = await Promise.all([builtTags(), runningTag(), latestTag()]);
    // `tag` is what a start would run: the latest release, or the newest image here when GitHub
    // can't be reached.
    return {
        tag: latest || tags[0] || null,
        image: tags.length > 0,
        built: tags[0] || null,
        running: running !== null,
        runningTag: running || null,
    };
}

/** Removes helper images, all of them or all but one release's. */
async function removeImages(keep = null) {
    const old = (await builtTags()).filter((t) => t !== keep);
    for (const t of old) await docker(['image', 'rm', '-f', `${IMAGE_NAME}:${t}`], { timeoutMs: 60_000 }).catch(() => {});
    return old;
}

/** Removes images built for releases older than the latest. Does nothing while GitHub is out of reach. */
export async function removeOldImages() {
    const latest = await latestTag();
    return latest ? removeImages(latest) : [];
}

/** Builds the helper image for a release, once. */
async function ensureImage(tag, onLine) {
    if ((await builtTags()).includes(tag)) return;
    onLine(`Building the NFC helper ${tag} (once per release). It downloads the release and checks its hash.`);
    await docker(['build', '--build-arg', `VERSION=${tag}`, '-t', `${IMAGE_NAME}:${tag}`, dockerfileUrl(tag)], {
        onLine,
        timeoutMs: 15 * 60_000,
    });
}

/**
 * Starts the helper here, built from the latest release, with the USB bus passed in. A reader
 * plugged in after the container started may not be seen, so starting again always replaces a
 * running one.
 */
export async function startServerHelper(onLine = () => {}) {
    if ((await hostKind()) !== 'linux') {
        throw new Error('This server runs Docker Desktop, which cannot reach USB. Use the helper on your computer.');
    }
    const latest = await latestTag();
    const tag = latest || (await builtTags())[0];
    if (!tag) throw new Error(`Could not reach GitHub to find the latest ${REPO} release. Try again shortly.`);
    if (!latest) onLine(`GitHub can't be reached, so this starts the helper already here (${tag}).`);
    await ensureImage(tag, onLine);
    await docker(['rm', '-f', CONTAINER], { timeoutMs: 30_000 }).catch(() => {});
    const old = latest ? await removeImages(tag) : [];
    if (old.length) onLine(`Removed the older NFC helper image${old.length > 1 ? 's' : ''} (${old.join(', ')}).`);
    onLine(`Starting the NFC helper ${tag} with access to USB...`);
    await docker(
        [
            'run', '--detach', '--rm',
            '--name', CONTAINER,
            '--network', NETWORK,
            '--device', '/dev/bus/usb',
            `${IMAGE_NAME}:${tag}`,
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
    await removeImages();
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
/** A card load or secure is going through the server helper right now. */
export const writing = () => busy;

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

// The applet's version is in its source, so reading it at a ref says which card software that
// ref would put on a card. raw.githubusercontent.com isn't counted against the API limit.
const APPLET_SOURCE = 'applet/src/app/kachat/nfc/KaChatNFCApplet.java';

async function appletVersionAt(ref) {
    const res = await fetch(`https://raw.githubusercontent.com/${REPO}/${ref}/${APPLET_SOURCE}`, {
        headers: { 'user-agent': 'kaspa-quick-start' },
        signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`GitHub returned ${res.status} for the card software at ${ref}`);
    const text = await res.text();
    const major = text.match(/APPLET_VERSION_MAJOR\s*=\s*(\d+)/)?.[1];
    const minor = text.match(/APPLET_VERSION_MINOR\s*=\s*(\d+)/)?.[1];
    if (major === undefined || minor === undefined) throw new Error(`The card software at ${ref} has no version the panel can read`);
    return `${major}.${minor}`;
}

async function githubApi(path) {
    const res = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'kaspa-quick-start' },
        signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
        const hint = res.status === 403 ? ' (GitHub API rate limit, try again shortly)' : '';
        throw new Error(`GitHub returned ${res.status} for ${REPO}${hint}`);
    }
    return res.json();
}

let githubCache = { at: 0, value: null };

/**
 * KaChat-NFC on GitHub: its latest release and its main branch, with the card software version
 * each one carries, and how far main has moved past the release. Cached for 10 minutes.
 */
export async function githubState({ force = false } = {}) {
    if (!force && githubCache.value && Date.now() - githubCache.at < 10 * 60_000) return githubCache.value;
    const [release, head] = await Promise.all([latestRelease({ force }), githubApi('/commits/main')]);
    const sha = String(head.sha || '');
    const [releaseApplet, mainApplet, compare] = await Promise.all([
        TAG_RE.test(release.tag) ? appletVersionAt(release.tag).catch(() => null) : null,
        appletVersionAt(sha),
        TAG_RE.test(release.tag) ? githubApi(`/compare/${release.tag}...${sha}`).catch(() => null) : null,
    ]);
    const value = {
        release: { ...release, appletVersion: releaseApplet },
        main: {
            sha,
            shortSha: sha.slice(0, 7),
            message: String(head.commit?.message || '').split('\n')[0],
            date: head.commit?.committer?.date || null,
            url: head.html_url || `https://github.com/${REPO}/commits/main`,
            appletVersion: mainApplet,
            aheadOfRelease: compare ? Number(compare.ahead_by) || 0 : null,
        },
    };
    githubCache = { at: Date.now(), value };
    return value;
}
