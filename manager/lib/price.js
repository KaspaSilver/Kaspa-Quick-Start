// Kaspa's spot price, cached and best-effort.
//
// It rides on the mining projection, which the panel refreshes every few
// seconds, so hitting a price API on every one of those would be both rude and
// pointless: the number barely moves in five seconds. One fetch every few
// minutes is plenty.
//
// The refresh is deliberately off the response path. Once there is a price to
// show, a stale one is returned immediately and a new one is fetched in the
// background -- a five-second poll should never wait on a third-party API, and
// a fetch that fails just leaves the last good number in place. Only the very
// first call, with nothing cached yet, waits, so the fiat figures appear on the
// first paint rather than a poll later.
//
// CoinGecko's simple-price endpoint needs no key and returns exactly one
// number. If it is ever unreachable the projection still works; only the "~$"
// hints go quiet.

const ENDPOINT = 'https://api.coingecko.com/api/v3/simple/price?ids=kaspa&vs_currencies=usd';
const TTL_MS = 5 * 60_000;

let cache = { usd: null, source: null, at: 0 };
let inflight = null;

function refresh() {
    if (inflight) return inflight;
    inflight = (async () => {
        try {
            const res = await fetch(ENDPOINT, { signal: AbortSignal.timeout(5000) });
            if (!res.ok) throw new Error(`price service returned ${res.status}`);
            const body = await res.json();
            const usd = Number(body?.kaspa?.usd);
            if (Number.isFinite(usd) && usd > 0) cache = { usd, source: 'coingecko', at: Date.now() };
        } catch {
            // Keep whatever we had. The fiat hints simply stop advancing.
        } finally {
            inflight = null;
        }
    })();
    return inflight;
}

/** The latest KAS price in USD, from cache; refreshed in the background. */
export async function kaspaPrice() {
    if (cache.usd === null || Date.now() - cache.at >= TTL_MS) {
        const pending = refresh();
        // Nothing to show yet: wait this once so fiat is there on first paint.
        if (cache.usd === null) await pending;
    }
    return { ...cache };
}
