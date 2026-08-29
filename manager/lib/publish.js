import { APPS, loadAppsConfig } from './apps.js';
import { loadBridgeConfig } from './bridge.js';
import { loadManagerConfig, loadNodeConfig, loadProxies } from './store.js';
import { TARGET_KINDS } from './nginx.js';

/**
 * What can be given a public web address, in the order someone would think of
 * them: the node first, then the things that ride along with it, then the panel
 * that runs all of it.
 *
 * The old proxy screen asked the question the other way round -- add a domain,
 * then pick an upstream from a list of ports -- which meant knowing that the
 * KaChat indexer answers on 3080 before you could publish it. A service is the
 * thing a person actually wants to put on a domain, so a service is what this
 * lists, and the port behind it is nobody's business but this file's.
 *
 * `kind` is the existing proxy target kind, so an assignment made here produces
 * exactly the proxy host the advanced screen has always produced.
 */
export const SERVICES = [
    {
        key: 'kaspad',
        kind: 'borsh',
        sharedPath: '/borsh',
        label: 'Kaspa node',
        detail: 'wRPC Borsh, the endpoint wallets and KDX connect to.',
        afterNote: 'Wallets and KDX connect to wss://{domain}. The certificate is what makes that a wss and not a ws.',
    },
    {
        key: 'mining',
        kind: 'bridge',
        sharedPath: '/mining',
        label: 'Stratum bridge dashboard',
        detail: "The bridge's own web page: connected workers, hashrate, shares and blocks found.",
        afterNote:
            'The dashboard is at https://{domain}. It is the page built into the stratum bridge itself, showing the same numbers as the Mining tab here, which reads them from it. Publishing it is worth doing when people mining to you want to see their own workers without a login to this panel. It has no password of its own, so add one above if it should not be public. Miners still point at the stratum port directly; this name is only the stats page.',
    },
    {
        key: 'kachat',
        kind: 'kachat',
        // Its clients call absolute paths (/get-posts, /v1/push), so it can
        // only ever be the thing at the root of a name.
        rootOnly: true,
        label: 'KaChat indexer',
        detail: 'The KaPosts REST API, plus the chat and push endpoints, on one name.',
        afterNote:
            'Point KaChat clients at https://{domain}. Content, chat and push registration all answer there: the panel routes /handshakes, /contextual-messages, /payments, /self-stash, /group-messages, /group-control and /v1/push to the chat indexer, and everything else to the content API. The admin dashboard and the internal push injection point are never published.',
    },
    {
        key: 'desktop',
        kind: 'desktop',
        sharedPath: '/app',
        label: 'KaChat Desktop',
        detail: 'The browser client, served from this machine.',
        afterNote: 'Open https://{domain} in a browser. Point it at your own indexer domain if you published one.',
    },
    {
        key: 'nextcloud',
        kind: 'nextcloud',
        sharedPath: '/cloud',
        label: 'Nextcloud',
        detail: 'Files, photos and calendars.',
        afterNote: 'Nextcloud is at https://{domain}. Add the name to its trusted domains under Apps if it complains.',
    },
    {
        key: 'panel',
        kind: 'manager',
        sharedPath: '/panel',
        label: 'This control panel',
        detail: 'Everything on this page, from anywhere.',
        afterNote: 'This panel is at https://{domain}. It drives the Docker daemon, so keep the admin password somewhere safe.',
    },
];

export const serviceFor = (key) => SERVICES.find((s) => s.key === key) ?? null;

/**
 * Where a service should sit on a name, given what is already there.
 *
 * One free DuckDNS name is all most people will have, and a node and an indexer
 * on it is the pairing this stack was built for, so sharing has to be the easy
 * case rather than the clever one. The first service on a name takes the root;
 * anything joining it moves to its own prefix, which nginx strips before the
 * request arrives.
 */
export function pathFor(service, domain, proxies) {
    const others = proxies.filter((p) => p.domain === domain && p.target?.kind !== service.kind);
    // Nothing else there: take the root, whoever you are.
    if (!others.length) return { path: '/', sharedWith: [] };

    const rootTaken = others.some((p) => (p.path ?? '/') === '/');
    if (!rootTaken) return { path: '/', sharedWith: others };

    if (service.rootOnly) {
        const holder = others.find((p) => (p.path ?? '/') === '/');
        const err = new Error(
            `${service.label} has to answer at the root of a name, and ${domain} already serves ${
                SERVICES.find((sv) => sv.kind === holder.target?.kind)?.label ?? 'something else'
            } there.`,
        );
        err.details = [`Give ${service.label} a name of its own, or move the other service off the root first.`];
        throw err;
    }

    return { path: service.sharedPath ?? `/${service.key}`, sharedWith: others };
}

/**
 * Whether publishing a service would reach anything today, and if not, why.
 *
 * A domain can be assigned before its service is switched on -- nginx renders
 * the vhost either way and the upstream simply answers once it exists -- so
 * this never blocks. It is the difference between "this will work" and "this is
 * ready, but nothing is listening yet", which is worth saying out loud rather
 * than leaving someone to discover through a 502.
 */
export function readiness({ nodeCfg = loadNodeConfig(), appsCfg = loadAppsConfig(), bridgeCfg = loadBridgeConfig(), panelHasPassword = true } = {}) {
    const state = {};

    state.kaspad = nodeCfg.services.borsh
        ? { ready: true }
        : { ready: false, reason: 'The wRPC Borsh listener is off. Switch it on under Kaspad, Ports.' };

    state.mining = bridgeCfg.enabled
        ? bridgeCfg.publishDashboard
            ? { ready: true }
            : { ready: false, reason: "The bridge's dashboard is off. Switch it on under Mining." }
        : { ready: false, reason: 'Mining is off, so the bridge is not running.' };

    for (const key of ['kachat', 'desktop', 'nextcloud']) {
        state[key] = appsCfg[key]?.enabled
            ? { ready: true }
            : { ready: false, reason: `${APPS[key].label} is switched off under Apps.` };
    }

    // The panel is the one service where publishing is refused rather than
    // merely unready: without a password, a domain would hand the Docker daemon
    // to anyone who found it. nginx.validateProxy enforces this too; saying it
    // here is what stops the dropdown from looking available in the first place.
    state.panel = panelHasPassword
        ? { ready: true }
        : {
              ready: false,
              blocked: true,
              reason: 'This panel has no admin password, so it cannot go on a domain. Set one under Global settings, then come back.',
          };

    return state;
}

/** The service view: every publishable thing, with the domain it answers on. */
export function overview({ proxies = loadProxies(), panelHasPassword = true } = {}) {
    const ready = readiness({ panelHasPassword });
    // The address someone can paste into a browser, which is not the same as
    // the name when a router put a different port in front of this machine.
    const mgr = loadManagerConfig().proxy;
    const portFor = (scheme) => {
        const port = scheme === 'https' ? (mgr.publicHttpsPort ?? 443) : (mgr.publicHttpPort ?? 80);
        return Number(port) === (scheme === 'https' ? 443 : 80) ? '' : `:${Number(port)}`;
    };

    return SERVICES.map((service) => {
        // The proxy host this service owns, if one has been assigned. Matching
        // on the target kind is what makes the two screens the same data: a
        // host added by hand on the advanced screen shows up here too.
        const proxy = proxies.find((p) => p.target?.kind === service.kind) ?? null;
        return {
            ...service,
            upstreamLabel: TARGET_KINDS[service.kind]?.label ?? service.kind,
            domain: proxy?.domain ?? null,
            proxyId: proxy?.id ?? null,
            path: proxy?.path ?? null,
            url: proxy
                ? `${proxy.ssl?.mode === 'letsencrypt' ? 'https' : 'http'}://${proxy.domain}${portFor(
                      proxy.ssl?.mode === 'letsencrypt' ? 'https' : 'http',
                  )}${(proxy.path ?? '/') === '/' ? '' : proxy.path}`
                : null,
            ...ready[service.key],
        };
    });
}

/**
 * Everything that has to become true before a service answers on a domain, in
 * the order the wizard will do it.
 *
 * This is deliberately a plan rather than a checklist: someone setting up a
 * public address should not have to know that the KaChat indexer needs its
 * containers running, that a Borsh listener has to be bound, or that a
 * certificate cannot be issued before nginx is up. They should say "publish
 * this on that name" once, see what that entails, and agree to it.
 *
 * Steps already satisfied are returned with `done: true` rather than dropped,
 * so the wizard can show the whole shape of the job and tick off the parts that
 * are already in place.
 */
export function setupPlan(key, { nodeCfg = loadNodeConfig(), appsCfg = loadAppsConfig(), bridgeCfg = loadBridgeConfig(), panelHasPassword = true, proxyOn = false } = {}) {
    const service = serviceFor(key);
    if (!service) return null;

    const steps = [
        {
            key: 'proxy',
            label: 'Start the reverse proxy',
            detail: 'It takes ports 80 and 443 on this machine and serves every domain you publish.',
            done: proxyOn,
        },
    ];

    if (key === 'kaspad') {
        steps.push({
            key: 'borsh',
            label: "Switch on the node's wRPC Borsh listener",
            detail: 'That is the endpoint being published. The node restarts to pick it up.',
            done: Boolean(nodeCfg.services.borsh),
        });
    }

    if (key === 'mining') {
        steps.push({
            key: 'mining',
            label: 'Switch mining on',
            detail: 'Builds the stratum bridge if it has never run, then starts it.',
            done: Boolean(bridgeCfg.enabled),
        });
        steps.push({
            key: 'dashboard',
            label: "Switch on the bridge's own dashboard",
            detail: 'It is off by default because the Mining tab already shows those numbers. It is the page this domain will serve.',
            done: Boolean(bridgeCfg.publishDashboard),
        });
    }

    if (['kachat', 'desktop', 'nextcloud'].includes(key)) {
        steps.push({
            key: 'app',
            label: `Switch ${APPS[key].label} on`,
            detail:
                key === 'kachat'
                    ? 'Builds the indexer from Rust source the first time, which takes a long while, then starts it and its database.'
                    : 'Builds its images if they are missing, then starts its containers.',
            done: Boolean(appsCfg[key]?.enabled),
        });
    }

    steps.push({
        key: 'dns',
        label: 'Point the DuckDNS name at this machine',
        detail: "Saves the subdomain and token, then tells DuckDNS this connection's address. It keeps itself current from then on.",
        done: false,
    });
    steps.push({
        key: 'publish',
        label: `Publish ${service.label} on the name`,
        detail:
            key === 'kachat'
                ? 'Writes the vhost, including the chat and push routes on their own port and a 404 for the endpoints that must stay private.'
                : 'Writes the nginx vhost for the domain.',
        done: false,
    });
    steps.push({
        key: 'certificate',
        label: "Get an HTTPS certificate from Let's Encrypt",
        detail: 'Needs the name to resolve here and port 80 open from the internet. Renewal is automatic afterwards.',
        done: false,
    });

    // The one thing the wizard cannot do for you. Publishing the panel without
    // a password hands the Docker daemon to whoever finds the address.
    const blocked =
        key === 'panel' && !panelHasPassword
            ? 'This panel has no admin password. Set one under Global settings before putting it on a domain: it holds the Docker socket, so an address without a password is the whole machine.'
            : null;

    return { service, steps, blocked };
}
