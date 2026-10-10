import http from 'node:http';
import net from 'node:net';

import { docker } from './dockerctl.js';
import { readEnvFile } from './store.js';

/**
 * x4kas (github.com/smartgoo/x4kas): the Kaspa terminal desktop app, run in its own container
 * on a virtual screen and streamed with KasmVNC, so the panel's x4kas tab shows exactly what
 * the downloaded app shows.
 *
 * The stream is never published on a port of its own. The panel proxies it under /x4kas/
 * (plain HTTP for the page, a WebSocket for the screen) and only for a signed-in session.
 * KasmVNC also asks for a password (X4KAS_PASSWORD, generated, never shown), which only this
 * proxy sends, so nothing else on the stack network can open the app either: x4kas has a
 * built-in terminal, which is a shell in its container.
 */
export const REPO = 'smartgoo/x4kas';
export const MOUNT = '/x4kas';
export const CONTAINER = 'kaspa-node-x4kas';
const IMAGE = 'kaspa-one-click/x4kas';
const VERSION_LABEL = 'org.opencontainers.image.version';
// Overridable for development (a panel running outside the stack network).
const ORIGIN = new URL(process.env.X4KAS_ORIGIN || 'http://x4kas:3000');

export const version = () => (readEnvFile().X4KAS_VERSION || '').trim() || null;
export const imageTag = (v = version()) => `${IMAGE}:${v || 'latest'}`;
export const cpus = () => {
    const n = Number(readEnvFile().X4KAS_CPUS);
    return Number.isFinite(n) && n > 0 ? n : 0.5;
};

/** The release the installed image was built from, or null when it is not built. */
export async function installedVersion() {
    try {
        const { stdout } = await docker(['image', 'inspect', '-f', `{{index .Config.Labels "${VERSION_LABEL}"}}`, imageTag()], {
            timeoutMs: 15_000,
        });
        const v = stdout.trim();
        return v && v !== '<no value>' ? v : null;
    } catch {
        return null;
    }
}

/** The newest x4kas release on GitHub: { tag, name, url, publishedAt, prerelease, notes }. */
export async function latestRelease() {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'kaspa-quick-start' },
        signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
        const hint = res.status === 403 ? ' (GitHub API rate limit - try again shortly)' : '';
        throw new Error(`GitHub returned ${res.status} for ${REPO} releases${hint}`);
    }
    const r = await res.json();
    if (!/^v?\d+\.\d+\.\d+([-.][0-9A-Za-z.-]+)?$/.test(String(r.tag_name || ''))) {
        throw new Error(`Unexpected x4kas release tag "${r.tag_name}".`);
    }
    return {
        tag: r.tag_name,
        name: r.name || r.tag_name,
        url: r.html_url,
        publishedAt: r.published_at,
        prerelease: Boolean(r.prerelease),
        notes: String(r.body || '').slice(0, 4000),
    };
}

// --- the stream, proxied ---------------------------------------------------------------

const auth = () => `Basic ${Buffer.from(`kqs:${readEnvFile().X4KAS_PASSWORD || ''}`).toString('base64')}`;

/** Request headers to forward: no cookies (the panel's session stays here), our own auth. */
function upstreamHeaders(req) {
    const out = {};
    for (const [k, v] of Object.entries(req.headers)) {
        const key = k.toLowerCase();
        if (['cookie', 'authorization', 'host', 'origin', 'referer'].includes(key)) continue;
        out[key] = v;
    }
    out.host = ORIGIN.host;
    // KasmVNC checks a WebSocket's Origin against its own host; the browser's is the panel's.
    if (req.headers.origin) out.origin = ORIGIN.origin;
    out.authorization = auth();
    return out;
}

/** The page, its assets and KasmVNC's HTTP calls, under /x4kas/. */
export function handle(req, res) {
    const upstream = http.request(
        { host: ORIGIN.hostname, port: ORIGIN.port || 80, method: req.method, path: req.url, headers: upstreamHeaders(req) },
        (up) => {
            const headers = { ...up.headers };
            // Never let KasmVNC's own login prompt reach the browser: the panel is the login.
            delete headers['www-authenticate'];
            delete headers['set-cookie'];
            res.writeHead(up.statusCode === 401 ? 502 : up.statusCode, headers);
            up.pipe(res);
        },
    );
    upstream.on('error', () => {
        if (!res.headersSent) {
            res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end('<p style="font-family:sans-serif">x4kas is not running. Turn it on with its switch in the sidebar.</p>');
        } else res.destroy();
    });
    req.pipe(upstream);
}

/** The screen itself: a WebSocket, spliced through after the same checks. */
export function upgrade(req, socket, head) {
    const up = net.connect(Number(ORIGIN.port || 80), ORIGIN.hostname, () => {
        const headers = upstreamHeaders(req);
        const lines = [`${req.method} ${req.url} HTTP/1.1`];
        for (const [k, v] of Object.entries(headers)) {
            for (const value of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${value}`);
        }
        up.write(`${lines.join('\r\n')}\r\n\r\n`);
        if (head?.length) up.write(head);
        up.pipe(socket);
        socket.pipe(up);
    });
    const close = () => {
        up.destroy();
        socket.destroy();
    };
    up.on('error', close);
    socket.on('error', close);
    up.on('close', () => socket.destroy());
    socket.on('close', () => up.destroy());
}
