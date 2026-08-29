import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import dns from 'node:dns/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONF_DIR, DOMAINS_FILE, ensureDirs, KASPAD_ARGS_FILE, NODE_CONFIG_FILE, PROXIES_FILE, STACK_HOST } from './lib/paths.js';
import {
    DEFAULT_NODE_CONFIG,
    NETWORKS,
    loadDomains,
    loadManagerConfig,
    loadNodeConfig,
    loadProxies,
    readEnvFile,
    updateEnvFile,
    saveDomains,
    saveManagerConfig,
    saveNodeConfig,
    saveProxies,
} from './lib/store.js';
import { buildArgs, portMatrix, ports, publicPorts, renderPortsOverride, setPortState, writeArgsFile } from './lib/kaspad-args.js';
import * as dockerctl from './lib/dockerctl.js';
import * as nginx from './lib/nginx.js';
import * as certbot from './lib/certbot.js';
import * as duckdns from './lib/duckdns.js';
import * as updater from './lib/updater.js';
import * as bridge from './lib/bridge.js';
import * as apps from './lib/apps.js';
import * as kachatProxy from './lib/kachat-proxy.js';
import * as syncProgress from './lib/sync-progress.js';
import * as network from './lib/network.js';
import * as emission from './lib/emission.js';
import * as pruning from './lib/pruning.js';
import * as kassigner from './lib/kassigner.js';
import * as selfservice from './lib/selfservice.js';
import * as publish from './lib/publish.js';
import { nodeSnapshot, rpc } from './lib/rpc.js';
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
async function applyNodeConfig(cfg, onLine = () => {}) {
    const args = writeArgsFile(cfg);
    const mappings = renderPortsOverride(cfg);
    rpc.setUrl(`ws://${KASPAD_SERVICE}:${ports(cfg).json}`);

    onLine(`kaspad arguments: ${args.join(' ')}`);
    onLine(`Published ports: ${mappings.length ? mappings.join(', ') : 'none (internal only)'}`);

    // Regenerate proxy configs too: they embed kaspad's port numbers, which
    // change when the network does.
    nginx.writeAll(loadProxies(), cfg);

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
    if (miningCfg.enabled) {
        onLine('Restarting the stratum bridge against the reconfigured node...');
        await dockerctl
            .compose(['up', '-d', '--force-recreate', 'bridge'], { onLine, profile: 'mining', timeoutMs: 10 * 60_000 })
            .catch((err) => onLine(`Bridge restart failed: ${err.message}`));
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

    for (const key of Object.keys(cfg.services)) cfg.services[key] = Boolean(input.services?.[key]);
    for (const key of Object.keys(cfg.expose)) cfg.expose[key] = Boolean(input.expose?.[key]);
    for (const key of Object.keys(cfg.flags)) cfg.flags[key] = Boolean(input.flags?.[key]);

    const bind = String(input.expose?.bindAddress || '0.0.0.0').trim();
    if (!/^[0-9a-fA-F.:]+$/.test(bind)) errors.push('Publish address must be an IP such as 0.0.0.0 or 127.0.0.1.');
    cfg.expose.bindAddress = bind;

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

route(
    'GET',
    /^\/api\/session$/,
    async (req, res) =>
        sendJson(res, 200, {
            // `required` false means no password is set, so the panel is open to
            // whoever can reach the port. The installer keeps that bound to
            // loopback; the UI says so, and proxying it out is refused unless a
            // password or proxy-level basic auth is in place.
            required: authRequired(),
            authenticated: !authRequired() || isAuthenticated(req),
            // A stored hash that cannot be verified would otherwise present as
            // "your password is wrong", forever.
            passwordUnusable: passwordUnusable(),
            panelVersion: PANEL_VERSION,
        }),
    { auth: false },
);

route(
    'POST',
    /^\/api\/login$/,
    async (req, res) => {
        const body = await readBody(req);
        if (!authRequired()) return sendJson(res, 200, { ok: true, required: false });
        if (!verifyPassword(String(body.password ?? ''))) {
            // Constant-ish delay so the endpoint is not a fast password oracle.
            await new Promise((r) => setTimeout(r, 500));
            return fail(res, 401, 'Incorrect password.');
        }
        const { token } = issueSession();
        const secure = (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
        sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionCookie(token, { secure }) });
    },
    { auth: false },
);

route('POST', /^\/api\/logout$/, async (req, res) => sendJson(res, 200, { ok: true }, { 'Set-Cookie': clearCookie() }), {
    auth: false,
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
        portMatrix: portMatrix(cfg),
        bindAddress: cfg.expose.bindAddress || '0.0.0.0',
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
    sendJson(res, 202, { ok: true, jobId: job.id, config: cfg });
});

route('POST', /^\/api\/ports\/(p2p|grpc|borsh|json)$/, async (req, res, match) => {
    const key = match[1];
    const body = await readBody(req);
    const wanted = {
        listening: typeof body.listening === 'boolean' ? body.listening : undefined,
        published: typeof body.published === 'boolean' ? body.published : undefined,
    };
    if (wanted.listening === undefined && wanted.published === undefined) {
        return fail(res, 400, 'Send listening and/or published as booleans.');
    }

    const cfg = loadNodeConfig();
    const before = portMatrix(cfg).find((e) => e.key === key);

    // Two services in this stack reach the node over the internal network, and
    // turning their listener off would strand them without touching anything
    // they can see. Refuse rather than break them silently.
    if (wanted.listening === false) {
        if (key === 'borsh' && apps.loadAppsConfig().kachat.enabled) {
            return fail(res, 409, 'The KaChat indexer reads the chain over wRPC Borsh.', {
                details: ['Switch KaChat off first, or leave this listener on.'],
            });
        }
        if (key === 'grpc' && bridge.loadBridgeConfig().enabled) {
            return fail(res, 409, 'The stratum bridge talks to the node over gRPC.', {
                details: ['Switch mining off first, or leave this listener on.'],
            });
        }
    }

    const changes = setPortState(cfg, key, wanted);
    if (!changes.length) return sendJson(res, 200, { ok: true, unchanged: true });

    saveNodeConfig(cfg);
    const job = jobs.start(`${before.name} (${before.port})`, (onLine) => {
        for (const change of changes) onLine(change);
        return applyNodeConfig(cfg, onLine);
    });
    sendJson(res, 202, { ok: true, jobId: job.id, changes });
});

route('POST', /^\/api\/ports\/bind$/, async (req, res) => {
    const body = await readBody(req);
    const address = String(body.address || '').trim();
    if (!/^[0-9a-fA-F.:]+$/.test(address)) {
        return fail(res, 400, 'Publish address must be an IP such as 0.0.0.0 or 127.0.0.1.');
    }
    const cfg = loadNodeConfig();
    if (cfg.expose.bindAddress === address) return sendJson(res, 200, { ok: true, unchanged: true });

    cfg.expose.bindAddress = address;
    saveNodeConfig(cfg);
    const job = jobs.start(`Publish ports on ${address}`, (onLine) => {
        onLine(`Published ports will bind ${address}.`);
        return applyNodeConfig(cfg, onLine);
    });
    sendJson(res, 202, { ok: true, jobId: job.id });
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

const containerFor = (url) => {
    switch (url.searchParams.get('container')) {
        case 'proxy': return dockerctl.PROXY_CONTAINER;
        case 'bridge': return dockerctl.BRIDGE_CONTAINER;
        case 'kachat': return dockerctl.KACHAT_CONTAINER;
        case 'nextcloud': return dockerctl.NEXTCLOUD_CONTAINER;
        default: return dockerctl.KASPAD_CONTAINER;
    }
};

route('GET', /^\/api\/logs$/, async (req, res, match, url) => {
    const tail = Math.min(Number(url.searchParams.get('tail')) || 300, 5000);
    sendJson(res, 200, { text: await dockerctl.logs(containerFor(url), tail) });
});

route('GET', /^\/api\/logs\/stream$/, async (req, res, match, url) => {
    const { send, onClose } = sse(req, res);
    const stop = dockerctl.streamLogs(containerFor(url), (line) => send('line', { line }));
    onClose(stop);
});

route('GET', /^\/api\/logs\/containers$/, async (req, res) => {
    const rows = await Promise.all(
        dockerctl.STACK_CONTAINERS.map(async (c) => ({ ...c, state: await dockerctl.containerState(c.name) })),
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
route('GET', /^\/api\/logs\/stream-all$/, async (req, res) => {
    const present = [];
    for (const c of dockerctl.STACK_CONTAINERS) {
        const state = await dockerctl.containerState(c.name);
        if (state.exists) present.push(c);
    }

    const { send, onClose } = sse(req, res);
    send('containers', { containers: present.map(({ key, label, name }) => ({ key, label, name })) });

    const stops = present.map((c) =>
        dockerctl.streamLogs(c.name, (line) => send('line', { key: c.key, line }), { tail: 60 }),
    );
    onClose(() => {
        for (const stop of stops) {
            try {
                stop();
            } catch {
                /* already exited */
            }
        }
    });
});

route('GET', /^\/api\/jobs\/stream$/, async (req, res) => {
    const { send, onClose } = sse(req, res);
    const snapshot = jobs.snapshot();
    if (snapshot) send('snapshot', snapshot);
    const onLine = (e) => send('line', e);
    const onStart = (job) => send('start', { id: job.id, name: job.name });
    const onEnd = (job) => send('end', { id: job.id, name: job.name, status: job.status, error: job.error });
    jobs.on('line', onLine);
    jobs.on('start', onStart);
    jobs.on('end', onEnd);
    onClose(() => {
        jobs.off('line', onLine);
        jobs.off('start', onStart);
        jobs.off('end', onEnd);
    });
});

route('GET', /^\/api\/jobs\/current$/, async (req, res) => sendJson(res, 200, { job: jobs.snapshot(), busy: jobs.busy }));

// ------------------------------------------------------------------ updates --

route('GET', /^\/api\/update\/check$/, async (req, res, match, url) => {
    const includePrereleases = url.searchParams.get('prereleases') === '1';
    try {
        sendJson(res, 200, await updater.checkLatest({ includePrereleases }));
    } catch (err) {
        fail(res, 502, err.message);
    }
});

route('POST', /^\/api\/update\/apply$/, async (req, res) => {
    const body = await readBody(req);
    let version = String(body.version || '').trim();

    // Never install a version the user pasted without confirming it exists
    // upstream; this is the one place the stack pulls code from the internet.
    let info;
    try {
        info = await updater.checkLatest({ includePrereleases: Boolean(body.includePrereleases) });
    } catch (err) {
        return fail(res, 502, `Cannot reach GitHub to verify the release: ${err.message}`);
    }
    if (!version) version = info.latest;
    if (version !== info.latest) {
        return fail(res, 400, `Only the newest release (${info.latest}) can be installed from here.`);
    }
    if (info.current && updater.compareVersions(info.current, version) >= 0) {
        return sendJson(res, 200, { ok: true, alreadyCurrent: true, version });
    }

    const job = jobs.start(`Update kaspad to ${version}`, (onLine) => updater.applyUpdate(version, onLine));
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
    nginx.writeAll(list, cfg);
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
        nginx.writeAll(loadProxies(), loadNodeConfig());
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
        nginx.writeAll(list, loadNodeConfig());
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
        onLine(`Requesting a certificate for ${proxy.domain} from Let's Encrypt.`);
        onLine('This needs port 80 reachable from the internet for that domain.');
        await certbot.issue(proxy.domain, email, { staging: Boolean(body.staging), onLine });

        const current = loadProxies();
        const target = current.find((p) => p.id === proxy.id);
        if (target) {
            target.ssl = { ...target.ssl, mode: 'letsencrypt', email, forceHttps: target.ssl?.forceHttps !== false };
            saveProxies(current);
            nginx.writeAll(current, loadNodeConfig());
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

route('POST', /^\/api\/proxy\/reload$/, async (req, res) => {
    if (!proxyEnabled()) return fail(res, 409, 'The reverse proxy is switched off.');
    try {
        nginx.writeAll(loadProxies(), loadNodeConfig());
        await nginx.reload();
        sendJson(res, 200, { ok: true, test: await nginx.testConfig() });
    } catch (err) {
        fail(res, 400, err.message);
    }
});

route('POST', /^\/api\/proxy\/renew$/, async (req, res) => {
    const job = jobs.start('Renew certificates', async (onLine) => {
        await certbot.renew({ onLine });
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
route('POST', /^\/api\/publish\/([a-z]+)$/, async (req, res, match) => {
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
        nginx.writeAll(rolled, loadNodeConfig());
        throw new Error(`nginx rejected the configuration: ${cause.message}`);
    }
    return proxy;
}

// ----------------------------------------------------------- setup wizard --

route('GET', /^\/api\/setup\/([a-z]+)$/, async (req, res, match) => {
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
route('POST', /^\/api\/setup\/([a-z]+)$/, async (req, res, match) => {
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

    const [subdomain] = existing ? [null] : duckdns.normalizeDomains(body.subdomain);
    if (!existing && (!subdomain || !/^[a-z0-9-]{1,63}$/.test(subdomain))) {
        return fail(res, 400, 'Enter the DuckDNS subdomain you created, without the .duckdns.org.');
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

    const domain = existing ? existing.domain : `${subdomain}.duckdns.org`;

    const job = jobs.start(`Publish ${plan.service.label} on ${domain}`, async (onLine) => {
        // --- the name -------------------------------------------------------
        if (existing) {
            onLine(`Using ${domain}, which is already on this panel.`);
        } else {
            onLine(`Saving ${domain} and telling DuckDNS where this machine is.`);
            const mgr = loadManagerConfig();
            // DuckDNS refreshes every name on the account in one call, so a
            // second service on a second name adds to the list rather than
            // replacing it.
            const names = new Set(duckdns.normalizeDomains(mgr.duckdns.domains));
            names.add(subdomain);
            mgr.duckdns.domains = [...names].join(',');
            if (token) mgr.duckdns.token = token;
            mgr.duckdns.enabled = true;
            saveManagerConfig(mgr);
            duckdns.scheduleFromConfig(log);

            const update = await duckdns.update({ domains: mgr.duckdns.domains, token: token || storedToken });
            onLine(`DuckDNS: ${update.body.split('\n').join(' ').trim()}`);
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
            const cfg = loadNodeConfig();
            if (!cfg.services.borsh) {
                onLine("Switching on the node's wRPC Borsh listener.");
                cfg.services.borsh = true;
                saveNodeConfig(cfg);
                await applyNodeConfig(cfg, onLine);
            }
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
            onLine("Asking Let's Encrypt for a certificate. This needs port 80 open from the internet.");
            try {
                await certbot.issue(domain, email, { onLine });
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
        nginx.writeAll(loadProxies(), loadNodeConfig());
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

    onLine(`Stratum ports: ${cfg.instances.map((i) => `${i.stratumPort} (diff ${i.minShareDiff})`).join(', ')}`);
    onLine(`Published to the host: ${published.length ? published.join(', ') : 'none - local miners only'}`);
    onLine(`Connecting to kaspad gRPC on port ${ports(nodeCfg).grpc}.`);

    onLine('Building the stratum bridge image if needed...');
    await dockerctl.compose(['build', 'bridge'], { onLine, profile: 'mining', timeoutMs: 90 * 60_000 });

    onLine('Starting the stratum bridge...');
    await dockerctl.compose(['up', '-d', '--force-recreate', 'bridge'], { onLine, profile: 'mining', timeoutMs: 10 * 60_000 });

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

route('GET', /^\/api\/mining$/, async (req, res) => {
    const cfg = bridge.loadBridgeConfig();
    const [state, stats, version] = await Promise.all([
        dockerctl.containerState(dockerctl.BRIDGE_CONTAINER),
        cfg.enabled ? bridge.fetchStats() : Promise.resolve(null),
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
    nginx.writeAll(loadProxies(), loadNodeConfig());
    onLine('Starting the reverse proxy on ports 80 and 443.');
    await dockerctl.compose(['up', '-d', 'proxy'], { onLine, profile: 'proxy', timeoutMs: 5 * 60_000 });
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

route('GET', /^\/api\/mining\/stats$/, async (req, res) => {
    const cfg = bridge.loadBridgeConfig();
    if (!cfg.enabled) return sendJson(res, 200, { enabled: false, reachable: false, workers: [], blocks: [] });
    sendJson(res, 200, { enabled: true, ...(await bridge.fetchStats()) });
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

    apps.ensureSecrets();
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

route('GET', /^\/api\/apps\/(kachat|desktop|nextcloud)\/refs$/, async (req, res, match, url) => {
    try {
        sendJson(res, 200, await apps.listRefs(match[1], { force: url.searchParams.get('force') === '1' }));
    } catch (err) {
        fail(res, 502, err.message);
    }
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

route('GET', /^\/api\/apps\/(kachat|desktop|nextcloud)\/check$/, async (req, res, match) => {
    const name = match[1];
    try {
        const upstream = await apps.checkUpstream(name, apps.loadAppsConfig());
        const built = apps.readBuildRecord(name);
        sendJson(res, 200, {
            ...upstream,
            builtSha: built.sha,
            builtAt: built.builtAt,
            // No published releases upstream, so "up to date" means the running
            // image was built from the commit the branch currently points at.
            updateAvailable: Boolean(built.sha) && built.sha !== upstream.latestSha,
            neverBuilt: !built.sha,
        });
    } catch (err) {
        fail(res, 502, err.message);
    }
});

route('POST', /^\/api\/apps\/(kachat|desktop|nextcloud)\/update$/, async (req, res, match) => {
    const name = match[1];
    const cfg = apps.loadAppsConfig();
    if (!cfg[name].enabled) return fail(res, 409, `${apps.APPS[name].label} is switched off.`);

    const app = apps.APPS[name];
    const job = jobs.start(`Update ${app.label}`, async (onLine) => {
        onLine(`Rebuilding ${app.label} from ${app.repo}@${cfg[name].ref}...`);
        // --no-cache: the build context is a git ref, and Docker would otherwise
        // reuse the layer it already has for that same ref string.
        await dockerctl.compose(['build', '--no-cache', ...app.services.filter((sv) => sv === 'kachat-app' || sv === 'nextcloud')], {
            onLine,
            profile: app.profile,
            timeoutMs: 120 * 60_000,
        });
        await dockerctl.compose(['up', '-d', '--force-recreate', ...app.services], {
            onLine,
            profile: app.profile,
            timeoutMs: 20 * 60_000,
        });
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

/** Where the panel's own port is published, which .env records. */
const managerBind = () => (readEnvFile().MANAGER_BIND || '0.0.0.0').trim();
const isLoopbackBind = () => ['127.0.0.1', '::1', 'localhost'].includes(managerBind());

/**
 * Sets, changes or clears the panel's own password.
 *
 * The hash lives in .env and is read into the process once at startup, so this
 * writes the file and then has a sidecar replace this container. Nothing is
 * lost: the node, the proxy and every app keep running, and the browser is told
 * to expect a few seconds of silence.
 *
 * With no password set this route is open, because the panel is open -- anyone
 * who can reach it already has the Docker socket. Once one exists the ordinary
 * gate applies, and changing it also requires the current one, so a borrowed
 * session cannot lock the owner out.
 */
route('POST', /^\/api\/auth\/password$/, async (req, res) => {
    const body = await readBody(req);

    if (authConfigured() && !verifyPassword(String(body.current || ''))) {
        return fail(res, 403, 'That is not the current password.');
    }

    if (body.clear) {
        if (!authConfigured()) return sendJson(res, 200, { ok: true, unchanged: true });
        // Removing the password is only sane while the panel is on loopback and
        // not on a domain; either would leave the Docker socket open.
        const published = loadProxies().some((p) => p.target?.kind === 'manager');
        if (published) {
            return fail(res, 409, 'This panel is published on a domain, so it cannot have its password removed.', {
                details: ['Unpublish it first, or keep the password.'],
            });
        }
        if (!isLoopbackBind()) {
            return fail(res, 409, `This panel is bound to ${managerBind()}, not to loopback, so it needs a password.`);
        }
        updateEnvFile({ ADMIN_PASSWORD_HASH: '' });
        await selfservice.restartManager();
        return sendJson(res, 202, { ok: true, cleared: true, restarting: true });
    }

    const password = String(body.password || '');
    if (password.length < 8) return fail(res, 400, 'Use at least 8 characters.');
    if (password.length > 200) return fail(res, 400, 'That is longer than 200 characters.');

    updateEnvFile({ ADMIN_PASSWORD_HASH: hashPassword(password) });
    await selfservice.restartManager();
    sendJson(res, 202, { ok: true, restarting: true });
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
    const repo = (url.searchParams.get('repo') || 'KaspaSilver/Quick-Start-Kaspa').trim();
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
            repo: String(body.repo || 'KaspaSilver/Quick-Start-Kaspa').trim(),
            ref: String(body.ref || 'main').trim(),
        });
        log(`panel update started in ${started.container}`);
        sendJson(res, 200, started);
    } catch (err) {
        fail(res, 400, err.message);
    }
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
        sendJson(res, 200, started);
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

// ------------------------------------------------------------------- server --

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    // The embedded KaChat dashboard. Behind the same auth as everything else,
    // since it can delete indexed content.
    if (url.pathname === kachatProxy.MOUNT || url.pathname.startsWith(`${kachatProxy.MOUNT}/`)) {
        if (authRequired() && !isAuthenticated(req)) return fail(res, 401, 'Not signed in.');
        return kachatProxy.handle(req, res, url);
    }

    const isApi = url.pathname.startsWith('/api/') || url.pathname === '/healthz';

    if (!isApi) return serveStatic(req, res, url.pathname);

    const match = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname));
    if (!match) return fail(res, 404, 'Not found');

    // With no password set the panel is open; the installer binds it to
    // loopback so "open" means "open to this machine".
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
 * Published ports used to bind 0.0.0.0 whenever nobody had chosen an address.
 * The default is loopback now, which is right for a new install and wrong for
 * an old one: a config written before the change carries no key to read, and
 * its node was reachable from the network. Letting the new default apply would
 * quietly unpublish a public node on its next restart, so pin those installs to
 * what they were already doing and leave the choice where it was made.
 */
function migrateBindAddress(cfg) {
    try {
        const raw = JSON.parse(fs.readFileSync(NODE_CONFIG_FILE, 'utf8'));
        if (!raw?.expose || raw.expose.bindAddress !== undefined) return;
        cfg.expose.bindAddress = '0.0.0.0';
        saveNodeConfig(cfg);
        log('published ports pinned to 0.0.0.0, which is where this install already had them');
    } catch (err) {
        log(`could not read the published-port address: ${err.message}`);
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
    migrateBindAddress(cfg);
    writeArgsFile(cfg);
    renderPortsOverride(cfg);
    nginx.writeAll(loadProxies(), cfg);
    bridge.writeBridgeFiles(bridge.loadBridgeConfig(), cfg);

    const appsCfg = apps.loadAppsConfig();
    apps.ensureSecrets();
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
        authRequired()
            ? 'auth           : password required'
            : 'auth           : none (panel expects to be bound to 127.0.0.1)',
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
    duckdns.scheduleFromConfig(log);

    // Certificates are valid for 90 days; a daily attempt is what certbot's own
    // packaging recommends and is a no-op until one is close to expiry.
    const renewTimer = setInterval(
        () => {
            if (jobs.busy) return;
            if (!loadProxies().some((p) => p.ssl?.mode === 'letsencrypt')) return;
            jobs.start('Automatic certificate renewal', async (onLine) => {
                await certbot.renew({ onLine });
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
