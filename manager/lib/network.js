import net from 'node:net';
import { docker } from './dockerctl.js';

/**
 * Host addressing and LAN discovery.
 *
 * The manager runs in a bridge-network container, so os.networkInterfaces()
 * here reports the container's 172.x address -- useless for telling someone
 * where to point a miner. The host's real LAN address is obtained by asking the
 * Docker daemon to run a throwaway container in the host's own network
 * namespace, which is the only way to see the host's interfaces from in here.
 *
 * Outbound connections to the LAN do work from a bridge container (they route
 * through the host), which is what makes the scanner below possible.
 */

let cache = { at: 0, addresses: [] };
const CACHE_MS = 60_000;

const PRIVATE_RE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

export async function hostAddresses({ force = false } = {}) {
    if (!force && Date.now() - cache.at < CACHE_MS && cache.addresses.length) return cache.addresses;

    let addresses = [];
    try {
        const { stdout } = await docker(
            ['run', '--rm', '--network', 'host', 'alpine:3.21', 'ip', '-4', '-o', 'addr', 'show', 'scope', 'global'],
            { timeoutMs: 30_000 },
        );
        addresses = stdout
            .split('\n')
            .map((line) => /^\d+:\s+(\S+)\s+inet\s+(\d+\.\d+\.\d+\.\d+)\/(\d+)/.exec(line))
            .filter(Boolean)
            .map((m) => ({ iface: m[1], ip: m[2], prefix: Number(m[3]) }))
            // Docker's own bridges are not where a miner lives.
            .filter((a) => !/^(docker|br-|veth|lo)/.test(a.iface));
    } catch {
        addresses = [];
    }

    cache = { at: Date.now(), addresses };
    return addresses;
}

/** The address to hand out on the LAN: a private one if there is one. */
export async function primaryLanAddress() {
    const addresses = await hostAddresses();
    return addresses.find((a) => PRIVATE_RE.test(a.ip)) ?? addresses[0] ?? null;
}

// ------------------------------------------------------------------- scan --

const probe = (host, port, timeout) =>
    new Promise((resolve) => {
        const socket = net.connect({ host, port, timeout });
        const done = (open) => {
            socket.destroy();
            resolve(open);
        };
        socket.once('connect', () => done(true));
        socket.once('timeout', () => done(false));
        socket.once('error', () => done(false));
    });

/** Runs `limit` promises at a time over `items`. */
async function pool(items, limit, worker) {
    const results = [];
    let index = 0;
    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
        for (;;) {
            const i = index++;
            if (i >= items.length) return;
            results[i] = await worker(items[i]);
        }
    });
    await Promise.all(runners);
    return results;
}

/**
 * Reads whatever the device says about itself over HTTP. Deliberately shallow:
 * this labels what it can prove and leaves everything else as unidentified,
 * rather than guessing a vendor from an open port.
 */
async function identify(ip) {
    try {
        // Most LAN devices redirect straight to a login page, and refusing to
        // follow that leaves nothing identifiable but the status line.
        const res = await fetch(`http://${ip}/`, {
            signal: AbortSignal.timeout(2500),
            redirect: 'follow',
            headers: { 'User-Agent': 'kaspa-one-click-panel' },
        });
        const server = res.headers.get('server');
        let title = null;
        let sample = '';
        const type = res.headers.get('content-type') || '';
        if (type.includes('text/html') || type.includes('text/plain') || !type) {
            const body = (await res.text()).slice(0, 6000);
            title = /<title[^>]*>([^<]{1,120})<\/title>/i.exec(body)?.[1]?.trim() ?? null;
            sample = body;
        }
        const haystack = `${server ?? ''} ${title ?? ''} ${sample}`.toLowerCase();
        const vendor = /iceriver/.test(haystack)
            ? 'IceRiver'
            : /bitmain|antminer/.test(haystack)
              ? 'Bitmain'
              : /goldshell/.test(haystack)
                ? 'Goldshell'
                : null;
        return { http: true, status: res.status, server, title, vendor };
    } catch {
        return { http: false, status: null, server: null, title: null, vendor: null };
    }
}

// 80 is the ASIC web interface; 4028 is the cgminer-style API most of them also
// expose, and is the better signal that a responder is a miner and not a
// printer or a NAS.
export const SCAN_PORTS = [80, 4028];

/**
 * Sweeps the /24 the host sits on. Anything that answers is reported with what
 * it disclosed about itself -- no claim is made that a responder is a miner
 * unless it says so or is already talking to the bridge.
 */
export async function scanLan({ base, knownMinerIps = [], timeout = 400, concurrency = 64 } = {}) {
    const address = base ?? (await primaryLanAddress());
    if (!address) throw new Error('Could not work out this machine\'s LAN address.');

    const prefix = address.ip.split('.').slice(0, 3).join('.');
    const hosts = Array.from({ length: 254 }, (_, i) => `${prefix}.${i + 1}`);

    const open = await pool(hosts, concurrency, async (ip) => {
        const results = await Promise.all(SCAN_PORTS.map((port) => probe(ip, port, timeout)));
        const ports = SCAN_PORTS.filter((_, i) => results[i]);
        return ports.length ? { ip, ports } : null;
    });

    const found = open.filter(Boolean);
    const detailed = await pool(found, 16, async (entry) => {
        const info = entry.ports.includes(80) ? await identify(entry.ip) : { http: false, vendor: null };
        return {
            ...entry,
            ...info,
            self: entry.ip === address.ip,
            connectedToBridge: knownMinerIps.includes(entry.ip),
            // Only 4028 or an outright vendor string is treated as evidence.
            likelyMiner: entry.ports.includes(4028) || Boolean(info.vendor) || knownMinerIps.includes(entry.ip),
        };
    });

    return {
        subnet: `${prefix}.0/24`,
        scannedFrom: address.ip,
        scanned: hosts.length,
        devices: detailed.sort((a, b) => Number(b.likelyMiner) - Number(a.likelyMiner) || a.ip.localeCompare(b.ip)),
    };
}
