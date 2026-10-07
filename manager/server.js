import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import dns from 'node:dns/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONF_DIR, DOMAINS_FILE, ensureDirs, KASPAD_ARGS_FILE, NAMES_DIR, NODE_CONFIG_FILE, PROXIES_FILE, STACK_HOST } from './lib/paths.js';
import {
    DEFAULT_NODE_CONFIG,
    NETWORKS,
    loadDomains,
    loadManagerConfig,
    loadNodeConfig,
    loadProxies,
    loadTestnetNodeConfig,
    readEnvFile,
    updateEnvFile,
    saveDomains,
    saveManagerConfig,
    saveNodeConfig,
    saveProxies,
    saveTestnetNodeConfig,
} from './lib/store.js';
import { buildArgs, portMatrix, ports, publicPorts, renderPortsOverride, renderTestnetPortsOverride, setPortState, writeArgsFile, writeTestnetArgsFile } from './lib/kaspad-args.js';
import * as dockerctl from './lib/dockerctl.js';
import * as nginx from './lib/nginx.js';
import * as certbot from './lib/certbot.js';
import * as duckdns from './lib/duckdns.js';
import * as updater from './lib/updater.js';
import * as bridge from './lib/bridge.js';
import * as price from './lib/price.js';
import * as geoip from './lib/geoip.js';
import * as apps from './lib/apps.js';
import * as kachatProxy from './lib/kachat-proxy.js';
import * as syncProgress from './lib/sync-progress.js';
import { createSyncTracker } from './lib/sync-progress.js';
import * as network from './lib/network.js';
import * as emission from './lib/emission.js';
import * as pruning from './lib/pruning.js';
import * as kassigner from './lib/kassigner.js';
import * as selfservice from './lib/selfservice.js';
import * as cpuminer from './lib/cpuminer.js';
import * as publish from './lib/publish.js';
import * as portcheck from './lib/portcheck.js';
import * as push from './lib/push.js';
import * as lifecycle from './lib/lifecycle.js';
import * as host from './lib/host.js';
import * as bot from './lib/bot.js';
import * as backup from './lib/backup.js';
import { nodeSnapshot, rpc, rpcTestnet } from './lib/rpc.js';
import { jobs } from './lib/jobs.js';
import {
    authConfigured,
    authRequired,
    clearCookie,
    hashPassword,
    passwordUnusable,
    isAuthenticated,
    issueSession,
    sessionCookie,
    verifyPassword,
    verifyPasswordAsync,
    clientKey,
    loginBlockedFor,
    recordLoginFailure,
    recordLoginSuccess,
    withLoginSlot,
} from './lib/auth.js';

// Identifies this manager process, and nothing more. The panel reads it on
// every status poll and reloads itself when it changes, so a tab left open
// overnight is never running the code of a build that has already been
// replaced -- after the panel updates itself, and after every restart while
// `dev.sh watch` is rebuilding it.
const BOOT_ID = crypto.randomUUID();

// This panel's own version, not the node's. kaspad's version is reported
// separately on the Kaspad page, where it belongs.
const PANEL_VERSION = (() => {
    try {
        return JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8')).version;
    } catch {
        return '1.0.0';
    }
})();

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const KASPAD_SERVICE = process.env.KASPAD_SERVICE || 'kaspad';

const log = (...args) => console.log(new Date().toISOString(), ...args);

// ------------------------------------------------------------- http helpers --

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.png': 'image/png',
    '.webmanifest': 'application/manifest+json',
    '.json': 'application/json; charset=utf-8',
};

function sendJson(res, status, body, headers = {}) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...headers,
    });
    res.end(payload);
}

const fail = (res, status, message, extra = {}) => sendJson(res, status, { error: message, ...extra });

async function readBody(req, limit = 512 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > limit) throw new Error('Request body too large.');
        chunks.push(chunk);
    }
    if (!chunks.length) return {};
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        throw new Error('Request body is not valid JSON.');
    }
}

function serveStatic(req, res, urlPath) {
    const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const file = path.resolve(PUBLIC_DIR, rel);
    // Path traversal guard: the resolved file must stay inside PUBLIC_DIR.
    if (!file.startsWith(`${PUBLIC_DIR}${path.sep}`) && file !== path.join(PUBLIC_DIR, 'index.html')) {
        return fail(res, 403, 'Forbidden');
    }
    fs.readFile(file, (err, data) => {
        if (err) {
            // Unknown paths fall back to the single page app entry point.
            return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err2, html) => {
                if (err2) return fail(res, 404, 'Not found');
                res.writeHead(200, { 'Content-Type': MIME['.html'] });
                res.end(html);
            });
        }
        res.writeHead(200, {
            'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
            'Cache-Control': 'no-cache',
            'X-Content-Type-Options': 'nosniff',
            'Referrer-Policy': 'same-origin',
        });
        res.end(data);
    });
}

function sse(req, res) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    const send = (event, data) => {
        if (res.writableEnded) return;
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    const keepAlive = setInterval(() => !res.writableEnded && res.write(': ping\n\n'), 20_000);
    const close = () => clearInterval(keepAlive);
    req.on('close', close);
    res.on('close', close);
    return { send, onClose: (fn) => req.on('close', fn) };
}

// -------------------------------------------------------------- apply logic --

/**
 * Writes the generated kaspad args + published-port override and restarts the
 * node so both take effect. Everything the UI changes about the node funnels
 * through here so the on-disk state and the running container cannot drift.
 */
/**
 * What in the stack is currently asking the node for a listener. The gRPC and
 * wRPC-Borsh listeners follow these, so every path that writes the node's args
 * reads them from here rather than from a stored switch.
 */
function nodeSiblings() {
    const appsCfg = apps.loadAppsConfig();
    return {
        mining: bridge.loadBridgeConfig().enabled === true,
        indexer: Boolean(appsCfg.kachat?.enabled),
        bot: Boolean(appsCfg.bot?.enabled),
    };
}

/**
 * Bring the node's in-container listeners in line with what the enabled
 * services need, restarting it only if that actually changed the args. This is
 * how switching on the miner, indexer or bot turns its gRPC / wRPC-Borsh
 * listener on -- and how doing so touches the node only when the listener was
 * not already there.
 */
async function ensureNodeListeners(onLine = () => {}) {
    const cfg = loadNodeConfig();
    writeArgsFile(cfg, nodeSiblings());
    if (argsDrifted()) {
        onLine("Bringing the node's listeners in line with the services that need them.");
        await applyNodeConfig(cfg, onLine);
    }
}

async function applyNodeConfig(cfg, onLine = () => {}) {
    const args = writeArgsFile(cfg, nodeSiblings());
    const mappings = renderPortsOverride(cfg);
    rpc.setUrl(`ws://${KASPAD_SERVICE}:${ports(cfg).json}`);

    onLine(`kaspad arguments: ${args.join(' ')}`);
    onLine(`Published ports: ${mappings.length ? mappings.join(', ') : 'none (internal only)'}`);

    // Regenerate proxy configs too: they embed kaspad's port numbers, which
    // change when the network does.
    nginx.writeAll(loadProxies(), cfg, renderOptions());

    // A stopped node stays stopped. Everything above this point is on disk,
    // and kaspad reads it when it next boots, so changing settings is never a
    // back door that starts a node somebody switched off -- nor one that has
    // never been started at all, which is how every fresh install begins.
    const state = await dockerctl.containerState(dockerctl.KASPAD_CONTAINER);
    if (!state.running) {
        onLine(
            state.exists
                ? 'The node is stopped, so this is saved and applies the moment you start it.'
                : 'The node has not been started yet, so this applies the moment you start it.',
        );
        await reloadProxyIfRunning(onLine);
        return { args, mappings };
    }

    onLine('Recreating the kaspad container...');
    await dockerctl.compose(['up', '-d', '--force-recreate', KASPAD_SERVICE], { onLine, timeoutMs: 10 * 60_000 });
    // The container now matches the file; remember that so a manager restart
    // does not decide the node needs recreating again.
    recordAppliedArgs();
    syncProgress.reset();

    await reloadProxyIfRunning(onLine);

    // The bridge's config embeds kaspad's gRPC port, which moves when the
    // network changes, and it holds a gRPC connection that a kaspad restart
    // breaks. Rewrite and bounce it whenever the node is reconfigured.
    const miningCfg = bridge.loadBridgeConfig();
    bridge.writeBridgeFiles(miningCfg, cfg);
    // Only if it is actually running. The saved 'enabled' flag survives the
    // switch being turned off -- that is the point of it -- so restarting on
    // the flag would start a bridge somebody had stopped, as a side effect of
    // editing an unrelated node setting.
    if ((await dockerctl.containerState(dockerctl.BRIDGE_CONTAINER)).running) {
        onLine('Restarting the stratum bridge against the reconfigured node...');
        await dockerctl
            .compose(['up', '-d', '--no-deps', '--force-recreate', 'bridge'], {
                onLine,
                profile: 'mining',
                timeoutMs: 10 * 60_000,
            })
            .catch((err) => onLine(`Bridge restart failed: ${err.message}`));
    } else if (miningCfg.enabled) {
        onLine('The stratum bridge is stopped, so it picks up the new node settings when you start it.');
    }

    return { args, mappings };
}

const APPLIED_ARGS_FILE = path.join(CONF_DIR, 'kaspad-applied.json');

const argsHash = () =>
    crypto.createHash('sha256').update(fs.readFileSync(KASPAD_ARGS_FILE, 'utf8')).digest('hex');

/** True when the args on disk are not what the running container was built with. */
function argsDrifted() {
    try {
        const applied = JSON.parse(fs.readFileSync(APPLIED_ARGS_FILE, 'utf8'));
        return applied.hash !== argsHash();
    } catch {
        // No record at all: either a fresh install or an older one. Treat as
        // drifted so the node is brought in line exactly once.
        return true;
    }
}

function recordAppliedArgs() {
    try {
        fs.writeFileSync(APPLIED_ARGS_FILE, `${JSON.stringify({ hash: argsHash(), at: new Date().toISOString() }, null, 2)}\n`);
    } catch (err) {
        log(`could not record applied kaspad arguments: ${err.message}`);
    }
}

/**
 * Whether the node is far enough along for the services that depend on it.
 *
 * The stratum bridge and the KaChat indexer both read live chain data: started
 * against a syncing node they either serve stale work to miners or index a
 * chain that is not there yet. The panel greys them out for the same reason,
 * but the check lives here too -- the UI is a courtesy, this is the rule.
 */
async function nodeReadiness() {
    const [state, snapshot] = await Promise.all([
        dockerctl.containerState(dockerctl.KASPAD_CONTAINER),
        nodeSnapshot(),
    ]);
    const synced = Boolean(snapshot.sync?.isSynced ?? snapshot.info?.isSynced ?? false);
    const running = Boolean(state.running);

    let reason = null;
    if (!running) reason = 'The node is not running.';
    else if (!snapshot.reachable) reason = 'The node is still starting up and is not answering yet.';
    else if (!synced) reason = 'The node is still syncing with the network.';

    return { running, rpcReachable: snapshot.reachable, synced, ready: running && snapshot.reachable && synced, reason };
}

function sanitizeNodeConfig(input) {
    const errors = [];
    const cfg = structuredClone(DEFAULT_NODE_CONFIG);

    if (!NETWORKS[input.network]) errors.push(`Unknown network "${input.network}".`);
    else cfg.network = input.network;

    for (const key of Object.keys(cfg.flags)) cfg.flags[key] = Boolean(input.flags?.[key]);

    // Each port is one level: off / local / public. P2P and wRPC-JSON cannot be
    // off (the node and this panel need them), so they settle at local instead.
    const LEVELS = new Set(['off', 'local', 'public']);
    const PINNED = new Set(['p2p', 'json']);
    for (const key of Object.keys(cfg.expose)) {
        let want = String(input.expose?.[key] ?? cfg.expose[key]).trim();
        if (!LEVELS.has(want)) {
            errors.push(`Port ${key} must be off, local or public.`);
            want = cfg.expose[key];
        }
        if (PINNED.has(key) && want === 'off') want = 'local';
        cfg.expose[key] = want;
    }

    const t = input.tuning ?? {};
    const intField = (name, value, min, max, fallback) => {
        if (value === null || value === undefined || `${value}`.trim() === '') return fallback;
        const n = Number(value);
        if (!Number.isInteger(n) || n < min || n > max) {
            errors.push(`${name} must be a whole number between ${min} and ${max}.`);
            return fallback;
        }
        return n;
    };
    cfg.tuning.logLevel = ['off', 'error', 'warn', 'info', 'debug', 'trace'].includes(t.logLevel) ? t.logLevel : 'info';
    cfg.tuning.outpeers = intField('Outbound peers', t.outpeers, 1, 1000, 8);
    cfg.tuning.maxinpeers = intField('Max inbound peers', t.maxinpeers, 0, 10_000, 128);
    cfg.tuning.rpcmaxclients = intField('Max RPC clients', t.rpcmaxclients, 1, 10_000, 128);
    cfg.tuning.maxTrackedAddresses = intField('Max tracked addresses', t.maxTrackedAddresses, 0, 100_000_000, 0);
    cfg.tuning.asyncThreads = t.asyncThreads ? intField('Async threads', t.asyncThreads, 1, 512, null) : null;

    const ramScale = Number(t.ramScale ?? 1);
    if (!Number.isFinite(ramScale) || ramScale < 0.1 || ramScale > 10) errors.push('RAM scale must be between 0.1 and 10.');
    else cfg.tuning.ramScale = ramScale;

    if (t.retentionPeriodDays === null || t.retentionPeriodDays === undefined || `${t.retentionPeriodDays}`.trim() === '') {
        cfg.tuning.retentionPeriodDays = null;
    } else {
        const days = Number(t.retentionPeriodDays);
        if (!Number.isFinite(days) || days < 1) errors.push('Retention period must be at least 1 day.');
        else cfg.tuning.retentionPeriodDays = days;
    }

    const preset = String(t.rocksdbPreset || '').trim();
    if (preset && !/^[a-z0-9-]{1,32}$/.test(preset)) errors.push('RocksDB preset name is invalid.');
    cfg.tuning.rocksdbPreset = preset;

    const p = input.peering ?? {};
    const ip = String(p.externalip || '').trim();
    if (ip && !/^[0-9a-fA-F.:]+(:\d{1,5})?$/.test(ip)) errors.push('External IP is not a valid address.');
    cfg.peering.externalip = ip;
    cfg.peering.externalipAuto = Boolean(p.externalipAuto);

    const ua = String(p.uacomment || '').trim();
    if (ua && !/^[\w .:/+-]{1,64}$/.test(ua)) errors.push('User agent comment may only contain letters, digits and . : / + - _');
    cfg.peering.uacomment = ua;

    const peerList = (list, label) =>
        (Array.isArray(list) ? list : [])
            .map((v) => String(v).trim())
            .filter(Boolean)
            .filter((v) => {
                if (/^[0-9a-zA-Z.:\[\]-]{1,64}(:\d{1,5})?$/.test(v)) return true;
                errors.push(`${label} entry "${v}" is not a valid address.`);
                return false;
            });
    cfg.peering.connectPeers = peerList(p.connectPeers, 'Connect-only peer');
    cfg.peering.addPeers = peerList(p.addPeers, 'Additional peer');

    cfg.extraArgs = (Array.isArray(input.extraArgs) ? input.extraArgs : [])
        .map((v) => String(v).trim())
        .filter(Boolean)
        .filter((v) => {
            // Extra args are appended verbatim to the args file. Requiring the
            // `--flag` / `--flag=value` shape keeps a stray value from being
            // read as a positional argument.
            if (/^--[a-z0-9-]+(=[^\s]*)?$/i.test(v)) return true;
            errors.push(`Extra argument "${v}" must look like --flag or --flag=value.`);
            return false;
        });

    // The UI shows these as locked; enforce it here too so a hand-crafted
    // request cannot turn off what the stack depends on.
    cfg.expose.json = Boolean(input.expose?.json);

    return { cfg, errors };
}

// ------------------------------------------------------------------ routes --

const routes = [];
const route = (method, pattern, handler, { auth = true } = {}) =>
    routes.push({ method, pattern, handler, auth });

route('GET', /^\/healthz$/, async (req, res) => sendJson(res, 200, { ok: true }), { auth: false });

// True when this request reached the panel through a reverse proxy rather than
// on the panel's own port. Our nginx vhost sets X-Forwarded-* headers on the way
// through; a browser hitting http://localhost:GUI_PORT directly sets none. It
// matters for one thing: stopping the proxy from a request that arrived through
// it tears down the route carrying the reply, so the page hangs on "Stopping..."
// forever. The panel warns first, and needs to know when to.
const reachedViaProxy = (req) =>
    Boolean(req.headers['x-forwarded-for'] || req.headers['x-forwarded-proto'] || req.headers['x-forwarded-host']);

// The panel's own address, bypassing any proxy -- where to send someone so they
// can turn the proxy back on after stopping it. GUI_PORT is the port compose
// published this container on.
const panelDirectUrl = () => `http://localhost:${process.env.GUI_PORT || '8080'}`;

route(
    'GET',
    /^\/api\/session$/,
    async (req, res) =>
        sendJson(res, 200, {
            // A password is always required (KQS-001). `needsSetup`: none is set
            // yet, so the panel shows only its set-password screen.
            required: true,
            needsSetup: !authConfigured(),
            authenticated: authConfigured() && isAuthenticated(req),
            // A stored hash that cannot be verified would otherwise present as
            // "your password is wrong", forever.
            passwordUnusable: passwordUnusable(),
            panelVersion: PANEL_VERSION,
            // So the UI can warn before stopping the proxy would disconnect it.
            viaProxy: reachedViaProxy(req),
            directUrl: panelDirectUrl(),
        }),
    { auth: false },
);

route(
    'POST',
    /^\/api\/login$/,
    async (req, res) => {
        const body = await readBody(req);
        if (!authConfigured()) return fail(res, 409, 'No password is set yet. Set one first.');
        // Throttled (KQS-005): 5 wrong tries lock this client out for a minute.
        const key = clientKey(req);
        const wait = loginBlockedFor(key);
        if (wait) return fail(res, 429, `Too many wrong passwords. Try again in ${wait} s.`);
        const ok = await withLoginSlot(() => verifyPasswordAsync(String(body.password ?? '')));
        if (ok === null) return fail(res, 429, 'Busy checking other sign-ins. Try again in a moment.');
        if (!ok) {
            recordLoginFailure(key);
            // Constant-ish delay so the endpoint is not a fast password oracle.
            await new Promise((r) => setTimeout(r, 500));
            return fail(res, 401, 'Incorrect password.');
        }
        recordLoginSuccess(key);
        const { token } = issueSession();
        const secure = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
        sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(token, { secure }) });
    },
    { auth: false },
);

route('POST', /^\/api\/logout$/, async (req, res) => sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearCookie() }), {
    auth: false,
});

// The machine, not the node: disk, memory, and which containers are up. Kept
// off /api/status because that one is polled constantly by every screen, and
// this walks the filesystem and shells out to the daemon. The Overview page
// polls it on its own, only while it is on screen.
route('GET', /^\/api\/host$/, async (req, res) => {
    sendJson(res, 200, await host.snapshot());
});

route('GET', /^\/api\/status$/, async (req, res) => {
    const cfg = loadNodeConfig();
    const [state, snapshot, version, published, disk, breakdown] = await Promise.all([
        dockerctl.containerState(dockerctl.KASPAD_CONTAINER),
        nodeSnapshot(),
        updater.runningVersion(),
        dockerctl.publishedPorts(dockerctl.KASPAD_CONTAINER),
        dockerctl.diskUsage(),
        // Exact bytes, split into the part pruning drops and the part it does not.
        dockerctl.dataBreakdown(),
    ]);

    const peers = Array.isArray(snapshot.peers?.peerInfo) ? snapshot.peers.peerInfo : [];
    const inbound = peers.filter((p) => p.isOutbound === false).length;

    sendJson(res, 200, {
        container: state,
        rpc: {
            reachable: snapshot.reachable,
            error: snapshot.error,
            info: snapshot.info,
            dag: snapshot.dag,
            synced: snapshot.sync?.isSynced ?? snapshot.info?.isSynced ?? null,
        },
        // Reconstructed from kaspad's log: RPC reports blockCount 0 for the
        // whole header and UTXO-set phases, so it cannot answer "how far along".
        sync: syncProgress.snapshot({
            synced: Boolean(snapshot.sync?.isSynced ?? snapshot.info?.isSynced ?? false),
        }),
        peers: { total: peers.length, inbound, outbound: peers.length - inbound },
        // Inbound peers are the honest signal that the P2P port is reachable
        // from the internet: nobody can dial in if it is closed.
        p2pReachable: peers.length ? inbound > 0 : null,
        // Drives whether the panel unlocks Mining and KaChat.
        ready: state.running && snapshot.reachable && Boolean(snapshot.sync?.isSynced ?? snapshot.info?.isSynced ?? false),
        bootId: BOOT_ID,
        version,
        network: cfg.network,
        ports: ports(cfg),
        publicPorts: publicPorts(cfg),
        portMatrix: portMatrix(cfg, nodeSiblings()),
        published,
        disk,
        // The volume split by what is in it. The UTXO index is worth showing on
        // its own because it is the part pruning never touches, so it explains
        // why the total does not drop as far as someone might expect.
        dataSplit: breakdown && {
            consensusBytes: breakdown.consensus ?? null,
            utxoindexBytes: breakdown.utxoindex ?? null,
        },
        // When the node next throws away old block data, and what the last one
        // did to the volume.
        pruning: pruning.pruningStatus({
            network: cfg.network,
            sinkBlueScore: Number(snapshot.sinkBlueScore?.blueScore ?? NaN),
            pruningPointHash: snapshot.dag?.pruningPointHash ?? null,
            pruningPointBlueScore: Number(snapshot.pruningPointBlueScore ?? NaN),
            consensusBytes: breakdown?.consensus ?? null,
            blockCount: Number(snapshot.dag?.blockCount ?? NaN),
            synced: Boolean(snapshot.sync?.isSynced ?? snapshot.info?.isSynced ?? false),
        }),
        job: jobs.snapshot(),
    });
});

route('GET', /^\/api\/update\/releases$/, async (req, res, match, url) => {
    try {
        sendJson(res, 200, { releases: await updater.listReleases({ force: url.searchParams.get('force') === '1' }) });
    } catch (err) {
        fail(res, 502, err.message);
    }
});

route('GET', /^\/api\/config$/, async (req, res) => {
    const cfg = loadNodeConfig();
    sendJson(res, 200, {
        config: cfg,
        networks: Object.fromEntries(Object.entries(NETWORKS).map(([k, v]) => [k, { ...v }])),
        argsPreview: ['--appdir=/data', '--yes', '--utxoindex', ...buildArgs(cfg)],
        locked: {
            utxoindex: 'Always enabled by the container entrypoint.',
            json: 'wRPC JSON always listens inside the stack; the toggle only publishes it to the host.',
        },
    });
});

route('PUT', /^\/api\/config$/, async (req, res) => {
    const body = await readBody(req);
    const { cfg, errors } = sanitizeNodeConfig(body.config ?? {});
    if (errors.length) return fail(res, 400, 'The configuration has problems.', { details: errors });

    saveNodeConfig(cfg);
    const job = jobs.start('Apply node configuration', (onLine) => applyNodeConfig(cfg, onLine));
    // The auto-follow flag may have just changed; (re)arm the watcher to match.
    scheduleExternalIpWatch(log);
    sendJson(res, 202, { ok: true, jobId: job.id, config: cfg });
});

// ---- KaChat automatic backup (Export/Import tab) --------------------------------
// One combined, importable file per run (KaPosts DB + full chat store), written nightly at
// 00:00 server time to an operator-chosen host path via a docker helper (see lib/backup.js).
route('GET', /^\/api\/kachat\/backup$/, async (req, res) => {
    sendJson(res, 200, backup.status());
});

// Mounted drives/folders on the host, so the UI can offer a pick-list (no manual path typing).
route('GET', /^\/api\/kachat\/backup\/drives$/, async (req, res) => {
    sendJson(res, 200, { drives: await backup.listDrives() });
});

route('PUT', /^\/api\/kachat\/backup$/, async (req, res) => {
    const body = await readBody(req);
    const enabled = !!body.enabled;
    const dest = typeof body.dest === 'string' ? body.dest.trim() : '';
    const keep = Math.max(1, Math.min(365, Number(body.keep) || 14));
    if (enabled && !dest) return fail(res, 400, 'Choose a destination folder for the backups.');
    if (dest && !dest.startsWith('/')) {
        return fail(res, 400, 'Destination must be an absolute host path, e.g. /media/you/drive/kachat-backups.');
    }
    backup.saveConfig({ enabled, dest, keep });
    backup.scheduleBackup(log);
    sendJson(res, 200, backup.status());
});

route('POST', /^\/api\/kachat\/backup\/run$/, async (req, res) => {
    const cfg = backup.loadConfig();
    if (!cfg.dest) return fail(res, 400, 'Set and save a destination folder first.');
    // Fire-and-forget: a full backup can take a while; the UI polls GET /api/kachat/backup.
    backup.runBackup(log).catch((e) => log(`[backup] ${e.message}`));
    sendJson(res, 202, { started: true });
});

route('POST', /^\/api\/kachat\/backup\/restore$/, async (req, res) => {
    const body = await readBody(req);
    const filePath = typeof body.path === 'string' ? body.path.trim() : '';
    if (!filePath.startsWith('/')) {
        return fail(res, 400, 'Give the absolute host path to a kachat-backup-*.tar.gz file.');
    }
    try {
        const result = await backup.restoreBackup(filePath, log);
        sendJson(res, 200, result);
    } catch (e) {
        fail(res, 500, `Restore failed: ${e.message}`);
    }
});

/** This connection's public address, for the "Use current IP" button. */
route('GET', /^\/api\/node\/external-ip$/, async (req, res) => {
    const ip = await duckdns.publicIp();
    if (!ip) return fail(res, 502, 'Could not work out this connection\'s public address.');
    sendJson(res, 200, { ip });
});

/** The handful of settings the "How to go public" wizard switches on. */
route('GET', /^\/api\/node\/go-public$/, async (req, res) => {
    const cfg = loadNodeConfig();
    const lan = await network.primaryLanAddress().catch(() => null);
    sendJson(res, 200, {
        port: ports(cfg).p2p,
        p2pPublic: cfg.expose.p2p === 'public',
        externalip: cfg.peering.externalip || '',
        externalipAuto: Boolean(cfg.peering.externalipAuto),
        lan: lan?.ip ?? null,
    });
});

/**
 * Keeps the address kaspad advertises to peers in step with a changing
 * connection -- dynamic DNS for --externalip.
 *
 * Off unless the node asks for it. When on, it rechecks the public address on a
 * timer and, only when it has actually changed, rewrites externalip and
 * restarts the node. The restart is real work, so it runs through the job
 * console like any other node change, and the "only on change" guard is what
 * stops it bouncing the node every quarter hour for nothing.
 */
let externalIpTimer = null;
const EXTERNAL_IP_INTERVAL_MS = 15 * 60_000;

function scheduleExternalIpWatch(log = () => {}) {
    if (externalIpTimer) clearInterval(externalIpTimer);
    externalIpTimer = null;
    if (!loadNodeConfig().peering?.externalipAuto) return;

    const tick = async () => {
        const cfg = loadNodeConfig();
        if (!cfg.peering?.externalipAuto) return;
        const ip = await duckdns.publicIp().catch(() => null);
        if (!ip || ip === cfg.peering.externalip) return;
        // Something else is mid-job. Persist nothing and leave the difference in
        // place, so the next tick sees it still needs doing and retries.
        if (jobs.busy) return;

        const was = cfg.peering.externalip || '(none)';
        cfg.peering.externalip = ip;
        saveNodeConfig(cfg);
        jobs.start(`External IP changed (${was} → ${ip}) — updating the node`, (onLine) => applyNodeConfig(cfg, onLine));
        log(`external-ip: ${was} -> ${ip}`);
    };

    externalIpTimer = setInterval(() => tick().catch(() => {}), EXTERNAL_IP_INTERVAL_MS);
    externalIpTimer.unref?.();
    tick().catch(() => {}); // once now, so enabling it takes effect immediately
}

route('POST', /^\/api\/ports\/(p2p|grpc|borsh|json)$/, async (req, res, match) => {
    const key = match[1];
    const body = await readBody(req);
    const wanted = {
        local: typeof body.local === 'boolean' ? body.local : undefined,
        public: typeof body.public === 'boolean' ? body.public : undefined,
    };
    if (wanted.local === undefined && wanted.public === undefined) {
        return fail(res, 400, 'Send local and/or public as booleans.');
    }

    const cfg = loadNodeConfig();
    const before = portMatrix(cfg).find((e) => e.key === key);

    // No refusal needed for a port a sibling depends on: turning it off here
    // only unpublishes the host mapping. The in-container listener the bridge
    // or indexer speaks to follows what needs it, so it stays bound regardless.
    const changes = setPortState(cfg, key, wanted);
    if (!changes.length) return sendJson(res, 200, { ok: true, unchanged: true });

    saveNodeConfig(cfg);
    const job = jobs.start(`${before.name} (${before.port})`, (onLine) => {
        for (const change of changes) onLine(change);
        return applyNodeConfig(cfg, onLine);
    });
    sendJson(res, 202, { ok: true, jobId: job.id, changes });
});

// Testnet-10 node ports: its own config (conf/node-testnet.json) and override
// (conf/ports-testnet.yml), so the Testnet view's Ports table never touches -- or
// restarts -- the mainnet node.
const KASPAD_TESTNET_CONTAINER = 'kaspa-node-kaspad-testnet';
// The Testnet view's Kaspad tab: the testnet node's own status and settings.
// Nothing here reads or writes the mainnet node.
const testnetRpcUrl = (cfg = loadTestnetNodeConfig()) => `ws://kaspad-testnet:${ports(cfg).json}`;
// The testnet node's own log-reconstructed sync progress (RPC reports blockCount 0 for the
// whole header and UTXO-set phases, so blocks/headers would sit at 0%).
const testnetSync = createSyncTracker('kaspa-node-kaspad-testnet');
let testnetStartedAt = null;

route('GET', /^\/api\/status-testnet$/, async (req, res) => {
    const cfg = loadTestnetNodeConfig();
    rpcTestnet.setUrl(testnetRpcUrl(cfg));
    const [state, snapshot, published] = await Promise.all([
        dockerctl.containerState(KASPAD_TESTNET_CONTAINER),
        nodeSnapshot(rpcTestnet),
        dockerctl.publishedPorts(KASPAD_TESTNET_CONTAINER).catch(() => []),
    ]);
    const synced = Boolean(snapshot.sync?.isSynced ?? snapshot.info?.isSynced ?? false);
    const dag = snapshot.dag;
    // A recreated testnet node starts a fresh sync session.
    if (state.startedAt && state.startedAt !== testnetStartedAt) {
        if (testnetStartedAt !== null) testnetSync.reset();
        testnetStartedAt = state.startedAt;
    }
    const peers = Array.isArray(snapshot.peers?.peerInfo) ? snapshot.peers.peerInfo : [];
    const inbound = peers.filter((p) => p.isOutbound === false).length;
    sendJson(res, 200, {
        testnet: true,
        container: state,
        rpc: { reachable: snapshot.reachable, error: snapshot.error, info: snapshot.info, dag, synced },
        sync: testnetSync.snapshot({ synced }),
        peers: { total: peers.length, inbound, outbound: peers.length - inbound },
        p2pReachable: peers.length ? inbound > 0 : null,
        ready: state.running && snapshot.reachable && synced,
        bootId: BOOT_ID,
        version: { version: snapshot.info?.serverVersion ?? null },
        network: cfg.network,
        ports: ports(cfg),
        portMatrix: portMatrix(cfg, { indexer: true }),
        published,
        disk: null,
        dataSplit: null,
        pruning: null,
    });
});

route('GET', /^\/api\/config-testnet$/, async (req, res) => {
    const cfg = loadTestnetNodeConfig();
    sendJson(res, 200, {
        config: cfg,
        networks: { 'testnet-10': { ...NETWORKS['testnet-10'] } },
        argsPreview: ['--appdir=/data', '--yes', '--utxoindex', ...buildArgs(cfg, { indexer: true })],
        testnet: true,
    });
});

route('PUT', /^\/api\/config-testnet$/, async (req, res) => {
    const body = await readBody(req);
    // Same validation as mainnet, pinned to testnet-10 whatever the form sent.
    const { cfg, errors } = sanitizeNodeConfig({ ...(body.config ?? {}), network: 'testnet-10' });
    if (errors.length) return fail(res, 400, 'The configuration has problems.', { details: errors });
    // Published ports are managed from the Ports table; keep them.
    cfg.expose = loadTestnetNodeConfig().expose ?? cfg.expose;
    saveTestnetNodeConfig(cfg);
    const job = jobs.start('Apply testnet node configuration', async (onLine) => {
        const args = writeTestnetArgsFile(cfg);
        renderTestnetPortsOverride(cfg);
        onLine(`kaspad (testnet) arguments: ${args.join(' ')}`);
        const state = await lifecycle.status('node-testnet').catch(() => null);
        if (state?.running) {
            onLine('Recreating the testnet node with the new settings.');
            await lifecycle.setRunning('node-testnet', true, onLine);
        } else {
            onLine('The testnet node is not running; the settings apply when it starts.');
        }
    });
    sendJson(res, 202, { ok: true, jobId: job.id, config: cfg });
});

route('GET', /^\/api\/ports-testnet$/, async (req, res) => {
    const cfg = loadTestnetNodeConfig();
    const published = await dockerctl.publishedPorts(KASPAD_TESTNET_CONTAINER).catch(() => []);
    // The testnet indexer always dials wRPC Borsh, so that listener stays bound.
    sendJson(res, 200, { network: cfg.network, portMatrix: portMatrix(cfg, { indexer: true }), published });
});

route('POST', /^\/api\/ports-testnet\/(p2p|grpc|borsh|json)$/, async (req, res, match) => {
    const key = match[1];
    const body = await readBody(req);
    const wanted = {
        local: typeof body.local === 'boolean' ? body.local : undefined,
        public: typeof body.public === 'boolean' ? body.public : undefined,
    };
    if (wanted.local === undefined && wanted.public === undefined) {
        return fail(res, 400, 'Send local and/or public as booleans.');
    }
    const cfg = loadTestnetNodeConfig();
    const before = portMatrix(cfg).find((e) => e.key === key);
    const changes = setPortState(cfg, key, wanted);
    if (!changes.length) return sendJson(res, 200, { ok: true, unchanged: true });

    saveTestnetNodeConfig(cfg);
    const job = jobs.start(`Testnet ${before.name} (${before.port})`, async (onLine) => {
        for (const change of changes) onLine(change);
        renderTestnetPortsOverride(cfg);
        const state = await lifecycle.status('node-testnet').catch(() => null);
        if (state?.running) {
            onLine('Recreating the testnet node with the new ports.');
            await lifecycle.setRunning('node-testnet', true, onLine);
        } else {
            onLine('The testnet node is not running; the ports apply when it starts.');
        }
    });
    sendJson(res, 202, { ok: true, jobId: job.id, changes });
});

route('POST', /^\/api\/node\/(start|stop|restart)$/, async (req, res, match) => {
    const action = match[1];
    const job = jobs.start(`${action} node`, async (onLine) => {
        if (action === 'start') {
            await dockerctl.compose(['up', '-d', KASPAD_SERVICE], { onLine });
            // It has just been created from the arguments file as it stands, so
            // record that. Otherwise the next manager restart reads drift that
            // is not there and recreates a node the user only just started.
            recordAppliedArgs();
            syncProgress.reset();
        } else if (action === 'stop') await dockerctl.compose(['stop', KASPAD_SERVICE], { onLine, timeoutMs: 5 * 60_000 });
        else await dockerctl.compose(['restart', KASPAD_SERVICE], { onLine, timeoutMs: 5 * 60_000 });
    });
    sendJson(res, 202, { ok: true, jobId: job.id });
});

/**
 * The log source `?container=` names: any key from dockerctl.LOG_SOURCES (a
 * container, or a container plus a line filter), or the panel-update sidecar.
 * Anything else is kaspad, as it always was.
 */
const KASPAD_SOURCE = { key: 'kaspad', label: 'kaspad', name: dockerctl.KASPAD_CONTAINER };
const sourceFor = (url) => {
    const key = url.searchParams.get('container');
    // The detached sidecar that rebuilds the panel, so its progress can be
    // streamed into the update overlay while it runs.
    if (key === 'panel-update') return { key, label: 'panel update', name: 'kaspa-node-panel-update' };
    return dockerctl.logSource(key) ?? KASPAD_SOURCE;
};

route('GET', /^\/api\/logs$/, async (req, res, match, url) => {
    const tail = Math.min(Number(url.searchParams.get('tail')) || 300, 5000);
    const source = sourceFor(url);
    if (source.match) return sendJson(res, 200, { text: await dockerctl.filteredLogs(source, tail) });
    sendJson(res, 200, { text: await dockerctl.logs(source.name, tail) });
});

route('GET', /^\/api\/logs\/stream$/, async (req, res, match, url) => {
    const { send, onClose } = sse(req, res);
    const source = sourceFor(url);
    // A source whose container is not there says so, instead of an empty box.
    // (The sidecar is exempt: the update overlay opens this just before it starts.)
    if (source.key !== 'panel-update' && !(await dockerctl.containerState(source.name)).exists) {
        send('line', { line: `[panel] ${source.label} is not installed on this machine, so it has no log yet.` });
        return onClose(() => {});
    }
    // A filtered source reads a deep backlog: its lines are a small share of the container's.
    const stop = dockerctl.streamLogs(source.name, dockerctl.filterFor(source, (line) => send('line', { line })), {
        ...(source.match ? { tail: 3000 } : {}),
    });
    onClose(stop);
});

route('GET', /^\/api\/logs\/containers$/, async (req, res) => {
    const rows = await Promise.all(
        dockerctl.LOG_SOURCES.map(async (c) => ({ ...c, state: await dockerctl.containerState(c.name) })),
    );
    sendJson(res, 200, { containers: rows.filter((c) => c.state.exists) });
});

/**
 * One stream carrying every container's log, tagged by container.
 *
 * Deliberately multiplexed rather than one EventSource per tile: browsers allow
 * only about six concurrent HTTP/1.1 connections per origin, so a tile each
 * would consume the entire budget and stall the status polling that drives the
 * rest of the panel.
 */
/**
 * Every container's log at once, and it keeps up with the stack.
 *
 * What is on the machine changes while somebody is watching this page:
 * installing creates a container, a switch starts one, uninstalling takes one
 * away. The set used to be read once, when the page connected -- so a container
 * that appeared afterwards never got a tile, and one that restarted went quiet
 * for good, because `docker logs --follow` ends when its container does and
 * nothing reattached. Rescanned every few seconds instead.
 */
route('GET', /^\/api\/logs\/stream-all$/, async (req, res) => {
    const { send, onClose } = sse(req, res);

    // Keyed by source, not container: one container can feed two tiles (the full
    // testnet indexer log and its filtered .kachat names lines).
    const followers = new Map(); // source key -> { stop, startedAt }
    let listed = null;
    let closed = false;

    const detach = (key) => {
        const follower = followers.get(key);
        if (!follower) return;
        followers.delete(key);
        try {
            follower.stop();
        } catch {
            /* already exited */
        }
    };

    const scan = async () => {
        if (closed) return;

        const present = [];
        for (const c of dockerctl.LOG_SOURCES) {
            const state = await dockerctl.containerState(c.name);
            if (state.exists) present.push({ ...c, state });
        }

        // The browser rebuilds every tile when this arrives, losing what is in
        // them, so it is sent when the set itself changed and not on every scan.
        const signature = present.map((c) => `${c.key}:${c.state.running ? 1 : 0}`).join(',');
        if (signature !== listed) {
            listed = signature;
            send('containers', {
                containers: present.map(({ key, label, name, state }) => ({
                    key,
                    label,
                    name,
                    running: state.running,
                })),
            });
        }

        const keys = new Set(present.map((c) => c.key));
        for (const key of [...followers.keys()]) if (!keys.has(key)) detach(key);

        for (const c of present) {
            const follower = followers.get(c.key);
            // startedAt is what tells one run of a container from the next, and
            // a new run means the old `docker logs` has already exited.
            if (follower && follower.startedAt === c.state.startedAt) continue;
            detach(c.key);
            followers.set(c.key, {
                startedAt: c.state.startedAt,
                // A filtered source reads deeper: its lines are a small share of the container's.
                stop: dockerctl.streamLogs(c.name, dockerctl.filterFor(c, (line) => send('line', { key: c.key, line })), {
                    tail: c.match ? 3000 : 60,
                }),
            });
        }
    };

    await scan();
    const timer = setInterval(() => scan().catch(() => {}), 5000);
    onClose(() => {
        closed = true;
        clearInterval(timer);
        for (const key of [...followers.keys()]) detach(key);
    });
});

route('GET', /^\/api\/jobs\/stream$/, async (req, res) => {
    const { send, onClose } = sse(req, res);
    const snapshot = jobs.snapshot();
    if (snapshot) send('snapshot', snapshot);
    const onLine = (e) => send('line', e);
    const onStart = (job) => send('start', { id: job.id, name: job.name, pending: jobs.pending });
    const onEnd = (job) => send('end', { id: job.id, name: job.name, status: job.status, error: job.error, pending: jobs.pending });
    // Asked for but not started. Without this the browser has no way to show
    // that a second request was accepted rather than swallowed.
    const onQueued = (job) => send('queued', job);
    jobs.on('line', onLine);
    jobs.on('start', onStart);
    jobs.on('end', onEnd);
    jobs.on('queued', onQueued);
    onClose(() => {
        jobs.off('line', onLine);
        jobs.off('start', onStart);
        jobs.off('end', onEnd);
        jobs.off('queued', onQueued);
    });
});

route('GET', /^\/api\/jobs\/current$/, async (req, res) => sendJson(res, 200, { job: jobs.snapshot(), busy: jobs.busy }));

/**
 * Stop a job. What it had already done stays done -- the overlay says so before
 * it asks -- and the next job in the queue starts as soon as this one lets go.
 */
route('POST', /^\/api\/jobs\/([a-z0-9-]+)\/cancel$/, async (req, res, match) => {
    const result = jobs.cancel(match[1]);
    if (!result.cancelled) return fail(res, 409, result.reason ?? 'That job cannot be cancelled.');
    sendJson(res, 202, { ok: true, ...result });
});

// ------------------------------------------------------------------ updates --

route('GET', /^\/api\/update\/check$/, async (req, res, match, url) => {
    const includePrereleases = url.searchParams.get('prereleases') === '1';
    // ?net=testnet compares against the testnet-10 node's own version.
    const testnet = url.searchParams.get('net') === 'testnet';
    try {
        sendJson(res, 200, await updater.checkLatest({ includePrereleases, testnet }));
    } catch (err) {
        fail(res, 502, err.message);
    }
});

route('POST', /^\/api\/update\/apply$/, async (req, res) => {
    const body = await readBody(req);
    let version = String(body.version || '').trim();
    // `testnet: true` updates only the testnet-10 node (its own version pin).
    const testnet = body.testnet === true;

    // Never install a version the user pasted without confirming it exists
    // upstream; this is the one place the stack pulls code from the internet.
    let info;
    let releases;
    try {
        info = await updater.checkLatest({ includePrereleases: Boolean(body.includePrereleases), testnet });
        releases = await updater.listReleases();
    } catch (err) {
        return fail(res, 502, `Cannot reach GitHub to verify the release: ${err.message}`);
    }
    if (!version) version = info.latest;
    // Any published release may be installed -- newer, older (pinning back) or a
    // prerelease (testnet runs Toccata builds) -- but only one that exists upstream.
    if (version !== info.latest && !releases.some((r) => r.tag === version)) {
        return fail(res, 400, `${version} is not a release of ${info.repo}.`);
    }
    if (info.current && version === info.latest && updater.compareVersions(info.current, version) >= 0) {
        return sendJson(res, 200, { ok: true, alreadyCurrent: true, version });
    }

    const job = jobs.start(`Update ${testnet ? 'the testnet kaspad' : 'kaspad'} to ${version}`, (onLine) =>
        updater.applyUpdate(version, onLine, { testnet }),
    );
    sendJson(res, 202, { ok: true, jobId: job.id, version });
});

// ------------------------------------------------------------------ proxies --

route('GET', /^\/api\/proxies$/, async (req, res) => {
    const list = loadProxies().map((p) => ({
        ...p,
        auth: p.auth ? { ...p.auth, htpasswd: undefined, hasPassword: Boolean(p.auth.htpasswd) } : undefined,
        certificate: nginx.hasCertificate(p.domain),
    }));
    sendJson(res, 200, {
        proxies: list,
        targets: nginx.TARGET_KINDS,
        enabled: proxyEnabled(),
        container: await dockerctl.containerState(dockerctl.PROXY_CONTAINER),
    });
});

async function saveProxyList(list, cfg, onLine) {
    saveProxies(list);
    nginx.writeAll(list, cfg, renderOptions());
    // With the proxy off the files are still written, so switching it on later
    // brings up everything that was configured meanwhile.
    if (!proxyEnabled()) return;
    await nginx.reload();
    onLine?.('Reverse proxy reloaded.');
}

route('POST', /^\/api\/proxies$/, async (req, res) => {
    const body = await readBody(req);
    const list = loadProxies();
    const proxy = {
        enabled: true,
        websocket: true,
        allowlist: [],
        rateLimit: null,
        customSnippet: '',
        ...body.proxy,
        // Assigned after the spread so a client cannot choose its own id.
        id: nginx.newId(),
        domain: String(body.proxy?.domain || '').trim().toLowerCase(),
    };

    const errors = nginx.validateProxy(proxy, { existing: list, panelHasPassword: authConfigured() });
    if (errors.length) return fail(res, 400, 'The proxy host has problems.', { details: errors });

    nginx.storeBasicAuth(proxy);
    list.push(proxy);

    try {
        await saveProxyList(list, loadNodeConfig());
    } catch (err) {
        // Roll back so a config nginx rejects never stays on disk.
        saveProxies(list.filter((p) => p.id !== proxy.id));
        nginx.writeAll(loadProxies(), loadNodeConfig(), renderOptions());
        return fail(res, 400, `nginx rejected the configuration: ${err.message}`);
    }
    sendJson(res, 201, { ok: true, proxy: { ...proxy, auth: undefined } });
});

route('PUT', /^\/api\/proxies\/([a-f0-9]{12})$/, async (req, res, match) => {
    const body = await readBody(req);
    const list = loadProxies();
    const index = list.findIndex((p) => p.id === match[1]);
    if (index < 0) return fail(res, 404, 'No such proxy host.');

    const previous = list[index];
    const proxy = {
        ...previous,
        ...body.proxy,
        id: previous.id,
        domain: String(body.proxy?.domain ?? previous.domain).trim().toLowerCase(),
        auth: { ...previous.auth, ...body.proxy?.auth },
    };

    const errors = nginx.validateProxy(proxy, { existing: list, panelHasPassword: authConfigured() });
    if (errors.length) return fail(res, 400, 'The proxy host has problems.', { details: errors });

    nginx.storeBasicAuth(proxy);
    list[index] = proxy;

    try {
        await saveProxyList(list, loadNodeConfig());
    } catch (err) {
        list[index] = previous;
        saveProxies(list);
        nginx.writeAll(list, loadNodeConfig(), renderOptions());
        return fail(res, 400, `nginx rejected the configuration: ${err.message}`);
    }
    sendJson(res, 200, { ok: true, proxy: { ...proxy, auth: undefined } });
});

route('DELETE', /^\/api\/proxies\/([a-f0-9]{12})$/, async (req, res, match) => {
    const list = loadProxies();
    const next = list.filter((p) => p.id !== match[1]);
    if (next.length === list.length) return fail(res, 404, 'No such proxy host.');
    await saveProxyList(next, loadNodeConfig());
    sendJson(res, 200, { ok: true });
});

route('POST', /^\/api\/proxies\/([a-f0-9]{12})\/certificate$/, async (req, res, match) => {
    const body = await readBody(req);
    const list = loadProxies();
    const proxy = list.find((p) => p.id === match[1]);
    if (!proxy) return fail(res, 404, 'No such proxy host.');

    const email = String(body.email || proxy.ssl?.email || '').trim();
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail(res, 400, `"${email}" is not an e-mail address.`);
    // Let's Encrypt proves the domain by fetching a file over port 80, which
    // nginx serves. Without it running the request can only fail.
    if (!proxyEnabled()) {
        return fail(res, 409, 'Turn the reverse proxy on first.', {
            details: ["Certificates are issued by answering a request on port 80, which needs the proxy running."],
        });
    }

    const job = jobs.start(`Issue certificate for ${proxy.domain}`, async (onLine) => {
        const viaDns = duckdnsFor(proxy.domain);
        onLine(`Requesting a certificate for ${viaDns?.wildcard ?? proxy.domain} from Let's Encrypt.`);
        onLine(
            viaDns
                ? 'Proving the name with a DuckDNS TXT record, so no ports need to be open.'
                : 'This needs port 80 reachable from the internet for that domain.',
        );
        await certbot.issue(proxy.domain, email, {
            staging: Boolean(body.staging),
            onLine,
            duckdns: viaDns,
        });

        const current = loadProxies();
        const target = current.find((p) => p.id === proxy.id);
        if (target) {
            target.ssl = { ...target.ssl, mode: 'letsencrypt', email, forceHttps: target.ssl?.forceHttps !== false };
            saveProxies(current);
            nginx.writeAll(current, loadNodeConfig(), renderOptions());
            await nginx.reload();
            onLine('HTTPS is now enabled for this host.');
        }
    });
    sendJson(res, 202, { ok: true, jobId: job.id });
});

route('POST', /^\/api\/proxy\/enabled$/, async (req, res) => {
    const body = await readBody(req);
    const enabled = Boolean(body.enabled);
    if (enabled === proxyEnabled()) return sendJson(res, 200, { ok: true, unchanged: true });

    const job = jobs.start(enabled ? 'Start reverse proxy' : 'Stop reverse proxy', (onLine) =>
        applyProxyState(enabled, onLine),
    );
    sendJson(res, 202, { ok: true, jobId: job.id });
});

/**
 * Whether 80 and 443 actually reach this machine from the internet.
 *
 * Deliberately not run on page load: it asks a third party to connect back, so
 * it happens when somebody presses the button and not before.
 */
/**
 * The ports the outside world reaches this machine on, which a router decides
 * and nginx cannot know. Saved rather than detected: the check can tell you
 * whether a port arrives, but not which one a visitor should type.
 */
route('POST', /^\/api\/proxy\/ports$/, async (req, res) => {
    const body = await readBody(req);
    const port = (value, fallback) => {
        const n = Number(value);
        return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : fallback;
    };

    const env = readEnvFile();
    const bindHttp = port(body.bindHttp, Number(env.HTTP_PORT) || 80);
    const bindHttps = port(body.bindHttps, Number(env.HTTPS_PORT) || 443);
    const guiPort = Number(env.GUI_PORT) || 8080;

    // Docker accepts the mapping and then fails to start the container, so the
    // clash is caught here where it can be explained. The panel's own port is
    // the one that bites: 8080 is both a common panel default and the first
    // port anyone reaches for as an alternative to 80.
    if (bindHttp === guiPort || bindHttps === guiPort) {
        return fail(res, 409, `Port ${guiPort} is this panel's own port, so the proxy cannot take it.`, {
            details: ['Move the panel first, under Global settings, or give the proxy a different port.'],
        });
    }
    if (bindHttp === bindHttps) return fail(res, 400, 'http and https cannot share one port on this machine.');

    const cfg = loadManagerConfig();
    cfg.proxy.publicHttpPort = port(body.http, 80);
    cfg.proxy.publicHttpsPort = port(body.https, 443);
    saveManagerConfig(cfg);

    const rebind = bindHttp !== (Number(env.HTTP_PORT) || 80) || bindHttps !== (Number(env.HTTPS_PORT) || 443);
    if (rebind) updateEnvFile({ HTTP_PORT: String(bindHttp), HTTPS_PORT: String(bindHttps) });

    // Redirects embed the https port, so every vhost is rewritten.
    nginx.writeAll(loadProxies(), loadNodeConfig(), renderOptions());

    if (rebind && proxyEnabled()) {
        // A published port is fixed when a container is created, so this is a
        // recreate rather than a reload. Only the proxy changes; the node and
        // every app keep running.
        const job = jobs.start(`Move the proxy to ports ${bindHttp} and ${bindHttps}`, async (onLine) => {
            onLine(`Recreating the reverse proxy on ports ${bindHttp} and ${bindHttps}.`);
            await dockerctl.compose(['up', '-d', '--force-recreate', 'proxy'], {
                onLine,
                profile: 'proxy',
                timeoutMs: 5 * 60_000,
            });
        });
        return sendJson(res, 202, {
            ok: true,
            jobId: job.id,
            http: cfg.proxy.publicHttpPort,
            https: cfg.proxy.publicHttpsPort,
            bindHttp,
            bindHttps,
        });
    }

    if (proxyEnabled()) await nginx.reload().catch(() => {});
    sendJson(res, 200, { ok: true, http: cfg.proxy.publicHttpPort, https: cfg.proxy.publicHttpsPort, bindHttp, bindHttps });
});

/**
 * Moves the panel itself to another port.
 *
 * Same shape as setting a password: .env holds it, the container reads it when
 * it is created, so a sidecar recreates this container a moment after the
 * answer goes out. The browser has to be told where to look next, because the
 * address it is on stops working.
 */
route('POST', /^\/api\/panel\/port$/, async (req, res) => {
    const body = await readBody(req);
    const wanted = Number(body.port);
    if (!Number.isInteger(wanted) || wanted < 1 || wanted > 65535) return fail(res, 400, 'That is not a port number.');

    const env = readEnvFile();
    if (wanted === (Number(env.HTTP_PORT) || 80) || wanted === (Number(env.HTTPS_PORT) || 443)) {
        return fail(res, 409, `Port ${wanted} belongs to the reverse proxy.`);
    }
    if (wanted === (Number(env.GUI_PORT) || 8080)) return sendJson(res, 200, { ok: true, unchanged: true });

    updateEnvFile({ GUI_PORT: String(wanted) });
    await selfservice.restartManager();
    sendJson(res, 202, { ok: true, port: wanted, restarting: true });
});

/**
 * Who can reach the panel's own port: this machine only (127.0.0.1) or other
 * machines on the network too (0.0.0.0). Opening it needs a password -- the panel
 * drives the Docker daemon. The mapping is fixed at container creation, so this
 * recreates the panel through the same sidecar as a port change.
 */
route('POST', /^\/api\/panel\/bind$/, async (req, res) => {
    const body = await readBody(req);
    const lan = body.lan === true;
    if (lan && !authConfigured()) {
        return fail(res, 409, 'Set an admin password first. The panel controls Docker, so it is never opened to the network without one.');
    }
    const wanted = lan ? '0.0.0.0' : '127.0.0.1';
    if (managerBind() === wanted) return sendJson(res, 200, { ok: true, unchanged: true, bind: wanted });
    updateEnvFile({ MANAGER_BIND: wanted });
    await selfservice.restartManager();
    sendJson(res, 202, { ok: true, restarting: true, bind: wanted });
});

route('GET', /^\/api\/proxy\/portcheck$/, async (req, res) => {
    const domain = loadDomains()[0]?.domain ?? null;
    const mgr = loadManagerConfig().proxy;
    const env = readEnvFile();
    sendJson(
        res,
        200,
        await portcheck.check(domain, {
            httpPort: mgr.publicHttpPort ?? 80,
            httpsPort: mgr.publicHttpsPort ?? 443,
            bindHttp: Number(env.HTTP_PORT) || 80,
            bindHttps: Number(env.HTTPS_PORT) || 443,
            // A DuckDNS name proves itself with a TXT record, so nothing here
            // is required for a certificate -- only for serving.
            dnsChallenge: Boolean(domain && duckdnsFor(domain)),
        }),
    );
});

route('POST', /^\/api\/proxy\/reload$/, async (req, res) => {
    if (!proxyEnabled()) return fail(res, 409, 'The reverse proxy is switched off.');
    try {
        nginx.writeAll(loadProxies(), loadNodeConfig(), renderOptions());
        await nginx.reload();
        sendJson(res, 200, { ok: true, test: await nginx.testConfig() });
    } catch (err) {
        fail(res, 400, err.message);
    }
});

route('POST', /^\/api\/proxy\/renew$/, async (req, res) => {
    const job = jobs.start('Renew certificates', async (onLine) => {
        await certbot.renew({ onLine, duckdns: anyDuckdnsCredentials() });
        await nginx.reload();
    });
    sendJson(res, 202, { ok: true, jobId: job.id });
});

// ------------------------------------------------------- domains & publishing --

/**
 * The service-first view of the reverse proxy: what can be published, what it
 * is published on, and every domain available to publish it on.
 *
 * The proxy-host endpoints below still exist and still own the detail -- basic
 * auth, allowlists, custom snippets, certificates. This is the same data asked
 * a friendlier question.
 */
route('GET', /^\/api\/publish$/, async (req, res) => {
    const proxies = loadProxies();
    sendJson(res, 200, {
        services: publish.overview({ proxies, panelHasPassword: authConfigured() }),
        domains: loadDomains().map((d) => ({
            ...d,
            certificate: nginx.hasCertificate(d.domain),
            expiry: nginx.certificateExpiry(d.domain),
            // Which services are on this name, and where. A name carries
            // several now, so the wizard shows what it would be joining.
            usedBy: proxies.find((p) => p.domain === d.domain && (p.path ?? '/') === '/')?.target?.kind ?? null,
            hosts: proxies
                .filter((p) => p.domain === d.domain)
                .map((p) => ({ kind: p.target?.kind ?? null, path: p.path ?? '/' })),
            rootFree: !proxies.some((p) => p.domain === d.domain && (p.path ?? '/') === '/'),
        })),
        enabled: proxyEnabled(),
        publicPorts: {
            http: loadManagerConfig().proxy.publicHttpPort ?? 80,
            https: loadManagerConfig().proxy.publicHttpsPort ?? 443,
            // What nginx binds here, which is what a router rule points at.
            bindHttp: Number(readEnvFile().HTTP_PORT) || 80,
            bindHttps: Number(readEnvFile().HTTPS_PORT) || 443,
            panel: Number(readEnvFile().GUI_PORT) || 8080,
            // Where the panel's port is published: 127.0.0.1 (this machine) or 0.0.0.0
            // (other machines on the network too).
            panelBind: managerBind(),
            panelLan: !isLoopbackBind(),
            hasPassword: authConfigured(),
        },
        container: await dockerctl.containerState(dockerctl.PROXY_CONTAINER),
    });
});

route('POST', /^\/api\/domains$/, async (req, res) => {
    const body = await readBody(req);
    const { domain, error } = nginx.validateDomainName(body.domain);
    if (error) return fail(res, 400, error);

    const list = loadDomains();
    if (list.some((d) => d.domain === domain)) return fail(res, 400, `${domain} is already on the list.`);

    const mode = body.ssl?.mode === 'letsencrypt' ? 'letsencrypt' : 'none';
    const email = String(body.ssl?.email || '').trim();
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail(res, 400, `"${email}" is not an e-mail address.`);

    const record = { id: nginx.newId(), domain, ssl: { mode, email }, addedAt: new Date().toISOString() };
    list.push(record);
    saveDomains(list);
    sendJson(res, 201, { ok: true, domain: record });
});

route('DELETE', /^\/api\/domains\/([a-f0-9]{12})$/, async (req, res, match) => {
    const list = loadDomains();
    const record = list.find((d) => d.id === match[1]);
    if (!record) return fail(res, 404, 'No such domain.');

    // Removing a name that something answers on would leave a vhost pointing at
    // a domain the panel no longer knows about, so the assignment goes first.
    const inUse = loadProxies().find((p) => p.domain === record.domain);
    if (inUse) {
        const service = publish.SERVICES.find((sv) => sv.kind === inUse.target?.kind);
        return fail(res, 409, `${record.domain} is still publishing ${service?.label ?? 'a proxy host'}.`, {
            details: ['Set that service back to "not published" first, then remove the domain.'],
        });
    }

    saveDomains(list.filter((d) => d.id !== record.id));
    sendJson(res, 200, { ok: true });
});

/**
 * Points a service at one of the stored domains, or at none of them.
 *
 * Everything here funnels into the same proxy-host list the advanced screen
 * edits, so a service published from this screen can be opened there and given
 * an allowlist or a password without any of it being a special case.
 */
route('POST', /^\/api\/publish\/([a-z][a-z-]*)$/, async (req, res, match) => {
    const service = publish.serviceFor(match[1]);
    if (!service) return fail(res, 404, 'No such service.');

    const body = await readBody(req);
    const wanted = body.domain ? String(body.domain).trim().toLowerCase() : null;

    const list = loadProxies();
    const index = list.findIndex((p) => p.target?.kind === service.kind);

    if (!wanted) {
        if (index < 0) return sendJson(res, 200, { ok: true, unchanged: true });
        const [removed] = list.splice(index, 1);
        await saveProxyList(list, loadNodeConfig());
        return sendJson(res, 200, { ok: true, domain: null, was: removed.domain });
    }

    const record = loadDomains().find((d) => d.domain === wanted);
    if (!record) return fail(res, 400, `${wanted} is not one of your domains.`, { details: ['Set it up from a service first.'] });

    // The domain owns the certificate settings: a certificate is issued for a
    // name, not for whatever happens to sit behind it this week.
    const ssl = { mode: record.ssl?.mode ?? 'none', email: record.ssl?.email ?? '' };
    try {
        const proxy = await attachDomain(service, wanted, ssl);
        sendJson(res, 200, { ok: true, domain: wanted, proxyId: proxy.id });
    } catch (err) {
        fail(res, 400, err.message, err.details ? { details: err.details } : undefined);
    }
});

/**
 * Attaches a domain to a service, creating the proxy host if there is not one.
 * Shared by the dropdown on the services page and by the setup wizard, so both
 * produce exactly the same proxy host.
 */
async function attachDomain(service, domain, ssl, extras = null) {
    const list = loadProxies();
    const index = list.findIndex((p) => p.target?.kind === service.kind);
    // Where it sits on that name depends on what is already there. Throws with
    // an explanation when the service can only live at a root that is taken.
    const { path } = publish.pathFor(service, domain, index >= 0 ? list.filter((_, i) => i !== index) : list);
    const proxy =
        index >= 0
            ? { ...list[index], domain, ssl, path }
            : {
                  path,
                  id: nginx.newId(),
                  enabled: true,
                  websocket: true,
                  allowlist: [],
                  rateLimit: null,
                  customSnippet: '',
                  auth: { enabled: false },
                  domain,
                  target: { kind: service.kind },
                  ssl,
              };

    // Basic auth and an allowlist used to be reachable only from the advanced
    // screen. They are the two protections worth offering at the moment someone
    // puts a service on the internet, so the wizard asks for them there and
    // passes them through here.
    if (extras) {
        if (extras.auth?.enabled) {
            proxy.auth = { enabled: true, user: extras.auth.user, password: extras.auth.password, htpasswd: proxy.auth?.htpasswd };
        } else if (extras.auth) {
            proxy.auth = { enabled: false };
        }
        if (Array.isArray(extras.allowlist)) proxy.allowlist = extras.allowlist.filter(Boolean);
    }

    const errors = nginx.validateProxy(proxy, { existing: list, panelHasPassword: authConfigured() });
    if (errors.length) {
        const err = new Error(`${service.label} cannot be published on ${domain}.`);
        err.details = errors;
        throw err;
    }

    nginx.storeBasicAuth(proxy);

    const previous = index >= 0 ? { ...list[index] } : null;
    if (index >= 0) list[index] = proxy;
    else list.push(proxy);

    try {
        await saveProxyList(list, loadNodeConfig());
    } catch (cause) {
        // Roll back so a configuration nginx rejects never stays on disk.
        const rolled = loadProxies().filter((p) => p.id !== proxy.id);
        if (previous) rolled.push(previous);
        saveProxies(rolled);
        nginx.writeAll(rolled, loadNodeConfig(), renderOptions());
        throw new Error(`nginx rejected the configuration: ${cause.message}`);
    }
    return proxy;
}

// ----------------------------------------------------------- setup wizard --

route('GET', /^\/api\/setup\/([a-z][a-z-]*)$/, async (req, res, match) => {
    const plan = publish.setupPlan(match[1], { panelHasPassword: authConfigured(), proxyOn: proxyEnabled() });
    if (!plan) return fail(res, 404, 'No such service.');

    const dd = loadManagerConfig().duckdns;
    sendJson(res, 200, {
        ...plan,
        duckdns: { subdomain: duckdns.normalizeDomains(dd.domains)[0] ?? '', hasToken: Boolean(dd.token) },
        publicIp: await duckdns.publicIp(),
    });
});

/**
 * The whole setup, done once: name, DNS, whatever the service needs switched
 * on, the vhost, and the certificate. Every step narrates itself into the job
 * console, because "it did not work" is unanswerable when the failure could
 * have been any one of six things.
 */
route('POST', /^\/api\/setup\/([a-z][a-z-]*)$/, async (req, res, match) => {
    const key = match[1];
    const plan = publish.setupPlan(key, { panelHasPassword: authConfigured(), proxyOn: proxyEnabled() });
    if (!plan) return fail(res, 404, 'No such service.');
    if (plan.blocked) return fail(res, 409, plan.blocked);

    const body = await readBody(req);

    // Two ways in: a name that already exists on this panel, or a new DuckDNS
    // one to create. Only the second needs a token, and only the second touches
    // the DNS record.
    const existing = body.domain ? loadDomains().find((d) => d.domain === String(body.domain).trim().toLowerCase()) : null;
    if (body.domain && !existing) return fail(res, 400, `${body.domain} is not one of your domains.`);

    // The name being published and the DuckDNS account behind it are no longer
    // the same thing. "mining.yournode" publishes on mining.yournode.duckdns.org
    // while the account that gets refreshed, and that holds the token, is
    // "yournode" -- a name under an account is not registered anywhere.
    const wanted = String(body.subdomain || '')
        .trim()
        .toLowerCase()
        .replace(/\.duckdns\.org\.?$/, '');
    // From the full name, not the stripped one: accountLabel treats a bare
    // "panel.kachat" as some other provider's hostname and returns nothing,
    // whereas "panel.kachat.duckdns.org" is unambiguously the account "kachat"
    // with a name in front. Publishing a prefix in front of an existing name
    // depends on getting "kachat" here, so the right account is refreshed.
    const subdomain = existing ? null : duckdns.accountLabel(`${wanted}.duckdns.org`);
    if (!existing && !/^[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63}){0,3}$/.test(wanted)) {
        return fail(res, 400, 'Enter the DuckDNS name you created, without the .duckdns.org.');
    }

    const storedToken = loadManagerConfig().duckdns.token;
    const token = String(body.token || '').trim();
    if (!existing && !token && !storedToken) return fail(res, 400, 'Enter your DuckDNS token.');

    // No contact address is asked for or required: the ACME account registers
    // without one, and the panel shows the expiry date itself.
    const email = String(body.email || existing?.ssl?.email || '').trim();
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail(res, 400, `"${email}" is not an e-mail address.`);

    const extras = {
        auth: body.auth?.enabled
            ? { enabled: true, user: String(body.auth.user || '').trim(), password: String(body.auth.password || '') }
            : { enabled: false },
        allowlist: String(body.allowlist || '')
            .split(/[\s,]+/)
            .map((entry) => entry.trim())
            .filter(Boolean),
    };

    const domain = existing ? existing.domain : `${wanted}.duckdns.org`;

    const job = jobs.start(`Publish ${plan.service.label} on ${domain}`, async (onLine) => {
        // --- the name -------------------------------------------------------
        if (existing) {
            onLine(`Using ${domain}, which is already on this panel.`);
        } else {
            onLine(`Saving ${domain} and telling DuckDNS where this machine is.`);
            if (wanted !== subdomain) {
                onLine(
                    `${domain} is a name under ${subdomain}.duckdns.org. There is nothing to create for it at ` +
                        `duckdns.org -- the account is what gets refreshed, and names under it follow.`,
                );
            }
            const mgr = loadManagerConfig();
            // DuckDNS refreshes every name on the account in one call, so a
            // second service on a second name adds to the list rather than
            // replacing it.
            const names = new Set(duckdns.normalizeDomains(mgr.duckdns.domains));
            names.add(subdomain);
            const domains = [...names].join(',');

            // Ask DuckDNS first; save the names (and a newly typed token) only once it has
            // accepted them. Saving first meant a mistyped token replaced the good one, and
            // every refresh after that failed with "KO".
            const update = await duckdns.update({ domains, token: token || storedToken });
            onLine(`DuckDNS: ${update.body.split('\n').join(' ').trim()}`);
            const saved = loadManagerConfig();
            saved.duckdns.domains = domains;
            if (token) saved.duckdns.token = token;
            saved.duckdns.enabled = true;
            saveManagerConfig(saved);
            duckdns.scheduleFromConfig(log);
            if (update.refused.length) {
                // The name being published must be refreshable; others refused only warn.
                if (update.refused.includes(`${subdomain}.duckdns.org`)) {
                    throw new Error(duckdns.refusedNote([`${subdomain}.duckdns.org`]));
                }
                onLine(`! ${duckdns.refusedNote(update.refused)}`);
            }
        }

        // --- does the name actually arrive here -----------------------------
        const [resolved, publicIp] = await Promise.all([
            dns.resolve4(domain).catch(() => []),
            duckdns.publicIp(),
        ]);
        if (!resolved.length) {
            onLine(`${domain} does not resolve yet. DNS can take a minute; the certificate step will say if it is still not there.`);
        } else if (publicIp && !resolved.includes(publicIp)) {
            onLine(`Careful: ${domain} resolves to ${resolved.join(', ')} but this connection looks like ${publicIp}.`);
        } else {
            onLine(`${domain} resolves to ${resolved.join(', ')}.`);
        }

        // --- whatever this service needs before it can answer ---------------
        if (!proxyEnabled()) {
            onLine('Starting the reverse proxy, which serves every domain.');
            await applyProxyState(true, onLine);
        }

        if (key === 'kaspad') {
            // The node's listeners follow whatever needs them; make the on-disk
            // args match before it comes up so a dependent service never starts
            // against a node that is not listening for it.
            await ensureNodeListeners(onLine);
        }

        if (key === 'mining') {
            const mining = bridge.loadBridgeConfig();
            if (!mining.enabled || !mining.publishDashboard) {
                onLine('Switching mining and the bridge dashboard on.');
                mining.enabled = true;
                mining.publishDashboard = true;
                bridge.saveBridgeConfig(mining);
                await applyMiningConfig(mining, onLine);
            }
        }

        if (['kachat', 'desktop', 'nextcloud'].includes(key)) {
            const appsCfg = apps.loadAppsConfig();
            if (!appsCfg[key]?.enabled) {
                onLine(`Switching ${apps.APPS[key].label} on. The first build can take a while.`);
                appsCfg[key].enabled = true;
                apps.saveAppsConfig(appsCfg);
                await applyAppConfig(key, appsCfg, onLine);
            }
        }

        // --- the name becomes one of ours, and the service answers on it ----
        const domains = loadDomains();
        const ssl = { mode: 'letsencrypt', email };
        // Not `existing`: that name belongs to the domain record this job was
        // started for, declared outside this closure. Shadowing it here put the
        // outer one in the temporal dead zone for the whole job, so the very
        // first line that read it threw before anything ran.
        const record = domains.find((d) => d.domain === domain);
        if (record) {
            record.ssl = ssl;
        } else {
            domains.push({ id: nginx.newId(), domain, ssl, addedAt: new Date().toISOString() });
        }
        saveDomains(domains);

        onLine(`Publishing ${plan.service.label} on ${domain}.`);
        if (extras.auth.enabled) onLine(`It will ask for a username and password (${extras.auth.user}).`);
        if (extras.allowlist.length) onLine(`Only these addresses will be let through: ${extras.allowlist.join(', ')}.`);
        await attachDomain(plan.service, domain, ssl, extras);

        // --- https ----------------------------------------------------------
        if (nginx.hasCertificate(domain)) {
            onLine(`${domain} already has a certificate, so it is left alone.`);
        } else {
            const viaDns = duckdnsFor(domain);
            if (viaDns?.wildcard) {
                onLine(
                    `${domain} is a name under ${duckdnsAccountFor(domain)}.duckdns.org, so this asks for ${viaDns.wildcard}, ` +
                        'which DuckDNS can prove with a TXT record on the account. It covers this name and any other under it.',
                );
            }
            onLine(
                viaDns
                    ? "Asking Let's Encrypt for a certificate, proving the name with a DuckDNS TXT record. This needs no open ports."
                    : "Asking Let's Encrypt for a certificate. This needs port 80 open from the internet.",
            );
            try {
                await certbot.issue(domain, email, { onLine, duckdns: viaDns, staging: Boolean(body.staging) });
            } catch (err) {
                // Everything else is done and the address works over http, so
                // this is the one outstanding step rather than a failed job.
                // certbot cannot say why a challenge failed, so say it here:
                // the answer is almost always the route in, and the checks
                // below are what distinguish that from a broken vhost.
                onLine('');
                onLine('Let\'s Encrypt could not verify the name, so there is no certificate yet.');

                const [reachable, resolvedNow, ip] = await Promise.all([
                    certbot.selfTest(domain),
                    dns.resolve4(domain).catch(() => []),
                    duckdns.publicIp(),
                ]);

                onLine(
                    reachable.ok
                        ? `  - This machine serves the challenge correctly: nginx answered for ${domain} over the internal network.`
                        : `  - This machine did not serve the challenge: ${reachable.error ?? 'nginx did not return it'}. That is the thing to fix first.`,
                );
                onLine(
                    resolvedNow.length
                        ? `  - ${domain} resolves to ${resolvedNow.join(', ')}${ip ? `, and this connection looks like ${ip} from outside` : ''}.`
                        : `  - ${domain} does not resolve yet. DNS can take a few minutes to spread.`,
                );
                if (reachable.ok && ip && resolvedNow.includes(ip)) {
                    onLine('  - So the name points here and this machine answers. What is missing is the route from the');
                    onLine('    internet to it: forward TCP port 80 (and 443) on your router to this machine, then press');
                    onLine('    "Retry HTTPS" on the service. Some ISPs block port 80 on home connections, which looks the same.');
                }

                onLine('');
                onLine(`${plan.service.label} is live on http://${domain} in the meantime.`);
                return { domain, url: `http://${domain}`, certificate: false };
            }
        }
        // The vhost is rendered without a 443 block until the certificate is on
        // disk, so it has to be written again now that it is.
        nginx.writeAll(loadProxies(), loadNodeConfig(), renderOptions());
        await nginx.reload();

        onLine(`Done. https://${domain} is live.`);
        return { domain, url: `https://${domain}`, certificate: true };
    });

    sendJson(res, 202, { ok: true, jobId: job.id, domain });
});

// ------------------------------------------------------------------- mining --

/**
 * Brings the bridge in line with the saved config: writes its YAML and port
 * override, then starts, recreates or removes the container. Disabling mining
 * removes the container rather than stopping it, so a stopped-but-present
 * stratum service can't be resurrected by an unrelated `compose up`.
 */
async function applyMiningConfig(cfg, onLine = () => {}) {
    const nodeCfg = loadNodeConfig();
    const published = bridge.writeBridgeFiles(cfg, nodeCfg);

    if (!cfg.enabled) {
        onLine('Mining disabled - removing the stratum bridge container.');
        await dockerctl.compose(['rm', '-sf', 'bridge'], { onLine, profile: 'mining' });
        return { enabled: false };
    }

    // The bridge dials the node over gRPC, so make sure that listener is on
    // before it starts. It comes on automatically now that mining is enabled.
    await ensureNodeListeners(onLine);

    onLine(`Stratum ports: ${cfg.instances.map((i) => `${i.stratumPort} (diff ${i.minShareDiff})`).join(', ')}`);
    onLine(`Published to the host: ${published.length ? published.join(', ') : 'none - local miners only'}`);
    onLine(`Connecting to kaspad gRPC on port ${ports(nodeCfg).grpc}.`);

    onLine('Building the stratum bridge image if needed...');
    await dockerctl.compose(['build', 'bridge'], { onLine, profile: 'mining', timeoutMs: 90 * 60_000 });

    // Saving mining settings is not asking for mining to start. This is reached
    // from the Save button on the mining tab, which carries `enabled` through
    // unchanged -- so recreating unconditionally started a bridge that was
    // deliberately stopped, on an edit that had nothing to do with running it.
    if ((await dockerctl.containerState(dockerctl.BRIDGE_CONTAINER)).running) {
        onLine('Restarting the stratum bridge with the new settings...');
        await dockerctl.compose(['up', '-d', '--no-deps', '--force-recreate', 'bridge'], {
            onLine,
            profile: 'mining',
            timeoutMs: 10 * 60_000,
        });
    } else {
        onLine('The stratum bridge is not running, so this applies the moment you switch it on.');
    }

    return { enabled: true, published };
}

/**
 * Network hashrate for the earnings maths. The bridge reports one, but it is
 * only running when mining is on -- the node can answer directly the rest of
 * the time, and is the more authoritative source anyway.
 */
async function networkHashesPerSecond(stats) {
    const fromBridge = Number(stats?.summary?.networkHashrate ?? 0);
    if (fromBridge > 0) return { value: fromBridge, source: 'bridge' };
    try {
        const r = await rpc.call('estimateNetworkHashesPerSecond', { windowSize: 1000 }, 6000);
        const value = Number(r?.networkHashesPerSecond ?? 0);
        if (value > 0) return { value, source: 'node' };
    } catch {
        /* node may still be syncing */
    }
    return { value: 0, source: null };
}

// ---- Testnet-10 mining (bridge-testnet): status and stats only. Its config is the
// mainnet bridge config rendered against kaspad-testnet with stratum ports +100
// (writeTestnetBridgeFiles), so there is nothing of its own to edit here. Counters
// are not accumulated or persisted: that state belongs to the mainnet bridge.
const BRIDGE_TESTNET_CONTAINER = 'kaspa-node-bridge-testnet';
const TESTNET_STRATUM_OFFSET = 100;

async function testnetMiningStatus() {
    const cfg = bridge.loadBridgeConfig();
    const [state, nodeState, snapshot] = await Promise.all([
        dockerctl.containerState(BRIDGE_TESTNET_CONTAINER),
        dockerctl.containerState(KASPAD_TESTNET_CONTAINER),
        nodeSnapshot(rpcTestnet),
    ]);
    const stats = state.running ? await bridge.fetchStats(bridge.TESTNET_STATS_URL) : null;
    const synced = Boolean(snapshot.sync?.isSynced ?? snapshot.info?.isSynced ?? false);
    const reason = !nodeState.running
        ? 'The testnet node is not running.'
        : !snapshot.reachable
          ? 'The testnet node is still starting up.'
          : !synced
            ? 'The testnet node is still syncing.'
            : null;
    return {
        testnet: true,
        stratumOffset: TESTNET_STRATUM_OFFSET,
        // Shown for the stratum ports; `enabled` follows the testnet bridge itself.
        config: { ...cfg, enabled: state.exists },
        container: state,
        stats,
        version: await dockerctl.imageVersion(BRIDGE_TESTNET_CONTAINER).catch(() => null),
        blockers: [],
        readiness: { ready: !reason, reason },
        publicIp: await duckdns.publicIp(),
        lan: await network.primaryLanAddress(),
        extraSubnets: loadManagerConfig().scan.extraSubnets,
    };
}

/** This machine's address on the local network (shown on Proxy & domains). */
route('GET', /^\/api\/network\/lan$/, async (req, res) => {
    const lan = await network.primaryLanAddress();
    sendJson(res, 200, { ip: lan?.ip ?? null, iface: lan?.iface ?? null });
});

// ---- Testnet-10 CPU miner (the Testnet view's Mining tab) -------------------
route('GET', /^\/api\/cpuminer$/, async (req, res) => {
    const [state, stats] = await Promise.all([lifecycle.status('cpuminer-testnet'), cpuminer.stats()]);
    sendJson(res, 200, { config: cpuminer.loadConfig(), cpus: cpuminer.cpuCount(), state, stats });
});

route('PUT', /^\/api\/cpuminer$/, async (req, res) => {
    const body = await readBody(req);
    const { cfg, errors } = cpuminer.validate(body);
    if (errors.length) return fail(res, 400, errors.join(' '));
    cpuminer.saveConfig(cfg);
    const state = await lifecycle.status('cpuminer-testnet');
    if (!state?.running) return sendJson(res, 200, { ok: true, config: cfg });
    // Running: recreate it on the new address / threads.
    const job = jobs.start('Apply testnet miner settings', (onLine) => lifecycle.setRunning('cpuminer-testnet', true, onLine));
    sendJson(res, 202, { ok: true, config: cfg, jobId: job.id });
});

route('GET', /^\/api\/mining$/, async (req, res, match, url) => {
    if (url.searchParams.get('net') === 'testnet') return sendJson(res, 200, await testnetMiningStatus());
    const cfg = bridge.loadBridgeConfig();
    const [state, stats, version] = await Promise.all([
        dockerctl.containerState(dockerctl.BRIDGE_CONTAINER),
        cfg.enabled ? bridgeStatsWithIps() : Promise.resolve(null),
        dockerctl.imageVersion(dockerctl.BRIDGE_CONTAINER),
    ]);
    sendJson(res, 200, {
        config: cfg,
        container: state,
        stats,
        // The bridge ships in the node's release, so this should always match
        // the node. Showing it is how you would ever notice if it did not.
        version,
        blockers: bridge.miningBlockers(cfg, loadNodeConfig()),
        readiness: await nodeReadiness(),
        // Both addresses: a miner on the same network wants the LAN one, and
        // anything outside wants the public one through a forwarded port.
        publicIp: await duckdns.publicIp(),
        lan: await network.primaryLanAddress(),
        extraSubnets: loadManagerConfig().scan.extraSubnets,
        ...(await miningEconomics(stats)),
    });
});

const proxyEnabled = () => loadManagerConfig().proxy.enabled === true;

/**
 * Reloads nginx, unless the proxy is switched off. Several flows regenerate
 * proxy config as a side effect of something else (a node restart, a network
 * change); none of them should fail because a container the user chose not to
 * run is not there.
 */
async function reloadProxyIfRunning(onLine = () => {}) {
    if (!proxyEnabled()) {
        onLine('Reverse proxy is switched off, nothing to reload.');
        return;
    }
    try {
        await nginx.reload();
        onLine('Reloaded the reverse proxy.');
    } catch (err) {
        onLine(`Could not reload the reverse proxy: ${err.message}`);
    }
}

async function applyProxyState(enabled, onLine = () => {}) {
    const mgr = loadManagerConfig();
    mgr.proxy.enabled = enabled;
    saveManagerConfig(mgr);

    if (!enabled) {
        onLine('Stopping the reverse proxy and releasing ports 80 and 443.');
        await dockerctl.compose(['rm', '-sf', 'proxy'], { onLine, profile: 'proxy', timeoutMs: 5 * 60_000 });
        return;
    }
    nginx.writeAll(loadProxies(), loadNodeConfig(), renderOptions());
    onLine('Starting the reverse proxy on ports 80 and 443.');
    await dockerctl.compose(['up', '-d', 'proxy'], { onLine, profile: 'proxy', timeoutMs: 5 * 60_000 });
}

/**
 * The bridge's stats, with each worker's mining address filled in from the
 * connection handshakes in its log. The address is what lets the panel link a
 * worker straight to its own dashboard, which for the common IceRiver on a home
 * network is a page on that box. Best-effort: a worker whose handshake is not
 * in the log tail simply has no link until it reconnects.
 */
async function bridgeStatsWithIps() {
    const stats = await bridge.fetchStats();
    if (stats?.reachable) {
        // One log read serves both: worker addresses for the dashboard links,
        // and the rejected-block tally the stats API does not carry. Read even
        // with no workers connected, since a block can still be rejected.
        const logs = await dockerctl.logs(dockerctl.BRIDGE_CONTAINER, 1500).catch(() => '');
        bridge.learnWorkerIps(logs);
        bridge.learnBlockOutcomes(logs);
        stats.workers = stats.workers.map((w) => ({ ...w, ip: bridge.workerIp(w.worker) }));
        if (stats.summary) stats.summary.rejectedBlocks = bridge.rejectedBlockCount();
    }
    // Persist the cumulative counters + found-block history so they survive a
    // bridge/computer restart; mutates the summary + blocks to the running totals.
    bridge.accumulateStats(stats);
    return stats;
}

/** Block reward, the next reduction, and what today's rate would pay. */
async function miningEconomics(stats, hashrateOverride = null) {
    const nodeCfg = loadNodeConfig();
    let dag = null;
    try {
        dag = await rpc.call('getBlockDagInfo', {}, 6000);
    } catch {
        return { reward: null, projection: null };
    }
    const daaScore = Number(dag.virtualDaaScore ?? 0);
    if (!daaScore) return { reward: null, projection: null };

    const reward = emission.rewardStatus(daaScore, nodeCfg.network);
    const net = await networkHashesPerSecond(stats);
    // The bridge reports worker hashrate in GH/s.
    const measured = Number(stats?.summary?.poolHashrate ?? 0) * 1e9;
    const hashrate = hashrateOverride ?? measured;

    return {
        reward,
        // What the earnings, and a found block's reward, are worth today. Best
        // effort and cached: absent when the price service cannot be reached.
        price: await price.kaspaPrice(),
        networkHashrate: net,
        projection:
            hashrate > 0 && net.value > 0
                ? {
                      ...emission.projectEarnings({
                          hashrate,
                          networkHashrate: net.value,
                          daaScore,
                          network: nodeCfg.network,
                      }),
                      hashrate,
                      measured,
                      hypothetical: hashrateOverride !== null,
                  }
                : { hashrate, measured, networkHashrate: net.value, horizons: [], share: 0, perDayKas: 0 },
    };
}

route('GET', /^\/api\/mining\/projection$/, async (req, res, match, url) => {
    const raw = url.searchParams.get('hashrate');
    const hashrate = raw === null ? null : Number(raw);
    if (raw !== null && (!Number.isFinite(hashrate) || hashrate < 0 || hashrate > 1e24)) {
        return fail(res, 400, 'Hashrate must be a positive number of hashes per second.');
    }
    const cfg = bridge.loadBridgeConfig();
    const stats = cfg.enabled ? await bridge.fetchStats() : null;
    sendJson(res, 200, await miningEconomics(stats, hashrate));
});

route('PUT', /^\/api\/mining$/, async (req, res) => {
    const body = await readBody(req);
    const { cfg, errors } = bridge.validateBridgeConfig(body.config ?? {});
    if (errors.length) return fail(res, 400, 'The mining configuration has problems.', { details: errors });

    const blockers = bridge.miningBlockers(cfg, loadNodeConfig());
    if (cfg.enabled) {
        const readiness = await nodeReadiness();
        if (!readiness.ready) {
            blockers.unshift(`${readiness.reason} You can switch mining on once the node is running and caught up.`);
        }
    }
    if (blockers.length) return fail(res, 409, 'Mining cannot start yet.', { details: blockers });

    bridge.saveBridgeConfig(cfg);
    const job = jobs.start(cfg.enabled ? 'Start stratum bridge' : 'Stop stratum bridge', (onLine) =>
        applyMiningConfig(cfg, onLine),
    );
    sendJson(res, 202, { ok: true, jobId: job.id, config: cfg });
});

route('POST', /^\/api\/mining\/scan$/, async (req, res) => {
    const body = await readBody(req);
    const mgr = loadManagerConfig();
    const extra = typeof body.extraSubnets === 'string' ? body.extraSubnets.trim() : mgr.scan.extraSubnets;

    if (extra !== mgr.scan.extraSubnets) {
        mgr.scan.extraSubnets = extra.slice(0, 500);
        saveManagerConfig(mgr);
    }

    try {
        const logs = await dockerctl.logs(dockerctl.BRIDGE_CONTAINER, 2000).catch(() => '');
        const knownMinerIps = await bridge.connectedMinerIps(logs);
        const result = await network.scanLan({ knownMinerIps, extra });
        sendJson(res, 200, { ...result, extraSubnets: extra });
    } catch (err) {
        fail(res, 502, err.message);
    }
});

route('GET', /^\/api\/mining\/stats$/, async (req, res, match, url) => {
    if (url.searchParams.get('net') === 'testnet') {
        const state = await dockerctl.containerState(BRIDGE_TESTNET_CONTAINER);
        if (!state.running) return sendJson(res, 200, { enabled: state.exists, reachable: false, workers: [], blocks: [] });
        return sendJson(res, 200, { enabled: true, ...(await bridge.fetchStats(bridge.TESTNET_STATS_URL)) });
    }
    const cfg = bridge.loadBridgeConfig();
    if (!cfg.enabled) return sendJson(res, 200, { enabled: false, reachable: false, workers: [], blocks: [] });
    sendJson(res, 200, { enabled: true, ...(await bridgeStatsWithIps()) });
});

route('POST', /^\/api\/mining\/(start|stop|restart)$/, async (req, res, match) => {
    const action = match[1];
    const cfg = bridge.loadBridgeConfig();
    if (!cfg.enabled) return fail(res, 409, 'Mining is switched off. Enable it first.');

    const job = jobs.start(`${action} stratum bridge`, async (onLine) => {
        if (action === 'start') await dockerctl.compose(['up', '-d', 'bridge'], { onLine, profile: 'mining' });
        else if (action === 'stop') await dockerctl.compose(['stop', 'bridge'], { onLine, profile: 'mining' });
        else await dockerctl.compose(['restart', 'bridge'], { onLine, profile: 'mining' });
    });
    sendJson(res, 202, { ok: true, jobId: job.id });
});

// --------------------------------------------------------------------- apps --

/**
 * Brings an optional app in line with its saved config. Disabling removes the
 * containers rather than stopping them, matching how mining behaves: a stopped
 * service could otherwise be restarted by an unrelated `compose up`.
 */
// The services built from source. The rest are stock images (databases, cache,
// imaginary) with nothing to build, and asking compose to build them errors.
const BUILDABLE_SERVICES = new Set(['kachat-app', 'kachat-desktop', 'nextcloud']);

async function applyAppConfig(name, cfg, onLine = () => {}) {
    const app = apps.APPS[name];
    const settings = cfg[name];

    await apps.ensureSecrets((line) => onLine(line));
    apps.writeAppsEnv(cfg);
    apps.renderAppsPortsOverride(cfg);

    if (!settings.enabled) {
        onLine(`${app.label} disabled - removing its containers.`);
        await dockerctl.compose(['rm', '-sf', ...app.services], { onLine, profile: app.profile, timeoutMs: 10 * 60_000 });
        return { enabled: false };
    }

    onLine(`${app.label}: tracking ${app.repo}@${settings.ref}`);
    if (name === 'kachat') {
        onLine(`Reading the chain from the node in this stack (wRPC borsh, ${settings.network}).`);
        onLine('First build compiles the indexer from Rust source - expect this to take a while.');
    }

    // The indexer and bot dial the node over wRPC-Borsh (and the bot over gRPC
    // too), so make sure those listeners are on before their container starts.
    // They come on automatically now that the app is enabled.
    if (name === 'kachat' || name === 'bot') await ensureNodeListeners(onLine);

    onLine('Building images if needed...');
    await dockerctl.compose(['build', ...app.services.filter((sv) => BUILDABLE_SERVICES.has(sv))], {
        onLine,
        profile: app.profile,
        timeoutMs: 120 * 60_000,
    });

    onLine('Starting containers...');
    await dockerctl.compose(['up', '-d', ...app.services], { onLine, profile: app.profile, timeoutMs: 20 * 60_000 });

    // Record what was actually built so "commits behind" can be answered later.
    try {
        const upstream = await apps.checkUpstream(name, cfg);
        apps.writeBuildRecord(name, { sha: upstream.latestSha, ref: settings.ref, builtAt: new Date().toISOString() });
        onLine(`Built from ${upstream.shortSha}.`);
    } catch (err) {
        onLine(`Could not record the upstream commit: ${err.message}`);
    }

    // The bot needs a wallet to pay for the notifications it sends. Rather than
    // make someone paste a private key, create one here from the bot's own
    // Kaspa library the moment its image exists, so installing it leaves a
    // funded-and-ready address waiting on the KaChat Bot tab. Only when there
    // is not one already, so a reinstall never abandons a funded wallet.
    if (name === 'bot' && !bot.hasKey()) {
        try {
            onLine('Creating the notification wallet...');
            const wallet = await botGenerateWallet(cfg.bot.network);
            bot.saveWallet({ privateKeyHex: wallet.privateKeyHex, address: wallet.address });
            onLine(`Sending wallet created: ${wallet.address}`);
            onLine('Fund it with a little KAS, then set who to watch and who to notify on the KaChat Bot tab.');
        } catch (err) {
            onLine(`Could not create the wallet automatically (${err.message}). Create it on the KaChat Bot tab instead.`);
        }
    }

    // Nextcloud reads its trusted domains only while installing, so a change
    // made later has to be applied to the running instance or it silently does
    // nothing. Failure here is worth reporting but not worth failing the job:
    // the container is up either way.
    if (name === 'nextcloud') {
        try {
            await apps.syncTrustedDomains(dockerctl.docker, cfg, onLine);
        } catch (err) {
            onLine(`Could not update the trusted domains: ${err.message}`);
        }
    }

    onLine(`${app.label} is up.`);
    return { enabled: true };
}

// ---------------------------------------------------------------- kassigner --

route('GET', /^\/api\/kassigner$/, async (req, res) => {
    const state = kassigner.loadState();
    sendJson(res, 200, {
        state,
        repo: kassigner.REPO,
        boards: kassigner.BOARDS,
    });
});

/** Switching it on fetches every image and checks each against its hash. */
route('PUT', /^\/api\/kassigner$/, async (req, res) => {
    const body = await readBody(req);
    if (!body.enabled) {
        kassigner.disable();
        return sendJson(res, 200, { ok: true, state: kassigner.loadState() });
    }
    const job = jobs.start('Fetch and verify KasSigner firmware', (onLine) =>
        kassigner.prepare(body.tag || null, onLine),
    );
    sendJson(res, 202, { ok: true, jobId: job.id });
});

/**
 * Re-checks the firmware on disk against the hashes GitHub publishes now.
 *
 * A job rather than a plain request: it fetches from GitHub and hashes every
 * file, and the point of it is the log rather than the verdict, so it belongs
 * where the panel already streams long output from.
 */
route('POST', /^\/api\/kassigner\/verify$/, async (req, res) => {
    const body = await readBody(req);
    const job = jobs.start('Verify KasSigner firmware', (onLine) => kassigner.verify(body.tag || null, onLine));
    sendJson(res, 202, { ok: true, jobId: job.id });
});

route('GET', /^\/api\/kassigner\/releases$/, async (req, res, match, url) => {
    try {
        const releases = await kassigner.listReleases({ force: url.searchParams.get('force') === '1' });
        sendJson(res, 200, { releases: releases.map(({ tag, prerelease, publishedAt }) => ({ tag, prerelease, publishedAt })) });
    } catch (err) {
        fail(res, 502, err.message);
    }
});

route('GET', /^\/api\/kassigner\/devices$/, async (req, res) => {
    try {
        sendJson(res, 200, { devices: await kassigner.detectDevices() });
    } catch (err) {
        fail(res, 500, err.message);
    }
});

route('POST', /^\/api\/kassigner\/flash$/, async (req, res) => {
    const body = await readBody(req);
    const state = kassigner.loadState();
    if (!state.enabled) return fail(res, 409, 'Switch KasSigner on first, so the firmware is downloaded and checked.');

    const job = jobs.start(`Write firmware to ${body.port}`, (onLine) =>
        kassigner.flash({ port: body.port, board: body.board, image: body.image || 'full', onLine }),
    );
    sendJson(res, 202, { ok: true, jobId: job.id });
});

route('GET', /^\/api\/apps$/, async (req, res) => {
    const cfg = apps.loadAppsConfig();
    const nodeCfg = loadNodeConfig();

    const state = {};
    for (const [name, app] of Object.entries(apps.APPS)) {
        const [container, published] = await Promise.all([
            dockerctl.containerState(app.container),
            dockerctl.publishedPorts(app.container),
        ]);
        state[name] = {
            label: app.label,
            repo: app.repo,
            container,
            published,
            build: apps.readBuildRecord(name),
            blockers: apps.appBlockers(name, cfg, nodeCfg),
            lastRun: apps.readLastRun(name),
        };
    }
    sendJson(res, 200, { config: cfg, apps: state, readiness: await nodeReadiness() });
});

route('PUT', /^\/api\/apps\/(kachat|desktop|nextcloud)$/, async (req, res, match) => {
    const name = match[1];
    const body = await readBody(req);

    // Validate the whole document so one app's edit cannot corrupt the other's
    // stored settings, then apply only the app that was asked for.
    const current = apps.loadAppsConfig();
    const merged = { ...current, [name]: { ...current[name], ...(body.config ?? {}) } };
    const { cfg, errors } = apps.validateAppsConfig(merged);
    if (errors.length) return fail(res, 400, 'The configuration has problems.', { details: errors });

    const blockers = apps.appBlockers(name, cfg, loadNodeConfig());
    // Nextcloud does not read the chain, so it is not gated on the node.
    if (cfg[name].enabled && apps.APPS[name].needsSyncedNode) {
        const readiness = await nodeReadiness();
        if (!readiness.ready) {
            blockers.unshift(`${readiness.reason} You can switch ${apps.APPS[name].label} on once the node is running and caught up.`);
        }
    }
    if (blockers.length) return fail(res, 409, `${apps.APPS[name].label} cannot start yet.`, { details: blockers });

    apps.saveAppsConfig(cfg);
    const job = jobs.start(`${cfg[name].enabled ? 'Start' : 'Stop'} ${apps.APPS[name].label}`, async (onLine) => {
        // Remember how this turned out. The job itself only lives in memory, so
        // without a record on disk a failed build is indistinguishable from one
        // that is still running as soon as the manager restarts.
        apps.writeLastRun(name, { ok: null, error: null, enabled: cfg[name].enabled });

        // Docker's own error says which build step died but not why; the reason
        // is a line the compiler printed further up, which only ever appears in
        // the streamed output. Keeping the tail of it means the panel can say
        // something more useful than "exit code 101".
        const output = [];
        const capture = (line) => {
            output.push(line);
            if (output.length > 400) output.shift();
            onLine(line);
        };

        try {
            const result = await applyAppConfig(name, cfg, capture);
            apps.writeLastRun(name, { ok: true, error: null, enabled: cfg[name].enabled });
            return result;
        } catch (err) {
            apps.writeLastRun(name, {
                ok: false,
                error: `${output.join('\n')}\n${err.message}`,
                enabled: cfg[name].enabled,
            });
            throw err;
        }
    });
    sendJson(res, 202, { ok: true, jobId: job.id, config: cfg });
});

route('GET', /^\/api\/apps\/(kachat|desktop|bot)\/refs$/, async (req, res, match, url) => {
    try {
        sendJson(res, 200, await apps.listRefs(match[1], { force: url.searchParams.get('force') === '1' }));
    } catch (err) {
        fail(res, 502, err.message);
    }
});

// The bot's wallet is created and its address derived by the bot's own image,
// running gen_wallet.py against the same Kaspa SDK it sends with, so the
// address is always exactly the one it will spend from.
const botImageTag = () => `kaspa-one-click/kachat-bot:${(readEnvFile().BOT_REF || 'main').trim()}`;

async function botGenerateWallet(network, fromKey = null) {
    const args = ['run', '--rm', '--entrypoint', 'python', botImageTag(), 'gen_wallet.py', '--network', network || 'mainnet'];
    if (fromKey) args.push('--from-key', fromKey);
    const { stdout } = await dockerctl.docker(args, { timeoutMs: 60_000 });
    const line = stdout.trim().split('\n').filter(Boolean).pop() || '';
    let parsed;
    try {
        parsed = JSON.parse(line);
    } catch {
        throw new Error('The wallet generator returned unexpected output.');
    }
    if (!parsed.address) throw new Error('The wallet generator did not return an address.');
    return parsed;
}

/** Has the bot deliver one arbitrary KaChat message (used for alerts). */
async function botSendMessage(text) {
    return dockerctl.compose(
        ['run', '--rm', '-T', '--no-deps', '--entrypoint', 'python', 'kachat-bot', 'watcher.py', '--send', text],
        { profile: 'bot', timeoutMs: 3 * 60_000 },
    );
}

/**
 * Watches the stratum bridge's pool hashrate and, when the bot is asked to, has
 * it send a KaChat message if the rate drops past the chosen percentage.
 *
 * The reference is the highest reading over the last half hour, so "dropped X%"
 * means "X% below your recent level" -- a rig going offline, not ordinary
 * variance. It waits until there is enough history to have a level at all, only
 * fires once per drop (re-arming when the rate comes back), and holds a minimum
 * gap between alerts so a flapping miner cannot spam the chain. A bridge that is
 * not answering is mining being off, not a drop, so nothing is sent then.
 */
let hrReadings = [];
let hrAlerted = false;
let hrLastAlertAt = 0;
const HR_WINDOW_MS = 30 * 60_000;
const HR_MIN_SPAN_MS = 10 * 60_000;
const HR_MIN_INTERVAL_MS = 60 * 60_000;

const fmtGhs = (ghs) => {
    const th = ghs / 1000;
    if (th >= 1000) return `${(th / 1000).toFixed(2)} PH/s`;
    if (th >= 1) return `${th.toFixed(2)} TH/s`;
    return `${ghs.toFixed(1)} GH/s`;
};

async function hashrateWatchTick() {
    const config = bot.readConfig();
    if (!config.hashrateAlert) {
        hrReadings = [];
        hrAlerted = false;
        return;
    }

    let stats;
    try {
        stats = await bridge.fetchStats();
    } catch {
        return;
    }
    if (!stats?.reachable || !stats.summary) return; // mining off / bridge down

    const now = Date.now();
    const current = Number(stats.summary.poolHashrate) || 0;
    hrReadings.push({ t: now, hr: current });
    hrReadings = hrReadings.filter((r) => now - r.t <= HR_WINDOW_MS);
    if (now - hrReadings[0].t < HR_MIN_SPAN_MS) return; // still learning the level

    const reference = Math.max(...hrReadings.map((r) => r.hr));
    if (reference <= 0) return;
    const pct = Math.max(1, Math.min(99, Number(config.hashrateDropPct) || 25));
    const threshold = reference * (1 - pct / 100);

    if (current >= threshold) {
        hrAlerted = false; // recovered / armed
        return;
    }
    if (hrAlerted || now - hrLastAlertAt < HR_MIN_INTERVAL_MS || !config.complete) return;

    const dropPct = Math.round((1 - current / reference) * 100);
    const message = `Hashrate alert: your pool hashrate dropped about ${dropPct}% (now ${fmtGhs(current)}, was ${fmtGhs(reference)}). Check your miners.`;
    try {
        await botSendMessage(message);
        hrAlerted = true;
        hrLastAlertAt = now;
        log(`hashrate-alert: sent (${dropPct}% drop)`);
    } catch (err) {
        log(`hashrate-alert: could not send: ${err.message}`);
    }
}

function startHashrateWatch() {
    const timer = setInterval(() => hashrateWatchTick().catch(() => {}), 2 * 60_000);
    timer.unref?.();
}

// Fold the bridge's live counters into the persistent tally on a steady cadence,
// so blocks-found / shares / uptime and the found-block history keep accumulating
// (and a bridge restart gets banked) even when nobody has the mining tab open.
async function miningStatsPersistTick() {
    if (!bridge.loadBridgeConfig().enabled) return;
    const stats = await bridge.fetchStats();
    bridge.accumulateStats(stats);
}
function startMiningStatsPersist() {
    const timer = setInterval(() => miningStatsPersistTick().catch(() => {}), 60_000);
    timer.unref?.();
}

/**
 * Watches the bot's sending wallet and, when asked to, messages you once it
 * drops below the chosen amount -- while it still has enough to send that very
 * message, which is the whole point of a threshold rather than "when empty".
 *
 * Fires once per low spell and re-arms when the wallet is topped back up, with a
 * minimum gap so a balance hovering at the line cannot ping repeatedly. A node
 * that cannot be reached is not "low", so nothing is sent then.
 */
let lowBalAlerted = false;
let lowBalLastAlertAt = 0;
const LOWBAL_MIN_INTERVAL_MS = 6 * 60 * 60_000;

async function lowBalanceWatchTick() {
    const config = bot.readConfig();
    if (!config.lowBalanceAlert) {
        lowBalAlerted = false;
        return;
    }
    const address = bot.walletAddress();
    if (!address || !config.complete) return;

    let balanceKas;
    try {
        const r = await rpc.call('getBalanceByAddress', { address }, 6000);
        balanceKas = Number(r?.balance ?? 0) / 1e8;
    } catch {
        return; // node not reachable or still syncing
    }

    const threshold = Math.max(0, Number(config.lowBalanceKas) || 0.5);
    if (balanceKas > threshold) {
        lowBalAlerted = false; // topped up / armed
        return;
    }

    const now = Date.now();
    if (lowBalAlerted || now - lowBalLastAlertAt < LOWBAL_MIN_INTERVAL_MS) return;

    const message =
        `Wallet alert: your KaChat bot wallet is low -- ${balanceKas.toFixed(4)} KAS left, below ${threshold} KAS. ` +
        `Top it up so it can keep sending notifications.`;
    try {
        await botSendMessage(message);
        lowBalAlerted = true;
        lowBalLastAlertAt = now;
        log(`low-balance-alert: sent (${balanceKas.toFixed(4)} KAS left)`);
    } catch (err) {
        log(`low-balance-alert: could not send: ${err.message}`);
    }
}

function startLowBalanceWatch() {
    const timer = setInterval(() => lowBalanceWatchTick().catch(() => {}), 5 * 60_000);
    timer.unref?.();
}

// ---------------------------------------------------------------- kachat bot --

/**
 * The block notifier's settings.
 *
 * One of them is a wallet key, so this is the shape of every route here: it
 * goes in, it never comes back out, and an empty one on the way in means "keep
 * the one you have" rather than "clear it".
 */
route('GET', /^\/api\/bot$/, async (req, res) => {
    const cfg = apps.loadAppsConfig();
    sendJson(res, 200, {
        config: bot.readConfig(),
        app: { ref: cfg.bot.ref, network: cfg.bot.network },
        container: await lifecycle.status('bot'),
        blockers: apps.appBlockers('bot', cfg, loadNodeConfig()),
        node: { network: loadNodeConfig().network },
        build: apps.readBuildRecord('bot'),
        history: bot.readHistory(50),
    });
});

route('PUT', /^\/api\/bot$/, async (req, res) => {
    const body = await readBody(req);
    const problems = bot.validate(body, { existingKey: bot.hasKey() });
    if (problems.length) return fail(res, 400, 'That is not usable yet.', { details: problems });

    bot.writeConfig(body);

    const cfg = apps.loadAppsConfig();
    if (body.network) cfg.bot.network = body.network === 'testnet-10' ? 'testnet-10' : 'mainnet';
    if (body.ref) cfg.bot.ref = String(body.ref).trim() || 'main';
    apps.saveAppsConfig(cfg);
    apps.writeAppsEnv(cfg);

    // Its settings are read once, at startup, from a file the container has
    // already mounted -- so a running bot has to be recreated, and a stopped
    // one is left stopped. Saving a setting has never started anything here.
    const state = await lifecycle.status('bot');
    if (!state.installed || !state.running) {
        return sendJson(res, 200, { ok: true, config: bot.readConfig(), restarted: false });
    }

    const job = jobs.start('Restart KaChat Bot', async (onLine) => {
        onLine('Recreating the bot so it reads the new settings.');
        await dockerctl.compose(['up', '-d', '--no-deps', '--force-recreate', 'kachat-bot'], {
            onLine,
            profile: 'bot',
            timeoutMs: 10 * 60_000,
        });
    });
    sendJson(res, 202, { ok: true, jobId: job.id, config: bot.readConfig(), restarted: true });
});

/**
 * Saves one field on its own, so each has its own Save button and a value
 * locked in here survives a refresh. Network and ref live in apps.json; the
 * rest live in the bot's env file.
 */
route('POST', /^\/api\/bot\/field$/, async (req, res) => {
    const body = await readBody(req);
    const field = String(body.field ?? '');
    const problems = bot.validateField(field, body.value);
    if (problems.length) return fail(res, 400, problems[0], { details: problems });

    if (field === 'network' || field === 'ref') {
        const cfg = apps.loadAppsConfig();
        if (field === 'network') cfg.bot.network = body.value === 'testnet-10' ? 'testnet-10' : 'mainnet';
        else cfg.bot.ref = String(body.value).trim() || 'main';
        apps.saveAppsConfig(cfg);
        apps.writeAppsEnv(cfg);
    } else {
        bot.savePartial({ [field]: body.value });
    }
    // Deliberately no restart: saving a field locks it in, it takes effect the
    // next time the bot starts. "Save settings" is what restarts a running bot.
    sendJson(res, 200, { ok: true, config: bot.readConfig() });
});

/**
 * Sends a test notification: one real KaChat message now, with sample figures,
 * so the setup can be proven without waiting for a block. Runs the bot's own
 * image with --test, on the bot network and env, and streams what it says.
 */
route('POST', /^\/api\/bot\/test$/, async (req, res) => {
    const state = await lifecycle.status('bot');
    if (!state.installed) return fail(res, 409, 'Install the KaChat Bot first.');
    if (!bot.readConfig().complete) {
        return fail(res, 409, 'Fill in and save the mining address, alias, receiver key and wallet first.');
    }
    const job = jobs.start('Send a test notification', async (onLine) => {
        onLine('Sending a test notification through the bot. This is a real message and costs a small fee.');
        await dockerctl.compose(
            ['run', '--rm', '-T', '--no-deps', '--entrypoint', 'python', 'kachat-bot', 'watcher.py', '--test'],
            { onLine, profile: 'bot', timeoutMs: 3 * 60_000 },
        );
        onLine('If it reported the message sent, it is on its way to your KaChat alias. An empty wallet means fund it first.');
    });
    sendJson(res, 202, { ok: true, jobId: job.id });
});

/**
 * The sending wallet: its address (to fund) and balance. Derives the address
 * from a stored-but-unrecorded key if needed, and reads the balance from the
 * node's UTXO index.
 */
route('GET', /^\/api\/bot\/wallet$/, async (req, res) => {
    const cfg = apps.loadAppsConfig();
    const hasKey = bot.hasKey();
    let address = bot.walletAddress();

    // A pasted key has no recorded address; derive it once from the bot image.
    if (!address && hasKey && (await lifecycle.status('bot')).installed) {
        try {
            address = (await botGenerateWallet(cfg.bot.network, bot.walletKey())).address;
            bot.saveWallet({ address });
        } catch {
            /* leave it empty; the panel explains the address is not known yet */
        }
    }

    let balanceKas = null;
    if (address) {
        try {
            const r = await rpc.call('getBalanceByAddress', { address }, 6000);
            balanceKas = Number(r?.balance ?? 0) / 1e8;
        } catch {
            /* node not reachable or still syncing; balance stays unknown */
        }
    }

    sendJson(res, 200, { hasKey, address, balanceKas, network: cfg.bot.network });
});

/** Creates a fresh sending wallet. Refuses to overwrite a funded one blindly. */
route('POST', /^\/api\/bot\/wallet$/, async (req, res) => {
    const body = await readBody(req);
    if (bot.walletKey() && !body.force) {
        return fail(res, 409, 'A wallet already exists. Creating another abandons any funds on the current one.', {
            details: ['Reveal and back up the current key first, then confirm to replace it.'],
        });
    }
    const state = await lifecycle.status('bot');
    if (!state.installed) {
        return fail(res, 409, 'Install the KaChat Bot first. The wallet is created with its own Kaspa library.');
    }

    const cfg = apps.loadAppsConfig();
    try {
        const wallet = await botGenerateWallet(cfg.bot.network);
        const saved = bot.saveWallet({ privateKeyHex: wallet.privateKeyHex, address: wallet.address });
        if (state.running) {
            const job = jobs.start('Load the new wallet into the bot', async (onLine) => {
                onLine(`New sending wallet: ${saved.address}`);
                await dockerctl.compose(['up', '-d', '--no-deps', '--force-recreate', 'kachat-bot'], {
                    onLine,
                    profile: 'bot',
                    timeoutMs: 10 * 60_000,
                });
            });
            return sendJson(res, 202, { ok: true, jobId: job.id, address: saved.address });
        }
        sendJson(res, 200, { ok: true, address: saved.address });
    } catch (err) {
        fail(res, 502, err.message);
    }
});

/**
 * Hands back the wallet key. Only reachable on the loopback panel, and only
 * when asked -- the same treatment as the Nextcloud admin password. It is the
 * user's own key, and backing it up is the whole point of showing it.
 */
route('POST', /^\/api\/bot\/wallet\/reveal$/, async (req, res) => {
    const key = bot.walletKey();
    if (!key) return fail(res, 404, 'No wallet key is stored.');
    sendJson(res, 200, { privateKeyHex: key });
});

// ------------------------------------------------------------- translation --

/**
 * Which languages the translation engine loads.
 *
 * Bare BCP-47 primary subtags, which is what the indexer's /translate contract
 * speaks: 'pt', never 'pt-BR'. Anything else is dropped rather than argued
 * with, because the engine's answer to a language it does not know is to fail
 * to start, hours later, once the models have downloaded.
 */
function normaliseLanguages(input) {
    const seen = new Set();
    for (const raw of String(input ?? '').split(/[\s,]+/)) {
        const tag = raw.trim().toLowerCase().split('-')[0];
        if (/^[a-z]{2,3}$/.test(tag)) seen.add(tag);
    }
    return [...seen].sort().join(',');
}

route('GET', /^\/api\/kachat\/translate$/, async (req, res) => {
    const cfg = apps.loadAppsConfig();
    sendJson(res, 200, {
        languages: cfg.kachat.translate?.languages ?? '',
        engine: await lifecycle.status('translate'),
        indexer: await lifecycle.status('kachat'),
    });
});

// Chess Tournaments (5.1) stats. The indexer replays the #chess-arena broadcast channel and
// serves the leaderboard on its content API (kachat-app:3080); the panel just fetches and
// displays it. Read-only: nothing here changes the stack.
const CHESS_ORIGIN = process.env.KACHAT_CONTENT_ORIGIN || 'http://kachat-app:3080';
const CHESS_TESTNET_ORIGIN = 'http://kachat-app-testnet:3080';
route('GET', /^\/api\/chess$/, async (req, res, match, url) => {
    // ?net=testnet reads the testnet-10 indexer's chess-arena instead.
    const testnet = url.searchParams.get('net') === 'testnet';
    const origin = testnet ? CHESS_TESTNET_ORIGIN : CHESS_ORIGIN;
    const state = await dockerctl.containerState(testnet ? 'kaspa-node-kachat-testnet' : 'kaspa-node-kachat');
    if (!state.exists) {
        return sendJson(res, 200, { installed: false, running: false, leaderboard: [], tournaments: [] });
    }
    let leaderboard = [];
    let tournaments = [];
    let error = null;
    try {
        const [lb, ts] = await Promise.all([
            fetch(`${origin}/chess/leaderboard?limit=100`, { signal: AbortSignal.timeout(6000) }),
            fetch(`${origin}/chess/tournaments?limit=200`, { signal: AbortSignal.timeout(6000) }),
        ]);
        if (lb.ok) leaderboard = (await lb.json()).players ?? [];
        if (ts.ok) tournaments = (await ts.json()).tournaments ?? [];
        if (!lb.ok && !ts.ok) {
            error = 'The indexer answered but not on /chess. Update KaChat-Indexer to a build with chess support.';
        }
    } catch {
        error = state.running
            ? 'Could not reach the KaChat indexer. It may still be starting.'
            : 'The KaChat indexer is not running.';
    }
    sendJson(res, 200, { installed: true, running: state.running, leaderboard, tournaments, error });
});

// Address profiles: the avatar / banner / bio / Linktree links people stamp to their own
// address (a kchat:1:profile: self-send). They belong to the address, not to a .kachat name,
// so this works on both networks. The indexer's profiles follower serves the numbers on
// GET /profiles/stats (kachat-indexer docs/KACHAT_PROFILES.md); read-only here.
route('GET', /^\/api\/profiles$/, async (req, res, match, url) => {
    // ?net=testnet reads the testnet-10 indexer instead.
    const testnet = url.searchParams.get('net') === 'testnet';
    const origin = testnet ? CHESS_TESTNET_ORIGIN : CHESS_ORIGIN;
    const state = await dockerctl.containerState(testnet ? 'kaspa-node-kachat-testnet' : 'kaspa-node-kachat');
    if (!state.exists) {
        return sendJson(res, 200, { installed: false, running: false, stats: null });
    }
    let stats = null;
    let error = null;
    try {
        const r = await fetch(`${origin}/profiles/stats`, { signal: AbortSignal.timeout(6000) });
        if (r.ok) {
            stats = await r.json();
        } else if (r.status === 404) {
            error = 'The indexer answered but not on /profiles/stats. Update KaChat-Indexer to a build with the profiles follower.';
        } else if (r.status === 503) {
            error = 'The indexer is not following profiles yet (its profiles follower is off or still starting).';
        } else {
            error = `The indexer answered ${r.status} on /profiles/stats.`;
        }
    } catch {
        error = state.running
            ? 'Could not reach the KaChat indexer. It may still be starting.'
            : 'The KaChat indexer is not running.';
    }
    sendJson(res, 200, { installed: true, running: state.running, stats, error });
});

// Every profile save, all time, one page at a time (the indexer's GET /profiles/history),
// for the Profiles tab's numbered pager. ?net=testnet, ?page=, ?address=.
route('GET', /^\/api\/profiles\/history$/, async (req, res, match, url) => {
    const testnet = url.searchParams.get('net') === 'testnet';
    const origin = testnet ? CHESS_TESTNET_ORIGIN : CHESS_ORIGIN;
    const limit = 25;
    const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
    const qs = new URLSearchParams({ limit: String(limit), offset: String((page - 1) * limit) });
    const address = (url.searchParams.get('address') || '').trim();
    if (address) qs.set('address', address);
    try {
        const r = await fetch(`${origin}/profiles/history?${qs}`, { signal: AbortSignal.timeout(8000) });
        if (r.ok) return sendJson(res, 200, { ...(await r.json()), page, limit });
        const error =
            r.status === 404
                ? 'This indexer has no profile history yet. Update KaChat-Indexer.'
                : r.status === 400
                  ? 'That is not a Kaspa address.'
                  : r.status === 503
                    ? 'The indexer is not following profiles yet.'
                    : `The indexer answered ${r.status}.`;
        sendJson(res, 200, { total: 0, items: [], page, limit, error });
    } catch {
        sendJson(res, 200, { total: 0, items: [], page, limit, error: 'Could not reach the KaChat indexer.' });
    }
});

// Downloads any argos model a requested language needs but the volume does not
// have yet. Models pivot through English, so each language needs en->X and
// X->en; already-installed pairs are skipped, and a language with no upstream
// model is reported rather than failing. Run inside the libretranslate
// container with its bundled venv python.
const LT_MODEL_INSTALL = `
import sys
import argostranslate.package as pkg

want = [c.strip() for c in sys.argv[1].split(',') if c.strip() and c.strip() != 'en']
pkg.update_package_index()
installed = {(x.from_code, x.to_code) for x in pkg.get_installed_packages()}
available = {(p.from_code, p.to_code): p for p in pkg.get_available_packages()}

missing = []
for code in want:
    for pair in (('en', code), (code, 'en')):
        if pair not in installed and pair in available:
            missing.append(pair)

if not missing:
    print('All requested language models are already present.')
else:
    for (frm, to) in missing:
        print('Downloading model %s -> %s ...' % (frm, to), flush=True)
        pkg.install_from_path(available[(frm, to)].download())
    print('Downloaded %d model(s).' % len(missing))

unavailable = sorted({c for c in want if ('en', c) not in available and (c, 'en') not in available})
if unavailable:
    print('No upstream model for: %s (these will not load).' % ', '.join(unavailable))
`;

route('PUT', /^\/api\/kachat\/translate$/, async (req, res) => {
    const body = await readBody(req);
    const languages = normaliseLanguages(body.languages);
    if (!languages) return fail(res, 400, 'Choose at least one language.');

    const cfg = apps.loadAppsConfig();
    cfg.kachat.translate = { ...cfg.kachat.translate, languages };
    apps.saveAppsConfig(cfg);
    apps.writeAppsEnv(cfg);

    // The engine reads this once, at startup, so a running one has to be
    // recreated. A stopped one picks it up when it is started, and is not
    // started here: saving a setting is not asking for anything to run.
    const engine = await lifecycle.status('translate');
    if (!engine.running)
        return sendJson(res, 200, {
            ok: true,
            languages,
            restarted: false,
            message: 'Saved. The translation engine will load these the next time it starts.',
        });

    const job = jobs.start('Reload the translation engine', async (onLine) => {
        onLine(`Languages: ${languages.split(',').join(', ')}.`);
        // The engine only auto-downloads models onto an empty volume, so once
        // it has run once, adding a language and restarting would just reload
        // what is already there -- the new language would never appear. So fetch
        // any missing model first (they persist on the volume, so this is a
        // one-time cost per language), then restart to load the full set.
        onLine('Checking which language models are already downloaded...');
        try {
            await dockerctl.compose(
                ['exec', '-T', 'libretranslate', '/app/venv/bin/python', '-c', LT_MODEL_INSTALL, languages],
                { onLine, profile: 'translate', timeoutMs: 60 * 60_000 },
            );
        } catch (err) {
            onLine(`Could not fetch missing models (${err.message}). Restarting with whatever is already downloaded.`);
        }
        onLine('Restarting the engine to load them...');
        await dockerctl.compose(['up', '-d', '--no-deps', '--force-recreate', 'libretranslate'], {
            onLine,
            profile: 'translate',
            timeoutMs: 60 * 60_000,
        });
        onLine('Reloading. It answers /translate again once its models are in memory.');
    });
    sendJson(res, 202, { ok: true, jobId: job.id, languages, restarted: true });
});

route('GET', /^\/api\/apps\/nextcloud\/admin$/, async (req, res) => {
    // The panel is bound to loopback and this is the same value sitting in the
    // stack's .env, so showing it here reveals nothing a local user could not
    // already read. It is the only way to reach a fresh install.
    sendJson(res, 200, apps.nextcloudAdmin());
});

route('POST', /^\/api\/apps\/nextcloud\/admin\/password$/, async (req, res) => {
    const body = await readBody(req);
    const password = String(body.password ?? '');

    // Nextcloud's own minimum is 10 characters. Checking here means a bad one is
    // refused before the container is touched, rather than after a failed occ run.
    if (password.length < 10) return fail(res, 400, 'The password needs to be at least 10 characters.');
    if (password.length > 200) return fail(res, 400, 'That password is too long.');

    const state = await dockerctl.containerState(apps.APPS.nextcloud.container);
    if (!state.running) return fail(res, 409, 'Nextcloud is not running, so its password cannot be changed yet.');

    try {
        await apps.setNextcloudAdminPassword(dockerctl.docker, password);
        sendJson(res, 200, { ok: true });
    } catch (err) {
        fail(res, 500, `Nextcloud refused the change: ${err.message}`);
    }
});

route('GET', /^\/api\/apps\/(kachat|desktop|nextcloud|bot)\/check$/, async (req, res, match) => {
    const name = match[1];
    try {
        const upstream = await apps.checkUpstream(name, apps.loadAppsConfig());
        const built = apps.readBuildRecord(name);
        // The panel records a commit only when it does the build itself, so an
        // image brought in another way -- a migration, or an older panel -- has
        // no record. With the container sitting right there that is not "never
        // built": we simply cannot prove which commit it is, so the honest move
        // is to offer a rebuild that both updates it and starts the tracking.
        const installed = (await dockerctl.containerState(apps.APPS[name].container)).exists;
        const builtUnknown = !built.sha && installed;
        sendJson(res, 200, {
            ...upstream,
            builtSha: built.sha,
            builtAt: built.builtAt,
            builtUnknown,
            // No published releases upstream, so "up to date" means the running
            // image was built from the commit the branch currently points at.
            updateAvailable: built.sha ? built.sha !== upstream.latestSha : installed,
            neverBuilt: !built.sha && !installed,
        });
    } catch (err) {
        fail(res, 502, err.message);
    }
});

route('POST', /^\/api\/apps\/(kachat|desktop|nextcloud|bot)\/update$/, async (req, res, match) => {
    const name = match[1];
    const cfg = apps.loadAppsConfig();
    if (!cfg[name].enabled) return fail(res, 409, `${apps.APPS[name].label} is switched off.`);

    const app = apps.APPS[name];
    const job = jobs.start(`Update ${app.label}`, async (onLine) => {
        onLine(
            app.image
                ? `Rebuilding ${app.label} on the current ${app.image}, plus what this stack adds to it...`
                : `Rebuilding ${app.label} from ${app.repo}@${cfg[name].ref}...`,
        );
        // Which of the app's services actually has a build, taken from the same
        // list the installer uses rather than named again here. It used to be a
        // filter for two service names, and every app that is not one of those
        // two -- KaChat-Desktop, now the bot -- passed no service names at all,
        // which tells compose to build every service it can see. That includes
        // kaspad, from source.
        const buildable = lifecycle.unitFor(name)?.buildable ?? [];
        if (!buildable.length) throw new Error(`${app.label} has nothing to build.`);
        // --no-cache: the build context is a git ref, and Docker would otherwise
        // reuse the layer it already has for that same ref string.
        //
        // --pull as well, because an app built on somebody else's image is
        // updated by that image moving. Without it the build is repeated
        // against the copy of nextcloud:stable already on the machine, which is
        // the very thing being updated away from.
        await dockerctl.compose(['build', '--no-cache', '--pull', ...buildable], {
            onLine,
            profile: app.profile,
            timeoutMs: 120 * 60_000,
        });
        // The new image is built either way; what was stopped stays stopped and
        // comes up on the new image whenever somebody starts it.
        if ((await lifecycle.status(name))?.running) {
            await dockerctl.compose(['up', '-d', '--no-deps', '--force-recreate', ...app.services], {
                onLine,
                profile: app.profile,
                timeoutMs: 20 * 60_000,
            });
        } else {
            onLine(`${app.label} is stopped, so it stays stopped. It runs the new build when you start it.`);
        }
        const upstream = await apps.checkUpstream(name, cfg);
        apps.writeBuildRecord(name, { sha: upstream.latestSha, ref: cfg[name].ref, builtAt: new Date().toISOString() });
        onLine(`${app.label} is now running ${upstream.shortSha}.`);
    });
    sendJson(res, 202, { ok: true, jobId: job.id });
});

route('POST', /^\/api\/apps\/(kachat|desktop|nextcloud)\/(start|stop|restart)$/, async (req, res, match) => {
    const [, name, action] = match;
    const app = apps.APPS[name];
    const job = jobs.start(`${action} ${app.label}`, async (onLine) => {
        const verb = action === 'start' ? ['up', '-d'] : [action];
        await dockerctl.compose([...verb, ...app.services], { onLine, profile: app.profile, timeoutMs: 10 * 60_000 });
    });
    sendJson(res, 202, { ok: true, jobId: job.id });
});

// ------------------------------------------------------------------ duckdns --

route('GET', /^\/api\/duckdns$/, async (req, res) => {
    const cfg = loadManagerConfig();
    sendJson(res, 200, {
        duckdns: {
            ...cfg.duckdns,
            token: cfg.duckdns.token ? '********' : '',
            // Derived, not read back: a config saved before refreshing became
            // automatic can hold enabled:false while both fields are filled in,
            // and the scheduler goes by the fields.
            enabled: duckdns.isConfigured(cfg.duckdns),
        },
        publicIp: await duckdns.publicIp(),
    });
});

route('PUT', /^\/api\/duckdns$/, async (req, res) => {
    const body = await readBody(req);
    const cfg = loadManagerConfig();
    const domains = duckdns.normalizeDomains(body.domains ?? cfg.duckdns.domains);

    for (const d of domains) {
        if (!/^[a-z0-9-]{1,63}$/.test(d)) return fail(res, 400, `"${d}" is not a valid DuckDNS subdomain.`);
    }

    cfg.duckdns.domains = domains.join(',');
    // An unchanged masked token must not overwrite the stored one.
    if (typeof body.token === 'string' && body.token && !/^\*+$/.test(body.token)) cfg.duckdns.token = body.token.trim();
    cfg.duckdns.intervalMinutes = Math.max(5, Number(body.intervalMinutes) || 5);

    // Refreshing is not opt-in -- filling both fields in is the decision. Half
    // a pair is a mistake worth naming, rather than a silent no-op to save.
    if (domains.length && !cfg.duckdns.token) return fail(res, 400, 'A DuckDNS token is required.');
    if (!domains.length && cfg.duckdns.token) return fail(res, 400, 'Enter at least one DuckDNS subdomain.');
    cfg.duckdns.enabled = duckdns.isConfigured(cfg.duckdns);

    saveManagerConfig(cfg);
    duckdns.scheduleFromConfig(log);
    sendJson(res, 200, { ok: true, domains: domains.map((d) => `${d}.duckdns.org`) });
});

// -------------------------------------------------------- admin password --

/**
 * What the renderer needs to know about the world outside this machine.
 *
 * Only the ports so far, and only because a redirect has to name one: nginx
 * knows what it binds, but not what a router put in front of it.
 */
const renderOptions = () => ({ publicHttpsPort: loadManagerConfig().proxy.publicHttpsPort ?? 443 });

/**
 * The DuckDNS credentials for a name, when it is one and the panel holds the
 * token.
 *
 * A DuckDNS name is exactly the case where DNS-01 is both possible and worth
 * preferring: it proves the name with a TXT record instead of an inbound
 * request, so it works on a network where port 80 already belongs to something
 * else, and it keeps working if that ever changes.
 */
/**
 * The DuckDNS credentials for proving ownership of a name over DNS, or null
 * when that cannot be done for this name.
 *
 * It cannot be done for a name *under* an account. DuckDNS's API sets the TXT
 * record on the account itself, so the challenge for sub.testing.duckdns.org
 * would be answered at _acme-challenge.testing.duckdns.org while Let's Encrypt
 * asks at _acme-challenge.sub.testing.duckdns.org. That is not a wildcard
 * question or a timing one: the record is put in the wrong place, and every
 * such request would fail after burning a rate limit. Those names prove
 * themselves over port 80 instead.
 */
function duckdnsFor(domain) {
    const label = duckdns.accountLabel(domain);
    if (!label || !String(domain || '').toLowerCase().endsWith('.duckdns.org')) return null;
    const token = loadManagerConfig().duckdns.token;
    if (!token) return null;
    // A name under an account (desktop.testing.duckdns.org): DuckDNS can only set the TXT
    // record on the account, which is exactly where Let's Encrypt looks for a *wildcard*
    // (_acme-challenge.testing.duckdns.org for *.testing.duckdns.org). So these get a
    // wildcard certificate over DNS-01 -- no port 80 needed, which matters when 80/443 on
    // the router belong to another machine.
    if (duckdns.isSubdomain(domain)) return { subdomain: label, token, wildcard: `*.${label}.duckdns.org` };
    return { subdomain: label, token };
}

/** The account behind a name, whether or not DNS-01 is possible for it. */
const duckdnsAccountFor = (domain) =>
    String(domain || '').toLowerCase().endsWith('.duckdns.org') ? duckdns.accountLabel(domain) : null;

/**
 * Renewal runs over every certificate at once, so it needs the credentials if
 * any of them was issued against a DuckDNS name. One token covers them all.
 */
const anyDuckdnsCredentials = () => {
    const dd = loadManagerConfig().duckdns;
    // Only the token is passed. The hook takes the name from certbot, so one
    // token covers every DuckDNS certificate on the account.
    return dd.token ? { subdomain: duckdns.normalizeDomains(dd.domains)[0] ?? '', token: dd.token } : null;
};

/** Where the panel's own port is published, which .env records. */
const managerBind = () => (readEnvFile().MANAGER_BIND || '0.0.0.0').trim();
const isLoopbackBind = () => ['127.0.0.1', '::1', 'localhost'].includes(managerBind());

/**
 * Sets or changes the panel's own password. It cannot be removed (KQS-001).
 *
 * The hash lives in .env and auth reads it live, so it is in force at once.
 *
 * The first password: with none set, the route is open (nothing else is), but
 * only for a request addressed to this machine itself -- localhost or one of its
 * own IPs. A web page that rebinds its own domain to 127.0.0.1 arrives with its
 * domain in Host and is refused, so it cannot set a password before the owner
 * does. Changing an existing one needs a session and the current password, so a
 * borrowed session cannot lock the owner out.
 */
async function hostIsThisMachine(req) {
    const host = String(req.headers.host || '')
        .replace(/:\d+$/, '')
        .replace(/^\[|\]$/g, '')
        .toLowerCase();
    if (['localhost', '127.0.0.1', '::1'].includes(host)) return true;
    const own = await network.hostAddresses().catch(() => []);
    return own.some((a) => a.ip === host);
}

route(
    'POST',
    /^\/api\/auth\/password$/,
    async (req, res) => {
    const body = await readBody(req);
    if (authConfigured()) {
        if (!isAuthenticated(req)) return fail(res, 401, 'Not signed in.');
    } else if (!(await hostIsThisMachine(req))) {
        return fail(res, 403, 'Set the first password from this machine (http://localhost) or its own IP address.');
    }

    if (authConfigured() && !verifyPassword(String(body.current || ''))) {
        return fail(res, 403, 'That is not the current password.');
    }

    if (body.clear) return fail(res, 400, 'The panel always needs a password. It can be changed, not removed.');

    const password = String(body.password || '');
    if (password.length < 8) return fail(res, 400, 'Use at least 8 characters.');
    if (password.length > 200) return fail(res, 400, 'That is longer than 200 characters.');

    updateEnvFile({ ADMIN_PASSWORD_HASH: hashPassword(password) });

    // Setting a password never changes who can reach the panel (KQS-005): opening
    // it to the network is only ever the "Reachable from other machines" switch.
    // Auth reads the hash live from .env, so this is in force immediately with
    // no restart. Issue a session in the same response so whoever just set the
    // password is not locked straight back out and made to sign in again.
    const { token } = issueSession();
    const secure = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
    sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(token, { secure }) });
    },
    { auth: false },
);

// -------------------------------------------------------------- lifecycle --

/**
 * Install, start, stop, uninstall, for every service that is a container.
 *
 * One set of endpoints rather than a set per service, because the difference
 * between them is a table and the mistake worth avoiding -- a switch that
 * quietly deletes an hour of building -- is the same mistake everywhere.
 */
route('GET', /^\/api\/services$/, async (req, res) => {
    sendJson(res, 200, { services: await lifecycle.statusAll() });
});

route('POST', /^\/api\/services\/([a-z-]+)\/install$/, async (req, res, match) => {
    const unit = lifecycle.unitFor(match[1]);
    if (!unit) return fail(res, 404, 'No such service.');

    if (unit.runnable === false) {
        // Not a container: installing it means fetching and verifying the
        // firmware, which is what its own endpoint has always done.
        const job = jobs.start(`Install ${unit.label}`, (onLine) => kassigner.prepare(null, onLine));
        return sendJson(res, 202, { ok: true, jobId: job.id });
    }

    const job = jobs.start(`Install ${unit.label}`, async (onLine) => {
        // Whatever the service needs written before it starts. Enabling it in
        // the apps config keeps the rest of the panel agreeing with reality.
        const appsCfg = apps.loadAppsConfig();
        if (appsCfg[match[1]]) {
            appsCfg[match[1]].enabled = true;
            apps.saveAppsConfig(appsCfg);
            apps.writeAppsEnv(appsCfg);
            apps.renderAppsPortsOverride(appsCfg);
        }

        // Two services keep their own idea of being on, in their own files, and
        // the rest of the panel reads those rather than asking docker. Starting
        // a container without setting them leaves a service that is running and
        // that every screen still describes as off.
        if (match[1] === 'proxy') {
            const mgr = loadManagerConfig();
            mgr.proxy.enabled = true;
            saveManagerConfig(mgr);
            nginx.writeAll(loadProxies(), loadNodeConfig(), renderOptions());
        }
        if (match[1] === 'mining') {
            const miningCfg = bridge.loadBridgeConfig();
            miningCfg.enabled = true;
            bridge.saveBridgeConfig(miningCfg);
            bridge.writeBridgeFiles(miningCfg, loadNodeConfig());
        }

        // The testnet indexer is built from KaChat-Indexer at KACHAT_REF; record which
        // commit, so its Updates tab can say whether it is behind.
        const upstream =
            match[1] === 'kachat-testnet'
                ? await selfservice.latestCommit({ repo: apps.APPS.kachat.repo, ref: readEnvFile().KACHAT_REF || 'main' }).catch(() => null)
                : null;
        await lifecycle.install(match[1], onLine);
        if (upstream) apps.writeBuildRecord('kachat-testnet', { sha: upstream.sha, ref: readEnvFile().KACHAT_REF || 'main', builtAt: new Date().toISOString() });
    });
    sendJson(res, 202, { ok: true, jobId: job.id });
});

// ---- Testnet-10 indexer updates. It builds its own image (kaspa-one-click/
// kachat-testnet:<KACHAT_REF>, kachat-audits KQS-008) from KaChat-Indexer and recreates
// only the testnet indexer; mainnet's image and container are never touched.
route('GET', /^\/api\/kachat-testnet\/update$/, async (req, res) => {
    const ref = readEnvFile().KACHAT_REF || 'main';
    const built = apps.readBuildRecord('kachat-testnet');
    let latest = null;
    let error = null;
    try {
        latest = await selfservice.latestCommit({ repo: apps.APPS.kachat.repo, ref });
    } catch (err) {
        error = err.message;
    }
    sendJson(res, 200, {
        repo: apps.APPS.kachat.repo,
        ref,
        built,
        latest,
        error,
        updateAvailable: Boolean(latest && (!built?.sha || built.sha !== latest.sha)),
        state: await lifecycle.status('kachat-testnet'),
    });
});

route('POST', /^\/api\/kachat-testnet\/update$/, async (req, res) => {
    const state = await lifecycle.status('kachat-testnet');
    if (!state?.installed) return fail(res, 409, 'The testnet indexer is not installed yet.');
    const ref = readEnvFile().KACHAT_REF || 'main';
    const job = jobs.start('Update the testnet indexer', async (onLine) => {
        const upstream = await selfservice.latestCommit({ repo: apps.APPS.kachat.repo, ref }).catch(() => null);
        onLine(`Building KaChat-Indexer@${ref}${upstream ? ` (${upstream.shortSha})` : ''} for the testnet indexer.`);
        await dockerctl.compose(['build', 'kachat-app-testnet'], { onLine, profile: 'testnet-kachat', timeoutMs: 120 * 60_000 });
        if ((await lifecycle.status('kachat-testnet'))?.running) {
            onLine('Recreating the testnet indexer on the new build.');
            await dockerctl.compose(['up', '-d', '--no-deps', '--force-recreate', 'kachat-app-testnet'], {
                onLine,
                profile: 'testnet-kachat',
                timeoutMs: 10 * 60_000,
            });
        } else {
            onLine('The testnet indexer is stopped; it runs the new build when you start it.');
        }
        if (upstream) apps.writeBuildRecord('kachat-testnet', { sha: upstream.sha, ref, builtAt: new Date().toISOString() });
        onLine('Done. The mainnet indexer was not touched.');
    });
    sendJson(res, 202, { ok: true, jobId: job.id });
});

route('POST', /^\/api\/services\/([a-z-]+)\/(start|stop)$/, async (req, res, match) => {
    const unit = lifecycle.unitFor(match[1]);
    if (!unit) return fail(res, 404, 'No such service.');

    const running = match[2] === 'start';
    const state = await lifecycle.status(match[1]);
    if (!state.installed) return fail(res, 409, `${unit.label} is not installed yet.`);

    const job = jobs.start(`${running ? 'Start' : 'Stop'} ${unit.label}`, (onLine) =>
        lifecycle.setRunning(match[1], running, onLine),
    );
    sendJson(res, 202, { ok: true, jobId: job.id });
});

route('POST', /^\/api\/services\/([a-z-]+)\/uninstall$/, async (req, res, match) => {
    const unit = lifecycle.unitFor(match[1]);
    if (!unit) return fail(res, 404, 'No such service.');
    const body = await readBody(req);

    // Deleting somebody's Nextcloud is not a thing to do on a mis-click, so the
    // request has to name the service it means.
    if (String(body.confirm ?? '') !== match[1]) {
        return fail(res, 400, 'The uninstall request did not confirm which service it meant.');
    }

    const keepData = body.keepData === true;
    const job = jobs.start(`Uninstall ${unit.label}`, async (onLine) => {
        const removed = await lifecycle.uninstall(match[1], { keepData, onLine });

        // Back to how it looked before it was ever installed.
        const appsCfg = apps.loadAppsConfig();
        if (appsCfg[match[1]]) {
            appsCfg[match[1]] = structuredClone(apps.DEFAULT_APPS_CONFIG[match[1]]);
            apps.saveAppsConfig(appsCfg);
            apps.writeAppsEnv(appsCfg);
            apps.renderAppsPortsOverride(appsCfg);
            onLine('Its settings are back to their defaults.');
        }
        if (match[1] === 'mining') {
            bridge.saveBridgeConfig(structuredClone(bridge.DEFAULT_BRIDGE_CONFIG));
            onLine('Mining settings are back to their defaults.');
        }
        if (match[1] === 'proxy') {
            const mgr = loadManagerConfig();
            mgr.proxy.enabled = false;
            saveManagerConfig(mgr);
            onLine('The proxy is switched off. Your domains and certificates are untouched.');
        }
        return removed;
    });
    sendJson(res, 202, { ok: true, jobId: job.id });
});

// --------------------------------------------------------- .kachat names ----
// The testnet names registry (KACHAT_NAMES_INDEXER.md). The module runs on the
// TESTNET indexer and stays off until a genesis manifest is configured. These
// routes manage that manifest and surface the module's status; the heavy
// covenant-follower + /names/* API live in the indexer itself.

route('GET', /^\/api\/names\/config$/, async (req, res) => {
    const current = readEnvFile().KACHAT_NAMES_MANIFEST_TESTNET || '';
    const manifest = current.startsWith('/names/') ? current.slice('/names/'.length) : current;
    const state = await lifecycle.status('kachat-testnet').catch(() => null);
    sendJson(res, 200, { manifest, running: Boolean(state?.running), installed: Boolean(state?.installed) });
});

route('PUT', /^\/api\/names\/config$/, async (req, res) => {
    const body = await readBody(req);
    const file = String(body.manifest ?? '').trim();
    // Just a file name: it lives in conf/names, mounted read-only into the indexer.
    if (file.includes('/') || file.includes('..')) {
        return fail(res, 400, 'Enter just the file name; it lives in the conf/names folder.');
    }
    sendJson(res, 202, { ok: true, jobId: applyNamesManifest(file).id });
});

// The published testnet-10 manifest ships with the panel (lib/names/): it is public
// on-chain data, byte-identical to the copy the KaChat apps bundle, while kachat-domains
// itself is private. One click writes it to conf/names and applies. It is registry v4
// (2026-10-07: registry bff18554…0e2f, fixed prices, no price record); re-clicking replaces
// an older file of the same name, and the follower starts fresh tables when the registry id
// changes. Apply it the same day a new genesis lands: the follower scans from the genesis
// block, which a pruned node keeps for about a day (kachat-indexer
// docs/KACHAT_NAMES_PRUNED_START.md).
const BUNDLED_NAMES_MANIFEST = 'kachat-names-testnet-10.json';
route('POST', /^\/api\/names\/use-bundled$/, async (req, res) => {
    const src = path.join(path.dirname(fileURLToPath(import.meta.url)), 'lib', 'names', BUNDLED_NAMES_MANIFEST);
    const text = fs.readFileSync(src, 'utf8');
    const manifest = JSON.parse(text);
    if (!manifest.registryCovenantId || !manifest.genesis?.txid) return fail(res, 500, 'The bundled manifest is incomplete.');
    fs.mkdirSync(NAMES_DIR, { recursive: true });
    fs.writeFileSync(path.join(NAMES_DIR, BUNDLED_NAMES_MANIFEST), text);
    sendJson(res, 202, { ok: true, manifest: BUNDLED_NAMES_MANIFEST, jobId: applyNamesManifest(BUNDLED_NAMES_MANIFEST).id });
});

function applyNamesManifest(file) {
    updateEnvFile({ KACHAT_NAMES_MANIFEST_TESTNET: file ? `/names/${file}` : '' });
    return jobs.start('Apply .kachat names manifest', async (onLine) => {
        onLine(file ? `Names manifest set to ${file}.` : 'Names manifest cleared (module off).');
        const state = await lifecycle.status('kachat-testnet').catch(() => null);
        if (state?.running) {
            onLine('Restarting the testnet indexer so it reads the manifest...');
            // `up -d` applies a changed manifest *path* (it recreates the container), but a new
            // manifest under the same file name -- the usual case, "Use the testnet-10 manifest"
            // after a new genesis -- leaves the env as it was, so nothing restarts and the
            // follower and API keep the one they read at start. Restart the processes too.
            await lifecycle.setRunning('kachat-testnet', true, onLine);
            await dockerctl.docker(['restart', 'kaspa-node-kachat-testnet'], { onLine, timeoutMs: 3 * 60_000 });
            onLine('Done. The .kachat log shows the registry it now follows.');
        } else if (state?.installed) {
            onLine('The testnet indexer is stopped; the manifest applies next time it starts.');
        } else {
            onLine('The testnet indexer is not installed yet; install it from the Indexer row.');
        }
    });
}

route('GET', /^\/api\/names\/status$/, async (req, res) => {
    // Proxy the testnet indexer's names status over the internal network, and treat
    // its absence as "not available yet" rather than an error.
    try {
        const r = await fetch('http://kachat-app-testnet:3080/names/status', {
            signal: AbortSignal.timeout(4000),
        });
        if (r.status === 404) {
            return sendJson(res, 200, {
                available: false,
                reason: 'off',
                message: 'The names module is off — set a genesis manifest, or this indexer build predates it.',
            });
        }
        if (!r.ok) {
            return sendJson(res, 200, { available: false, reason: 'error', message: `Names status returned ${r.status}.` });
        }
        sendJson(res, 200, { available: true, ...(await r.json()) });
    } catch {
        sendJson(res, 200, {
            available: false,
            reason: 'unreachable',
            message: 'The testnet indexer is not reachable — enable it from the Indexer row in the Testnet view.',
        });
    }
});

// -------------------------------------------------------------------- push --
// Mobile push for the KaChat indexer: Android via Firebase (FCM) and iPhone via
// Apple (APNs). The non-secret identifiers live
// in apps.json/.env, the key files are written 0600 under conf/push/ and
// bind-mounted into the indexer. Only relevant to whoever operates the KaChat
// mobile apps and owns their Firebase project / Apple developer account.

route('GET', /^\/api\/push$/, async (req, res) => {
    const k = apps.loadAppsConfig().kachat ?? {};
    const container = await dockerctl.containerState('kaspa-node-kachat');
    sendJson(res, 200, {
        enabled: Boolean(k.enabled),
        fcmProjectId: k.fcmProjectId ?? '',
        apns: k.apns ?? apps.DEFAULT_APPS_CONFIG.kachat.apns,
        // Whether the key files are actually on disk. The panel never reads them
        // back out -- it only ever says present or not.
        credentials: { apns: push.hasApns(), fcm: push.hasFcm() },
        container,
    });
});

route('POST', /^\/api\/push\/config$/, async (req, res) => {
    const body = await readBody(req);
    try {
        // Keys first: a saved key id with no key file is a half-configured
        // platform, and the indexer will not enable one of those.
        if (body.apnsKey) push.saveApnsKey(body.apnsKey);
        if (body.fcmServiceAccount) push.saveFcmKey(body.fcmServiceAccount);

        // Merge the push fields into the whole document and validate it, but
        // persist only the validated kachat block so bot/etc. keep their
        // stored settings untouched.
        const current = apps.loadAppsConfig();
        const merged = {
            ...current,
            kachat: {
                ...current.kachat,
                fcmProjectId: body.fcmProjectId ?? current.kachat.fcmProjectId,
                apns: { ...current.kachat.apns, ...(body.apns ?? {}) },
            },
        };
        const { cfg, errors } = apps.validateAppsConfig(merged);
        if (errors.length) return fail(res, 400, 'The push settings have problems.', { details: errors });

        current.kachat = cfg.kachat;
        apps.saveAppsConfig(current);
        apps.writeAppsEnv(current);

        // The indexer reads push settings only at startup, so a change is not
        // live until it restarts. Only worth doing when the app is switched on;
        // otherwise the new settings apply the next time it starts.
        if (current.kachat.enabled) {
            const job = jobs.start('Apply push settings', async (onLine) => {
                onLine('Restarting the KaChat indexer so it picks up the new push settings...');
                await dockerctl.compose(['up', '-d', '--force-recreate', 'kachat-app'], {
                    onLine,
                    profile: apps.APPS.kachat.profile,
                    timeoutMs: 20 * 60_000,
                });
                onLine('Done. Push notifications now use the new settings.');
            });
            return sendJson(res, 202, {
                ok: true,
                jobId: job.id,
                apns: current.kachat.apns,
                credentials: { apns: push.hasApns(), fcm: push.hasFcm() },
            });
        }
        sendJson(res, 200, {
            ok: true,
            apns: current.kachat.apns,
            credentials: { apns: push.hasApns(), fcm: push.hasFcm() },
        });
    } catch (err) {
        fail(res, 400, err.message);
    }
});

// ------------------------------------------------------------ global system --

route('GET', /^\/api\/system$/, async (req, res) => {
    sendJson(res, 200, {
        panelVersion: PANEL_VERSION,
        stackDir: STACK_HOST,
        lastUpdate: selfservice.lastUpdate(),
    });
});

route('GET', /^\/api\/system\/panel-latest$/, async (req, res, match, url) => {
    const repo = (url.searchParams.get('repo') || 'KaspaSilver/Kaspa-Quick-Start').trim();
    const ref = (url.searchParams.get('ref') || 'main').trim();
    try {
        const latest = await selfservice.latestCommit({ repo, ref });
        const installed = selfservice.lastUpdate();
        // Only meaningful once something has recorded which commit is installed,
        // which is the first time this panel updates itself.
        const known = installed?.repo === repo ? installed.sha : null;
        sendJson(res, 200, {
            latest,
            installedSha: known || null,
            upToDate: known ? known === latest.sha : null,
            compare: known ? await selfservice.compareToInstalled({ repo, base: known, head: latest.sha }) : null,
        });
    } catch (err) {
        fail(res, 400, err.message);
    }
});

route('POST', /^\/api\/system\/panel-update$/, async (req, res) => {
    const body = await readBody(req);
    try {
        const started = await selfservice.updatePanel({
            repo: String(body.repo || 'KaspaSilver/Kaspa-Quick-Start').trim(),
            ref: String(body.ref || 'main').trim(),
        });
        log(`panel update started in ${started.container}`);
        sendJson(res, 200, started);
    } catch (err) {
        fail(res, 400, err.message);
    }
});

/**
 * Docker's reclaimable disk: build cache and images nothing uses.
 *
 * Every indexer, kaspad and panel update builds an image, and each build leaves
 * its old image and gigabytes of layer cache behind, so the disk fills up with
 * copies of things no longer running. This clears only that. Volumes (chain
 * data, databases, Nextcloud files) and containers, running or stopped, are
 * never touched: an image a stopped container still uses is kept too.
 */
const CACHE_CLEANS = {
    smart: {
        title: 'Clean up without slowing anything down',
        run: smartClean,
    },
    build: {
        title: 'Clear the build cache',
        steps: [['builder', 'prune', '--all', '--force']],
    },
    dangling: {
        title: 'Remove old untagged images',
        steps: [['image', 'prune', '--force']],
    },
    unused: {
        title: 'Remove all unused images and the build cache',
        steps: [
            ['builder', 'prune', '--all', '--force'],
            ['image', 'prune', '--all', '--force'],
        ],
    },
};

/** Images this stack builds itself (everything with a `build:` in docker-compose.yml). */
const BUILT_IMAGES = 'kaspa-one-click/*';
// A build's cache is last touched while it runs, a little before its image is
// stamped Created; a slow Rust build takes well over an hour. Kept generous.
const BUILD_MARGIN_HOURS = 24;

/**
 * Clears what accumulates from updates without costing the next update anything:
 *
 * 1. Untagged images: the previous image each rebuild replaced.
 * 2. Old versions of this stack's own images that no container uses (a kaspad
 *    or indexer version you moved off). `docker rmi` without --force refuses an
 *    image any container uses, as a second guard.
 * 3. Build cache that no current image was built from. Every build marks the
 *    cache it used, so cache last used before the oldest image still in service
 *    was built belongs only to superseded builds: the next update of anything
 *    installed would not have reused it anyway.
 *
 * Third-party images and the cache the current builds use are kept, so updates
 * stay exactly as fast as before.
 */
async function smartClean(onLine) {
    const out = async (args) => (await dockerctl.docker(args, { timeoutMs: 5 * 60_000 })).stdout.trim();

    onLine('$ docker image prune --force');
    await dockerctl.docker(['image', 'prune', '--force'], { onLine, timeoutMs: 30 * 60_000 });

    const containerIds = (await out(['ps', '-aq'])).split('\n').filter(Boolean);
    const inUse = new Set(
        containerIds.length
            ? (await out(['inspect', '--format', '{{.Image}}', ...containerIds])).split('\n').filter(Boolean)
            : [],
    );
    const built = (await out(['image', 'ls', '--no-trunc', '--filter', `reference=${BUILT_IMAGES}`, '--format', '{{.ID}} {{.Repository}}:{{.Tag}}']))
        .split('\n')
        .filter(Boolean)
        .map((l) => {
            const [id, ref] = l.split(' ');
            return { id, ref };
        });

    const unused = built.filter((b) => !inUse.has(b.id));
    if (unused.length) {
        for (const { ref } of unused) {
            onLine(`$ docker rmi ${ref}`);
            await dockerctl.docker(['rmi', ref], { onLine, timeoutMs: 5 * 60_000 }).catch((e) => onLine(`kept ${ref}: ${e.message}`));
        }
    } else {
        onLine('No old versions of this stack\'s images to remove.');
    }

    const live = [...new Set(built.filter((b) => inUse.has(b.id)).map((b) => b.id))];
    if (!live.length) {
        onLine('Nothing built by this stack is running, so the build cache is left alone.');
        return;
    }
    const created = (await out(['image', 'inspect', '--format', '{{.Created}}', ...live]))
        .split('\n')
        .map((t) => Date.parse(t))
        .filter(Number.isFinite);
    const oldest = Math.min(...created);
    const hours = Math.ceil((Date.now() - oldest) / 3_600_000) + BUILD_MARGIN_HOURS;
    onLine(`Oldest image in service was built ${new Date(oldest).toISOString()}; clearing build cache unused for over ${hours}h.`);
    const args = ['builder', 'prune', '--all', '--force', '--filter', `until=${hours}h`];
    onLine(`$ docker ${args.join(' ')}`);
    await dockerctl.docker(args, { onLine, timeoutMs: 30 * 60_000 });
}

route('GET', /^\/api\/system\/disk-cache$/, async (req, res) => {
    try {
        const { stdout } = await dockerctl.docker(['system', 'df', '--format', '{{json .}}'], { timeoutMs: 60_000 });
        const rows = stdout
            .split('\n')
            .filter((l) => l.trim().startsWith('{'))
            .map((l) => JSON.parse(l))
            .map((r) => ({
                type: r.Type,
                total: Number(r.TotalCount) || 0,
                active: Number(r.Active) || 0,
                size: r.Size,
                reclaimable: r.Reclaimable,
            }));
        sendJson(res, 200, { rows });
    } catch (err) {
        fail(res, 500, `docker system df failed: ${err.message}`);
    }
});

route('POST', /^\/api\/system\/disk-cache\/clean$/, async (req, res) => {
    const body = await readBody(req);
    const clean = CACHE_CLEANS[String(body.what || '')];
    if (!clean) return fail(res, 400, 'Unknown clean-up.');
    const job = jobs.start(clean.title, async (onLine) => {
        if (clean.run) await clean.run(onLine);
        for (const args of clean.steps ?? []) {
            onLine(`$ docker ${args.join(' ')}`);
            await dockerctl.docker(args, { onLine, timeoutMs: 30 * 60_000 });
        }
        onLine('Volumes and containers were not touched.');
    });
    sendJson(res, 202, { ok: true, jobId: job.id });
});

route('POST', /^\/api\/system\/teardown$/, async (req, res) => {
    const body = await readBody(req);
    // Typed rather than clicked. This removes the node, its chain data and this
    // panel, and there is no undo anywhere in the flow.
    if (String(body.confirm || '') !== 'DELETE EVERYTHING') {
        return fail(res, 400, 'Type DELETE EVERYTHING to confirm.');
    }
    try {
        const started = await selfservice.teardown();
        log(`teardown started in ${started.container}; this panel is about to go away`);

        // The removal runs in a container of its own, because it has to delete
        // the image this panel is running from and docker will not remove an
        // image a running container is using. Its output is the only account of
        // what happened, so it is followed and republished as a job -- which is
        // what puts it on the overlay, right up until the step that removes
        // this panel and takes the log with it.
        const job = jobs.start('Remove everything', async (onLine) => {
            onLine('Removing everything this stack put on the machine. Docker itself is left installed.');
            onLine('This panel goes last, and its disappearing is what finishing looks like.');

            for (let attempt = 0; attempt < 20; attempt += 1) {
                if ((await dockerctl.containerState(started.container)).exists) break;
                await new Promise((r) => setTimeout(r, 500));
            }

            await new Promise((resolve) => {
                const stop = dockerctl.streamLogs(started.container, onLine, { tail: 0 });
                // Nothing here resolves in the ordinary case: this container is
                // removed part-way through and the process ends with it. The
                // timeout is only so a teardown that somehow fails to reach us
                // does not leave a job running for the rest of the day.
                setTimeout(() => {
                    try {
                        stop();
                    } catch {
                        /* already gone */
                    }
                    resolve();
                }, 30 * 60_000).unref?.();
            });
        });

        sendJson(res, 202, { ...started, jobId: job.id });
    } catch (err) {
        fail(res, 400, err.message);
    }
});

route('POST', /^\/api\/duckdns\/update$/, async (req, res) => {
    try {
        sendJson(res, 200, await duckdns.update());
    } catch (err) {
        fail(res, 400, err.message);
    }
});

// --------------------------------------------------------------- port check --

route('GET', /^\/api\/portcheck$/, async (req, res, match, url) => {
    const port = Number(url.searchParams.get('port'));
    if (!Number.isInteger(port) || port < 1 || port > 65535) return fail(res, 400, 'Invalid port.');

    const ip = url.searchParams.get('ip') || (await duckdns.publicIp());
    if (!ip) return fail(res, 502, 'Could not determine this machine\'s public IP address.');

    const open = await new Promise((resolve) => {
        const socket = net.connect({ host: ip, port, timeout: 5000 });
        const done = (result) => {
            socket.destroy();
            resolve(result);
        };
        socket.on('connect', () => done(true));
        socket.on('timeout', () => done(false));
        socket.on('error', () => done(false));
    });

    sendJson(res, 200, {
        ip,
        port,
        open,
        // Home routers often refuse to route a LAN host back to their own WAN
        // address, so a negative result here is not proof the port is shut.
        note: open
            ? 'Reachable from this machine using its public address.'
            : 'No answer. That usually means the port is closed, but if this node is behind a home router it can also just mean the router will not loop a connection back to itself. Worth checking from another network before you change anything.',
    });
});

/**
 * "Am I public?" -- does the Kaspa network reach this node from outside.
 *
 * Two answers, because they fail differently. The direct one asks places on the
 * internet to open a TCP connection to the P2P port, the same thing a peer
 * would do: that is the honest external test, and it needs the address told to
 * check-host.net (the same address every node this one talks to already sees).
 * The corroborating one is the inbound peer count from kaspad itself -- nobody
 * can dial in on a closed port, so an inbound peer is proof the door is open
 * even if the prober is having a bad day.
 *
 * Location is only for the map: the pin it drops is this connection's rough
 * city, looked up from the same public address. Absent is fine; the verdict
 * does not depend on it.
 */
route('POST', /^\/api\/node\/public-check$/, async (req, res) => {
    const cfg = loadNodeConfig();
    const port = ports(cfg).p2p;
    const exposed = Boolean(cfg.expose.p2p);

    const ip = await duckdns.publicIp();
    if (!ip) return fail(res, 502, 'Could not work out this connection\'s public address.');

    const [probe, geo, snapshot] = await Promise.all([
        portcheck.probeTcp(ip, port).catch((err) => ({ open: null, detail: err.message, link: null })),
        geoip.locate(ip),
        nodeSnapshot().catch(() => null),
    ]);

    const peers = Array.isArray(snapshot?.peers?.peerInfo) ? snapshot.peers.peerInfo : [];
    const inbound = peers.filter((p) => p.isOutbound === false).length;

    sendJson(res, 200, {
        ip,
        port,
        exposed,
        probe,
        peers: { total: peers.length, inbound, outbound: peers.length - inbound },
        geo,
        // Reachable if the world connected, or -- prober aside -- if a peer has
        // already dialled in. Either one is proof the P2P port is open.
        public: probe.open === true || inbound > 0,
    });
});

// ------------------------------------------------------------------- server --

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    // The embedded KaChat dashboard. Behind the same auth as everything else,
    // since it can delete indexed content.
    if (url.pathname === kachatProxy.MOUNT || url.pathname.startsWith(`${kachatProxy.MOUNT}/`)) {
        if (authRequired() && !isAuthenticated(req)) return fail(res, 401, 'Not signed in.');
        return kachatProxy.handle(req, res, url);
    }
    // The testnet-10 indexer's admin API (the Testnet view's Indexer tab).
    if (url.pathname === kachatProxy.TESTNET_MOUNT || url.pathname.startsWith(`${kachatProxy.TESTNET_MOUNT}/`)) {
        if (authRequired() && !isAuthenticated(req)) return fail(res, 401, 'Not signed in.');
        return kachatProxy.handleTestnet(req, res, url);
    }

    const isApi = url.pathname.startsWith('/api/') || url.pathname === '/healthz';

    if (!isApi) return serveStatic(req, res, url.pathname);

    const match = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
    if (!match) return fail(res, 404, 'Not found');

    // Every route needs a session (KQS-001); with no password set yet there are
    // none, so only the auth: false routes (session, login, first password) answer.
    if (match.auth && authRequired() && !isAuthenticated(req)) {
        return fail(res, 401, 'Not signed in.');
    }

    // Same-origin guard for state changes. The session cookie is SameSite=Strict
    // already; this closes the gap for clients that ignore that.
    if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
        const origin = req.headers.origin;
        if (origin) {
            let sameHost = false;
            try {
                sameHost = new URL(origin).host === req.headers.host;
            } catch {
                sameHost = false;
            }
            if (!sameHost) return fail(res, 403, 'Cross-origin request refused.');
        }
    }

    try {
        await match.handler(req, res, match.pattern.exec(url.pathname), url);
    } catch (err) {
        log('request failed', url.pathname, err);
        if (!res.headersSent) fail(res, 500, err.message || 'Internal error');
    }
});

// -------------------------------------------------------------------- boot ---

/**
 * The ports model used to be two booleans per port -- a listener switch and a
 * publish switch -- plus one shared publish address. It is now a single level
 * per port: off / local / public, with the address folded in and the listener
 * derived from what needs it. Convert an old config the first time it is seen so
 * nothing about how the node was reachable changes underneath it:
 *   - a published port keeps its address: the old shared 0.0.0.0 becomes public,
 *     anything else (loopback) becomes local;
 *   - an unpublished port becomes off (its listener, if a sibling needs it, is
 *     handled by the derivation, not by a stored flag);
 *   - P2P and wRPC-JSON cannot be off, so an unpublished one settles at local.
 * The old `services` and `bindAddress` keys are dropped once converted.
 */
function migrateExposeModel(cfg) {
    try {
        const raw = JSON.parse(fs.readFileSync(NODE_CONFIG_FILE, 'utf8'));
        const ex = raw?.expose;
        if (!ex) return;
        const KEYS = ['p2p', 'grpc', 'borsh', 'json'];
        const isOld = 'bindAddress' in ex || KEYS.some((k) => typeof ex[k] === 'boolean');
        if (!isOld) return;

        const oldBind = typeof ex.bindAddress === 'string' ? ex.bindAddress : '127.0.0.1';
        const pinned = new Set(['p2p', 'json']);
        for (const key of KEYS) {
            const published = ex[key] === true;
            let out = published ? (oldBind === '127.0.0.1' ? 'local' : 'public') : 'off';
            if (pinned.has(key) && out === 'off') out = 'local';
            cfg.expose[key] = out;
        }
        delete cfg.expose.bindAddress;
        delete cfg.services;
        saveNodeConfig(cfg);
        log('ports: migrated to the off / local / public model');
    } catch (err) {
        log(`could not migrate the ports model: ${err.message}`);
    }
}

async function bootstrap() {
    ensureDirs();

    if (!fs.existsSync(NODE_CONFIG_FILE)) saveNodeConfig(structuredClone(DEFAULT_NODE_CONFIG));
    if (!fs.existsSync(PROXIES_FILE)) saveProxies([]);
    // A domain used to exist only as a field on a proxy host. The services
    // screen needs domains as things in their own right, so an install that
    // predates the split gets its list built from the hosts it already has.
    if (!fs.existsSync(DOMAINS_FILE)) {
        const seeded = [];
        for (const proxy of loadProxies()) {
            if (seeded.some((d) => d.domain === proxy.domain)) continue;
            seeded.push({
                id: nginx.newId(),
                domain: proxy.domain,
                ssl: { mode: proxy.ssl?.mode ?? 'none', email: proxy.ssl?.email ?? '' },
                addedAt: new Date().toISOString(),
            });
        }
        saveDomains(seeded);
        if (seeded.length) log(`domains: adopted ${seeded.length} from existing proxy hosts`);
    }

    const cfg = loadNodeConfig();
    migrateExposeModel(cfg);
    writeArgsFile(cfg, nodeSiblings());
    renderPortsOverride(cfg);
    nginx.writeAll(loadProxies(), cfg, renderOptions());
    bridge.writeBridgeFiles(bridge.loadBridgeConfig(), cfg);

    const appsCfg = apps.loadAppsConfig();
    await apps.ensureSecrets(log);
    bot.ensureEnvFile();
    apps.writeAppsEnv(appsCfg);
    apps.renderAppsPortsOverride(appsCfg);

    rpc.setUrl(`ws://${KASPAD_SERVICE}:${ports(cfg).json}`);

    log(`stack dir      : ${CONF_DIR}`);
    log(`kaspad version : ${readEnvFile().KASPAD_VERSION || 'unset'}`);
    log(`network        : ${cfg.network} (${JSON.stringify(ports(cfg))})`);
    if (passwordUnusable()) {
        log('auth           : the stored password hash is unusable and no password will be accepted.');
        log('                 It was truncated by docker compose reading a $ in .env, which is fixed now.');
        log(`                 Clear ADMIN_PASSWORD_HASH in ${STACK_HOST}/.env, recreate this container, and set a new one.`);
    }
    log(
        authConfigured()
            ? 'auth           : password required'
            : 'auth           : no password yet; the panel serves only its set-password screen',
    );

    // Self-heal the first-boot race. kaspad and this container start together,
    // and kaspad reads its arguments file the instant it boots -- so on a fresh
    // install it can start before the file exists and come up on kaspad's own
    // defaults: gRPC on loopback and no wRPC at all, which this panel cannot
    // talk to at all.
    //
    // The check is against a hash recorded when the container was last created,
    // not the file's timestamp: bootstrap rewrites that file on every start, so
    // a timestamp comparison would recreate the node every time the manager
    // restarted.
    try {
        const state = await dockerctl.containerState(dockerctl.KASPAD_CONTAINER);
        if (state.running && argsDrifted()) {
            log('kaspad is running with different arguments than configured - recreating it');
            jobs.start('Apply kaspad arguments', (onLine) => applyNodeConfig(cfg, onLine));
        }
    } catch (err) {
        log(`could not compare kaspad against its arguments: ${err.message}`);
    }

    // Decide the proxy's state once, for installs that predate it being
    // optional: if it is already running or there are hosts configured, it was
    // wanted. Otherwise it stays off and leaves ports 80 and 443 alone.
    const mgr = loadManagerConfig();
    if (mgr.proxy.enabled === null) {
        const proxyState = await dockerctl.containerState(dockerctl.PROXY_CONTAINER);
        mgr.proxy.enabled = proxyState.running || loadProxies().length > 0;
        saveManagerConfig(mgr);
        log(`reverse proxy: ${mgr.proxy.enabled ? 'on (already in use)' : 'off (nothing configured)'}`);
    }

    syncProgress.start(log);
    testnetSync.start(log);
    duckdns.scheduleFromConfig(log);
    scheduleExternalIpWatch(log);
    backup.scheduleBackup(log);
    startHashrateWatch();
    startLowBalanceWatch();
    startMiningStatsPersist();

    // Certificates are valid for 90 days; a daily attempt is what certbot's own
    // packaging recommends and is a no-op until one is close to expiry.
    const renewTimer = setInterval(
        () => {
            if (jobs.busy) return;
            if (!loadProxies().some((p) => p.ssl?.mode === 'letsencrypt')) return;
            jobs.start('Automatic certificate renewal', async (onLine) => {
                await certbot.renew({ onLine, duckdns: anyDuckdnsCredentials() });
                await nginx.reload().catch(() => {});
            });
        },
        24 * 60 * 60 * 1000,
    );
    renewTimer.unref?.();
}

bootstrap()
    .then(() => {
        server.listen(PORT, '0.0.0.0', () => log(`Kaspa Node Control listening on :${PORT}`));
    })
    .catch((err) => {
        console.error('failed to start', err);
        process.exit(1);
    });

for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
        log(`received ${signal}, shutting down`);
        rpc.close();
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 3000).unref();
    });
}
