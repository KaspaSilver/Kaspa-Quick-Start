import { streamLogs, KASPAD_CONTAINER } from './dockerctl.js';

/**
 * Real sync progress, reconstructed from kaspad's own log.
 *
 * RPC alone cannot answer "how far along is it": getBlockDagInfo reports
 * blockCount 0 for the whole of the header and UTXO-set phases, which is why a
 * naive blocks/headers ratio sits at 0.0% for the first hour and then jumps.
 *
 * kaspad does report its progress -- it just does it to the log. Its
 * ProgressReporter (protocol/flows/src/ibd/progress.rs) prints a real
 * percentage derived from DAA score for the two long phases:
 *
 *     IBD: Processed 947934 block headers (64%) last block timestamp: ...
 *     IBD: Processed 12345 blocks (7%) last block timestamp: ...
 *
 * and the UTXO-set stream (ibd/streams.rs) prints running counts. Following the
 * log and parsing those lines is the only way to show honest progress, so that
 * is what this does.
 */

// Each phase owns a slice of the overall bar, so the number only ever moves
// forward even though the phases measure completely different things. The
// widths are rough proportions of wall-clock time on mainnet, not guarantees.
export const PHASES = [
    { key: 'starting', label: 'Starting up', start: 0, end: 1 },
    { key: 'connecting', label: 'Connecting to peers', start: 1, end: 3 },
    { key: 'proof', label: 'Verifying the pruning point proof', start: 3, end: 8 },
    { key: 'trusted', label: 'Processing trusted blocks', start: 8, end: 12 },
    { key: 'smt', label: 'Downloading commitment state', start: 12, end: 15 },
    { key: 'headers', label: 'Downloading block headers', start: 15, end: 55 },
    { key: 'utxoset', label: 'Downloading the UTXO set', start: 55, end: 70 },
    { key: 'blocks', label: 'Downloading and validating blocks', start: 70, end: 99 },
    { key: 'synced', label: 'Synced with the network', start: 100, end: 100 },
];

const phaseIndex = (key) => PHASES.findIndex((p) => p.key === key);

const state = {
    phase: 'starting',
    phasePercent: null, // kaspad's own figure, where it reports one
    processed: null,
    objectName: null,
    lastBlockTime: null,
    utxoChunks: 0,
    utxoCount: 0,
    utxoTotal: null,
    trustedBlocks: null,
    peer: null,
    updatedAt: null,
    lastLine: null,
};

// Never let the reported phase go backwards during a session. Peers drop and
// IBD restarts mid-sync; showing the bar snap back to 8% every time it does
// would look like the node was losing its work, which it is not.
function enterPhase(key) {
    if (phaseIndex(key) > phaseIndex(state.phase)) {
        state.phase = key;
        state.phasePercent = null;
    }
}

const MATCHERS = [
    [/IBD: Processed ([\d,]+) (block headers|blocks) \((\d+)%\)(?:.*last block timestamp: (.+))?/, (m) => {
        enterPhase(m[2] === 'block headers' ? 'headers' : 'blocks');
        state.processed = Number(m[1].replace(/,/g, ''));
        state.objectName = m[2];
        state.phasePercent = Number(m[3]);
        if (m[4]) state.lastBlockTime = m[4].trim();
    }],
    [/Received (\d+) UTXO set chunks so far, totaling in (\d+) UTXOs/, (m) => {
        enterPhase('utxoset');
        state.utxoChunks = Number(m[1]);
        state.utxoCount = Number(m[2]);
    }],
    [/Finished receiving the UTXO set\. Total UTXOs: (\d+)/, (m) => {
        enterPhase('utxoset');
        state.utxoTotal = Number(m[1]);
        state.utxoCount = Number(m[1]);
        state.phasePercent = 100;
    }],
    [/Starting IBD with headers proof with peer (\S+)/, (m) => {
        enterPhase('proof');
        state.peer = m[1];
    }],
    [/IBD started with peer (\S+)/, (m) => {
        enterPhase('connecting');
        state.peer = m[1];
    }],
    [/validating pruning points consistency/, () => enterPhase('proof')],
    [/Starting to process (\d+) trusted blocks/, (m) => {
        enterPhase('trusted');
        state.trustedBlocks = Number(m[1]);
    }],
    [/Done processing trusted blocks/, () => enterPhase('trusted')],
    [/downloading the pruning point SMT state/, () => enterPhase('smt')],
    [/IBD with peer \S+ completed successfully/, () => enterPhase('blocks')],
];

function consume(line) {
    for (const [re, apply] of MATCHERS) {
        const m = re.exec(line);
        if (!m) continue;
        apply(m);
        state.updatedAt = Date.now();
        state.lastLine = line.replace(/^\S+\s+/, '').trim().slice(0, 200);
        return;
    }
}

// ------------------------------------------------------------------ follow --

let stop = null;
let restartTimer = null;

export function start(log = () => {}) {
    if (stop) return;
    try {
        stop = streamLogs(KASPAD_CONTAINER, consume, { tail: 400 });
    } catch (err) {
        log(`sync progress: cannot follow kaspad logs: ${err.message}`);
    }
    // `docker logs -f` ends when the container stops or is recreated, which
    // happens on every settings change, so reattach rather than going blind.
    clearInterval(restartTimer);
    restartTimer = setInterval(() => {
        if (!stop) return;
        try {
            stop();
        } catch {
            /* already gone */
        }
        stop = streamLogs(KASPAD_CONTAINER, consume, { tail: 50 });
    }, 60_000);
    restartTimer.unref?.();
}

/** Called when the node is recreated, so the next session starts clean. */
export function reset() {
    Object.assign(state, {
        phase: 'starting',
        phasePercent: null,
        processed: null,
        objectName: null,
        utxoChunks: 0,
        utxoCount: 0,
        utxoTotal: null,
        lastLine: null,
    });
    if (stop) {
        try {
            stop();
        } catch {
            /* noop */
        }
        stop = null;
    }
    start();
}

// ---------------------------------------------------------------- snapshot --

/**
 * The UTXO set has no announced total, so its share of the bar is filled by an
 * asymptotic curve on the chunk count: always rising, never reaching the end of
 * its band, never claiming a precision that does not exist. The detail line
 * carries the real counts so nothing is hidden behind the estimate.
 */
const utxoFraction = (chunks) => 1 - Math.exp(-chunks / 45_000);

export function snapshot({ synced = false } = {}) {
    if (synced) {
        return {
            phase: 'synced',
            label: 'Synced with the network',
            percent: 100,
            estimated: false,
            detail: null,
            phasePercent: 100,
            lastLine: state.lastLine,
        };
    }

    const phase = PHASES.find((p) => p.key === state.phase) ?? PHASES[0];
    const width = phase.end - phase.start;
    let within = 0;
    let estimated = false;
    let detail = null;

    if (state.phase === 'headers' || state.phase === 'blocks') {
        within = (state.phasePercent ?? 0) / 100;
        if (state.processed != null) {
            detail = `${state.processed.toLocaleString()} ${state.objectName}` +
                (state.phasePercent != null ? ` · ${state.phasePercent}% of this stage` : '');
        }
    } else if (state.phase === 'utxoset') {
        within = state.utxoTotal ? 1 : utxoFraction(state.utxoChunks);
        estimated = !state.utxoTotal;
        detail = `${state.utxoCount.toLocaleString()} UTXOs in ${state.utxoChunks.toLocaleString()} chunks`;
    } else if (state.phase === 'trusted' && state.trustedBlocks) {
        detail = `${state.trustedBlocks.toLocaleString()} trusted blocks`;
    }

    return {
        phase: phase.key,
        label: phase.label,
        percent: Math.min(99.9, phase.start + width * Math.max(0, Math.min(1, within))),
        estimated,
        detail,
        phasePercent: state.phasePercent,
        lastBlockTime: state.lastBlockTime,
        lastLine: state.lastLine,
        stale: state.updatedAt ? Date.now() - state.updatedAt > 120_000 : true,
    };
}
