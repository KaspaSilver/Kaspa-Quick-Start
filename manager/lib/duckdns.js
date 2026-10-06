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

/** One request to DuckDNS for `list` (account labels). */
async function requestUpdate(list, token, ip) {
    const url = new URL(UPDATE_URL);
    url.searchParams.set('domains', list.join(','));
    url.searchParams.set('token', token);
    // An empty ip makes DuckDNS use the source address of this request, which
    // is the right answer for the common case of a node behind a home router.
    url.searchParams.set('ip', ip ?? '');
    url.searchParams.set('verbose', 'true');
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    const body = (await res.text()).trim();
    return { ok: body.startsWith('OK'), body };
}

/**
 * Refresh every saved name with the saved token.
 *
 * DuckDNS answers a bare "KO" for the whole request when any one name in it is not on the
 * token's account (or the token is wrong). So with several names, a refused request is
 * retried one name at a time: the names the token can update still get refreshed, and the
 * result says exactly which were refused (`refused`, as `name.duckdns.org`). It throws only
 * when nothing could be refreshed.
 */
export async function update({ domains, token, ip } = {}) {
    const cfg = loadManagerConfig();
    const list = normalizeDomains(domains ?? cfg.duckdns.domains);
    const useToken = token ?? cfg.duckdns.token;

    if (!list.length) throw new Error('No DuckDNS subdomain configured.');
    if (!useToken) throw new Error('No DuckDNS token configured.');

    let { ok, body } = await requestUpdate(list, useToken, ip);
    let refreshed = ok ? list : [];
    let refused = [];
    if (!ok && list.length > 1) {
        for (const name of list) {
            const one = await requestUpdate([name], useToken, ip).catch(() => ({ ok: false, body: '' }));
            if (one.ok) {
                refreshed.push(name);
                body = one.body;
            } else {
                refused.push(name);
            }
        }
        ok = refreshed.length > 0;
    } else if (!ok) {
        refused = list;
    }

    const next = loadManagerConfig();
    next.duckdns.lastRunAt = new Date().toISOString();
    next.duckdns.lastResult = ok
        ? `OK (${body.split('\n').slice(1).join(' ').trim() || 'no change'})${
              refused.length ? `; refused: ${refused.map((d) => `${d}.duckdns.org`).join(', ')}` : ''
          }`
        : `FAILED: ${body}`;
    saveManagerConfig(next);

    if (!ok) {
        throw new Error(
            `DuckDNS rejected the update: ${body || 'empty response'}. ${
                list.length > 1 ? 'None of the saved names can' : `${list[0]}.duckdns.org cannot`
            } be updated with the saved token: check the token at duckdns.org (it changes if you regenerate it), and that the name is on that account.`,
        );
    }
    return {
        ok,
        body,
        domains: refreshed.map((d) => `${d}.duckdns.org`),
        refused: refused.map((d) => `${d}.duckdns.org`),
    };
}

/** Why a name was refused, in words (for job logs). */
export const refusedNote = (names) =>
    `DuckDNS refused ${names.join(', ')} with the saved token. ${
        names.length === 1 ? 'That name is' : 'Those names are'
    } probably on a different duckdns.org account (each account has its own token), or no longer exist${
        names.length === 1 ? 's' : ''
    } there. Remove ${names.length === 1 ? 'it' : 'them'} from this panel's DuckDNS names, or use that account's token.`;

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
            (r) => log(`duckdns: refreshed ${r.domains.join(', ')}${r.refused.length ? `; ${refusedNote(r.refused)}` : ''}`),
            (err) => log(`duckdns: ${err.message}`),
        );

    timer = setInterval(tick, minutes * 60_000);
    timer.unref?.();
    tick();
}
