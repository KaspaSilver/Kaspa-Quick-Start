/**
 * The few Cloudflare API calls a tunnel needs, and nothing else.
 *
 * One API token does all of it: list the domains on the account, make (or
 * find) the tunnel, tell it which hostname goes where, and add the DNS record
 * that sends the hostname into the tunnel. The token needs three permissions,
 * which the panel asks for by name when one is missing:
 *
 *   Account  Cloudflare Tunnel  Edit
 *   Zone     DNS                Edit
 *   Zone     Zone               Read
 *
 * Zero dependencies, like the rest of the panel: Node's own fetch.
 */

// Overridable so a test can point it at a stand-in rather than the real API.
const API = (process.env.CLOUDFLARE_API_BASE || 'https://api.cloudflare.com/client/v4').replace(/\/+$/, '');

export class CloudflareError extends Error {
    constructor(message, { status, codes = [] } = {}) {
        super(message);
        this.name = 'CloudflareError';
        this.status = status;
        this.codes = codes;
    }
}

/**
 * One API call. Cloudflare wraps everything in {success, errors, result}; this
 * unwraps it and turns a failure into a sentence a person can act on.
 */
export async function call(token, method, path, body) {
    let res;
    try {
        res = await fetch(`${API}${path}`, {
            method,
            headers: {
                Authorization: `Bearer ${token}`,
                ...(body ? { 'Content-Type': 'application/json' } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
            signal: AbortSignal.timeout(30_000),
        });
    } catch (err) {
        throw new CloudflareError(`Could not reach Cloudflare: ${err.cause?.code || err.message}`);
    }

    let data = null;
    try {
        data = await res.json();
    } catch {
        data = null;
    }

    if (!res.ok || data?.success === false) {
        const errors = data?.errors ?? [];
        const codes = errors.map((e) => e.code);
        const detail = errors.map((e) => e.message).filter(Boolean).join('; ');
        // 401 is a token Cloudflare does not recognise at all; 403 (and code
        // 10000, "Authentication error", which it also uses for a missing
        // permission) is a real token without the right to do this one thing.
        if (res.status === 401) throw new CloudflareError('Cloudflare did not accept that API token. Check it was copied whole.', { status: 401, codes });
        if (res.status === 403 || codes.includes(10000)) {
            throw new CloudflareError(
                `The API token is missing a permission for this (${method} ${path.split('?')[0]}).${detail ? ` Cloudflare said: ${detail}` : ''}`,
                { status: 403, codes },
            );
        }
        throw new CloudflareError(detail || `Cloudflare answered ${res.status}.`, { status: res.status, codes });
    }
    return data?.result;
}

/**
 * The domains this token can see, with the account each belongs to.
 *
 * Doubles as the token check. A token with no zones is not "wrong" as far as
 * Cloudflare is concerned, but it is useless here, and saying so now beats a
 * cryptic failure at the first publish.
 */
export async function listZones(token) {
    const zones = await call(token, 'GET', '/zones?per_page=50&status=active');
    return (zones ?? []).map((z) => ({ id: z.id, name: z.name, accountId: z.account?.id, accountName: z.account?.name }));
}

/** A tunnel by id, or null when it is gone (deleted in the dashboard, or another account's). */
export async function getTunnel(token, accountId, tunnelId) {
    try {
        const t = await call(token, 'GET', `/accounts/${accountId}/cfd_tunnel/${tunnelId}`);
        return t && !t.deleted_at ? { id: t.id, name: t.name } : null;
    } catch (err) {
        if (err.status === 404 || err.status === 400) return null;
        throw err;
    }
}

/** The token cloudflared runs with, for a tunnel this account owns. */
export const runToken = (token, accountId, tunnelId) => call(token, 'GET', `/accounts/${accountId}/cfd_tunnel/${tunnelId}/token`);

/**
 * The tunnel to use, made if it does not exist yet.
 *
 * Found by name first, so connecting again -- after a reinstall, or a
 * disconnect -- picks the same tunnel back up rather than leaving another one
 * behind in the account each time.
 */
export async function ensureTunnel(token, accountId, name) {
    const found = await call(token, 'GET', `/accounts/${accountId}/cfd_tunnel?name=${encodeURIComponent(name)}&is_deleted=false`);
    const existing = (found ?? []).find((t) => t.name === name);
    if (existing) {
        return { id: existing.id, name: existing.name, token: await runToken(token, accountId, existing.id), created: false };
    }
    // config_src "cloudflare": the routes live in Cloudflare and are pushed to
    // the connector, so there is no config file here to keep in step.
    const made = await call(token, 'POST', `/accounts/${accountId}/cfd_tunnel`, { name, config_src: 'cloudflare' });
    return { id: made.id, name: made.name, token: made.token ?? (await runToken(token, accountId, made.id)), created: true };
}

/** How the tunnel is doing from Cloudflare's side: healthy, degraded, down or inactive. */
export async function tunnelStatus(token, accountId, tunnelId) {
    const t = await call(token, 'GET', `/accounts/${accountId}/cfd_tunnel/${tunnelId}`);
    return { status: t?.status ?? 'unknown', connections: (t?.connections ?? []).length };
}

/** The tunnel's routes as Cloudflare holds them now, catch-all included. */
export async function getIngress(token, accountId, tunnelId) {
    const result = await call(token, 'GET', `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`).catch((err) => {
        // A tunnel that has never had a configuration answers 404 here.
        if (err.status === 404) return null;
        throw err;
    });
    return result?.config?.ingress ?? [];
}

/**
 * Sets the routes for the names this panel manages, and keeps everyone else's.
 *
 * Cloudflare's configuration endpoint takes the full ingress list, not a change
 * to it, so the current one is read first. A route for a hostname this panel
 * does not manage -- one somebody added in the dashboard for another machine --
 * is carried over untouched; `drop` names the ones being taken off. The
 * catch-all at the end is required: a request for a name that matches nothing
 * gets a plain 404 rather than whatever happened to be listed first.
 */
export async function putIngress(token, accountId, tunnelId, routes, { drop = [] } = {}) {
    const ours = new Set([...routes.map((r) => r.hostname), ...drop]);
    const current = await getIngress(token, accountId, tunnelId);
    const theirs = current.filter((r) => r.hostname && !ours.has(r.hostname));
    const ingress = [
        ...routes.map((r) => ({ hostname: r.hostname, service: r.service, originRequest: r.originRequest ?? {} })),
        ...theirs,
        { service: 'http_status:404' },
    ];
    await call(token, 'PUT', `/accounts/${accountId}/cfd_tunnel/${tunnelId}/configurations`, { config: { ingress } });
}

// "an A record", "an MX record", "a CNAME record": by how the letters are said.
const article = (type) => (/^[AEFHILMNORSX]/.test(String(type)) ? 'an' : 'a');

export const tunnelTarget = (tunnelId) => `${tunnelId}.cfargotunnel.com`;

export async function findRecord(token, zoneId, hostname) {
    const list = await call(token, 'GET', `/zones/${zoneId}/dns_records?name.exact=${encodeURIComponent(hostname)}`);
    return (list ?? [])[0] ?? null;
}

/**
 * Points `hostname` into the tunnel.
 *
 * Never overwrites a record it did not make. A name that already exists and
 * points somewhere else is somebody's website, mail or verification record --
 * or the A record of a name this machine used to serve over its own ports --
 * and replacing it would break that silently. So this stops and says what is
 * there instead. A record already pointing at this tunnel is taken as-is, which
 * is what makes publishing safe to repeat.
 */
export async function pointAtTunnel(token, zoneId, hostname, tunnelId) {
    const want = tunnelTarget(tunnelId);
    const existing = await findRecord(token, zoneId, hostname);
    if (existing) {
        if (existing.type === 'CNAME' && existing.content === want) return { id: existing.id, reused: true };
        throw new CloudflareError(
            `${hostname} already has ${article(existing.type)} ${existing.type} record pointing at ${existing.content}. The panel will not replace a record it did not make: remove it in Cloudflare first, or pick another name.`,
            { status: 409 },
        );
    }
    const made = await call(token, 'POST', `/zones/${zoneId}/dns_records`, {
        type: 'CNAME',
        name: hostname,
        content: want,
        // Proxied is not optional: an unproxied CNAME to cfargotunnel.com
        // resolves to nothing anyone can connect to.
        proxied: true,
        comment: 'Kaspa Quick Start tunnel',
    });
    return { id: made.id, reused: false };
}

/**
 * Removes the record that sends a name into the tunnel, if it still does.
 *
 * Checked again first: somebody may have repointed the name by hand since, and
 * deleting it then would take down whatever they pointed it at.
 */
export async function removeRecord(token, zoneId, hostname, tunnelId) {
    const existing = await findRecord(token, zoneId, hostname);
    if (!existing) return { removed: false, reason: 'already gone' };
    if (existing.type !== 'CNAME' || existing.content !== tunnelTarget(tunnelId)) {
        return { removed: false, reason: `now points at ${existing.content}, so it was left alone` };
    }
    await call(token, 'DELETE', `/zones/${zoneId}/dns_records/${existing.id}`);
    return { removed: true };
}
