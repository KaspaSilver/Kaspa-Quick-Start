/**
 * Pass-through to the KaChat indexer's admin API.
 *
 * The panel used to frame upstream's own dashboard page, which meant rewriting
 * its HTML so its absolute `/api/...` calls did not land on this panel instead.
 * The dashboard is now built natively here, so none of that is needed: what
 * crosses this boundary is JSON, and the panel's own KaChat screens are the
 * only thing that calls it.
 *
 * The indexer binds its admin port to loopback inside its container because it
 * is unauthenticated, so proxying from in here is also the only way to reach it
 * without publishing an open port on the host.
 */

const ADMIN_ORIGIN = process.env.KACHAT_ADMIN_ORIGIN || 'http://kachat-app:3081';
export const MOUNT = '/kachat';

/** Headers that describe a hop, not the payload, and must not be forwarded. */
const HOP_BY_HOP = new Set([
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'content-encoding',
    'content-length',
]);

export async function handle(req, res, url) {
    const target = url.pathname.slice(MOUNT.length) || '/';

    // Only the API is reachable. Upstream's own page is no longer served through
    // here, and nothing else on that port should be exposed by accident.
    if (!target.startsWith('/api/')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
        return;
    }

    const upstream = `${ADMIN_ORIGIN}${target}${url.search}`;

    let body;
    if (!['GET', 'HEAD'].includes(req.method)) {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        body = Buffer.concat(chunks);
    }

    let response;
    try {
        response = await fetch(upstream, {
            method: req.method,
            headers: {
                // Only what the API actually needs; this panel's session cookie
                // has no business reaching the indexer.
                ...(req.headers['content-type'] ? { 'content-type': req.headers['content-type'] } : {}),
                ...(req.headers.accept ? { accept: req.headers.accept } : {}),
            },
            body,
            redirect: 'manual',
            signal: AbortSignal.timeout(120_000),
        });
    } catch (err) {
        // A shape the panel can read, so every KaChat screen can say "not
        // running yet" rather than failing to parse an error page.
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `The KaChat indexer is not answering: ${err.message}`, unreachable: true }));
        return;
    }

    const headers = {};
    for (const [key, value] of response.headers) {
        if (!HOP_BY_HOP.has(key.toLowerCase())) headers[key] = value;
    }

    res.writeHead(response.status, headers);
    if (response.body) {
        const reader = response.body.getReader();
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(Buffer.from(value));
        }
    }
    res.end();
}
