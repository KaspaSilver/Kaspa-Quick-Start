/**
 * Reverse proxy for the KaChat indexer's admin dashboard.
 *
 * The dashboard is a single-page app that upstream serves at the root of its
 * own port and that calls its API with absolute paths (`fetch("/api/stats")`,
 * and one `window.location = "/api/chat-export"`). Mounting it under /kachat/
 * therefore needs those paths rewritten, otherwise every call would hit this
 * panel's own API instead.
 *
 * Two mechanisms, deliberately:
 *   1. a text rewrite of the served HTML, which catches every current call
 *      including the `window.location` navigation that no fetch hook can see;
 *   2. a fetch() prefix patch, which keeps working if upstream adds a call the
 *      rewrite does not match.
 *
 * The alternative -- publishing port 3081 on the host and pointing an iframe at
 * it -- would only work when the panel is opened from the same machine, and
 * upstream binds that port to loopback precisely because it is unauthenticated.
 */

const ADMIN_ORIGIN = process.env.KACHAT_ADMIN_ORIGIN || 'http://kachat-app:3081';
export const MOUNT = '/kachat';

const FETCH_PATCH = `<script>
(function () {
  var base = ${JSON.stringify(MOUNT)};
  var orig = window.fetch;
  window.fetch = function (input, init) {
    try {
      if (typeof input === 'string' && input.indexOf('/api/') === 0) input = base + input;
      else if (input && input.url && new URL(input.url, location.origin).pathname.indexOf('/api/') === 0) {
        var u = new URL(input.url, location.origin);
        input = new Request(base + u.pathname + u.search, input);
      }
    } catch (e) { /* fall through with the original input */ }
    return orig.call(this, input, init);
  };
})();
</script>`;

function rewriteHtml(html) {
    // Every API reference in the upstream page is the literal string "/api/…".
    const rewritten = html.replaceAll('"/api/', `"${MOUNT}/api/`);
    // Inject the safety net as early as possible so it is installed before the
    // page's own script runs.
    return rewritten.includes('<head>')
        ? rewritten.replace('<head>', `<head>${FETCH_PATCH}`)
        : `${FETCH_PATCH}${rewritten}`;
}

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
                // Only pass through what the dashboard actually needs; this panel's
                // session cookie has no business reaching the indexer.
                ...(req.headers['content-type'] ? { 'content-type': req.headers['content-type'] } : {}),
                ...(req.headers.accept ? { accept: req.headers.accept } : {}),
            },
            body,
            redirect: 'manual',
            signal: AbortSignal.timeout(120_000),
        });
    } catch (err) {
        res.writeHead(502, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
            `<p style="font:15px system-ui;padding:24px">The KaChat indexer is not answering on ${ADMIN_ORIGIN}.<br>` +
                `<span style="color:#8b98a8">${escapeHtml(err.message)}</span></p>`,
        );
        return;
    }

    const headers = {};
    for (const [key, value] of response.headers) {
        if (!HOP_BY_HOP.has(key.toLowerCase())) headers[key] = value;
    }

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('text/html')) {
        const html = rewriteHtml(await response.text());
        headers['content-type'] = 'text/html; charset=utf-8';
        // Framed by the panel, so the upstream page must be allowed to render here.
        delete headers['x-frame-options'];
        res.writeHead(response.status, headers);
        res.end(html);
        return;
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

const escapeHtml = (v) =>
    String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
