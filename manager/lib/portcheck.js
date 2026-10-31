/**
 * Whether the outside world can actually reach this node's P2P port.
 *
 * Nothing inside the network can answer that question. A request from here to
 * this connection's own public address either loops back inside the router or
 * is dropped by it, and neither outcome says anything about what a stranger
 * would find. So the only honest test asks something on the internet to try the
 * connection, and this asks check-host.net, which exists for that and needs no
 * account.
 *
 * That means telling a third party this machine's address. It is the same
 * address every peer this node connects to already sees, and the check only
 * runs when somebody presses the button, but the panel says so before it does.
 *
 * Only the node's peer port is ever checked. Web addresses go through the
 * Cloudflare Tunnel, which opens no port to check.
 */
const API = 'https://check-host.net';

const NODES = 3;

async function ask(path) {
    const res = await fetch(`${API}${path}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`check-host.net answered ${res.status}`);
    return res.json();
}

/** Waits for the nodes to report. */
async function collect(started, interpret) {
    if (!started?.request_id) throw new Error('check-host.net did not accept the request');

    // Results arrive as the nodes finish, so this polls rather than waiting a
    // fixed time and hoping. A node that is still working reports null.
    for (let attempt = 0; attempt < 10; attempt += 1) {
        await new Promise((r) => setTimeout(r, 1500));
        const result = await ask(`/check-result/${started.request_id}`);
        const answers = Object.values(result ?? {}).filter((v) => v !== null);
        if (answers.length < Math.min(NODES, Object.keys(result ?? {}).length)) continue;

        const good = answers.filter(interpret).length;
        return { good, total: answers.length, link: started.permanent_link ?? null };
    }
    return { good: null, total: null, link: started.permanent_link ?? null };
}

/** A plain connection: something at that address accepts traffic on that port. */
export async function probeTcp(ip, port) {
    const r = await collect(
        await ask(`/check-tcp?host=${encodeURIComponent(`${ip}:${port}`)}&max_nodes=${NODES}`),
        (a) => Array.isArray(a) && a[0] && !a[0].error,
    );
    if (r.good === null) return { open: null, detail: 'check-host.net did not finish in time', link: r.link };
    return {
        open: r.good > 0,
        detail: r.good > 0 ? `${r.good} of ${r.total} places connected` : `none of ${r.total} places could connect`,
        link: r.link,
    };
}
