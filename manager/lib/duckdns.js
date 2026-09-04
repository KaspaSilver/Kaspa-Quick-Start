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

/**
 * The DuckDNS account's own label, from any name under it.
 *
 *   testing.duckdns.org          -> testing
 *   sub.testing.duckdns.org      -> testing
 *   a.b.testing.duckdns.org      -> testing
 *   testing                      -> testing
 *
 * DuckDNS's API only ever addresses the account: `domains=testing`. A record
 * under it is not something you register, so the label is what every request
 * has to carry -- and stripping only the suffix, which is what this used to do,
 * sent `sub.testing`, which DuckDNS refuses.
 */
export function accountLabel(input) {
    const name = String(input || '').trim().toLowerCase().replace(/\.$/, '');
    if (!name) return '';
    if (name.endsWith('.duckdns.org')) {
        // Whatever is left, the account is its last label: everything in front
        // is a name under the account rather than part of it.
        return name.slice(0, -'.duckdns.org'.length).split('.').filter(Boolean).pop() ?? '';
    }
    // A bare label is somebody typing just their account name, which the
    // settings field has always accepted. Anything else with a dot in it is
    // some other provider's hostname, and has no DuckDNS account behind it --
    // 'example.com' is not the account 'com'.
    return name.includes('.') ? '' : name;
}

/** True for a name under a DuckDNS account rather than the account's own name. */
export function isSubdomain(input) {
    const name = String(input || '').trim().toLowerCase().replace(/\.$/, '');
    if (!name.endsWith('.duckdns.org')) return false;
    return name.slice(0, -'.duckdns.org'.length).includes('.');
}

/** Every DuckDNS account named in a list, in the form the API wants. */
export const normalizeDomains = (input) => [
    ...new Set(
        String(input || '')
            .split(/[\s,]+/)
            .map(accountLabel)
            .filter(Boolean),
    ),
];

/**
 * A subdomain plus a token is the whole condition for refreshing. There is no
 * separate on switch, because a record that is not kept current is worse than
 * no record at all -- it points at an address the machine has since lost.
 */
export const isConfigured = (dd) => Boolean(normalizeDomains(dd?.domains).length && dd?.token);

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
    if (!isConfigured(cfg.duckdns)) return;

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
