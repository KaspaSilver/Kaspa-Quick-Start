import fs from 'node:fs';
import path from 'node:path';
import {
    ENV_FILE,
    MANAGER_CONFIG_FILE,
    NODE_CONFIG_FILE,
    PROXIES_FILE,
} from './paths.js';

// ---------------------------------------------------------------- defaults --

export const NETWORKS = {
    mainnet: { label: 'Mainnet', p2p: 16111, grpc: 16110, borsh: 17110, json: 18110, args: [] },
    'testnet-10': {
        label: 'Testnet 10',
        p2p: 16211,
        grpc: 16210,
        borsh: 17210,
        json: 18210,
        args: ['--testnet', '--netsuffix=10'],
    },
};

export const DEFAULT_NODE_CONFIG = {
    network: 'mainnet',
    // Which listeners kaspad binds inside the container. wRPC-JSON is not
    // listed: the manager itself speaks to it for status, so it is always on.
    services: { grpc: true, borsh: true },
    // Which of those get a published host port, i.e. what "going public" means.
    expose: { p2p: true, grpc: true, borsh: true, json: false },
    flags: {
        archival: false,
        unsaferpc: false,
        perfMetrics: false,
        disableUpnp: false,
        noDnsSeed: false,
        enableUnsyncedMining: false,
        sanity: false,
        noLogFiles: false,
    },
    tuning: {
        logLevel: 'info',
        outpeers: 8,
        maxinpeers: 128,
        rpcmaxclients: 128,
        maxTrackedAddresses: 0,
        ramScale: 1,
        retentionPeriodDays: null,
        asyncThreads: null,
        rocksdbPreset: '',
    },
    peering: {
        externalip: '',
        uacomment: '',
        connectPeers: [],
        addPeers: [],
    },
    extraArgs: [],
};

export const DEFAULT_MANAGER_CONFIG = {
    duckdns: { enabled: false, domains: '', token: '', intervalMinutes: 5, lastResult: null, lastRunAt: null },
    updates: { channel: 'stable', lastCheckedAt: null, latestKnown: null, autoCheck: true },
};

// ------------------------------------------------------------------- io ----

function readJson(file, fallback) {
    try {
        const raw = fs.readFileSync(file, 'utf8');
        return mergeDefaults(JSON.parse(raw), fallback);
    } catch {
        return structuredClone(fallback);
    }
}

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

// Recursive defaults fill so a config written by an older version keeps working
// after new keys are added. Arrays are replaced wholesale, not merged.
function mergeDefaults(value, defaults) {
    if (Array.isArray(defaults)) return Array.isArray(value) ? value : structuredClone(defaults);
    if (defaults && typeof defaults === 'object') {
        const out = {};
        for (const key of Object.keys(defaults)) {
            out[key] = mergeDefaults(value?.[key], defaults[key]);
        }
        // Preserve unknown keys so nothing the user set is silently dropped.
        for (const key of Object.keys(value ?? {})) {
            if (!(key in out)) out[key] = value[key];
        }
        return out;
    }
    return value === undefined ? structuredClone(defaults) : value;
}

export const loadNodeConfig = () => readJson(NODE_CONFIG_FILE, DEFAULT_NODE_CONFIG);
export const saveNodeConfig = (cfg) => writeJson(NODE_CONFIG_FILE, cfg);

export const loadManagerConfig = () => readJson(MANAGER_CONFIG_FILE, DEFAULT_MANAGER_CONFIG);
export const saveManagerConfig = (cfg) => writeJson(MANAGER_CONFIG_FILE, cfg);

export const loadProxies = () => readJson(PROXIES_FILE, []);
export const saveProxies = (list) => writeJson(PROXIES_FILE, list);

// ------------------------------------------------------------- .env file ----

export function readEnvFile() {
    const out = {};
    let raw;
    try {
        raw = fs.readFileSync(ENV_FILE, 'utf8');
    } catch {
        return out;
    }
    for (const line of raw.split(/\r?\n/)) {
        const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
        if (!match) continue;
        out[match[1]] = match[2].replace(/^"(.*)"$/, '$1');
    }
    return out;
}

// Rewrites in place, preserving comments and key order. The file is a bind
// mount of a single host file, so it must never be replaced via rename.
export function updateEnvFile(updates) {
    let raw = '';
    try {
        raw = fs.readFileSync(ENV_FILE, 'utf8');
    } catch {
        /* first write */
    }
    const lines = raw.split(/\r?\n/);
    const remaining = new Map(Object.entries(updates));

    const next = lines.map((line) => {
        const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
        if (!match || !remaining.has(match[1])) return line;
        const key = match[1];
        const value = remaining.get(key);
        remaining.delete(key);
        return `${key}=${value}`;
    });

    for (const [key, value] of remaining) next.push(`${key}=${value}`);
    fs.writeFileSync(ENV_FILE, `${next.join('\n').replace(/\n+$/, '')}\n`, 'utf8');
}
