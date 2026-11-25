import fs from 'node:fs';
import path from 'node:path';
import {
    DOMAINS_FILE,
    ENV_FILE,
    MANAGER_CONFIG_FILE,
    NODE_CONFIG_FILE,
    NODE_TESTNET_CONFIG_FILE,
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
    // One level per port, and it is the whole story for how that port is reached:
    //   'off'    not published to the host at all (internal-only if anything in
    //            the stack still needs it -- see the derived listeners below);
    //   'local'  published on 127.0.0.1, reachable from this machine only;
    //   'public' published on 0.0.0.0, reachable from the network.
    //
    // Everything starts local, nothing starts public: going public needs a
    // router configured to match, so it is a deliberate choice and never a
    // default. P2P and wRPC-JSON cannot be 'off' -- the node always speaks P2P
    // and this panel always speaks wRPC-JSON -- so they sit at 'local' until
    // someone makes them public.
    //
    // gRPC and wRPC-Borsh start off. Their in-container listener is not set here
    // at all: it follows whatever needs it (the stratum bridge needs gRPC, the
    // K-Digital-Freedom-Indexer needs wRPC-Borsh), worked out when the args are written so
    // a feature nobody uses never leaves a listener bound.
    expose: { p2p: 'local', grpc: 'off', borsh: 'off', json: 'local' },
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
        // When on, the manager rechecks this connection's public address on a
        // timer and, if it has changed, rewrites externalip and restarts the
        // node -- dynamic DNS for the address kaspad advertises to peers.
        externalipAuto: false,
        uacomment: '',
        connectPeers: [],
        addPeers: [],
    },
    extraArgs: [],
};

export const DEFAULT_MANAGER_CONFIG = {
    updates: { channel: 'stable', lastCheckedAt: null, latestKnown: null, autoCheck: true },
    // Subnets to sweep for miners besides the one this machine sits on. Miners
    // are often on a different subnet behind the router, which cannot be
    // discovered from here -- see network.js.
    scan: { extraSubnets: '' },
    // Whether the reverse proxy and the tunnel connector are switched on (Tunnel
    // & domains). null means "not decided yet" and is resolved once, on first
    // boot, from whether the stack is already using it.
    proxy: { enabled: null },
    // The panel's own update check (Global settings > Update the control panel): every few
    // hours, and a banner when one is out. Nothing else is checked on its own.
    panelUpdates: { autoCheck: true },
};

// ------------------------------------------------------------------- io ----

// Said once per file and problem, not on every read: readJson runs on every
// status poll, and the same broken file would otherwise flood the log.
const warned = new Set();
function warnOnce(message) {
    if (warned.has(message)) return;
    warned.add(message);
    console.error(new Date().toISOString(), `[store] WARNING: ${message}`);
}

const modeOf = (file) => {
    try {
        return fs.statSync(file).mode & 0o777;
    } catch {
        return undefined;
    }
};

/**
 * Replaces a whole file so that a failure at any point leaves the old one as it
 * was. `writeFileSync` onto the file itself empties it first, and a full disk --
 * common once the chain has filled it -- then leaves it empty: an empty node.json
 * became defaults and kaspad was recreated without archival, an empty
 * proxies.json unpublished every name (audit #3). Here the new content goes to a
 * temp file beside it, is flushed to disk, and only then renamed over the old one
 * (a rename within one directory is atomic), as bots.js does for bots.json.
 *
 * Never for a file bind-mounted on its own (.env): a rename there swaps the
 * file out from under the mount. See updateEnvFile.
 */
export function writeFileAtomic(file, data, { mode } = {}) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    // The rename makes a new inode, which would otherwise come out with default
    // permissions and the panel's owner: an existing file keeps both.
    let old = null;
    try {
        old = fs.statSync(file);
    } catch {
        /* first write */
    }
    const finalMode = mode ?? (old ? old.mode & 0o777 : undefined);
    // A temp file left by a crash may have other permissions, or be a link: start clean.
    fs.rmSync(tmp, { force: true });
    let fd;
    try {
        fd = fs.openSync(tmp, 'wx', finalMode ?? 0o666);
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
        for (let off = 0; off < buf.length; ) off += fs.writeSync(fd, buf, off, buf.length - off, off);
        // open()'s mode is narrowed by the umask; set exactly what was asked for.
        if (finalMode !== undefined) fs.fchmodSync(fd, finalMode);
        if (old) {
            try {
                fs.fchownSync(fd, old.uid, old.gid);
            } catch {
                /* not root, or a filesystem without owners (Docker Desktop) */
            }
        }
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = undefined;
        fs.renameSync(tmp, file);
    } catch (e) {
        if (fd !== undefined) fs.closeSync(fd);
        fs.rmSync(tmp, { force: true });
        throw e;
    }
    // Flush the rename itself, so a power cut right after cannot bring back the old name.
    try {
        const dir = fs.openSync(path.dirname(file), 'r');
        try {
            fs.fsyncSync(dir);
        } finally {
            fs.closeSync(dir);
        }
    } catch {
        /* not every filesystem lets a directory be synced; the file itself already is */
    }
}

/** One JSON file, told apart: missing, empty, broken, or parsed (with its text). */
function readJsonFile(file) {
    let raw;
    try {
        raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
        return e.code === 'ENOENT' ? { missing: true } : { why: `unreadable (${e.code || e.message})` };
    }
    if (!raw.trim()) return { empty: true, why: 'empty' };
    try {
        return { ok: true, value: JSON.parse(raw), raw };
    } catch {
        // Not the parser's message: it quotes the file, and some of these hold secrets.
        return { why: 'not valid JSON' };
    }
}

// Exported so modules with their own config file (bridge.js) reuse the same
// defaults-merging behaviour instead of reimplementing it.
//
// Defaults stand in only for a file that is not there. A broken one used to turn
// into defaults silently, and the next save wrote them back over whatever the
// owner had set (audit #3). Now it falls back to the copy writeJson kept before
// its last write, and says so; with no good copy either, a file that still has
// content is refused rather than overwritten -- it may be a hand edit with a
// typo, and it is the owner's to fix. An empty one with no copy (left by a
// version before this one) has nothing left to protect, so it gets defaults,
// loudly.
export function readJson(file, fallback) {
    const got = readJsonFile(file);
    if (got.ok) return mergeDefaults(got.value, fallback);
    if (got.missing) return structuredClone(fallback);
    const bak = readJsonFile(`${file}.bak`);
    if (bak.ok) {
        warnOnce(`${file} is ${got.why}; using ${file}.bak, the copy from before its last save. The next save rewrites it.`);
        return mergeDefaults(bak.value, fallback);
    }
    if (got.empty) {
        warnOnce(`${file} is empty and there is no good ${path.basename(file)}.bak; its settings are back to defaults.`);
        return structuredClone(fallback);
    }
    // Damaged with nothing to fall back on. Refusing to start would leave the owner with no
    // panel to fix anything from, and handing back defaults would have the next save write
    // them over the only copy. So the damaged file is set aside under its own name, kept for
    // recovery, and the panel carries on from defaults.
    const aside = `${file}.damaged-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    try {
        fs.renameSync(file, aside);
        warnOnce(`${file} is ${got.why}, and there is no good ${path.basename(file)}.bak. It was moved to ${aside} so nothing overwrites it; its settings are back to defaults until it is restored from there.`);
    } catch (e) {
        warnOnce(`${file} is ${got.why}, there is no good ${path.basename(file)}.bak, and it could not be set aside (${e.message}); its settings are back to defaults.`);
    }
    return structuredClone(fallback);
}

export function writeJson(file, value, { mode } = {}) {
    const data = `${JSON.stringify(value, null, 2)}\n`;
    // The file as it is now becomes the .bak readJson falls back on -- but only a
    // good one: a broken file must never overwrite the last good copy. Best
    // effort; the write itself is already safe without it.
    const current = readJsonFile(file);
    if (current.ok) {
        try {
            writeFileAtomic(`${file}.bak`, current.raw, { mode: mode ?? modeOf(file) });
        } catch (e) {
            warnOnce(`could not keep ${file}.bak: ${e.message}`);
        }
    }
    // `mode` is set on every write, so an existing file is tightened too.
    writeFileAtomic(file, data, { mode });
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

// The testnet-10 node runs beside mainnet with its own settings. Same shape as the
// mainnet node config, fixed to testnet-10. Nothing is published by default — the
// testnet node is reached over the internal docker network by the testnet indexer.
export const DEFAULT_TESTNET_NODE_CONFIG = {
    ...structuredClone(DEFAULT_NODE_CONFIG),
    network: 'testnet-10',
};
export const loadTestnetNodeConfig = () => readJson(NODE_TESTNET_CONFIG_FILE, DEFAULT_TESTNET_NODE_CONFIG);
export const saveTestnetNodeConfig = (cfg) => writeJson(NODE_TESTNET_CONFIG_FILE, cfg);

export const loadManagerConfig = () => readJson(MANAGER_CONFIG_FILE, DEFAULT_MANAGER_CONFIG);
// Holds the DuckDNS token, so only its owner may read it (KQS-011).
export const saveManagerConfig = (cfg) => writeJson(MANAGER_CONFIG_FILE, cfg, { mode: 0o600 });

/** Tighten a manager.json written by an older version (world-readable). */
export function protectManagerConfig() {
    try {
        fs.chmodSync(MANAGER_CONFIG_FILE, 0o600);
    } catch {
        /* not written yet */
    }
}

export const loadProxies = () => readJson(PROXIES_FILE, []);
// Holds each host's basic-auth hash, so it is the panel's alone (conf/ is mounted into other containers).
export const saveProxies = (list) => writeJson(PROXIES_FILE, list, { mode: 0o600 });

export const loadDomains = () => readJson(DOMAINS_FILE, []);
export const saveDomains = (list) => writeJson(DOMAINS_FILE, list);

// ------------------------------------------------------------- .env file ----

// The copy of .env from before the panel's last change to it. A plain sibling
// file, not a mount, so it may be replaced by rename.
const ENV_BAK = `${ENV_FILE}.bak`;
const ENV_KEY_RE = /^\s*[A-Za-z_][A-Za-z0-9_]*\s*=/m;
// Good enough to build on: some KEY= line, and no NULs (what a cut-off write
// can leave behind on some filesystems).
const envLooksGood = (raw) => typeof raw === 'string' && !raw.includes('\0') && ENV_KEY_RE.test(raw);

/**
 * .env's text, and where it came from. A .env that is there but empty or
 * unreadable as an env file falls back to .env.bak when that one is good: .env
 * holds the admin password hash, the session secret and the database
 * passwords, and without them the panel would offer to set a new password
 * (audit #3). `disk` is what the file holds now, whatever it is.
 */
function readEnvRaw() {
    let disk = null;
    try {
        disk = fs.readFileSync(ENV_FILE, 'utf8');
    } catch {
        return { raw: '', disk: null, good: false };
    }
    if (envLooksGood(disk)) return { raw: disk, disk, good: true };
    let bak = null;
    try {
        bak = fs.readFileSync(ENV_BAK, 'utf8');
    } catch {
        /* no copy */
    }
    if (envLooksGood(bak)) {
        warnOnce(`${ENV_FILE} is ${disk.trim() ? 'unreadable as an env file' : 'empty'}; using ${ENV_BAK}, the copy from before the panel's last change. The next change rewrites .env from it.`);
        return { raw: bak, disk, good: false };
    }
    return { raw: disk, disk, good: false };
}

export function readEnvFile() {
    const out = {};
    const { raw } = readEnvRaw();
    for (const line of raw.split(/\r?\n/)) {
        const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
        if (!match) continue;
        out[match[1]] = match[2].replace(/^"(.*)"$/, '$1');
    }
    return out;
}

// Rewrites in place, preserving comments and key order. The file is a bind
// mount of a single host file, so it must never be replaced via rename.
//
// In place cannot be atomic, so it is made safe in steps (audit #3): the whole
// new text is built first; the current file is copied to .env.bak (copied --
// .env itself stays where it is) and that copy must succeed before .env is
// touched; then .env is overwritten through one descriptor, cut to length and
// flushed. If that write fails partway, the old text is put back, which fits in
// the space the file already had; readEnvRaw covers what is left (a crash
// mid-write) from the .bak.
export function updateEnvFile(updates) {
    // One value per line, so a line break in a value would write keys of its own -- an
    // ADMIN_PASSWORD_HASH= among them (KQS-010). Nothing legitimate contains one.
    for (const [key, value] of Object.entries(updates)) {
        if (/[\r\n\0]/.test(String(value))) throw new Error(`Refusing to write ${key}: the value contains a line break.`);
    }
    const current = readEnvRaw();
    const raw = current.raw;
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
    const body = Buffer.from(`${next.join('\n').replace(/\n+$/, '')}\n`, 'utf8');

    // Only a good .env replaces the copy; a bad one must never overwrite the last
    // good .bak. 0600: it holds the same secrets, and only the panel reads it.
    if (current.good) {
        try {
            writeFileAtomic(ENV_BAK, current.disk, { mode: 0o600 });
        } catch (e) {
            throw new Error(`Not changing .env: could not first keep a copy of it as .env.bak (${e.message}).`);
        }
    }

    let fd;
    try {
        fd = fs.openSync(ENV_FILE, 'r+');
    } catch (e) {
        if (e.code !== 'ENOENT') throw e;
        fd = fs.openSync(ENV_FILE, 'w'); // first write
    }
    try {
        try {
            for (let off = 0; off < body.length; ) off += fs.writeSync(fd, body, off, body.length - off, off);
            fs.ftruncateSync(fd, body.length);
            fs.fsyncSync(fd);
        } catch (e) {
            if (current.disk !== null) {
                try {
                    const old = Buffer.from(current.disk, 'utf8');
                    for (let off = 0; off < old.length; ) off += fs.writeSync(fd, old, off, old.length - off, off);
                    fs.ftruncateSync(fd, old.length);
                    fs.fsyncSync(fd);
                } catch {
                    /* .env.bak still holds it, and readEnvRaw falls back on it */
                }
            }
            throw e;
        }
    } finally {
        fs.closeSync(fd);
    }
}

/**
 * The image tag for a branch or tag. A git ref may hold "/" (feature/push) and a Docker tag
 * may not, so the ref stays as the build's source and the tag gets this form of it.
 */
export const imageTagFor = (ref) =>
    String(ref || 'main').replace(/[^A-Za-z0-9_.-]/g, '-').replace(/^[.-]+/, '').slice(0, 128) || 'main';
