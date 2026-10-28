import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CONF_DIR } from './paths.js';
import { readJson, writeJson } from './store.js';
import { validateDomainName, TUNNEL_PORT } from './nginx.js';

/**
 * Cloudflare Tunnel: public names that reach this machine without an open port.
 *
 * `cloudflared` dials out to Cloudflare and holds the connection, so nothing on
 * the router is forwarded and DNS shows Cloudflare's addresses rather than this
 * network's. That is the whole point of it: a node at home can serve a domain
 * without publishing where home is.
 *
 * The tunnel is created in the Cloudflare dashboard, which hands over one token.
 * The routes (which public hostname goes where) also live in the dashboard, and
 * every one of them points at the same place: the reverse proxy's tunnel
 * listener, TUNNEL_ORIGIN. What a hostname then serves is decided here, by
 * naming one of the domains under Proxy & domains, so a tunnel name gets exactly
 * the routes, blocks, CORS and limits that domain already has -- and the two can
 * run side by side while clients move from one to the other.
 */

export const CLOUDFLARE_DIR = path.join(CONF_DIR, 'cloudflare');
// Read by compose (env_file on the cloudflared service). Holds the token and
// nothing else, 0600, and never goes into a JSON file the panel hands out.
export const TOKEN_FILE = path.join(CLOUDFLARE_DIR, 'tunnel.env');
export const CONFIG_FILE = path.join(CLOUDFLARE_DIR, 'cloudflare.json');

export const CONTAINER = 'kaspa-node-cloudflared';
// cloudflared's metrics server, where /ready says whether it holds a connection
// to Cloudflare. Internal network only; never published.
const METRICS_URL = 'http://cloudflared:2000/ready';

// What every route in the dashboard points at (nginx's tunnel listener, see nginx.js).
export const TUNNEL_ORIGIN = `http://proxy:${TUNNEL_PORT}`;

const DEFAULT_CONFIG = { hostnames: [] };

export const loadConfig = () => readJson(CONFIG_FILE, DEFAULT_CONFIG);
const saveConfig = (cfg) => writeJson(CONFIG_FILE, cfg);

/**
 * What a tunnel token says about itself.
 *
 * A token is base64 JSON: the account tag (a), the tunnel id (t) and the tunnel
 * secret (s). Decoding it catches a token pasted with a piece missing, or the
 * whole `cloudflared service install ...` command, before cloudflared refuses
 * it in a log nobody is reading. Only a and t ever leave this function.
 */
export function parseToken(raw) {
    let token = String(raw ?? '').trim();
    // The dashboard shows the token inside a command; take the last word of it.
    const fromCommand = token.match(/--token\s+(\S+)/) ?? token.match(/(\S+)\s*$/);
    if (fromCommand) token = fromCommand[1];
    if (!token) throw new Error('Paste the tunnel token first.');
    if (!/^[A-Za-z0-9+/=_-]+$/.test(token)) throw new Error('That is not a tunnel token: it has characters a token never has.');
    let decoded;
    try {
        decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
    } catch {
        throw new Error('That is not a tunnel token. Copy the long string after --token in the dashboard.');
    }
    if (!decoded?.a || !decoded?.t || !decoded?.s) {
        throw new Error('That token is incomplete. Copy the whole string after --token in the dashboard.');
    }
    return { token, accountTag: String(decoded.a), tunnelId: String(decoded.t) };
}

/** The saved token's account and tunnel id, or null when there is none. */
export function tokenInfo() {
    try {
        const line = fs
            .readFileSync(TOKEN_FILE, 'utf8')
            .split('\n')
            .find((l) => l.startsWith('TUNNEL_TOKEN='));
        if (!line) return null;
        const { accountTag, tunnelId } = parseToken(line.slice('TUNNEL_TOKEN='.length));
        return { accountTag, tunnelId };
    } catch {
        return null;
    }
}

export const hasToken = () => tokenInfo() !== null;

export function saveToken(raw) {
    const { token, accountTag, tunnelId } = parseToken(raw);
    fs.mkdirSync(CLOUDFLARE_DIR, { recursive: true });
    fs.writeFileSync(TOKEN_FILE, `TUNNEL_TOKEN=${token}\n`, { mode: 0o600 });
    // 0600 whether or not it existed: one restored from a backup must not stay readable.
    fs.chmodSync(TOKEN_FILE, 0o600);
    return { accountTag, tunnelId };
}

export function forgetToken() {
    fs.rmSync(TOKEN_FILE, { force: true });
}

/**
 * Adds a public hostname. `serves` names a domain under Proxy & domains; the
 * hostname gets whatever that domain has published, now and after any change.
 */
export function addHostname({ hostname, serves }, knownDomains) {
    const { domain, error } = validateDomainName(hostname);
    if (error) throw new Error(error);
    const source = String(serves ?? '').trim().toLowerCase();
    if (!knownDomains.includes(source)) throw new Error('Pick a domain from Proxy & domains for it to serve.');
    const cfg = loadConfig();
    if (cfg.hostnames.some((h) => h.hostname === domain)) throw new Error(`${domain} is already on the tunnel.`);
    const entry = { id: crypto.randomBytes(6).toString('hex'), hostname: domain, serves: source, addedAt: new Date().toISOString() };
    cfg.hostnames.push(entry);
    saveConfig(cfg);
    return entry;
}

export function removeHostname(id) {
    const cfg = loadConfig();
    const before = cfg.hostnames.length;
    cfg.hostnames = cfg.hostnames.filter((h) => h.id !== id);
    if (cfg.hostnames.length === before) return false;
    saveConfig(cfg);
    return true;
}

/**
 * Whether cloudflared holds a connection to Cloudflare. It keeps several (one
 * per nearby data centre) and is ready with at least one.
 */
export async function connection() {
    try {
        const res = await fetch(METRICS_URL, { signal: AbortSignal.timeout(2500) });
        const body = await res.json().catch(() => ({}));
        return { reachable: true, ready: res.ok, connections: Number(body.readyConnections ?? 0) };
    } catch {
        return { reachable: false, ready: false, connections: 0 };
    }
}
