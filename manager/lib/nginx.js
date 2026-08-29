import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { LETSENCRYPT_DIR, NGINX_CONF_D, NGINX_SNIPPETS } from './paths.js';
import { docker, PROXY_CONTAINER } from './dockerctl.js';
import { htpasswdLine } from './auth.js';
import { ports } from './kaspad-args.js';
import { APPS } from './apps.js';
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
export function validateProxy(proxy, { existing = [], panelHasPassword = true } = {}) {
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

    if (proxy.target?.kind === 'custom') {
        const host = String(proxy.target.host || '').trim();
        if (!host || !/^[A-Za-z0-9._-]{1,253}$/.test(host)) errors.push('Custom target host is invalid.');
        const port = Number(proxy.target.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) errors.push('Custom target port must be 1-65535.');
        if (!['http', 'https'].includes(proxy.target.scheme || 'http')) errors.push('Custom scheme must be http or https.');
    }

    if (proxy.ssl?.mode === 'letsencrypt' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(proxy.ssl.email || ''))) {
        errors.push("A contact e-mail is required for Let's Encrypt certificates.");
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
        case 'desktop':
        case 'nextcloud': {
            const app = APPS[proxy.target.kind];
            return { scheme: 'http', host: app.publish.hostname, port: app.publish.port, websocket: app.publish.websocket, grpc: false };
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

export const certPath = (domain) => path.join(LETSENCRYPT_DIR, 'live', domain, 'fullchain.pem');
export const hasCertificate = (domain) => fs.existsSync(certPath(domain));

// ------------------------------------------------------------- rendering ----

// Docker's embedded DNS, which every container on a user-defined network can
// reach. It is what resolves the upstream variables above, per request.
const RESOLVER = ['    resolver 127.0.0.11 valid=10s ipv6=off;', '    resolver_timeout 5s;'];

const BASE_CONF = `# Generated by the Kaspa Node Control panel - edits here are overwritten.
#
# The map below turns a websocket upgrade request into the right Connection
# header; kaspad's wRPC endpoints are websockets, so proxying them needs it.
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    # Served for every domain so a certificate can be issued before the vhost
    # for that domain exists.
    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
        default_type "text/plain";
    }

    location / {
        return 404 "No proxy host is configured for this domain.\\n";
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
    lines.push(up.grpc ? `${i}grpc_pass grpc://${variable};` : `${i}proxy_pass ${up.scheme}://${variable}${uri};`);
    return lines;
}

function locationBlock(up, proxy, indent = '        ', { strip = null } = {}) {
    const i = indent;
    const lines = [];
    if (up.grpc) {
        lines.push(...passTo(up, proxy, i, strip));
        lines.push(`${i}grpc_read_timeout 3600s;`);
        lines.push(`${i}grpc_send_timeout 3600s;`);
        return lines.join('\n');
    }
    lines.push(...passTo(up, proxy, i, strip));
    lines.push(`${i}proxy_http_version 1.1;`);
    lines.push(`${i}proxy_set_header Host $host;`);
    lines.push(`${i}proxy_set_header X-Real-IP $remote_addr;`);
    lines.push(`${i}proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`);
    lines.push(`${i}proxy_set_header X-Forwarded-Proto $scheme;`);
    if (up.websocket) {
        lines.push(`${i}proxy_set_header Upgrade $http_upgrade;`);
        lines.push(`${i}proxy_set_header Connection $connection_upgrade;`);
        // wRPC connections are long lived and mostly idle between notifications.
        lines.push(`${i}proxy_read_timeout 3600s;`);
        lines.push(`${i}proxy_send_timeout 3600s;`);
    } else {
        lines.push(`${i}proxy_read_timeout 300s;`);
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
function extraLocations(proxy) {
    const publish = APPS[proxy.target?.kind]?.publish;
    if (!publish) return [];

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
        };
        lines.push(`    location ^~ ${route.location} {`);
        lines.push(locationBlock(up, proxy));
        lines.push('    }');
        lines.push('');
    }
    return lines;
}

/**
 * One vhost for one name, serving every service published on it.
 *
 * A domain used to mean a service. It does not any more: a Kaspa node and a
 * KaChat indexer are the obvious pair to put on the same free DuckDNS name, and
 * they can share it because they answer on different paths. So the unit of
 * rendering is the name, and each service on it contributes a location.
 *
 * Whoever holds `/` gets the root; everyone else gets a prefix that is stripped
 * before the request reaches them, so the service behind it needs to know
 * nothing about being proxied.
 */
export function renderDomain(domain, hosts, nodeConfig) {
    const live = hosts.filter((p) => p.enabled !== false);
    // Longest path first: nginx picks the longest matching prefix anyway, and
    // reading the file top to bottom should agree with what it does.
    const ordered = [...live].sort((a, b) => normalizePath(b.path).length - normalizePath(a.path).length);

    const tlsHost = live.find((p) => p.ssl?.mode === 'letsencrypt');
    const useTls = Boolean(tlsHost) && hasCertificate(domain);
    const forceHttps = useTls && tlsHost.ssl?.forceHttps !== false;
    const anyGrpc = live.some((p) => upstreamFor(p, nodeConfig).grpc);

    const out = ['# Generated by the Kaspa Node Control panel - edits here are overwritten.'];
    for (const proxy of live) {
        if (proxy.rateLimit) {
            out.push(`limit_req_zone $binary_remote_addr zone=kz_${proxy.id}:10m rate=${Number(proxy.rateLimit)}r/s;`);
        }
    }

    // Every service on this name, as location blocks.
    const locations = () => {
        const lines = [];
        for (const proxy of ordered) {
            const up = upstreamFor(proxy, nodeConfig);
            const path = normalizePath(proxy.path);
            if (path === '/') {
                lines.push(...extraLocations(proxy));
                lines.push('    location / {');
                lines.push(locationBlock(up, proxy));
                lines.push('    }');
            } else {
                // The rewrite is what makes the prefix invisible to the service:
                // /borsh and /borsh/anything both arrive as / and /anything. A
                // proxy_pass with a URI cannot do both without doubling slashes.
                lines.push(`    location ^~ ${path} {`);
                lines.push(locationBlock(up, proxy, '        ', { strip: path }));
                lines.push('    }');
            }
            lines.push('');
        }
        return lines;
    };

    out.push('');
    out.push('server {');
    out.push('    listen 80;');
    out.push('    listen [::]:80;');
    // gRPC over plaintext is h2c. Since nginx 1.25.1 `http2 on` accepts both
    // h2c and HTTP/1.1 on the same listener, so the ACME challenge still works.
    if (anyGrpc) out.push('    http2 on;');
    out.push(`    server_name ${domain};`);
    out.push('');
    out.push(...RESOLVER);
    out.push('');
    out.push('    location /.well-known/acme-challenge/ {');
    out.push('        root /var/www/certbot;');
    out.push('        default_type "text/plain";');
    out.push('    }');
    out.push('');
    if (forceHttps) {
        out.push('    location / {');
        out.push('        return 301 https://$host$request_uri;');
        out.push('    }');
    } else {
        out.push(...locations());
    }
    out.push('}');

    if (useTls) {
        out.push('');
        out.push('server {');
        out.push(`    listen 443 ssl${anyGrpc ? ' http2' : ''};`);
        out.push(`    listen [::]:443 ssl${anyGrpc ? ' http2' : ''};`);
        if (!anyGrpc) out.push('    http2 on;');
        out.push(`    server_name ${domain};`);
        out.push('');
        out.push(`    ssl_certificate     /etc/letsencrypt/live/${domain}/fullchain.pem;`);
        out.push(`    ssl_certificate_key /etc/letsencrypt/live/${domain}/privkey.pem;`);
        out.push('    ssl_protocols TLSv1.2 TLSv1.3;');
        out.push('    ssl_prefer_server_ciphers off;');
        out.push('    ssl_session_cache shared:SSL:10m;');
        out.push('    ssl_session_timeout 1d;');
        out.push('    add_header Strict-Transport-Security "max-age=31536000" always;');
        out.push('');
        out.push('    client_max_body_size 32m;');
        out.push('');
        out.push(...RESOLVER);
        out.push('');
        out.push(...locations());
        out.push('}');
    }

    for (const proxy of live) {
        if (proxy.customSnippet?.trim()) {
            out.push('');
            out.push(`# --- custom snippet: ${normalizePath(proxy.path)} ---`);
            out.push(proxy.customSnippet.trim());
        }
    }

    // A name whose every service is disabled still needs a file, or nginx would
    // fall through to the catch-all and answer for it by accident.
    if (!live.length) return `# Every service on ${domain} is disabled in the control panel.\n`;

    return `${out.join('\n')}\n`;
}

export function writeAll(proxies, nodeConfig) {
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
        fs.writeFileSync(path.join(NGINX_CONF_D, file), renderDomain(domain, hosts, nodeConfig), 'utf8');
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
