import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { COMPOSE_FILE, CONF_DIR } from './paths.js';
import { readJson, writeJson, updateEnvFile, readEnvFile, NETWORKS } from './store.js';

/**
 * The optional applications that ride along with the node: the KaChat indexer,
 * the KaChat desktop client and Nextcloud. All are upstream projects of ours,
 * all live behind a compose profile so they do not exist until switched on, and
 * all track a git ref the panel can move forward.
 */

export const APPS_STATE_FILE = path.join(CONF_DIR, 'apps.json');
export const APPS_PORTS_OVERRIDE = path.join(CONF_DIR, 'apps-ports.yml');

export const APPS = {
    kachat: {
        label: 'KaChat-Indexer',
        repo: 'KaspaSilver/KaChat-Indexer',
        profile: 'kachat',
        services: ['kachat-db', 'kachat-app'],
        // Reads live chain data, so it is pointless before the node has synced.
        needsSyncedNode: true,
        container: 'kaspa-node-kachat',
        // Where nginx sends a domain pointed at this app. The hostname is the
        // one compose gives the container on the internal network, so this
        // works whether or not the port is published to the host.
        //
        // The indexer is two APIs on two ports and a client expects both under
        // one name: the KaPosts content API answers on 3080 and takes the root,
        // and the chat side -- handshakes, group traffic, push registration --
        // is a separate process on 8600. Upstream's INSTALL.md says to add
        // those as custom locations on the same proxy host, so the panel does
        // it rather than leaving it as homework.
        publish: {
            hostname: 'kachat-app',
            port: 3080,
            websocket: true,
            routes: [
                { location: '/handshakes', port: 8600 },
                { location: '/contextual-messages', port: 8600 },
                { location: '/payments', port: 8600 },
                { location: '/self-stash', port: 8600 },
                { location: '/group-messages', port: 8600 },
                { location: '/group-control', port: 8600 },
                { location: '/v1/push', port: 8600 },
            ],
            // Not decoration. `/self-stash-gc-orphans` is a top-level
            // maintenance route that lives under the `/self-stash` prefix, so
            // proxying the chat routes would publish it by accident; nginx
            // takes the longest matching prefix, which is why a 404 here wins.
            // `/internal/push` is the injection point upstream is emphatic
            // about never exposing, and it is one prefix away from a route that
            // is exposed on purpose.
            deny: ['/self-stash-gc-orphans', '/internal/push'],
        },
        // Ports the container listens on, and whether publishing them is useful.
        ports: {
            api: { port: 3080, label: 'KaPosts REST API' },
            chat: { port: 8600, label: 'Chat indexer API' },
        },
        // The admin dashboard is never published: the panel proxies it instead,
        // which is also why upstream binds it to loopback.
        adminPort: 3081,
    },
    desktop: {
        label: 'KaChat-Desktop',
        repo: 'KaspaSilver/KaChat-Desktop',
        profile: 'kachat-desktop',
        services: ['kachat-desktop'],
        // A browser client rather than an indexer: it talks to whichever node
        // and indexer it is pointed at, so there is nothing local to wait for.
        needsSyncedNode: false,
        container: 'kaspa-node-kachat-desktop',
        publish: { hostname: 'kachat-desktop', port: 5173, websocket: true },
        ports: {
            web: { port: 5173, label: 'KaChat Desktop', hostPort: 5173 },
        },
        adminPort: null,
    },
    bot: {
        label: 'KaChat Bot',
        repo: 'KaspaSilver/Kaspa-Block-Notifier',
        profile: 'bot',
        services: ['kachat-bot'],
        // It subscribes to the node's UTXO changes, so it wants a node that is
        // up -- but not a synced one. A node still catching up simply has not
        // found the block yet.
        needsSyncedNode: false,
        container: 'kaspa-node-kachat-bot',
        // Nothing to publish: it dials out to the node and to the network, and
        // listens on nothing at all.
        publish: null,
        ports: {},
        adminPort: null,
    },
    gift: {
        label: 'KaChat Gift Service',
        repo: 'KaspaSilver/KaChat-Gift-Service',
        profile: 'gift',
        services: ['gift'],
        // Nothing to do with the chain: it asks Apple and Google about a device
        // and then pays from a wallet. The node only matters when it pays.
        needsSyncedNode: false,
        container: 'kaspa-node-gift',
        publish: { hostname: 'gift', port: 8770, websocket: false },
        ports: {
            api: { port: 8770, label: 'Gift claim API' },
        },
        adminPort: null,
    },

    nextcloud: {
        label: 'Nextcloud',
        // Not a repository of ours. It is the official image with ffmpeg added
        // for video thumbnails, so what it tracks is a docker tag, and "is
        // there an update" is a question for the registry rather than GitHub.
        repo: null,
        image: 'nextcloud:stable',
        profile: 'nextcloud',
        services: ['nextcloud-db', 'nextcloud-redis', 'nextcloud-imaginary', 'nextcloud'],
        // A file server: nothing to do with the chain, so never gated on it.
        needsSyncedNode: false,
        container: 'kaspa-node-nextcloud',
        publish: {
            hostname: 'nextcloud',
            port: 80,
            websocket: false,
            // Nextcloud is a file server: an upload is one request that runs to
            // whatever size the person is storing, so the proxy imposes no limit
            // of its own. Nextcloud's own settings decide.
            maxBodySize: '0',
        },
        ports: {
            web: { port: 80, label: 'Nextcloud web', hostPort: 8080 },
        },
        adminPort: null,
    },
};

export const DEFAULT_APPS_CONFIG = {
    kachat: {
        enabled: false,
        ref: 'main',
        network: 'mainnet',
        publish: { api: false, chat: false },
        fcmProjectId: '',
        // Server-side translation of KaPosts. Its engine is a container of its
        // own -- gigabytes of language models -- so this is only the setting;
        // whether the engine exists at all is the `translate` service.
        translate: {
            // Every language here is a model held in memory for as long as the
            // engine runs, so this list is a memory bill, not a preference.
            languages: 'en,es,pt,fr,de,ru,zh,ja,ko,ar,vi',
        },
    },
    desktop: {
        enabled: false,
        ref: 'main',
        // Useless unpublished: the whole point is opening it in a browser.
        publish: { web: true },
        hostPort: 5173,
    },
    bot: {
        enabled: false,
        ref: 'main',
        // Everything else it needs -- the addresses, the alias, the wallet key
        // -- is in conf/bot/bot.env, because one of them is a key and this file
        // is not the place for one.
        network: 'mainnet',
    },
    gift: {
        enabled: false,
        ref: 'main',
        // The claim endpoint is what the phones call, so it is useless unless
        // something outside can reach it. Published through the proxy rather
        // than on a host port: it holds a wallet, and wants a name and HTTPS.
        publish: { api: false },
        // Everything the service is actually configured with lives in
        // conf/gift/, written by the wizards. None of it belongs in here: this
        // file is read and rewritten constantly and is not the place for a key.
        apple: { enabled: false, teamId: '', keyId: '', bundleId: 'com.kachat.app' },
        android: { enabled: false, packageName: 'com.kachat.app' },
        amountKas: 3,
        dailyCapKas: 300,
        poolFloorKas: 50,
        // record-only until somebody deliberately says otherwise.
        mode: 'record-only',
    },

    nextcloud: {
        enabled: false,
        ref: 'main',
        publish: { web: true },
        // Not 8080. That is this panel's own port, and Docker refuses to start a
        // container whose published port is already taken, so a Nextcloud left
        // on 8080 could never come up.
        hostPort: 8081,
        adminUser: 'admin',
        trustedDomains: 'localhost',
    },
};

/**
 * Host ports the stack already publishes, so Nextcloud cannot be pointed at one
 * of them. Docker's own error for this arrives long after the button was
 * pressed and reads like an internal fault, which is no help at all when the
 * fix is simply to pick another number.
 */
export function reservedHostPorts() {
    const panel = Number(process.env.PORT || 8080);
    const ports = new Map([
        [panel, 'this control panel'],
        [80, 'the reverse proxy'],
        [443, 'the reverse proxy'],
        [5555, 'the stratum bridge'],
    ]);
    for (const [name, net] of Object.entries(NETWORKS)) {
        for (const key of ['p2p', 'grpc', 'borsh', 'json']) {
            ports.set(net[key], `the node on ${name}`);
        }
    }
    return ports;
}

/**
 * Every language set this panel has ever shipped as its default.
 *
 * A default that has been written to disk is indistinguishable from a choice,
 * and this file is saved whenever anything else on it changes -- so the first
 * unrelated save freezes the language list at whatever the default was that
 * day, and the indexer adding a language can never reach that install again.
 *
 * A saved list that is exactly one of these was nobody's decision, so it moves
 * forward with the default. Anything else is a real choice and is left alone,
 * including a list that merely resembles one.
 */
const SUPERSEDED_LANGUAGE_SETS = new Set([
    // Before the indexer added Vietnamese (KaChat-Indexer a3ef567).
    'en,es,pt,fr,de,ru,zh,ja,ko,ar',
]);

function upgradeLanguages(translate) {
    if (!SUPERSEDED_LANGUAGE_SETS.has(translate?.languages)) return translate;
    return { ...translate, languages: DEFAULT_APPS_CONFIG.kachat.translate.languages };
}

export function loadAppsConfig() {
    const stored = readJson(APPS_STATE_FILE, {});

    // Defaults are filled in per app, not just when the whole file is missing.
    // A file written before an app existed has no key for it, and returning
    // that as-is hands the panel a config with a hole in it: the page that
    // reads config.<app>.ref throws, stops before it populates the rest of the
    // form, and the next save posts those empty fields back as if they were
    // real. Adding an app has to be survivable by an install that predates it.
    const cfg = structuredClone(DEFAULT_APPS_CONFIG);
    for (const [name, defaults] of Object.entries(DEFAULT_APPS_CONFIG)) {
        const saved = stored[name] ?? {};
        cfg[name] = { ...defaults, ...saved };
        // publish is a nested object, so a shallow merge would drop any key the
        // saved copy happens not to carry.
        if (defaults.publish) cfg[name].publish = { ...defaults.publish, ...(saved.publish ?? {}) };
        // Same for translate, added later than the file most people have.
        if (defaults.translate) cfg[name].translate = { ...defaults.translate, ...(saved.translate ?? {}) };
        if (defaults.translate) cfg[name].translate = upgradeLanguages(cfg[name].translate);
    }

    // Earlier versions defaulted Nextcloud to 8080, which is this panel's port,
    // so it could never start. Move those forward rather than leaving somebody
    // with a saved setting that only fails.
    if (reservedHostPorts().has(Number(cfg.nextcloud.hostPort))) {
        cfg.nextcloud.hostPort = DEFAULT_APPS_CONFIG.nextcloud.hostPort;
    }
    return cfg;
}

export const saveAppsConfig = (cfg) => writeJson(APPS_STATE_FILE, cfg);

// ------------------------------------------------------------- validation --

// Git ref names: no "..", which is also what the panel's "something else"
// placeholder contains, so a placeholder can never be saved as a branch.
const REF_RE = /^(?!.*\.\.)[A-Za-z0-9._\/-]{1,100}$/;
const DOMAIN_LIST_RE = /^[A-Za-z0-9.\-, ]{0,300}$/;

export function validateAppsConfig(input) {
    const errors = [];
    const cfg = structuredClone(DEFAULT_APPS_CONFIG);

    // --- KaChat ---
    const k = input.kachat ?? {};
    cfg.kachat.enabled = Boolean(k.enabled);
    // The ref is interpolated into a compose build context (`repo.git#ref`), so
    // it has to stay inside the characters git refs are allowed to use.
    const kref = String(k.ref ?? 'main').trim();
    if (!REF_RE.test(kref)) errors.push('KaChat branch or tag contains invalid characters.');
    else cfg.kachat.ref = kref;

    cfg.kachat.network = ['mainnet', 'testnet-10'].includes(k.network) ? k.network : 'mainnet';
    cfg.kachat.publish = { api: Boolean(k.publish?.api), chat: Boolean(k.publish?.chat) };

    const fcm = String(k.fcmProjectId ?? '').trim();
    if (fcm && !/^[a-z0-9-]{1,64}$/.test(fcm)) errors.push('FCM project id may only contain lowercase letters, digits and dashes.');
    cfg.kachat.fcmProjectId = fcm;

    // --- KaChat Desktop ---
    const d = input.desktop ?? {};
    cfg.desktop.enabled = Boolean(d.enabled);
    const dref = String(d.ref ?? 'main').trim();
    if (!REF_RE.test(dref)) errors.push('KaChat Desktop branch or tag contains invalid characters.');
    else cfg.desktop.ref = dref;

    cfg.desktop.publish = { web: d.publish?.web !== false };

    const dport = Number(d.hostPort ?? DEFAULT_APPS_CONFIG.desktop.hostPort);
    const dtaken = reservedHostPorts().get(dport);
    if (!Number.isInteger(dport) || dport < 1 || dport > 65535) {
        errors.push('KaChat Desktop port must be a number between 1 and 65535.');
    } else if (dtaken) {
        errors.push(`Port ${dport} is already used by ${dtaken}. Pick another for KaChat Desktop.`);
    } else {
        cfg.desktop.hostPort = dport;
    }

    // --- Nextcloud ---
    const n = input.nextcloud ?? {};
    cfg.nextcloud.enabled = Boolean(n.enabled);
    const nref = String(n.ref ?? 'main').trim();
    if (!REF_RE.test(nref)) errors.push('Nextcloud branch or tag contains invalid characters.');
    else cfg.nextcloud.ref = nref;

    cfg.nextcloud.publish = { web: n.publish?.web !== false };

    const port = Number(n.hostPort ?? DEFAULT_APPS_CONFIG.nextcloud.hostPort);
    const taken = reservedHostPorts().get(port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
        errors.push('Nextcloud port must be between 1024 and 65535.');
    } else if (taken && cfg.nextcloud.publish.web) {
        errors.push(
            `Port ${port} is already used by ${taken}, so Nextcloud cannot start on it. Pick another one, ` +
                `for example ${port + 1}.`,
        );
    } else {
        cfg.nextcloud.hostPort = port;
    }

    const user = String(n.adminUser ?? 'admin').trim();
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(user)) errors.push('Nextcloud admin user is invalid.');
    else cfg.nextcloud.adminUser = user;

    const domains = String(n.trustedDomains ?? 'localhost').trim();
    if (!DOMAIN_LIST_RE.test(domains)) {
        errors.push('Trusted domains may only contain hostnames, separated by spaces or commas.');
    } else {
        // Stored space separated whatever was typed. NEXTCLOUD_TRUSTED_DOMAINS is
        // read by a shell `for` loop over an unquoted variable, so it splits on
        // whitespace and a comma would stay stuck to the hostname before it.
        cfg.nextcloud.trustedDomains = domains.split(/[\s,]+/).filter(Boolean).join(' ') || 'localhost';
    }

    return { cfg, errors };
}

/** Reasons an app cannot be switched on right now. */
export function appBlockers(name, cfg, nodeCfg) {
    const blockers = [];
    if (name === 'kachat' && cfg.kachat.enabled) {
        if (!nodeCfg.services.borsh) {
            blockers.push(
                'The KaChat indexer reads the chain over wRPC Borsh, and that is currently switched off. ' +
                    'Turn the wRPC Borsh listener on under Kaspad, Ports. It does not have to be public.',
            );
        }
        if (nodeCfg.network !== cfg.kachat.network) {
            blockers.push(
                `The indexer is set to ${cfg.kachat.network} but your node is running ${nodeCfg.network}. ` +
                    'These need to match, otherwise the indexer looks for a chain that is not there.',
            );
        }
    }

    if (name === 'bot' && cfg.bot?.enabled) {
        // It watches for rewards over gRPC and sends the notification over
        // wRPC Borsh, so it needs both. Neither has to be published: it is a
        // container on the same network as the node.
        if (!nodeCfg.services.grpc) {
            blockers.push(
                'The bot watches for block rewards over gRPC, and that listener is switched off. ' +
                    'Turn gRPC on under Kaspad, Ports. It does not have to be public.',
            );
        }
        if (!nodeCfg.services.borsh) {
            blockers.push(
                'The bot sends its notification over wRPC Borsh, and that listener is switched off. ' +
                    'Turn wRPC Borsh on under Kaspad, Ports. It does not have to be public.',
            );
        }
        if (nodeCfg.network !== cfg.bot.network) {
            blockers.push(
                `The bot is set to ${cfg.bot.network} but your node is running ${nodeCfg.network}. ` +
                    'These have to match, or it watches an address on a chain the node is not following.',
            );
        }
    }

    return blockers;
}

// ---------------------------------------------------------------- secrets --

const randomSecret = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');

/**
 * Database passwords and shared secrets are generated once and then left alone
 * -- regenerating them would lock the apps out of their own existing volumes.
 */
export function ensureSecrets() {
    const env = readEnvFile();
    const updates = {};
    const need = {
        KACHAT_DB_PASSWORD: () => randomSecret(24),
        KACHAT_PUSH_SECRET: () => randomSecret(32),
        NEXTCLOUD_DB_PASSWORD: () => randomSecret(24),
        NEXTCLOUD_DB_ROOT_PASSWORD: () => randomSecret(24),
        NEXTCLOUD_IMAGINARY_SECRET: () => randomSecret(24),
        NEXTCLOUD_ADMIN_PASSWORD: () => randomSecret(18),
    };
    for (const [key, make] of Object.entries(need)) {
        if (!env[key]) updates[key] = make();
    }
    if (Object.keys(updates).length) updateEnvFile(updates);
    return { ...env, ...updates };
}

/** Writes the non-secret settings the compose file reads for these services. */
export function writeAppsEnv(cfg) {
    updateEnvFile({
        KACHAT_REF: cfg.kachat.ref,
        KACHAT_NETWORK: cfg.kachat.network,
        KACHAT_NODE_PORT: cfg.kachat.network === 'testnet-10' ? 17210 : 17110,
        KACHAT_FCM_PROJECT_ID: cfg.kachat.fcmProjectId,
        // Read by the translation engine at startup and by nothing else. It
        // only loads what is listed here, so changing it means recreating it.
        LT_LOAD_ONLY: cfg.kachat.translate?.languages || 'en,es,pt,fr,de,ru,zh,ja,ko,ar,vi',
        // Both the image tag and the build arg, so switching refs actually
        // rebuilds rather than re-tagging the layers already cached.
        KACHAT_DESKTOP_REF: cfg.desktop?.ref || 'main',
        BOT_REF: cfg.bot?.ref || 'main',
        BOT_NETWORK: cfg.bot?.network || 'mainnet',
        // The node's ports move with its network, and the bot dials both.
        BOT_NODE_GRPC_PORT: cfg.bot?.network === 'testnet-10' ? 16210 : 16110,
        BOT_NODE_BORSH_PORT: cfg.bot?.network === 'testnet-10' ? 17210 : 17110,
        NEXTCLOUD_ADMIN_USER: cfg.nextcloud.adminUser,
        NEXTCLOUD_TRUSTED_DOMAINS: cfg.nextcloud.trustedDomains,
    });
}

// -------------------------------------------------------------- port file --

/**
 * Whether the base compose file actually defines a service.
 *
 * This override is merged into every compose command, so a block naming a
 * service the base file has never heard of does not break one app: it makes the
 * whole project invalid ("neither an image nor a build context specified"), and
 * every compose call the panel makes stops working, including starting the
 * node.
 *
 * That state is reachable whenever the manager is newer than the stack files on
 * disk, which is exactly what an update looks like from the inside. Skipping the
 * block is the graceful version: the app cannot publish a port until its service
 * exists, and nothing else is affected.
 */
function composeDefines(service) {
    try {
        return new RegExp(`^\\s{2}${service}:\\s*$`, 'm').test(fs.readFileSync(COMPOSE_FILE, 'utf8'));
    } catch {
        // Unreadable compose file: write nothing rather than risk poisoning it.
        return false;
    }
}

export function renderAppsPortsOverride(cfg) {
    const lines = [
        '# Generated by the Kaspa Node Control panel - edits here are overwritten.',
        '# Published ports for the optional applications.',
        'services:',
    ];
    const published = { kachat: [], desktop: [], nextcloud: [] };

    const kachatPorts = [];
    if (cfg.kachat.publish.api) kachatPorts.push(APPS.kachat.ports.api.port);
    if (cfg.kachat.publish.chat) kachatPorts.push(APPS.kachat.ports.chat.port);
    if (composeDefines('kachat-app')) {
        lines.push('  kachat-app:');
        lines.push('    ports:');
        if (!kachatPorts.length) lines.push('      []');
        for (const port of kachatPorts) lines.push(`      - "0.0.0.0:${port}:${port}/tcp"`);
    }
    published.kachat = kachatPorts;

    if (composeDefines('kachat-desktop')) {
        lines.push('  kachat-desktop:');
        lines.push('    ports:');
        if (cfg.desktop?.publish?.web) {
            const hostPort = cfg.desktop.hostPort || 5173;
            lines.push(`      - "0.0.0.0:${hostPort}:5173/tcp"`);
            published.desktop = [hostPort];
        } else {
            lines.push('      []');
        }
    }

    if (composeDefines('nextcloud')) {
        lines.push('  nextcloud:');
        lines.push('    ports:');
        if (cfg.nextcloud.publish.web) {
            lines.push(`      - "0.0.0.0:${cfg.nextcloud.hostPort}:80/tcp"`);
            published.nextcloud = [cfg.nextcloud.hostPort];
        } else {
            lines.push('      []');
        }
    }

    fs.mkdirSync(CONF_DIR, { recursive: true });
    fs.writeFileSync(APPS_PORTS_OVERRIDE, `${lines.join('\n')}\n`, 'utf8');
    return published;
}

// --------------------------------------------------------------- upstream --

const ghHeaders = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'kaspa-one-click-node-manager',
    'X-GitHub-Api-Version': '2022-11-28',
};

/**
 * How far the tracked branch has moved since the running image was built. These
 * projects publish no releases, so the honest unit is "commits behind", not a
 * version number.
 */
/**
 * The branches and tags a repository actually has, so the branch to track can
 * be picked from a list rather than typed from memory.
 *
 * GitHub allows sixty unauthenticated calls an hour per address, and this costs
 * two of them, so the answer is held for a while. Refreshing is an explicit
 * action in the panel rather than something that happens on every page load.
 */
const refsCache = new Map();
const REFS_CACHE_MS = 10 * 60_000;

async function ghList(url, take) {
    const res = await fetch(url, { headers: ghHeaders, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
        const hint = res.status === 403 ? ' (GitHub rate limit, try again shortly)' : '';
        throw new Error(`GitHub returned ${res.status}${hint}`);
    }
    return (await res.json()).map(take);
}

export async function listRefs(name, { force = false } = {}) {
    const app = APPS[name];
    if (!app) throw new Error(`Unknown app "${name}".`);

    const hit = refsCache.get(name);
    if (!force && hit && Date.now() - hit.at < REFS_CACHE_MS) return hit.value;

    const base = `https://api.github.com/repos/${app.repo}`;
    // Tags are a nice-to-have; a repository with none is normal, and a failure
    // to list them should not cost the branches too.
    const [branches, tags] = await Promise.all([
        ghList(`${base}/branches?per_page=100`, (b) => b.name),
        ghList(`${base}/tags?per_page=100`, (t) => t.name).catch(() => []),
    ]);

    const value = { repo: app.repo, branches, tags };
    refsCache.set(name, { at: Date.now(), value });
    return value;
}

/**
 * Whether the tag an app is built on has moved, for an app built on somebody
 * else's image rather than on a repository of ours.
 *
 * A tag is not a version: `nextcloud:stable` means something different every
 * few weeks and the same name refers to a new image each time. The only honest
 * answer is what the registry currently calls that tag, compared with the
 * digest the local image was pulled at.
 *
 * Anonymous, because the image is public: the registry hands out a pull token
 * to anyone who asks.
 */
async function checkImageUpstream(app) {
    const [repository, tag] = app.image.split(':');
    const path = repository.includes('/') ? repository : `library/${repository}`;

    const auth = await fetch(
        `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${path}:pull`,
        { signal: AbortSignal.timeout(15_000) },
    );
    if (!auth.ok) throw new Error(`Docker Hub would not issue a token (${auth.status}).`);
    const { token } = await auth.json();

    // HEAD, because the digest is in the header and the body is a manifest
    // nobody here reads. Both media types are accepted: an image published as
    // a multi-architecture list answers with one, a single image with the other.
    const manifest = await fetch(`https://registry-1.docker.io/v2/${path}/manifests/${tag}`, {
        method: 'HEAD',
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: [
                'application/vnd.oci.image.index.v1+json',
                'application/vnd.docker.distribution.manifest.list.v2+json',
                'application/vnd.oci.image.manifest.v1+json',
                'application/vnd.docker.distribution.manifest.v2+json',
            ].join(', '),
        },
        signal: AbortSignal.timeout(15_000),
    });
    if (!manifest.ok) throw new Error(`Docker Hub returned ${manifest.status} for ${app.image}.`);

    const latestSha = manifest.headers.get('docker-content-digest') || '';
    return {
        repo: app.image,
        ref: tag,
        image: app.image,
        latestSha,
        shortSha: latestSha.replace(/^sha256:/, '').slice(0, 12),
        message: `the current ${app.image} on Docker Hub`,
        author: null,
        date: manifest.headers.get('last-modified') || null,
        url: `https://hub.docker.com/_/${repository.replace(/^library\//, '')}`,
    };
}

export async function checkUpstream(name, cfg) {
    const app = APPS[name];
    if (!app) throw new Error(`Unknown app "${name}".`);
    if (app.image) return checkImageUpstream(app);
    const ref = cfg[name].ref;

    const res = await fetch(`https://api.github.com/repos/${app.repo}/commits/${encodeURIComponent(ref)}`, {
        headers: ghHeaders,
        signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
        const hint = res.status === 403 ? ' (GitHub API rate limit - try again shortly)' : '';
        throw new Error(`GitHub returned ${res.status} for ${app.repo}@${ref}${hint}`);
    }
    const commit = await res.json();

    return {
        repo: app.repo,
        ref,
        latestSha: commit.sha,
        shortSha: String(commit.sha).slice(0, 7),
        message: (commit.commit?.message || '').split('\n')[0].slice(0, 200),
        author: commit.commit?.author?.name || null,
        date: commit.commit?.author?.date || null,
        url: commit.html_url,
    };
}

/** The commit an image was actually built from, if the build recorded one. */
export function buildRecordFile(name) {
    return path.join(CONF_DIR, `${name}-build.json`);
}

export function readBuildRecord(name) {
    return readJson(buildRecordFile(name), { sha: null, ref: null, builtAt: null });
}

export function writeBuildRecord(name, record) {
    writeJson(buildRecordFile(name), record);
}

/**
 * How the last attempt to start or stop an app turned out.
 *
 * Without this, an app whose build failed looks exactly like one that is still
 * building: switched on, no container, and a panel that says "starting up"
 * forever. The job that failed is in memory only, so it is gone the moment the
 * manager restarts, and the reason for the failure goes with it.
 */
const lastRunFile = (name) => path.join(CONF_DIR, `${name}-lastrun.json`);

export function readLastRun(name) {
    return readJson(lastRunFile(name), { ok: null, error: null, at: null, enabled: null });
}

export function writeLastRun(name, record) {
    writeJson(lastRunFile(name), { ...record, error: summarizeError(record.error), at: new Date().toISOString() });
}

/**
 * Picks the one line worth showing out of a failed build.
 *
 * A broken `docker compose build` reports itself with a page of context: the
 * Dockerfile excerpt, the layer graph, the numbered step. The sentence that
 * says what actually went wrong is somewhere in the middle, so it gets found
 * and the rest is left to the log.
 */
export function summarizeError(error) {
    if (!error) return null;
    const lines = String(error)
        .split('\n')
        // BuildKit stamps every line with its step number and a timestamp
        // ("#25 6.607 error: ..."), which hides the start of the real message.
        .map((l) => l.trim().replace(/^#\d+\s+[\d.]+\s+/, ''))
        .filter(Boolean);

    const pick =
        // A compiler or tool saying why, which is the most useful thing there is.
        lines.find((l) => /^error(\[[^\]]+\])?:/i.test(l)) ??
        // BuildKit's summary of which step died.
        lines.find((l) => l.startsWith('failed to solve:')) ??
        lines[0];

    const trimmed = pick.length > 240 ? `${pick.slice(0, 237)}...` : pick;
    return trimmed.endsWith('.') ? trimmed : `${trimmed}.`;
}

// ------------------------------------------------------- nextcloud runtime --

/**
 * Nextcloud settings that only take effect at install time.
 *
 * The image reads NEXTCLOUD_TRUSTED_DOMAINS once, inside the branch that runs
 * the first-time install. Change the value afterwards and nothing happens: the
 * container is already installed, so that branch never runs again. The panel
 * would look like it had applied a setting it had not.
 *
 * The same is true of the admin password, which is only used to create the
 * account. Both are therefore applied with `occ` against the running container,
 * which is what the install would have done.
 *
 * Everything here needs the container up. A stopped Nextcloud simply defers:
 * whatever is in the config is applied the next time this runs.
 */
export const NEXTCLOUD_CONTAINER = APPS.nextcloud.container;

/** Runs an `occ` command as the web user inside the Nextcloud container. */
function occArgs(args, { env = {} } = {}) {
    const envFlags = Object.keys(env).flatMap((k) => ['-e', `${k}=${env[k]}`]);
    return ['exec', '-u', 'www-data', ...envFlags, NEXTCLOUD_CONTAINER, 'php', 'occ', ...args];
}

/**
 * Rewrites the trusted-domain list to match the config.
 *
 * Indices are positional, so the list is written from 0 upward and anything
 * left over from a longer previous list is removed. Without that, shortening
 * the list would leave the dropped names still trusted.
 */
export async function syncTrustedDomains(docker, cfg, onLine = () => {}) {
    const wanted = String(cfg.nextcloud.trustedDomains || 'localhost')
        .split(/[\s,]+/)
        .filter(Boolean);
    if (!wanted.length) return;

    for (const [i, domain] of wanted.entries()) {
        await docker(occArgs(['config:system:set', 'trusted_domains', String(i), '--value', domain]));
    }
    // Clear stale trailing entries. `occ` exits non-zero once there is nothing
    // at an index, which is the signal to stop rather than an error.
    for (let i = wanted.length; i < wanted.length + 10; i++) {
        try {
            await docker(occArgs(['config:system:delete', 'trusted_domains', String(i)]));
        } catch {
            break;
        }
    }
    onLine(`Trusted domains: ${wanted.join(', ')}`);
}

/** The admin account's name and password, as the panel needs to show them. */
export function nextcloudAdmin() {
    const env = readEnvFile();
    return {
        user: env.NEXTCLOUD_ADMIN_USER || 'admin',
        password: env.NEXTCLOUD_ADMIN_PASSWORD || '',
    };
}

/**
 * Changes the admin password on the running instance and records the new one.
 *
 * `occ` takes it from the environment rather than an argument, so it never
 * appears in the container's process list.
 */
export async function setNextcloudAdminPassword(docker, password) {
    const { user } = nextcloudAdmin();
    await docker(occArgs(['user:resetpassword', '--password-from-env', user], { env: { OC_PASS: password } }), {
        timeoutMs: 120_000,
    });
    updateEnvFile({ NEXTCLOUD_ADMIN_PASSWORD: password });
}
