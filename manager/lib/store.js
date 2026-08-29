import fs from 'node:fs';
import path from 'node:path';
import {
    DOMAINS_FILE,
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
    //
    // Both start off. A new node should do nothing but what a node has to do,
    // and each of these has an owner that asks for it: the stratum bridge needs
    // gRPC, the KaChat indexer needs wRPC Borsh, and both say so plainly when
    // they are switched on (miningBlockers, appBlockers) rather than being
    // bound in advance for a feature nobody may use.
    services: { grpc: false, borsh: false },
    // Which of those get a published host port, i.e. what "going public" means.
    // Nothing is published on a fresh install, P2P included: going public is a
    // decision, and it is one that needs a router configured to match, so it
    // belongs to the person installing this and not to a default.
    //
    // bindAddress is the same decision one step further in. Loopback means that
    // even a port switched on by mistake is reachable from this machine only;
    // reaching the network is a second, deliberate choice.
    expose: { p2p: false, grpc: false, borsh: false, json: false, bindAddress: '127.0.0.1' },
    flags: {
        // On for every new install: it is what wallets, explorers and anything
        // asking "what does this address hold" need from a node, and building
        // it afterwards costs more than having it from the start. It can be
        // switched off, unlike --appdir and --yes.
        utxoindex: true,
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
    // Subnets to sweep for miners besides the one this machine sits on. Miners
    // are often on a different subnet behind the router, which cannot be
    // discovered from here -- see network.js.
    scan: { extraSubnets: '' },
    // The reverse proxy claims ports 80 and 443, so it stays off until someone
    // actually wants a domain. null means "not decided yet" and is resolved
    // once, on first boot, from whether the stack is already using it.
    proxy: {
        enabled: null,
        // What the outside world reaches this machine on, which is not always
        // what nginx binds. A router can send external 8443 to this machine's
        // 443, and it has to, on a network where 443 already belongs to
        // something else. The panel needs the outside numbers to write a
        // redirect that lands in the right place and to show an address that
        // can be pasted into a browser.
        publicHttpPort: 80,
        publicHttpsPort: 443,
    },
};

// ------------------------------------------------------------------- io ----

// Exported so modules with their own config file (bridge.js) reuse the same
// defaults-merging behaviour instead of reimplementing it.
export function readJson(file, fallback) {
    try {
        const raw = fs.readFileSync(file, 'utf8');
        return mergeDefaults(JSON.parse(raw), fallback);
    } catch {
        return structuredClone(fallback);
    }
}

export function writeJson(file, value) {
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

export const loadDomains = () => readJson(DOMAINS_FILE, []);
export const saveDomains = (list) => writeJson(DOMAINS_FILE, list);

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
