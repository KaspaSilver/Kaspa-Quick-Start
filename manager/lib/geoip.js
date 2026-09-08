// Best-effort geolocation of an IP address, for the "Am I public?" map.
//
// Cached for the life of the process: an address does not wander between
// cities, and the only caller wants a pin on a map, not a live track. A lookup
// that fails just means no pin -- the map and the reachability test both stand
// on their own without it.
//
// ipwho.is is https and needs no key. It is told this connection's public
// address, which is the same address every node on the Kaspa network already
// sees; the lookup only runs when the reachability test does.

const cache = new Map();

export async function locate(ip) {
    if (!ip) return null;
    if (cache.has(ip)) return cache.get(ip);

    let geo = null;
    try {
        const res = await fetch(`https://ipwho.is/${encodeURIComponent(ip)}`, { signal: AbortSignal.timeout(6000) });
        if (res.ok) {
            const b = await res.json();
            if (b?.success && Number.isFinite(b.latitude) && Number.isFinite(b.longitude)) {
                geo = {
                    lat: b.latitude,
                    lon: b.longitude,
                    city: b.city || null,
                    country: b.country || null,
                };
            }
        }
    } catch {
        // No pin. The caller treats a missing location as "unknown", not an error.
    }

    // Cache even a null, so a service that is down is not asked again every poll.
    cache.set(ip, geo);
    return geo;
}
