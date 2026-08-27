import http from 'node:http';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONF_DIR, ensureDirs, NODE_CONFIG_FILE, PROXIES_FILE } from './lib/paths.js';
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
import { buildArgs, ports, publicPorts, renderPortsOverride, writeArgsFile } from './lib/kaspad-args.js';
import * as dockerctl from './lib/dockerctl.js';
import * as nginx from './lib/nginx.js';
import * as certbot from './lib/certbot.js';
import * as duckdns from './lib/duckdns.js';
import * as updater from './lib/updater.js';
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

    try {
        await nginx.reload();
        onLine('Reloaded the reverse proxy.');
    } catch (err) {
        onLine(`Proxy reload skipped: ${err.message}`);
    }
    return { args, mappings };
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
        peers: { total: peers.length, inbound, outbound: peers.length - inbound },
        // Inbound peers are the honest signal that the P2P port is reachable
        // from the internet: nobody can dial in if it is closed.
        p2pReachable: peers.length ? inbound > 0 : null,
        version,
        network: cfg.network,
        ports: ports(cfg),
        publicPorts: publicPorts(cfg),
        published,
        disk,
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

route('POST', /^\/api\/node\/(start|stop|restart)$/, async (req, res, match) => {
    const action = match[1];
    const job = jobs.start(`${action} node`, async (onLine) => {
        if (action === 'start') await dockerctl.compose(['up', '-d', KASPAD_SERVICE], { onLine });
        else if (action === 'stop') await dockerctl.compose(['stop', KASPAD_SERVICE], { onLine, timeoutMs: 5 * 60_000 });
        else await dockerctl.compose(['restart', KASPAD_SERVICE], { onLine, timeoutMs: 5 * 60_000 });
    });
    sendJson(res, 202, { ok: true, jobId: job.id });
});

route('GET', /^\/api\/logs$/, async (req, res, match, url) => {
    const tail = Math.min(Number(url.searchParams.get('tail')) || 300, 5000);
    const which = url.searchParams.get('container') === 'proxy' ? dockerctl.PROXY_CONTAINER : dockerctl.KASPAD_CONTAINER;
    sendJson(res, 200, { text: await dockerctl.logs(which, tail) });
});

route('GET', /^\/api\/logs\/stream$/, async (req, res, match, url) => {
    const which = url.searchParams.get('container') === 'proxy' ? dockerctl.PROXY_CONTAINER : dockerctl.KASPAD_CONTAINER;
    const { send, onClose } = sse(req, res);
    const stop = dockerctl.streamLogs(which, (line) => send('line', { line }));
    onClose(stop);
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
    sendJson(res, 200, { proxies: list, targets: nginx.TARGET_KINDS });
});

async function saveProxyList(list, cfg, onLine) {
    saveProxies(list);
    nginx.writeAll(list, cfg);
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

route('POST', /^\/api\/proxy\/reload$/, async (req, res) => {
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
            ? 'Reachable from this machine via its public address.'
            : 'No connection. If this node is behind a home router this can also mean the router does not support NAT hairpinning - check from an outside network too.',
    });
});

// ------------------------------------------------------------------- server --

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
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
    rpc.setUrl(`ws://${KASPAD_SERVICE}:${ports(cfg).json}`);

    log(`stack dir      : ${CONF_DIR}`);
    log(`kaspad version : ${readEnvFile().KASPAD_VERSION || 'unset'}`);
    log(`network        : ${cfg.network} (${JSON.stringify(ports(cfg))})`);
    log(
        authRequired()
            ? 'auth           : password required'
            : 'auth           : none (panel expects to be bound to 127.0.0.1)',
    );

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
