import fs from 'node:fs';
import path from 'node:path';
import { CONF_DIR } from './paths.js';
import { ports } from './kaspad-args.js';
import { readJson, writeJson } from './store.js';

export const BRIDGE_CONFIG_FILE = path.join(CONF_DIR, 'bridge.yaml');
export const BRIDGE_PORTS_OVERRIDE = path.join(CONF_DIR, 'bridge-ports.yml');
export const MINING_STATE_FILE = path.join(CONF_DIR, 'mining.json');

// Reached over the internal docker network, so it needs no published port.
// Overridable so the stats plumbing can be exercised without a live bridge.
export const DASHBOARD_PORT = 3030;
const STATS_URL = process.env.BRIDGE_STATS_URL || `http://bridge:${DASHBOARD_PORT}/api/stats`;

export const DEFAULT_BRIDGE_CONFIG = {
    enabled: false,
    // One listener is the common case. Each entry gets its own stratum port and
    // its own starting difficulty, which is how you separate an S19-class ASIC
    // from a small home miner.
    instances: [{ stratumPort: 5555, minShareDiff: 2048, publish: true }],
    varDiff: true,
    sharesPerMin: 30,
    varDiffStats: true,
    pow2Clamp: true,
    extranonceSize: 2,
    blockWaitTimeMs: 1000,
    coinbaseTagSuffix: '',
    logToFile: false,
    // The bridge's own dashboard. Off by default: the Mining tab already shows
    // these numbers, and this would be a second unauthenticated web port.
    publishDashboard: false,
};

export const loadBridgeConfig = () => readJson(MINING_STATE_FILE, DEFAULT_BRIDGE_CONFIG);
export const saveBridgeConfig = (cfg) => writeJson(MINING_STATE_FILE, cfg);

// -------------------------------------------------------------- validation --

export function validateBridgeConfig(input) {
    const errors = [];
    const cfg = structuredClone(DEFAULT_BRIDGE_CONFIG);

    cfg.enabled = Boolean(input.enabled);
    cfg.varDiff = Boolean(input.varDiff);
    cfg.varDiffStats = Boolean(input.varDiffStats);
    cfg.pow2Clamp = Boolean(input.pow2Clamp);
    cfg.logToFile = Boolean(input.logToFile);
    cfg.publishDashboard = Boolean(input.publishDashboard);

    const int = (name, value, min, max, fallback) => {
        if (value === null || value === undefined || `${value}`.trim() === '') return fallback;
        const n = Number(value);
        if (!Number.isInteger(n) || n < min || n > max) {
            errors.push(`${name} must be a whole number between ${min} and ${max}.`);
            return fallback;
        }
        return n;
    };

    cfg.sharesPerMin = int('Target shares per minute', input.sharesPerMin, 1, 600, 30);
    cfg.extranonceSize = int('Extranonce size', input.extranonceSize, 0, 3, 2);
    cfg.blockWaitTimeMs = int('Block wait time', input.blockWaitTimeMs, 10, 60_000, 1000);

    const suffix = String(input.coinbaseTagSuffix ?? '').trim();
    // Ends up in the coinbase of blocks you find, and in a YAML scalar.
    if (suffix && !/^[A-Za-z0-9 ._-]{1,32}$/.test(suffix)) {
        errors.push('Coinbase tag suffix may only contain letters, digits, spaces and . _ -');
    }
    cfg.coinbaseTagSuffix = suffix;

    const rawInstances = Array.isArray(input.instances) ? input.instances : [];
    if (!rawInstances.length) errors.push('Add at least one stratum port.');
    if (rawInstances.length > 8) errors.push('At most 8 stratum ports are supported.');

    const seenPorts = new Set();
    cfg.instances = rawInstances.slice(0, 8).map((raw, index) => {
        const label = `Stratum port #${index + 1}`;
        const port = int(label, raw?.stratumPort, 1024, 65535, 5555);
        if (seenPorts.has(port)) errors.push(`Port ${port} is listed more than once.`);
        seenPorts.add(port);

        // The bridge serves its dashboard on 3030 and a Prometheus endpoint per
        // instance from 2114 up; a stratum listener on those would collide.
        if (port === DASHBOARD_PORT) errors.push(`Port ${port} is used by the bridge dashboard.`);
        if (port >= 2114 && port <= 2114 + 8) errors.push(`Port ${port} is reserved for the bridge's metrics endpoints.`);

        const diff = int(`${label} starting difficulty`, raw?.minShareDiff, 1, 1_000_000_000, 2048);
        return { stratumPort: port, minShareDiff: diff, publish: raw?.publish !== false };
    });

    return { cfg, errors };
}

/** Mining needs kaspad's gRPC, which is what the bridge connects to. */
export function miningBlockers(bridgeCfg, nodeCfg) {
    const blockers = [];
    if (bridgeCfg.enabled && !nodeCfg.services.grpc) {
        blockers.push(
            'The stratum bridge needs to talk to the node over gRPC, and that is currently switched off. ' +
                'Turn the gRPC listener on under Kaspad, Ports. It does not have to be public.',
        );
    }
    return blockers;
}

// --------------------------------------------------------------- rendering --

// Hand-rolled so the manager keeps its zero-dependency rule. Safe because every
// value below is either a validated integer, a boolean, or a string already
// constrained to [A-Za-z0-9 ._-] -- none of which can break out of a YAML
// scalar. Do not widen those patterns without revisiting this.
export function renderBridgeYaml(bridgeCfg, nodeCfg) {
    const p = ports(nodeCfg);
    const lines = [
        '# Generated by the Kaspa Node Control panel - edits here are overwritten.',
        '',
        `kaspad_address: "kaspad:${p.grpc}"`,
        `block_wait_time: ${bridgeCfg.blockWaitTimeMs}`,
        'print_stats: true',
        `log_to_file: ${bridgeCfg.logToFile}`,
        'health_check_port: ""',
        `web_dashboard_port: ":${DASHBOARD_PORT}"`,
        `var_diff: ${bridgeCfg.varDiff}`,
        `shares_per_min: ${bridgeCfg.sharesPerMin}`,
        `var_diff_stats: ${bridgeCfg.varDiffStats}`,
        `pow2_clamp: ${bridgeCfg.pow2Clamp}`,
        `extranonce_size: ${bridgeCfg.extranonceSize}`,
        `coinbase_tag_suffix: "${bridgeCfg.coinbaseTagSuffix}"`,
        '',
        'instances:',
    ];

    bridgeCfg.instances.forEach((instance, index) => {
        lines.push(`  - stratum_port: ":${instance.stratumPort}"`);
        lines.push(`    min_share_diff: ${instance.minShareDiff}`);
        lines.push(`    prom_port: ":${2114 + index}"`);
        lines.push(`    log_to_file: ${bridgeCfg.logToFile}`);
    });

    return `${lines.join('\n')}\n`;
}

export function renderBridgePortsOverride(bridgeCfg) {
    const published = bridgeCfg.instances.filter((i) => i.publish).map((i) => i.stratumPort);
    const lines = [
        '# Generated by the Kaspa Node Control panel - edits here are overwritten.',
        '# Published stratum ports. Miners outside this machine connect to these.',
        'services:',
        '  bridge:',
        '    ports:',
    ];
    if (!published.length && !bridgeCfg.publishDashboard) lines.push('      []');
    for (const port of published) lines.push(`      - "0.0.0.0:${port}:${port}/tcp"`);
    if (bridgeCfg.publishDashboard) lines.push(`      - "0.0.0.0:${DASHBOARD_PORT}:${DASHBOARD_PORT}/tcp"`);

    fs.mkdirSync(CONF_DIR, { recursive: true });
    fs.writeFileSync(BRIDGE_PORTS_OVERRIDE, `${lines.join('\n')}\n`, 'utf8');
    return published;
}

export function writeBridgeFiles(bridgeCfg, nodeCfg) {
    // Callers reach this from bootstrap, node re-config and the mining route;
    // not all of them are guaranteed to run after ensureDirs().
    fs.mkdirSync(CONF_DIR, { recursive: true });
    fs.writeFileSync(BRIDGE_CONFIG_FILE, renderBridgeYaml(bridgeCfg, nodeCfg), 'utf8');
    return renderBridgePortsOverride(bridgeCfg);
}

// ---------------------------------------------------------- connected IPs --

/**
 * Miner addresses the bridge has actually seen, scraped from its log.
 *
 * The stats API reports workers by name and wallet but never by address, and
 * connects are logged at debug level while disconnects are at info -- so this
 * is best-effort. It is used only to corroborate a LAN scan, never as the sole
 * source of truth.
 */
export async function connectedMinerIps(logs) {
    const ips = new Set();
    for (const match of String(logs || '').matchAll(/\[CONNECTION\][^\n]*?(\d+\.\d+\.\d+\.\d+)/g)) {
        ips.add(match[1]);
    }
    return [...ips];
}

// ------------------------------------------------------------------- stats --

/**
 * Pulls the bridge's own aggregated stats. Shapes come from StatsResponse in
 * bridge/src/prom.rs. Everything is optional -- a bridge that just started has
 * no workers and no blocks, which is a normal state, not an error.
 */
export async function fetchStats() {
    let raw;
    try {
        const res = await fetch(STATS_URL, { signal: AbortSignal.timeout(5000) });
        if (!res.ok) throw new Error(`bridge returned ${res.status}`);
        raw = await res.json();
    } catch (err) {
        return { reachable: false, error: err.message, summary: null, workers: [], blocks: [] };
    }

    const workers = Array.isArray(raw.workers) ? raw.workers : [];
    const blocks = Array.isArray(raw.blocks) ? raw.blocks : [];

    return {
        reachable: true,
        error: null,
        summary: {
            totalBlocks: raw.totalBlocks ?? 0,
            totalShares: raw.totalShares ?? 0,
            activeWorkers: raw.activeWorkers ?? 0,
            networkHashrate: raw.networkHashrate ?? 0,
            networkDifficulty: raw.networkDifficulty ?? 0,
            networkBlockCount: raw.networkBlockCount ?? 0,
            bridgeUptime: raw.bridgeUptime ?? null,
            // The bridge reports per-worker hashrate but no pool total; summing
            // the workers is the number an operator actually wants to see.
            poolHashrate: workers.reduce((sum, w) => sum + (Number(w.hashrate) || 0), 0),
            internalCpu: raw.internalCpu ?? null,
        },
        workers,
        blocks,
    };
}
