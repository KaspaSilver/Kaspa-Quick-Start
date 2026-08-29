import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { hasCertificate } from './nginx.js';
import { selfTest } from './certbot.js';
import { WEBROOT_DIR } from './paths.js';
import { publicIp } from './duckdns.js';
import { containerState, publishedPorts, PROXY_CONTAINER } from './dockerctl.js';

/**
 * Whether the outside world can actually reach this machine on 80 and 443.
 *
 * Nothing inside the network can answer that question. A request from here to
 * this connection's own public address either loops back inside the router or
 * is dropped by it, and neither outcome says anything about what a stranger
 * would find. So the only honest test asks something on the internet to try the
 * connection, and this asks check-host.net, which exists for that and needs no
 * account.
 *
 * That means telling a third party this machine's address. It is the same
 * address DuckDNS already publishes and every site this node connects to
 * already sees, and the check only runs when somebody presses the button, but
 * the panel says so before it does it.
 */
const API = 'https://check-host.net';

// No LAN address is reported. The obvious way to find one -- reading the
// interfaces -- returns this container's address on the docker network, which
// looks like an answer and would send somebody to change a forwarding rule that
// was already right. The host's own address is not visible from in here, so the
// panel says "this machine" and leaves the address to the router's own device
// list, which knows.
const NODES = 3;

async function ask(path) {
    const res = await fetch(`${API}${path}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`check-host.net answered ${res.status}`);
    return res.json();
}

/** Waits for the nodes to report, whichever kind of check was started. */
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
async function probeTcp(ip, port) {
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

/**
 * Port 80 gets a stronger test than "something answered".
 *
 * A router's own admin page on port 80 accepts connections perfectly well, and
 * a TCP check cannot tell it from nginx -- so it would report a forwarded port
 * where there is none, which is worse than not checking. This asks for the file
 * Let's Encrypt is going to ask for, from outside, and only a 200 means the
 * request reached this machine. The default vhost serves that path for every
 * name, so it works before any domain is set up.
 */
async function probeChallenge(target, { scheme = 'http' } = {}) {
    // `target` carries its own port, because the outside may not be using the
    // one this scheme defaults to.
    const token = `panel-check-${crypto.randomBytes(8).toString('hex')}`;
    const dir = path.join(WEBROOT_DIR, '.well-known', 'acme-challenge');
    const file = path.join(dir, token);

    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, token, 'utf8');
        const url = `${scheme}://${target}/.well-known/acme-challenge/${token}`;
        // Each node answers [ok, time, status text, http code, ip].
        const r = await collect(
            await ask(`/check-http?host=${encodeURIComponent(url)}&max_nodes=${NODES}`),
            (a) => Array.isArray(a) && String(a[3]) === '200',
        );
        if (r.good === null) return { open: null, detail: 'check-host.net did not finish in time', link: r.link };
        return {
            open: r.good > 0,
            detail:
                r.good > 0
                    ? `${r.good} of ${r.total} places fetched a file from this machine`
                    : `none of ${r.total} places reached this machine (nothing is forwarded, or something else answers there)`,
            link: r.link,
        };
    } finally {
        try {
            fs.rmSync(file);
        } catch {
            /* nothing to clean up */
        }
    }
}

/**
 * The whole picture: what this machine does, and what the internet can see.
 *
 * The local half is the more useful one when something is wrong, because it
 * separates "your router is not forwarding" from "your proxy is not running",
 * which look identical from outside and need opposite fixes.
 */
export async function check(domain = null, { httpPort = 80, httpsPort = 443, bindHttp = 80, bindHttps = 443, dnsChallenge = false } = {}) {
    const [state, published, ip] = await Promise.all([
        containerState(PROXY_CONTAINER),
        publishedPorts(PROXY_CONTAINER),
        publicIp(),
    ]);

    // What nginx binds on this machine, which is not what the outside dials
    // when a router maps one to the other.
    const listening = new Set(published.map((p) => (p.container || '').split('/')[0]));
    const local = {
        proxyRunning: state.running,
        bindHttp,
        bindHttps,
        publishesHttp: listening.has(String(bindHttp)),
        publishesHttps: listening.has(String(bindHttps)),
        // Serves the file Let's Encrypt will ask for, which is the thing that
        // actually has to work on port 80.
        servesChallenge: state.running ? (await selfTest(domain ?? 'localhost')).ok : false,
        certificate: domain ? hasCertificate(domain) : null,
    };

    if (!ip) return { ip: null, local, outside: null, error: 'Could not work out this connection\'s public address.' };

    let outside = null;
    let error = null;
    try {
        // 443 can only be identified once there is a certificate to serve: an
        // HTTPS request to a bare address fails on the name either way, so
        // before then all that can be said is that something accepted the
        // connection. Said plainly rather than implied.
        // Whatever the outside actually dials. Hardcoding 80 and 443 here
        // asked the wrong question the moment somebody forwarded 8080 instead,
        // and reported a closed port that nothing was supposed to be using.
        const identifyHttps = Boolean(domain) && hasCertificate(domain);
        const httpsTarget = identifyHttps ? `${domain}:${httpsPort}` : null;
        const [http, https] = await Promise.all([
            probeChallenge(`${ip}:${httpPort}`),
            identifyHttps ? probeChallenge(httpsTarget, { scheme: 'https' }) : probeTcp(ip, httpsPort),
        ]);
        outside = {
            http: { ...http, port: httpPort },
            https: { ...https, port: httpsPort, identified: identifyHttps },
        };
    } catch (err) {
        error = err.message;
    }

    // With DNS-01 available, an unreachable http port costs the ability to
    // serve plain http and nothing else. Saying so is the difference between a
    // failed check and a working setup that happens to skip a port.
    return { ip, local, outside, error, dnsChallenge };
}
