import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { NGINX_CONF_D, NGINX_SNIPPETS } from './paths.js';
import { docker, PROXY_CONTAINER } from './dockerctl.js';
import { htpasswdLine } from './auth.js';
import { ports } from './kaspad-args.js';
import { APPS, KACHAT_TESTNET_PUBLISH, KACHAT_NAMES_PUBLISH, KACHAT_NAMES_TESTNET_PUBLISH, NAMES_ROUTES } from './apps.js';

/** How a published app kind is served: its hostname, port, routes, blocks, CORS. */
const OWN_PUBLISH = {
    'kachat-testnet': KACHAT_TESTNET_PUBLISH,
    'kachat-names': KACHAT_NAMES_PUBLISH,
    'kachat-names-testnet': KACHAT_NAMES_TESTNET_PUBLISH,
};
const publishOf = (kind) => OWN_PUBLISH[kind] ?? APPS[kind]?.publish;
/** The .kachat Domains server that takes the names paths on each indexer's name. */
const NAMES_FOR_INDEXER = { kachat: KACHAT_NAMES_PUBLISH, 'kachat-testnet': KACHAT_NAMES_TESTNET_PUBLISH };
import { DASHBOARD_PORT } from './bridge.js';

const DOMAIN_RE = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))*$/;
// A path is a location prefix, so it has to be safe to paste into the nginx
// grammar and into a rewrite. No spaces, no traversal, no regex metacharacters.
const PATH_RE = /^\/(?:[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*)?$/;

/** '/', '/borsh', '/borsh/' and 'borsh' all mean the same location. */
export function normalizePath(value) {
    const raw = String(value ?? '/').trim();
    if (!raw || raw === '/') return '/';
    const withSlash = raw.startsWith('/') ? raw : `/${raw}`;
    return withSlash.replace(/\/+$/, '') || '/';
}

/**
 * PATH_RE allows dots, because a path like /v1.2 is legitimate, which means it
 * also allows `..`. A traversal segment in a location prefix is not an nginx
 * escape on its own, but it is never what someone meant, and letting it through
 * puts a `..` into a rewrite regex. Rejected separately rather than by making
 * the character class hostile to ordinary names.
 */
const hasTraversal = (path) => path.split('/').some((segment) => segment === '..' || segment === '.');
const ID_RE = /^[a-f0-9]{12}$/;

export const newId = () => crypto.randomBytes(6).toString('hex');

export const TARGET_KINDS = {
    borsh: { label: 'Kaspad wRPC Borsh', websocket: true, grpc: false },
    json: { label: 'Kaspad wRPC JSON', websocket: true, grpc: false },
    grpc: { label: 'Kaspad gRPC', websocket: false, grpc: true },
    manager: { label: 'This control panel', websocket: false, grpc: false },
    bridge: { label: 'Stratum bridge dashboard', websocket: false, grpc: false },
    kachat: { label: 'KaChat indexer API', websocket: true, grpc: false },
    'kachat-testnet': { label: 'KaChat indexer API (testnet-10)', websocket: true, grpc: false },
    'kachat-names': { label: '.kachat Domains API', websocket: false, grpc: false },
    'kachat-names-testnet': { label: '.kachat Domains API (testnet-10)', websocket: false, grpc: false },
    desktop: { label: 'KaChat Desktop', websocket: true, grpc: false },
    nextcloud: { label: 'Nextcloud', websocket: false, grpc: false },
    custom: { label: 'Custom host:port', websocket: false, grpc: false },
};

/**
 * Checks a bare domain name, for the places that hold one without a proxy host
 * around it. Returns the normalised name so callers store the same form the
 * validator accepted rather than whatever case it was typed in.
 */
export function validateDomainName(name) {
    const domain = String(name || '').trim().toLowerCase();
    if (!domain) return { domain, error: 'Domain is required.' };
    if (domain.length > 253 || !DOMAIN_RE.test(domain)) return { domain, error: `"${domain}" is not a valid domain name.` };
    return { domain, error: null };
}

/** Throws on anything that would let a value escape into the nginx grammar. */
export function validateProxy(proxy, { existing = [], panelHasPassword = true, names = null } = {}) {
    const errors = [];
    const domain = String(proxy.domain || '').trim().toLowerCase();

    // Publishing the panel is the one way to undo the "it is only on loopback"
    // assumption that lets it run without a password. nginx reaches the manager
    // over the internal network no matter what the panel is bound to, so this
    // has to be caught here rather than by the port binding.
    if (proxy.target?.kind === 'manager' && !panelHasPassword && !proxy.auth?.enabled) {
        errors.push(
            'This panel has no admin password, so it cannot be put on a domain. ' +
                'Set one under Global settings, or tick "Require a username and password" for this host.',
        );
    }

    if (!domain) errors.push('Domain is required.');
    else if (domain.length > 253 || !DOMAIN_RE.test(domain)) errors.push(`"${domain}" is not a valid domain name.`);
    // Only a name on the tunnel ever reaches this proxy, so a host for any other
    // name would be configured and never answer.
    else if (names && !names.includes(domain)) {
        errors.push(`${domain} is not one of your names. Add it from a service's Set up first, under Tunnel & domains.`);
    }
    // A domain can carry several services now, each on its own path, so what
    // has to be unique is the pair. Two things answering the same URL is the
    // only arrangement nginx cannot resolve.
    const path = normalizePath(proxy.path);
    if (!PATH_RE.test(path) || hasTraversal(path)) {
        errors.push(`"${proxy.path}" is not a valid path. Use something like /borsh.`);
    }
    else if (existing.some((p) => p.id !== proxy.id && p.domain === domain && normalizePath(p.path) === path)) {
        const clash = existing.find((p) => p.id !== proxy.id && p.domain === domain && normalizePath(p.path) === path);
        errors.push(
            path === '/'
                ? `${domain} already serves ${TARGET_KINDS[clash.target?.kind]?.label ?? 'something'} at its root. Give this one a path of its own.`
                : `${domain}${path} is already taken by ${TARGET_KINDS[clash.target?.kind]?.label ?? 'another host'}.`,
        );
    }

    if (!TARGET_KINDS[proxy.target?.kind]) errors.push('Unknown target type.');
    // The tunnel hands nginx plain HTTP/1.1, and gRPC needs HTTP/2 all the way.
    if (proxy.target?.kind === 'grpc' && proxy.enabled !== false) {
        errors.push('Kaspad gRPC cannot go through a Cloudflare Tunnel. Publish wRPC Borsh instead: wallets and KDX use that.');
    }

    if (proxy.target?.kind === 'custom') {
        const host = String(proxy.target.host || '').trim();
        if (!host || !/^[A-Za-z0-9._-]{1,253}$/.test(host)) errors.push('Custom target host is invalid.');
        // Inside the proxy's container, localhost is nginx itself.
        else if (['localhost', '127.0.0.1', '::1'].includes(host.toLowerCase())) {
            errors.push("Use the machine's network address, like 192.168.1.20, not localhost. The proxy runs in its own container, where localhost is the proxy.");
        }
        const port = Number(proxy.target.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push('Custom target port must be 1-65535.');
        if (!['http', 'https'].includes(proxy.target.scheme || 'http')) errors.push('Custom scheme must be http or https.');
    }

    if (proxy.auth?.enabled) {
        if (!/^[A-Za-z0-9._-]{1,64}$/.test(String(proxy.auth.user || ''))) errors.push('Basic-auth user is invalid.');
        const hasStored = Boolean(proxy.auth.htpasswd);
        if (!hasStored && String(proxy.auth.password || '').length < 6) {
            errors.push('Basic-auth password must be at least 6 characters.');
        }
    }

    for (const entry of proxy.allowlist ?? []) {
        if (!/^[0-9a-fA-F.:]+(\/\d{1,3})?$/.test(String(entry).trim())) errors.push(`"${entry}" is not a valid IP or CIDR.`);
    }

    if (proxy.id && !ID_RE.test(proxy.id)) errors.push('Invalid proxy id.');

    return errors;
}

/** Resolves a proxy target to the upstream nginx should talk to. */
export function upstreamFor(proxy, nodeConfig) {
    const p = ports(nodeConfig);
    switch (proxy.target.kind) {
        case 'borsh':
            return { scheme: 'http', host: 'kaspad', port: p.borsh, websocket: true, grpc: false };
        case 'json':
            return { scheme: 'http', host: 'kaspad', port: p.json, websocket: true, grpc: false };
        case 'grpc':
            return { scheme: 'grpc', host: 'kaspad', port: p.grpc, websocket: false, grpc: true };
        case 'manager':
            return { scheme: 'http', host: 'manager', port: 8080, websocket: true, grpc: false };
        // The optional apps, each reached by the hostname compose gives it on
        // the internal network, so proxying one never depends on its port being
        // published to the host as well.
        case 'bridge':
            return { scheme: 'http', host: 'bridge', port: DASHBOARD_PORT, websocket: false, grpc: false };
        case 'kachat':
        case 'kachat-testnet':
        case 'kachat-names':
        case 'kachat-names-testnet':
        case 'desktop':
        case 'nextcloud': {
            const publish = publishOf(proxy.target.kind);
            return {
                scheme: 'http',
                host: publish.hostname,
                port: publish.port,
                websocket: publish.websocket,
                grpc: false,
                maxBodySize: publish.maxBodySize ?? null,
            };
        }
        default:
            return {
                scheme: proxy.target.scheme || 'http',
                host: proxy.target.host,
                port: Number(proxy.target.port),
                websocket: Boolean(proxy.websocket),
                grpc: false,
            };
    }
}


// ------------------------------------------------------------- rendering ----

// Docker's embedded DNS, which every container on a user-defined network can
// reach. It is what resolves the upstream variables above, per request.
const RESOLVER = ['    resolver 127.0.0.11 valid=10s ipv6=off;', '    resolver_timeout 5s;'];

/**
 * The one port nginx listens on: where Cloudflare Tunnel traffic arrives
 * (lib/cloudflare.js).
 *
 * Plain HTTP and never published to the host, so the only things that can
 * reach it are containers on the stack's own network, cloudflared among them.
 * That is what makes CF-Connecting-IP safe to believe here: only cloudflared
 * sends it, and it carries the visitor's real address. Without it every request
 * would come from cloudflared, and the indexer, which rate-limits per address,
 * would put every visitor in one bucket. HTTPS is Cloudflare's, at its edge.
 */
export const TUNNEL_PORT = 8081;

const BASE_CONF = `# Generated by the Kaspa Node Control panel - edits here are overwritten.
#
# The map below turns a websocket upgrade request into the right Connection
# header; kaspad's wRPC endpoints are websockets, so proxying them needs it.
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

# What the visitor used to reach Cloudflare. The tunnel listener itself is plain
# http, so $scheme would tell every app it was reached insecurely and some
# (Nextcloud) would redirect to fix it.
map $http_x_forwarded_proto $tunnel_proto {
    default https;
    http    http;
}

# A name the tunnel carries but nothing here serves.
server {
    listen ${TUNNEL_PORT} default_server;
    server_name _;

    location / {
        return 404 "Nothing is published on this name. Put a service on it under Tunnel & domains.\\n";
    }
}
`;

/**
 * The upstream address, held in a variable rather than written straight into
 * proxy_pass.
 *
 * With a literal address nginx resolves the container name when it loads the
 * configuration, and refuses to start at all if the container is not running.
 * That makes every vhost hostage to every service it points at: switch KaChat
 * off, and nginx will not reload for the node either. A variable defers the
 * lookup to the request, so a name can be published before its service exists
 * and answers 502 until it does, which is the honest failure.
 *
 * `strip` is the location prefix to take off the front of the URI, for a
 * service sharing a name. The order matters and is easy to get wrong: `set` is
 * a rewrite-module directive, and `rewrite ... break` stops that module dead,
 * so a `set` written after the rewrite never runs and nginx passes to an empty
 * upstream. Both live here so they cannot drift apart again.
 */
function passTo(up, proxy, i, strip) {
    const variable = `$up_${proxy.id}`;
    const lines = [`${i}set ${variable} ${up.host}:${up.port};`];
    if (strip) lines.push(`${i}rewrite ^${strip}/?(.*)$ /$1 break;`);
    // With a variable in proxy_pass, nginx stops appending the URI itself. A
    // stripped location has already rewritten $uri; an unstripped one should
    // forward exactly what arrived.
    const uri = strip ? '$uri$is_args$args' : '$request_uri';
    lines.push(`${i}proxy_pass ${up.scheme}://${variable}${uri};`);
    return lines;
}

/**
 * CORS headers for a browser app on another origin, plus the preflight answer.
 *
 * Two things this gets right that a hand-written block usually does not:
 *
 *  - `always`, so the header rides on 4xx/5xx too. The indexer answers 400 to a
 *    malformed query and 429 when rate-limited; without `always` those come back
 *    headerless and the browser reports them as CORS failures, not as the errors
 *    they are.
 *  - The OPTIONS branch returns 204 *before* passTo()'s `set`/`rewrite ... break`
 *    and `proxy_pass`, so a preflight never reaches the app (which would 404 or
 *    405 it) and never gets rewritten. It is emitted at the top of the location
 *    for exactly this reason -- `rewrite ... break` stops the rewrite module, and
 *    an `if` placed after it would not run.
 */
function corsBlock(cors, i) {
    if (!cors) return [];
    const methods = cors.methods || 'GET, POST, OPTIONS';
    const headers = cors.headers || 'Content-Type, Accept';
    const maxAge = cors.maxAge ?? 86400;
    const common = [
        `${i}    add_header Access-Control-Allow-Origin $http_origin always;`,
        `${i}    add_header Access-Control-Allow-Methods "${methods}" always;`,
        `${i}    add_header Access-Control-Allow-Headers "${headers}" always;`,
        `${i}    add_header Vary Origin always;`,
    ];
    const lines = [];
    lines.push(`${i}if ($request_method = OPTIONS) {`);
    lines.push(...common);
    lines.push(`${i}    add_header Access-Control-Max-Age ${maxAge} always;`);
    lines.push(`${i}    add_header Content-Type text/plain always;`);
    lines.push(`${i}    add_header Content-Length 0 always;`);
    lines.push(`${i}    return 204;`);
    lines.push(`${i}}`);
    // Strip anything the upstream sent for itself first. The KaPosts API answers
    // with its own `Access-Control-Allow-Origin: *`, and a response carrying two
    // Allow-Origin headers (its `*` and ours) is rejected by every browser as
    // surely as one carrying none -- so hide the upstream's and let the ones
    // below be the only set. Harmless where the upstream sends nothing.
    for (const header of [
        'Access-Control-Allow-Origin',
        'Access-Control-Allow-Methods',
        'Access-Control-Allow-Headers',
        'Access-Control-Allow-Credentials',
        'Access-Control-Expose-Headers',
        'Access-Control-Max-Age',
    ]) {
        lines.push(`${i}proxy_hide_header ${header};`);
    }
    // Same four headers, one indent level out, for the real request.
    for (const line of common) lines.push(line.replace(`${i}    `, `${i}`));
    return lines;
}

function locationBlock(up, proxy, indent = '        ', { strip = null, cors = null } = {}) {
    const i = indent;
    const lines = [];
    // CORS first: the preflight short-circuit has to precede passTo()'s rewrite.
    lines.push(...corsBlock(cors, i));
    lines.push(...passTo(up, proxy, i, strip));
    lines.push(`${i}proxy_http_version 1.1;`);
    // $http_host, not $host: the same name the visitor asked Cloudflare for,
    // which is what every absolute URL an app builds should carry.
    lines.push(`${i}proxy_set_header Host $http_host;`);
    // X-Forwarded-For always; X-Real-IP for everything but Nextcloud.
    //
    // Both carry the same fact, and the second one breaks Nextcloud. Its image
    // runs mod_remoteip trusting X-Real-IP, so Apache rewrites REMOTE_ADDR to
    // the visitor's address before PHP sees it -- at which point Nextcloud's own
    // trusted-proxy check compares that visitor against the proxy ranges, fails,
    // and discards X-Forwarded-Proto. The result is an app that believes every
    // request arrived over plain http and redirects accordingly.
    //
    // Without it REMOTE_ADDR stays the proxy, the check passes, the protocol is
    // honoured, and Nextcloud reads the real client out of X-Forwarded-For
    // itself. Nothing this header was carrying is lost.
    lines.push(`${i}proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`);
    lines.push(`${i}proxy_set_header X-Forwarded-Proto $tunnel_proto;`);
    // Everything but Nextcloud gets X-Real-IP set to the real peer (kachat-audits IDX-021).
    // Unset, nginx passes along whatever X-Real-IP the client sent, and the indexer, which
    // trusts this proxy, took that as the client: a random value per request walked past
    // every per-IP limit. Nextcloud keeps the reasoning above.
    if (up.host !== 'nextcloud') lines.push(`${i}proxy_set_header X-Real-IP $remote_addr;`);
    // An app that stores files wants no limit of its own here; nginx's 1m
    // default rejects anything worth uploading.
    if (up.maxBodySize != null) lines.push(`${i}client_max_body_size ${up.maxBodySize};`);
    if (up.websocket) {
        lines.push(`${i}proxy_set_header Upgrade $http_upgrade;`);
        lines.push(`${i}proxy_set_header Connection $connection_upgrade;`);
        // wRPC connections are long lived and mostly idle between notifications.
        lines.push(`${i}proxy_read_timeout 3600s;`);
        lines.push(`${i}proxy_send_timeout 3600s;`);
    } else {
        // Long enough for a big upload or a server-side file operation to
        // finish. A file server routinely holds a request open for minutes, and
        // 300s cut those off mid-transfer.
        lines.push(`${i}proxy_read_timeout 3600s;`);
        lines.push(`${i}proxy_send_timeout 3600s;`);
        lines.push(`${i}proxy_request_buffering off;`);
    }
    lines.push(`${i}proxy_buffering off;`);
    if (proxy.auth?.enabled) {
        lines.push(`${i}auth_basic "Restricted";`);
        lines.push(`${i}auth_basic_user_file /etc/nginx/snippets/${proxy.id}.htpasswd;`);
    }
    for (const entry of proxy.allowlist ?? []) lines.push(`${i}allow ${String(entry).trim()};`);
    if ((proxy.allowlist ?? []).length) lines.push(`${i}deny all;`);
    if (proxy.rateLimit) lines.push(`${i}limit_req zone=kz_${proxy.id} burst=${Number(proxy.rateLimit) * 2} nodelay;`);
    return lines.join('\n');
}

/**
 * The locations a target needs besides `/`, and the ones that must never
 * answer. Everything here comes from the app's own declaration in apps.js, so
 * the knowledge of which port serves what stays with the app.
 */
function extraLocations(proxy, { namesOn = {} } = {}) {
    const publish = publishOf(proxy.target?.kind);
    if (!publish) return [];

    const cors = publish.cors ?? null;
    const lines = [];
    for (const location of publish.deny ?? []) {
        lines.push(`    location ^~ ${location} {`);
        lines.push('        return 404;');
        lines.push('    }');
        lines.push('');
    }
    for (const route of publish.routes ?? []) {
        const up = {
            scheme: 'http',
            host: publish.hostname,
            port: route.port,
            websocket: Boolean(route.websocket ?? publish.websocket),
            grpc: false,
            maxBodySize: route.maxBodySize ?? publish.maxBodySize ?? null,
        };
        lines.push(`    location ^~ ${route.location} {`);
        lines.push(locationBlock(up, proxy, '        ', { cors }));
        lines.push('    }');
        lines.push('');
    }
    // .kachat names run in their own server (.kachat Domains). On an indexer's name, its paths
    // go there once that network has it installed, so the apps keep one indexer URL.
    const names = NAMES_FOR_INDEXER[proxy.target?.kind];
    if (names && namesOn[proxy.target.kind]) {
        const up = { scheme: 'http', host: names.hostname, port: names.port, websocket: false, grpc: false, maxBodySize: null };
        for (const location of NAMES_ROUTES) {
            lines.push(`    location ^~ ${location} {`);
            lines.push(locationBlock(up, proxy, '        ', { cors }));
            lines.push('    }');
            lines.push('');
        }
    }
    return lines;
}

/** Every service on a name, as location blocks, longest path first. */
function renderLocations(ordered, nodeConfig, { namesOn = {} } = {}) {
    const lines = [];
    for (const proxy of ordered) {
        const up = upstreamFor(proxy, nodeConfig);
        const path = normalizePath(proxy.path);
        const cors = publishOf(proxy.target?.kind)?.cors ?? null;
        if (path === '/') {
            lines.push(...extraLocations(proxy, { namesOn }));
            lines.push('    location / {');
            lines.push(locationBlock(up, proxy, '        ', { cors }));
            lines.push('    }');
        } else {
            // The rewrite is what makes the prefix invisible to the service:
            // /borsh and /borsh/anything both arrive as / and /anything. A
            // proxy_pass with a URI cannot do both without doubling slashes.
            lines.push(`    location ^~ ${path} {`);
            lines.push(locationBlock(up, proxy, '        ', { strip: path, cors }));
            lines.push('    }');
        }
        lines.push('');
    }
    return lines;
}

/**
 * One server block for one public name, serving every service published on it.
 *
 * A name can carry several services, each on its own path: whoever holds `/`
 * gets the root, everyone else gets a prefix that is stripped before the
 * request reaches them, so the service behind it needs to know nothing about
 * being proxied.
 *
 * gRPC is left out: the tunnel's routes are plain HTTP/1.1, and gRPC needs
 * HTTP/2 to the origin. validateProxy refuses new ones; this skips any left
 * from before.
 */
export function renderDomain(domain, hosts, nodeConfig, { namesOn = {} } = {}) {
    const live = hosts.filter((p) => p.enabled !== false && !upstreamFor(p, nodeConfig).grpc);
    // A name whose every service is disabled still needs a file, or nginx would
    // fall through to the catch-all and answer for it by accident.
    if (!live.length) return `# Every service on ${domain} is disabled in the control panel.\n`;

    // Longest path first: nginx picks the longest matching prefix anyway, and
    // reading the file top to bottom should agree with what it does.
    const ordered = [...live].sort((a, b) => normalizePath(b.path).length - normalizePath(a.path).length);

    const out = ['# Generated by the Kaspa Node Control panel - edits here are overwritten.'];
    for (const proxy of live) {
        if (proxy.rateLimit) {
            out.push(`limit_req_zone $binary_remote_addr zone=kz_${proxy.id}:10m rate=${Number(proxy.rateLimit)}r/s;`);
        }
    }

    out.push('');
    out.push('server {');
    out.push(`    listen ${TUNNEL_PORT};`);
    out.push(`    server_name ${domain};`);
    out.push('');
    // Only cloudflared reaches this port (see TUNNEL_PORT), so the header it
    // sets is the visitor's address. Allowlists and rate limits read
    // $remote_addr, so they apply to the visitor too.
    out.push('    set_real_ip_from 0.0.0.0/0;');
    out.push('    set_real_ip_from ::/0;');
    out.push('    real_ip_header CF-Connecting-IP;');
    out.push('');
    // The ceiling for anything that does not set its own. 32m turned away
    // a phone video, which is the ordinary thing to send to a file server.
    out.push('    client_max_body_size 512m;');
    out.push('');
    out.push(...RESOLVER);
    out.push('');
    out.push(...renderLocations(ordered, nodeConfig, { namesOn }));
    out.push('}');

    for (const proxy of live) {
        if (proxy.customSnippet?.trim()) {
            out.push('');
            out.push(`# --- custom snippet: ${normalizePath(proxy.path)} ---`);
            out.push(proxy.customSnippet.trim());
        }
    }

    return `${out.join('\n')}\n`;
}

export function writeAll(proxies, nodeConfig, options = {}) {
    fs.mkdirSync(NGINX_CONF_D, { recursive: true });
    fs.mkdirSync(NGINX_SNIPPETS, { recursive: true });

    fs.writeFileSync(path.join(NGINX_CONF_D, '00-default.conf'), BASE_CONF, 'utf8');

    // Grouped by name: several services can share one, and nginx wants them in
    // one server block rather than in competing ones.
    const byDomain = new Map();
    for (const proxy of proxies) {
        if (!byDomain.has(proxy.domain)) byDomain.set(proxy.domain, []);
        byDomain.get(proxy.domain).push(proxy);
    }

    const keep = new Set(['00-default.conf']);
    for (const [domain, hosts] of byDomain) {
        const file = `10-${domain}.conf`;
        keep.add(file);
        fs.writeFileSync(path.join(NGINX_CONF_D, file), renderDomain(domain, hosts, nodeConfig, options), 'utf8');
    }

    // htpasswd files stay per host: two services on one name can have different
    // passwords, or one and not the other.
    for (const proxy of proxies) {
        const htpasswd = path.join(NGINX_SNIPPETS, `${proxy.id}.htpasswd`);
        if (proxy.auth?.enabled && proxy.auth.htpasswd) {
            fs.writeFileSync(htpasswd, `${proxy.auth.htpasswd}\n`, 'utf8');
        } else if (fs.existsSync(htpasswd)) {
            fs.rmSync(htpasswd);
        }
    }

    // Anything else is a file this panel wrote before and no longer wants --
    // the old per-name 80/443 vhosts and the separate tunnel file among them.
    for (const file of fs.readdirSync(NGINX_CONF_D)) {
        if (file.endsWith('.conf') && !keep.has(file)) fs.rmSync(path.join(NGINX_CONF_D, file));
    }
}

export function storeBasicAuth(proxy) {
    if (proxy.auth?.enabled && proxy.auth.password) {
        proxy.auth.htpasswd = htpasswdLine(proxy.auth.user, proxy.auth.password);
    }
    if (proxy.auth) delete proxy.auth.password;
    return proxy;
}

// ------------------------------------------------------------ nginx control --

export async function testConfig() {
    const { stdout, stderr } = await docker(['exec', PROXY_CONTAINER, 'nginx', '-t']);
    return `${stdout}${stderr}`.trim();
}

export async function reload() {
    await testConfig();
    await docker(['exec', PROXY_CONTAINER, 'nginx', '-s', 'reload']);
}
