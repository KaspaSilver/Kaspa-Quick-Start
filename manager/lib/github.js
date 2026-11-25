/**
 * The one way this panel asks GitHub's API anything.
 *
 * Without a token GitHub allows sixty requests an hour per public address, and that address
 * is shared with everything else on the network. Every request counts, even a conditional
 * one that comes back 304 (measured: an If-None-Match that got a 304 still took one off the
 * remaining count), so the only saving is not to send it. Two things here do that:
 *
 * - An answer is kept for two minutes, and the same URL asked again inside that time gets it
 *   without a request. Check all, or a Check pressed twice, or two screens wanting the same
 *   branch, then cost one request rather than several.
 * - Once GitHub says the allowance is spent, nothing more is sent until the reset time it gave:
 *   callers get the same 403 straight away instead of a burst of requests that all fail.
 *
 * Returns a fetch Response (a rebuilt one for a kept answer), so callers read it as before.
 */

const HEADERS = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'kaspa-quick-start-panel',
    'X-GitHub-Api-Version': '2022-11-28',
};

const KEEP_MS = 2 * 60_000;

// url -> { at, body, type, link }. Bounded: comparisons between commits are each their own URL.
const answers = new Map();
const MAX_ANSWERS = 300;

let limitedUntil = 0;

function remember(url, entry) {
    answers.delete(url);
    answers.set(url, entry);
    if (answers.size > MAX_ANSWERS) answers.delete(answers.keys().next().value);
}

function rebuilt({ body, type, link }) {
    const headers = { 'content-type': type || 'application/json' };
    if (link) headers.link = link;
    return new Response(body, { status: 200, headers });
}

function rateLimited() {
    return new Response(JSON.stringify({ message: 'API rate limit exceeded (held by the panel until GitHub resets it)' }), {
        status: 403,
        headers: { 'content-type': 'application/json', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.ceil(limitedUntil / 1000)) },
    });
}

/** When the allowance is spent, and until when; null while it is not. */
export function limitedTill() {
    return Date.now() < limitedUntil ? new Date(limitedUntil) : null;
}

export async function github(url, { timeoutMs = 15_000 } = {}) {
    const kept = answers.get(url);
    if (kept && Date.now() - kept.at < KEEP_MS) return rebuilt(kept);
    if (Date.now() < limitedUntil) return rateLimited();

    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(timeoutMs) });
    if (res.headers.get('x-ratelimit-remaining') === '0' && (res.status === 403 || res.status === 429)) {
        const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
        limitedUntil = reset > Date.now() ? reset : Date.now() + 60_000;
        return res;
    }
    if (!res.ok) return res;
    const entry = { at: Date.now(), body: await res.text(), type: res.headers.get('content-type'), link: res.headers.get('link') };
    remember(url, entry);
    return rebuilt(entry);
}
