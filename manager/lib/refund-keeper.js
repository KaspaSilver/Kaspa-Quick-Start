import path from 'node:path';

import { docker, containerState } from './dockerctl.js';
import * as kachatDomains from './kachat-domains.js';
import { ports } from './kaspad-args.js';
import { CONF_DIR } from './paths.js';
import { loadNodeConfig, loadTestnetNodeConfig, readJson, writeJson } from './store.js';

/**
 * The .kachat offer refund keeper (kachat-domains docs/KQS.md section 6, audit DOM-002).
 *
 * A .kachat offer stays acceptable by its seller until someone spends it, even after its
 * `refundAfter` and on a name that lapsed and came back (docs/MAINNET.md C1, C6): script cannot
 * say "not after", and nothing on chain runs by itself. `refund()` is open to anyone once
 * `refundAfter` has passed, can only pay the buyer back, and takes its fee from the offer, so a
 * node operator can send those refunds for every buyer with no key and no funds. That is this.
 *
 * Every few hours, for each network whose .kachat Domains server is running with a verified
 * manifest, it runs the kachat-domains tool image's `refund-expired --indexer <that server>
 * --submit` against this install's own node. Two installs refunding the same offer just race:
 * the loser reports "already spent", which is not a failure. Rows it cannot use are SKIPPED and
 * the run still exits 0. On by default; Settings is on the .kachat Domains tab (Refunds).
 */

const FILE = path.join(CONF_DIR, 'refund-keeper.json');
const EVERY_MS = 6 * 60 * 60_000;
const FIRST_AFTER_MS = 10 * 60_000;
const RUN_TIMEOUT_MS = 20 * 60_000;
const DOCKER_NET = 'kaspa-node-net';
const MAX_FEE_KAS = '0.1';

/**
 * Where each network's keeper reads the chain. Over wRPC Borsh, not gRPC: a default mainnet
 * node runs --nogrpc (gRPC only binds for mining, the bot or a published port), while the Borsh
 * listener is exactly what installing this network's names server guarantees (KQS-034). The port
 * is read from the node's own config at run time.
 */
const TARGETS = {
    mainnet: { host: 'kaspad', config: loadNodeConfig, args: ['--network', 'mainnet'] },
    testnet: { host: 'kaspad-testnet', config: loadTestnetNodeConfig, args: [] },
};

const nodeUrl = (net) => `ws://${TARGETS[net].host}:${ports(TARGETS[net].config()).borsh}`;

const blankNet = () => ({
    lastAt: null,
    ok: null,
    refunded: 0,
    due: 0,
    open: 0,
    skipped: 0,
    alreadySpent: 0,
    unreadable: 0,
    failed: 0,
    error: '',
    tail: [],
    fails: 0,
    alertedAt: null,
    nextAt: null,
});

const DEFAULTS = { enabled: true, nets: { mainnet: blankNet(), testnet: blankNet() } };

export const load = () => readJson(FILE, DEFAULTS);
const save = (s) => writeJson(FILE, s);

const running = new Set();

/** Whether this network has something to keep: its names server up with a verified manifest. */
async function ready(net) {
    if (!kachatDomains.manifestSet(net)) return 'no verified manifest (install .kachat Domains for this network)';
    if (!(await kachatDomains.installedRevision())) return 'the kachat-domains tool image is not built';
    const st = await containerState(kachatDomains.NETWORKS[net].container).catch(() => null);
    if (!st?.running) return 'its .kachat Domains server is not running';
    // Checking an offer's coins is GetUtxosByAddresses, which needs the node's UTXO index. With
    // it off every due offer would be "skip"ped and nothing refunded (KQS-035).
    if (!TARGETS[net].config().flags?.utxoindex) return "the node's UTXO index is off (Node settings)";
    return null;
}

/** Reads the keeper's own report lines (kachat-names-cli main.rs refund_expired). */
export function parseReport(lines) {
    const out = { refunded: 0, due: 0, open: 0, skipped: 0, alreadySpent: 0, unreadable: 0, failed: 0 };
    for (const line of lines) {
        let m;
        if ((m = /^(\d+) open offer\(s\), (\d+) past refundAfter/.exec(line))) {
            out.open = Number(m[1]);
            out.due = Number(m[2]);
        } else if ((m = /^refunded (\d+) of (\d+) due offer/.exec(line))) {
            out.refunded = Number(m[1]);
            out.due = Number(m[2]);
        } else if (/^SKIPPED /.test(line)) out.skipped += 1;
        else if (/^already spent /.test(line)) out.alreadySpent += 1;
        // The CLI's lowercase "skip <offer>: <error>" is a due offer whose coins could not be
        // read (the UTXO index off, the node restarting); it does not fail the CLI's exit.
        else if (/^skip /.test(line)) out.unreadable += 1;
        else if (/^FAILED /.test(line)) out.failed += 1;
    }
    return out;
}

/**
 * One run on one network. Resolves with the stored result; never throws. `alert(text)` is
 * called once when a network fails twice in a row (re-armed by a good run).
 */
export async function runOnce(net, { alert = async () => {}, log = () => {} } = {}) {
    if (running.has(net)) return { ...load().nets[net], busy: true };
    running.add(net);
    const lines = [];
    let error = '';
    try {
        const why = await ready(net);
        if (why) {
            const s = load();
            s.nets[net].nextAt = Date.now() + EVERY_MS;
            save(s);
            return { ...s.nets[net], idle: why };
        }
        const N = kachatDomains.NETWORKS[net];
        const T = TARGETS[net];
        try {
            await docker(
                [
                    'run', '--rm', '--network', DOCKER_NET, kachatDomains.imageTag(),
                    ...T.args, '--node', nodeUrl(net), '--max-fee', MAX_FEE_KAS,
                    'refund-expired', '--indexer', `http://${N.host}:3080`, '--submit',
                ],
                { onLine: (l) => lines.push(String(l)), timeoutMs: RUN_TIMEOUT_MS },
            );
        } catch (err) {
            error = String(err?.message || err).split('\n')[0].slice(0, 400);
        }
    } finally {
        running.delete(net);
    }

    // An image built before the keeper existed does not know the command: that is an update
    // to make, not a failing keeper, so it neither counts towards nor raises the alert.
    const tooOld = error && /unrecognized subcommand|unexpected argument '--indexer'/i.test(`${lines.join('\n')}\n${error}`);
    if (tooOld) error = 'the kachat-domains tool image is older than the refund keeper: Update .kachat Domains (Updates tab)';
    const report = parseReport(lines);
    // A clean exit that was due to refund offers but could not read a single one of them is not
    // OK: it is how an off UTXO index or a restarting node looks from outside (KQS-035).
    if (!error && report.due > 0 && report.refunded === 0 && report.unreadable > 0) {
        error = `${report.unreadable} expired offer(s) could not be read from the node (is the UTXO index on in Node settings?)`;
    }
    const s = load();
    const r = s.nets[net];
    Object.assign(r, report, {
        lastAt: Date.now(),
        ok: !error,
        error,
        tail: lines.slice(-60),
        nextAt: Date.now() + EVERY_MS,
    });
    if (error && !tooOld) {
        r.fails += 1;
        if (r.fails >= 2 && !r.alertedAt) {
            r.alertedAt = Date.now();
            const label = kachatDomains.NETWORKS[net].label;
            await alert(
                `Refund keeper alert: the .kachat offer refund keeper on ${label} failed ${r.fails} times in a row (${error}). ` +
                    'Expired offers are not being refunded to their buyers from this server. See .kachat Domains, Refunds in the panel.',
            ).catch((e) => log(`refund-keeper: alert not sent: ${e.message}`));
        }
    } else if (!error) {
        r.fails = 0;
        r.alertedAt = null;
    }
    save(s);
    log(`refund-keeper ${net}: ${error ? `failed: ${error}` : `refunded ${r.refunded} of ${r.due} due (${r.open} open, ${r.skipped} skipped)`}`);
    return r;
}

export function setEnabled(on) {
    const s = load();
    s.enabled = Boolean(on);
    save(s);
    return s;
}

/** Every network every six hours, the first ten minutes after the panel starts. */
export function start({ alert, log }) {
    const tick = async () => {
        if (!load().enabled) return;
        for (const net of Object.keys(TARGETS)) {
            const due = load().nets[net].nextAt;
            if (due && Date.now() < due) continue;
            await runOnce(net, { alert, log });
        }
    };
    setTimeout(() => {
        tick().catch(() => {});
        setInterval(() => tick().catch(() => {}), 5 * 60_000).unref?.();
    }, FIRST_AFTER_MS).unref?.();
}

/** For the panel: settings plus each network's last run and whether it can run at all. */
export async function view() {
    const s = load();
    const nets = {};
    for (const net of Object.keys(TARGETS)) {
        nets[net] = { ...s.nets[net], label: kachatDomains.NETWORKS[net].label, running: running.has(net), idle: await ready(net) };
    }
    return { enabled: s.enabled, everyHours: EVERY_MS / 3_600_000, maxFeeKas: MAX_FEE_KAS, nets };
}
