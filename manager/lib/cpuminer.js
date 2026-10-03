import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { logs } from './dockerctl.js';
import { CONF_DIR } from './paths.js';
import { updateEnvFile } from './store.js';

/**
 * The testnet-10 CPU miner (kaspanet/cpuminer, the "kaspa-miner" Kaspa core maintains
 * for testnets). Testnet is mined on CPUs, not ASICs: the miner talks straight to the
 * testnet node's gRPC (kaspad-testnet:16210) and needs nothing but a reward address
 * and a thread count. The compose service reads both from .env.
 */
export const CONTAINER = 'kaspa-node-cpuminer-testnet';
const CONFIG_FILE = path.join(CONF_DIR, 'cpuminer-testnet.json');

export const cpuCount = () => Math.max(1, os.cpus()?.length || 1);

/** Half the cores by default: the same machine runs the node and the indexer. */
const defaultThreads = () => Math.max(1, Math.floor(cpuCount() / 2));

export function loadConfig() {
    try {
        const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        return { address: String(cfg.address ?? ''), threads: Number(cfg.threads) || defaultThreads() };
    } catch {
        return { address: '', threads: defaultThreads() };
    }
}

// A testnet address: kaspatest: + bech32 payload (schnorr q…, ECDSA q…, P2SH p…).
const ADDRESS_RE = /^kaspatest:[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{40,90}$/;

export function validate(input) {
    const errors = [];
    const address = String(input.address ?? '').trim().toLowerCase();
    const threads = Number(input.threads);
    if (!ADDRESS_RE.test(address)) {
        errors.push('The reward address must be a testnet address (kaspatest:…). Mainnet kaspa: addresses cannot receive testnet rewards.');
    }
    if (!Number.isInteger(threads) || threads < 1 || threads > cpuCount()) {
        errors.push(`Threads must be a whole number from 1 to ${cpuCount()} (this machine's cores).`);
    }
    return { cfg: { address, threads }, errors };
}

export function saveConfig(cfg) {
    fs.mkdirSync(CONF_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
    writeEnv(cfg);
}

/** What the compose service reads (TESTNET_MINING_ADDRESS / TESTNET_MINING_THREADS). */
export function writeEnv(cfg = loadConfig()) {
    updateEnvFile({ TESTNET_MINING_ADDRESS: cfg.address, TESTNET_MINING_THREADS: String(cfg.threads) });
}

/**
 * Live figures from the miner's own log: its latest hashrate line, blocks it found,
 * and whether the node says it is not synced (the miner waits until it is).
 */
export async function stats() {
    const text = await logs(CONTAINER, 3000).catch(() => '');
    const lines = text.split('\n');
    let hashrate = null;
    let lastLine = null;
    let notSynced = false;
    let blocks = 0;
    for (const line of lines) {
        const rate = /Current hashrate is: ([\d.]+) (\S+)/.exec(line);
        if (rate) {
            hashrate = { value: Number(rate[1]), unit: rate[2] };
            notSynced = false;
        }
        if (/Found a block/.test(line)) blocks += 1;
        if (/not synced/i.test(line)) notSynced = true;
        if (line.trim()) lastLine = line.replace(/^\S+\s+/, '').trim().slice(0, 200);
    }
    return { hashrate, blocks, notSynced, lastLine };
}
