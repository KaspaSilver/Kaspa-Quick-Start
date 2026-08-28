import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CONF_DIR } from './paths.js';
import { readJson, writeJson, updateEnvFile, readEnvFile } from './store.js';

/**
 * The optional applications that ride along with the node: the KaChat indexer
 * and Nextcloud. Both are upstream projects of ours, both live behind a compose
 * profile so they do not exist until switched on, and both track a git ref that
 * the panel can move forward.
 */

export const APPS_STATE_FILE = path.join(CONF_DIR, 'apps.json');
export const APPS_PORTS_OVERRIDE = path.join(CONF_DIR, 'apps-ports.yml');

export const APPS = {
    kachat: {
        label: 'KaChat indexer',
        repo: 'KaspaSilver/KaChat-Indexer',
        profile: 'kachat',
        services: ['kachat-db', 'kachat-app'],
        // Reads live chain data, so it is pointless before the node has synced.
        needsSyncedNode: true,
        container: 'kaspa-node-kachat',
        // Ports the container listens on, and whether publishing them is useful.
        ports: {
            api: { port: 3080, label: 'KaPosts REST API' },
            chat: { port: 8600, label: 'Chat indexer API' },
        },
        // The admin dashboard is never published: the panel proxies it instead,
        // which is also why upstream binds it to loopback.
        adminPort: 3081,
    },
    nextcloud: {
        label: 'Nextcloud',
        repo: 'KaspaSilver/KaChat-NextCloud',
        profile: 'nextcloud',
        services: ['nextcloud-db', 'nextcloud-redis', 'nextcloud-imaginary', 'nextcloud'],
        // A file server: nothing to do with the chain, so never gated on it.
        needsSyncedNode: false,
        container: 'kaspa-node-nextcloud',
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
    },
    nextcloud: {
        enabled: false,
        ref: 'main',
        publish: { web: true },
        hostPort: 8080,
        adminUser: 'admin',
        trustedDomains: 'localhost',
    },
};

export const loadAppsConfig = () => readJson(APPS_STATE_FILE, DEFAULT_APPS_CONFIG);
export const saveAppsConfig = (cfg) => writeJson(APPS_STATE_FILE, cfg);

// ------------------------------------------------------------- validation --

const REF_RE = /^[A-Za-z0-9._\/-]{1,100}$/;
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

    // --- Nextcloud ---
    const n = input.nextcloud ?? {};
    cfg.nextcloud.enabled = Boolean(n.enabled);
    const nref = String(n.ref ?? 'main').trim();
    if (!REF_RE.test(nref)) errors.push('Nextcloud branch or tag contains invalid characters.');
    else cfg.nextcloud.ref = nref;

    cfg.nextcloud.publish = { web: n.publish?.web !== false };

    const port = Number(n.hostPort ?? 8080);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) errors.push('Nextcloud port must be between 1024 and 65535.');
    else cfg.nextcloud.hostPort = port;

    const user = String(n.adminUser ?? 'admin').trim();
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(user)) errors.push('Nextcloud admin user is invalid.');
    else cfg.nextcloud.adminUser = user;

    const domains = String(n.trustedDomains ?? 'localhost').trim();
    if (!DOMAIN_LIST_RE.test(domains)) errors.push('Trusted domains must be a comma-separated list of hostnames.');
    else cfg.nextcloud.trustedDomains = domains || 'localhost';

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
        NEXTCLOUD_ADMIN_USER: cfg.nextcloud.adminUser,
        NEXTCLOUD_TRUSTED_DOMAINS: cfg.nextcloud.trustedDomains,
    });
}

// -------------------------------------------------------------- port file --

export function renderAppsPortsOverride(cfg) {
    const lines = [
        '# Generated by the Kaspa Node Control panel - edits here are overwritten.',
        '# Published ports for the optional applications.',
        'services:',
    ];
    const published = { kachat: [], nextcloud: [] };

    lines.push('  kachat-app:');
    lines.push('    ports:');
    const kachatPorts = [];
    if (cfg.kachat.publish.api) kachatPorts.push(APPS.kachat.ports.api.port);
    if (cfg.kachat.publish.chat) kachatPorts.push(APPS.kachat.ports.chat.port);
    if (!kachatPorts.length) lines.push('      []');
    for (const port of kachatPorts) lines.push(`      - "0.0.0.0:${port}:${port}/tcp"`);
    published.kachat = kachatPorts;

    lines.push('  nextcloud:');
    lines.push('    ports:');
    if (cfg.nextcloud.publish.web) {
        lines.push(`      - "0.0.0.0:${cfg.nextcloud.hostPort}:80/tcp"`);
        published.nextcloud = [cfg.nextcloud.hostPort];
    } else {
        lines.push('      []');
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
export async function checkUpstream(name, cfg) {
    const app = APPS[name];
    if (!app) throw new Error(`Unknown app "${name}".`);
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
