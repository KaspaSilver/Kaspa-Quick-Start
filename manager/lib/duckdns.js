import { loadManagerConfig, saveManagerConfig } from './store.js';

const UPDATE_URL = 'https://www.duckdns.org/update';
const IP_SERVICES = ['https://api.ipify.org', 'https://ifconfig.me/ip', 'https://icanhazip.com'];

export async function publicIp() {
    for (const url of IP_SERVICES) {
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
            if (!res.ok) continue;
            const ip = (await res.text()).trim();
            if (/^[0-9a-fA-F.:]+$/.test(ip)) return ip;
        } catch {
            /* try the next one */
        }
    }
    return null;
}

/** Strips a full hostname down to the DuckDNS label, so both forms are accepted. */
export const normalizeDomains = (input) =>
    String(input || '')
        .split(/[\s,]+/)
        .map((d) => d.trim().toLowerCase().replace(/\.duckdns\.org\.?$/, ''))
        .filter(Boolean);

export async function update({ domains, token, ip } = {}) {
    const cfg = loadManagerConfig();
    const list = normalizeDomains(domains ?? cfg.duckdns.domains);
    const useToken = token ?? cfg.duckdns.token;

    if (!list.length) throw new Error('No DuckDNS subdomain configured.');
    if (!useToken) throw new Error('No DuckDNS token configured.');

    const url = new URL(UPDATE_URL);
    url.searchParams.set('domains', list.join(','));
    url.searchParams.set('token', useToken);
    // An empty ip makes DuckDNS use the source address of this request, which
    // is the right answer for the common case of a node behind a home router.
    url.searchParams.set('ip', ip ?? '');
    url.searchParams.set('verbose', 'true');

    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    const body = (await res.text()).trim();
    const ok = body.startsWith('OK');

    const next = loadManagerConfig();
    next.duckdns.lastRunAt = new Date().toISOString();
    next.duckdns.lastResult = ok ? `OK (${body.split('\n').slice(1).join(' ').trim() || 'no change'})` : `FAILED: ${body}`;
    saveManagerConfig(next);

    if (!ok) throw new Error(`DuckDNS rejected the update: ${body || 'empty response'}`);
    return { ok, body, domains: list.map((d) => `${d}.duckdns.org`) };
}

let timer = null;

/** (Re)arms the periodic refresh from the saved config. Safe to call anytime. */
export function scheduleFromConfig(log = () => {}) {
    if (timer) clearInterval(timer);
    timer = null;

    const cfg = loadManagerConfig();
    if (!cfg.duckdns.enabled) return;

    const minutes = Math.max(5, Number(cfg.duckdns.intervalMinutes) || 5);
    const tick = () =>
        update().then(
            (r) => log(`duckdns: refreshed ${r.domains.join(', ')}`),
            (err) => log(`duckdns: ${err.message}`),
        );

    timer = setInterval(tick, minutes * 60_000);
    timer.unref?.();
    tick();
}
