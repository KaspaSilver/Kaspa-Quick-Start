import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CONF_DIR } from './paths.js';
import { loadDomains, readJson, saveDomains, writeJson } from './store.js';
import { compose, containerState } from './dockerctl.js';
import { TUNNEL_PORT } from './nginx.js';
import * as cf from './cloudflare-api.js';

/**
 * Public addresses, through a Cloudflare Tunnel. The only way this panel puts
 * anything on the internet.
 *
 * `cloudflared` runs beside the stack and dials out to Cloudflare. Requests for
 * a published name come back down that connection, and the connector hands
 * every one of them to the reverse proxy's tunnel listener (TUNNEL_ORIGIN),
 * where nginx decides what the name serves: the routes, blocks, CORS, passwords
 * and per-visitor limits under Tunnel & domains. Nothing listens on the
 * internet here: no forwarded ports, no certificates to renew (Cloudflare
 * serves HTTPS at its edge), and DNS shows Cloudflare's addresses rather than
 * this network's. It works behind a provider that never gave the house an
 * address of its own.
 *
 * It replaces DuckDNS, port forwarding and Let's Encrypt, which between them
 * needed a free name kept pointed at home, ports 80 and 443 opened on the
 * router, and a certificate that quietly stopped renewing the day the DuckDNS
 * token was lost. The name is now one you own, on a Cloudflare account.
 *
 * One API token does the setup: the panel finds or makes the tunnel, starts the
 * connector with its run token, and for each name adds a proxied CNAME and a
 * route. A tunnel made by hand in the dashboard (how this used to work) is
 * picked up rather than replaced: its run token names it, and connecting with
 * an API token adopts it, its existing names and DNS records included.
 */

export const CLOUDFLARE_DIR = path.join(CONF_DIR, 'cloudflare');
// Read by compose (env_file on the cloudflared service). Holds the run token and
// nothing else, 0600, and never goes into a JSON file the panel hands out.
export const TOKEN_FILE = path.join(CLOUDFLARE_DIR, 'tunnel.env');
// The API token that manages the tunnel and DNS. Same rules as the run token.
const API_TOKEN_FILE = path.join(CLOUDFLARE_DIR, 'api-token');
export const CONFIG_FILE = path.join(CLOUDFLARE_DIR, 'cloudflare.json');

export const CONTAINER = 'kaspa-node-cloudflared';
const SERVICE = 'cloudflared';
// The connector rides with the reverse proxy: one switch, one app.
const PROFILE = 'proxy';
// cloudflared's metrics server, where /ready says whether it holds a connection
// to Cloudflare. Internal network only; never published.
const METRICS_URL = 'http://cloudflared:2000/ready';

// What every route points at (nginx's tunnel listener, see nginx.js).
export const TUNNEL_ORIGIN = `http://proxy:${TUNNEL_PORT}`;

const DEFAULT_CONFIG = { installId: null, accountId: null, accountName: null, tunnelId: null, tunnelName: null, zones: [] };

export const loadConfig = () => readJson(CONFIG_FILE, DEFAULT_CONFIG);
const saveConfig = (cfg) => writeJson(CONFIG_FILE, cfg, { mode: 0o600 });

const err400 = (message) => Object.assign(new Error(message), { status: 400 });

// ---------------------------------------------------------------- tokens ---

function writeSecret(file, contents) {
    fs.mkdirSync(CLOUDFLARE_DIR, { recursive: true });
    fs.writeFileSync(file, contents, { mode: 0o600 });
    // 0600 whether or not it existed: one restored from a backup must not stay readable.
    fs.chmodSync(file, 0o600);
}

/**
 * What a tunnel run token says about itself.
 *
 * A token is base64 JSON: the account tag (a), the tunnel id (t) and the tunnel
 * secret (s). Only a and t ever leave this function.
 */
export function parseToken(raw) {
    const token = String(raw ?? '').trim();
    if (!token || !/^[A-Za-z0-9+/=_-]+$/.test(token)) throw new Error('That is not a tunnel token.');
    let decoded;
    try {
        decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
    } catch {
        throw new Error('That is not a tunnel token.');
    }
    if (!decoded?.a || !decoded?.t || !decoded?.s) throw new Error('That tunnel token is incomplete.');
    return { token, accountTag: String(decoded.a), tunnelId: String(decoded.t) };
}

/** The run token's account and tunnel id, or null when there is none. */
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

/** Whether the connector has a token to run with. Started without one, it exits and restarts forever. */
export const hasToken = () => tokenInfo() !== null;

const apiToken = () => {
    try {
        return fs.readFileSync(API_TOKEN_FILE, 'utf8').trim();
    } catch {
        return '';
    }
};

/**
 * connected  an API token manages the tunnel, and names are added here.
 * legacy     a tunnel made in the Cloudflare dashboard is running on its run
 *            token, and its names keep working, but nothing can be added until
 *            an API token is connected (which adopts that same tunnel).
 * off        neither.
 */
export function mode() {
    if (loadConfig().tunnelId && apiToken()) return 'connected';
    return hasToken() ? 'legacy' : 'off';
}

// ------------------------------------------------------------- the names ---

// One DNS label. Cloudflare's free certificate covers example.com and
// *.example.com, and nothing deeper: a.b.example.com would be published and
// then refuse every HTTPS connection until a paid certificate was bought for
// it. Refusing the dot here is cheaper than explaining that afterwards.
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The full name for "kachat" on example.com; "" or "@" is the domain itself. */
export function hostnameFor(subdomain, zone) {
    const sub = String(subdomain ?? '').trim().toLowerCase().replace(/\.+$/, '');
    if (!sub || sub === '@') return zone.name;
    if (sub.endsWith(`.${zone.name}`)) return hostnameFor(sub.slice(0, -(zone.name.length + 1)), zone);
    if (sub.includes('.')) {
        throw err400(`Use one word in front of ${zone.name}, like "node". A name with more dots than that needs a paid Cloudflare certificate before HTTPS works on it.`);
    }
    if (!LABEL.test(sub)) throw err400('A name can only use letters, numbers and dashes, and cannot start or end with a dash.');
    return `${sub}.${zone.name}`;
}

/** The domain on the account a name belongs to: the longest one it ends in. */
export const zoneFor = (hostname, zones) =>
    [...zones].sort((a, b) => b.name.length - a.name.length).find((z) => hostname === z.name || hostname.endsWith(`.${z.name}`)) ?? null;

// Every name this panel holds goes to the same place; nginx tells them apart.
const ingressFor = (domains) => domains.filter((d) => d.tunnel === 'on').map((d) => ({ hostname: d.domain, service: TUNNEL_ORIGIN }));

/** Test seam: lets a test run this without touching real containers. */
const deps = { compose, containerState };
export function _setDeps(next) {
    Object.assign(deps, next);
}

function connected() {
    const t = loadConfig();
    const token = apiToken();
    if (!t.tunnelId || !token) {
        throw Object.assign(new Error('Connect your Cloudflare account first (Tunnel & domains, Overview).'), { status: 409 });
    }
    return { t, token };
}

/**
 * Sends one name into the tunnel: DNS first, then the route, and the DNS undone
 * if the route fails, so a failure never leaves a name that resolves to the
 * tunnel and is then turned away by it. Updates `record` in place.
 */
async function route(record, domains, { t, token }, onLine) {
    const zone = record.zoneId ? t.zones.find((z) => z.id === record.zoneId) : zoneFor(record.domain, t.zones);
    if (!zone) {
        record.tunnel = 'pending';
        record.problem = `${record.domain} is not a domain on the Cloudflare account this panel is connected to (${t.accountName || t.accountId}).`;
        return false;
    }
    record.zoneId = zone.id;
    let dns;
    try {
        dns = await cf.pointAtTunnel(token, zone.id, record.domain, t.tunnelId);
    } catch (err) {
        record.tunnel = 'pending';
        record.problem = err.message;
        return false;
    }
    onLine(dns.reused ? `${record.domain}: its DNS record already points into the tunnel.` : `${record.domain}: DNS record added.`);
    const wasOn = record.tunnel === 'on';
    record.tunnel = 'on';
    try {
        await cf.putIngress(token, t.accountId, t.tunnelId, ingressFor(domains));
    } catch (err) {
        if (!dns.reused) await cf.removeRecord(token, zone.id, record.domain, t.tunnelId).catch(() => {});
        record.tunnel = wasOn ? 'on' : 'pending';
        throw err;
    }
    delete record.problem;
    return true;
}

/**
 * A new public name: `kachat` on example.com becomes kachat.example.com, pointed
 * into the tunnel. Returns the domain record; nginx serves it once a service is
 * put on it.
 */
export async function addName({ subdomain, zoneId }, onLine = () => {}) {
    const ctx = connected();
    const zone = ctx.t.zones.find((z) => z.id === zoneId);
    if (!zone) throw err400('Pick one of your domains.');
    const hostname = hostnameFor(subdomain, zone);

    const domains = loadDomains();
    const known = domains.find((d) => d.domain === hostname);
    if (known?.tunnel === 'on') return known;

    const record = known ?? { id: crypto.randomBytes(6).toString('hex'), domain: hostname, zoneId: zone.id, tunnel: 'pending', addedAt: new Date().toISOString() };
    if (!known) domains.push(record);
    onLine(`Pointing ${hostname} at the tunnel...`);
    if (!(await route(record, domains, ctx, onLine))) throw Object.assign(new Error(record.problem), { status: 409 });
    saveDomains(domains);
    onLine(`${hostname} reaches this machine through the tunnel.`);
    return record;
}

/** Tries a name that could not be put on the tunnel again (after its old DNS record was removed, say). */
export async function retryName(id, onLine = () => {}) {
    const ctx = connected();
    const domains = loadDomains();
    const record = domains.find((d) => d.id === id);
    if (!record) throw Object.assign(new Error('No such name.'), { status: 404 });
    const ok = await route(record, domains, ctx, onLine);
    saveDomains(domains);
    if (!ok) throw Object.assign(new Error(record.problem), { status: 409 });
    return record;
}

/** Takes a name off the tunnel. Its DNS record goes too, if it still points into the tunnel. */
export async function removeName(record, onLine = () => {}) {
    const mine = mode() === 'connected';
    if (mine && record.tunnel === 'on') {
        const { t, token } = connected();
        const rest = loadDomains().filter((d) => d.id !== record.id);
        await cf.putIngress(token, t.accountId, t.tunnelId, ingressFor(rest), { drop: [record.domain] });
        const zone = record.zoneId ? { id: record.zoneId } : zoneFor(record.domain, t.zones);
        const rm = zone
            ? await cf.removeRecord(token, zone.id, record.domain, t.tunnelId).catch((err) => ({ removed: false, reason: err.message }))
            : { removed: false, reason: 'it is not on this account' };
        onLine(rm.removed ? `${record.domain}: DNS record removed.` : `${record.domain}: DNS record not removed, ${rm.reason}.`);
    } else if (record.tunnel === 'on') {
        onLine(`${record.domain} was set up in the Cloudflare dashboard, so its route and DNS record are still there. Remove them in the dashboard, or connect an API token first and the panel does it.`);
    }
}

// ------------------------------------------------------------ the connector --

/** Recreated rather than restarted: compose reads the run token when it creates the container. */
export async function startConnector(onLine = () => {}) {
    await deps.compose(['up', '-d', '--no-deps', '--force-recreate', SERVICE], { onLine, profile: PROFILE, timeoutMs: 5 * 60_000 });
}

async function removeConnector(onLine) {
    await deps.compose(['rm', '-sf', SERVICE], { onLine, profile: PROFILE, timeoutMs: 2 * 60_000 }).catch(() => {});
}

async function waitForHealthy(token, t, onLine) {
    for (let i = 0; i < 15; i++) {
        const s = await cf.tunnelStatus(token, t.accountId, t.tunnelId).catch(() => null);
        if (s?.status === 'healthy') {
            onLine(`The tunnel is up, with ${s.connections} connection${s.connections === 1 ? '' : 's'} to Cloudflare.`);
            return true;
        }
        await new Promise((r) => setTimeout(r, 3000));
    }
    onLine('The connector started, but Cloudflare has not reported the tunnel as healthy yet. Give it a minute; the status on this page will catch up.');
    return false;
}

// ------------------------------------------------------------- operations ---

/**
 * Connects this install to a Cloudflare account, given an API token.
 *
 * Every step is safe to repeat. A tunnel already running here on a run token
 * from the dashboard is adopted, so its names keep working throughout; without
 * one, the panel's own tunnel is found by name before one is made, so
 * connecting again after a disconnect ends with the same single tunnel. Every
 * name under Tunnel & domains is then pointed into it.
 */
export async function connect(rawToken, onLine = () => {}) {
    const token = String(rawToken ?? '').trim();
    if (!token) throw err400('Paste the API token from Cloudflare first.');
    if (/\s/.test(token)) throw err400('An API token is one word with no spaces. Copy it again from the page Cloudflare showed after creating it.');

    onLine('Checking the token with Cloudflare...');
    const zones = await cf.listZones(token);
    if (!zones.length) {
        throw err400(
            'That token works, but it cannot see any domain. Give it Zone > Zone > Read and Zone > DNS > Edit on your domain, and check the domain shows as Active in Cloudflare.',
        );
    }

    const prev = loadConfig();
    const installId = prev.installId || crypto.randomBytes(3).toString('hex');
    let accountId = null;
    let tunnel = null;

    // The tunnel this machine already runs, made in the dashboard: keep it.
    const running = tokenInfo();
    if (running) {
        const found = await cf.getTunnel(token, running.accountTag, running.tunnelId).catch(() => null);
        if (found) {
            accountId = running.accountTag;
            tunnel = { ...found, token: await cf.runToken(token, accountId, found.id), created: false, adopted: true };
            onLine(`Adopting the tunnel this machine already runs, "${found.name}", so its names keep working.`);
        } else {
            onLine('The tunnel this machine was running is not one this token can manage, so the panel sets up its own.');
        }
    }

    if (!tunnel) {
        // A tunnel belongs to one account. Prefer the one connected before.
        accountId = zones.some((z) => z.accountId === prev.accountId) ? prev.accountId : zones[0].accountId;
        const name = `kaspa-quick-start-${installId}`;
        onLine(`Finding or creating the tunnel "${name}"...`);
        tunnel = await cf.ensureTunnel(token, accountId, name);
        onLine(tunnel.created ? 'Created it.' : 'Found it from before, so it is being reused.');
    }

    const mine = zones.filter((z) => z.accountId === accountId);
    if (!mine.length) {
        throw err400('This token cannot see any domain on the account that owns the tunnel. Give it Zone > Zone > Read and Zone > DNS > Edit on that account\'s domain.');
    }
    if (mine.length < zones.length) {
        onLine(`The token can see domains in more than one Cloudflare account. Using ${mine[0].accountName || accountId}.`);
    }
    onLine(`Domains available: ${mine.map((z) => z.name).join(', ')}.`);

    const t = {
        installId,
        accountId,
        accountName: mine[0].accountName ?? null,
        tunnelId: tunnel.id,
        tunnelName: tunnel.name,
        zones: mine.map((z) => ({ id: z.id, name: z.name })),
    };
    writeSecret(API_TOKEN_FILE, `${token}\n`);
    writeSecret(TOKEN_FILE, `TUNNEL_TOKEN=${tunnel.token}\n`);
    saveConfig(t);

    // Every name the panel holds, into this tunnel. One that cannot go (another
    // account's domain, a record somebody else made) is marked and said, not fatal.
    const domains = loadDomains();
    for (const record of domains) {
        // Records from another tunnel point there, not here.
        if (record.zoneId && !t.zones.some((z) => z.id === record.zoneId)) delete record.zoneId;
        await route(record, domains, { t, token }, onLine).catch((err) => {
            record.tunnel = 'pending';
            record.problem = err.message;
        });
        if (record.problem) onLine(`! ${record.problem}`);
    }
    saveDomains(domains);
    await cf.putIngress(token, accountId, tunnel.id, ingressFor(domains));

    onLine('Starting the connector...');
    await startConnector(onLine);
    await waitForHealthy(token, t, onLine);
    return t;
}

/**
 * Disconnects from Cloudflare: names off the tunnel, their DNS records removed,
 * connector gone, tokens forgotten.
 *
 * The names stay on the list, so connecting again puts them all back. The
 * tunnel itself is left in the account, empty: it costs nothing, and the next
 * connect finds and reuses it rather than making a new one.
 */
export async function disconnect(onLine = () => {}) {
    const t = loadConfig();
    const token = apiToken();
    const domains = loadDomains();
    if (token && t.tunnelId) {
        for (const d of domains.filter((x) => x.tunnel === 'on')) {
            const zone = d.zoneId ? { id: d.zoneId } : zoneFor(d.domain, t.zones);
            const rm = zone
                ? await cf.removeRecord(token, zone.id, d.domain, t.tunnelId).catch((err) => ({ removed: false, reason: err.message }))
                : { removed: false, reason: 'it is not on this account' };
            onLine(rm.removed ? `Removed ${d.domain} from DNS.` : `Left ${d.domain} in DNS: ${rm.reason}.`);
        }
        await cf.putIngress(token, t.accountId, t.tunnelId, [], { drop: domains.map((d) => d.domain) }).catch(() => {});
    } else if (hasToken()) {
        onLine('This tunnel was set up in the Cloudflare dashboard, so its routes and DNS records stay there until you remove them.');
    }
    for (const d of domains) {
        d.tunnel = 'pending';
        delete d.problem;
    }
    saveDomains(domains);

    onLine('Stopping the connector...');
    await removeConnector(onLine);
    fs.rmSync(API_TOKEN_FILE, { force: true });
    fs.rmSync(TOKEN_FILE, { force: true });
    saveConfig({ ...DEFAULT_CONFIG, installId: t.installId, accountId: t.accountId });
    onLine('Disconnected. The tunnel is left, empty, in your Cloudflare account, and connecting again picks it back up.');
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

/** Everything the Tunnel & domains page shows about the tunnel. Cloudflare's own view is asked for live. */
export async function status() {
    const t = loadConfig();
    const m = mode();
    const container = await deps.containerState(CONTAINER).catch(() => ({ exists: false, running: false }));
    let cloudflare = null;
    if (m === 'connected') {
        cloudflare = await cf.tunnelStatus(apiToken(), t.accountId, t.tunnelId).catch((err) => ({ status: 'unknown', connections: 0, error: err.message }));
    }
    return {
        mode: m,
        accountName: m === 'connected' ? t.accountName : null,
        tunnelName: m === 'connected' ? t.tunnelName : null,
        tunnelId: m === 'connected' ? t.tunnelId : (tokenInfo()?.tunnelId ?? null),
        zones: m === 'connected' ? t.zones : [],
        origin: TUNNEL_ORIGIN,
        cloudflare,
        container,
        connection: container.running ? await connection() : null,
    };
}
