import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONF_DIR, ensureDirs, KASPAD_ARGS_FILE, NODE_CONFIG_FILE, PROXIES_FILE } from './lib/paths.js';
import {
    DEFAULT_NODE_CONFIG,
    NETWORKS,
    loadManagerConfig,
    loadNodeConfig,
    loadProxies,
    readEnvFile,
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
import { nodeSnapshot, rpc } from './lib/rpc.js';
import { jobs } from './lib/jobs.js';
import {
    authConfigured,
    authRequired,
    clearCookie,
    isAuthenticated,
    issueSession,
    sessionCookie,
    verifyPassword,
} from './lib/auth.js';

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
    const [state, snapshot, version, published, disk] = await Promise.all([
        dockerctl.containerState(dockerctl.KASPAD_CONTAINER),
        nodeSnapshot(),
        updater.runningVersion(),
        dockerctl.publishedPorts(dockerctl.KASPAD_CONTAINER),
        dockerctl.diskUsage(),
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
        version,
        network: cfg.network,
        ports: ports(cfg),
        publicPorts: publicPorts(cfg),
        portMatrix: portMatrix(cfg),
        bindAddress: cfg.expose.bindAddress || '0.0.0.0',
        published,
        disk,
        // When the node next throws away old block data, and what the last one
        // did to the volume.
        pruning: pruning.pruningStatus({
            network: cfg.network,
            sinkBlueScore: Number(snapshot.sinkBlueScore?.blueScore ?? NaN),
            pruningPointHash: snapshot.dag?.pruningPointHash ?? null,
            pruningPointBlueScore: Number(snapshot.pruningPointBlueScore ?? NaN),
            diskBytes: pruning.parseSize(disk?.size),
            synced: Boolean(snapshot.sync?.isSynced ?? snapshot.info?.isSynced ?? false),
        }),
        job: jobs.snapshot(),
    });
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
        if (action === 'start') await dockerctl.compose(['up', '-d', KASPAD_SERVICE], { onLine });
        else if (action === 'stop') await dockerctl.compose(['stop', KASPAD_SERVICE], { onLine, timeoutMs: 5 * 60_000 });
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
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return fail(res, 400, 'A valid contact e-mail is required.');
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
    const [state, stats] = await Promise.all([
        dockerctl.containerState(dockerctl.BRIDGE_CONTAINER),
        cfg.enabled ? bridge.fetchStats() : Promise.resolve(null),
    ]);
    sendJson(res, 200, {
        config: cfg,
        container: state,
        stats,
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
    await dockerctl.compose(['build', ...app.services.filter((sv) => sv === 'kachat-app' || sv === 'nextcloud')], {
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

    onLine(`${app.label} is up.`);
    return { enabled: true };
}

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
        };
    }
    sendJson(res, 200, { config: cfg, apps: state, adminPath: kachatProxy.MOUNT, readiness: await nodeReadiness() });
});

route('PUT', /^\/api\/apps\/(kachat|nextcloud)$/, async (req, res, match) => {
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
    const job = jobs.start(
        `${cfg[name].enabled ? 'Start' : 'Stop'} ${apps.APPS[name].label}`,
        (onLine) => applyAppConfig(name, cfg, onLine),
    );
    sendJson(res, 202, { ok: true, jobId: job.id, config: cfg });
});

route('GET', /^\/api\/apps\/(kachat|nextcloud)\/check$/, async (req, res, match) => {
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

route('POST', /^\/api\/apps\/(kachat|nextcloud)\/update$/, async (req, res, match) => {
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

route('POST', /^\/api\/apps\/(kachat|nextcloud)\/(start|stop|restart)$/, async (req, res, match) => {
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
        duckdns: { ...cfg.duckdns, token: cfg.duckdns.token ? '********' : '' },
        publicIp: await duckdns.publicIp(),
    });
});

route('PUT', /^\/api\/duckdns$/, async (req, res) => {
    const body = await readBody(req);
    const cfg = loadManagerConfig();
    const domains = duckdns.normalizeDomains(body.domains ?? cfg.duckdns.domains);

    if (body.enabled && !domains.length) return fail(res, 400, 'Enter at least one DuckDNS subdomain.');
    for (const d of domains) {
        if (!/^[a-z0-9-]{1,63}$/.test(d)) return fail(res, 400, `"${d}" is not a valid DuckDNS subdomain.`);
    }

    cfg.duckdns.enabled = Boolean(body.enabled);
    cfg.duckdns.domains = domains.join(',');
    // An unchanged masked token must not overwrite the stored one.
    if (typeof body.token === 'string' && body.token && !/^\*+$/.test(body.token)) cfg.duckdns.token = body.token.trim();
    cfg.duckdns.intervalMinutes = Math.max(5, Number(body.intervalMinutes) || 5);

    if (cfg.duckdns.enabled && !cfg.duckdns.token) return fail(res, 400, 'A DuckDNS token is required.');

    saveManagerConfig(cfg);
    duckdns.scheduleFromConfig(log);
    sendJson(res, 200, { ok: true, domains: domains.map((d) => `${d}.duckdns.org`) });
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

async function bootstrap() {
    ensureDirs();

    if (!fs.existsSync(NODE_CONFIG_FILE)) saveNodeConfig(structuredClone(DEFAULT_NODE_CONFIG));
    if (!fs.existsSync(PROXIES_FILE)) saveProxies([]);

    const cfg = loadNodeConfig();
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
