import fs from 'node:fs';
import path from 'node:path';
import { CONF_DIR } from './paths.js';

/**
 * When the node next prunes, and what that gives back.
 *
 * Kaspad keeps full block data for a rolling window and throws away everything
 * older. Two chain constants decide the shape of it, both from
 * consensus/core/src/config/constants.rs, scaled by the block rate in
 * consensus/core/src/config/bps.rs:
 *
 *   finality_depth = BPS * FINALITY_DURATION  (43,200s, so 12 hours)
 *   pruning_depth  = BPS * PRUNING_DURATION   (108,000s, so 30 hours)
 *
 * The node does not prune continuously. It moves its pruning point in whole
 * finality steps: candidates ("pruning samples") sit on multiples of
 * finality_depth in blue score, and the pruning point jumps to the newest
 * sample that is at least pruning_depth behind the sink
 * (consensus/src/processes/pruning.rs). So a prune happens roughly every 12
 * hours and each one drops about 12 hours of block data, leaving 30-ish hours
 * on disk.
 *
 * That regularity is what makes the countdown below exact rather than a guess:
 * knowing the current pruning point's blue score is enough to say which blue
 * score triggers the next move, and the only estimated part is how long the
 * chain takes to get there.
 */

// consensus/core/src/config/constants.rs
const FINALITY_DURATION = 43_200; // seconds, 12 hours
const PRUNING_DURATION = 108_000; // seconds, 30 hours

// Both live networks run Crescendo's 10 blocks per second.
const BPS = 10;

export const NETWORK_PRUNING = {
    mainnet: { bps: BPS, finalityDepth: BPS * FINALITY_DURATION, pruningDepth: BPS * PRUNING_DURATION },
    'testnet-10': { bps: BPS, finalityDepth: BPS * FINALITY_DURATION, pruningDepth: BPS * PRUNING_DURATION },
};

const paramsFor = (network) => NETWORK_PRUNING[network] ?? NETWORK_PRUNING.mainnet;

// --------------------------------------------------------- blue score rate --

/**
 * Blue score climbs at roughly the block rate, but not exactly: it counts the
 * blue blocks merged into the chain, which dips when peers are slow and catches
 * up afterwards. Timing the real thing over a few minutes beats assuming BPS.
 */
const RATE_WINDOW_MS = 10 * 60_000;
let samples = [];

function observeRate(blueScore, now) {
    if (!Number.isFinite(blueScore) || blueScore <= 0) return null;

    const last = samples[samples.length - 1];
    // A blue score that went backwards means a different chain or a fresh sync,
    // so the old samples say nothing useful about the new one.
    if (last && blueScore < last.blueScore) samples = [];
    if (!last || now - last.at >= 15_000) samples.push({ at: now, blueScore });
    samples = samples.filter((s) => now - s.at <= RATE_WINDOW_MS);

    const first = samples[0];
    const latest = samples[samples.length - 1];
    const seconds = (latest.at - first.at) / 1000;
    // A short window is a noisy one: blue score arrives in mergeset-sized
    // lumps, so a minute of samples swings the rate by several percent and
    // makes the countdown jump around by a quarter hour between refreshes.
    // Three minutes settles it, and the window keeps widening to ten from there.
    if (seconds < 180) return null;
    const rate = (latest.blueScore - first.blueScore) / seconds;
    return rate > 0 ? rate : null;
}

// -------------------------------------------------- measuring what it frees --

/**
 * How much disk a prune gives back is not something the node reports, and it
 * cannot be worked out from chain constants either: it depends on how full the
 * blocks in the discarded window happened to be. It can be measured, though,
 * and in two independent ways that check each other.
 *
 * The first is direct. Watch for the pruning point changing and see what the
 * volume did across it.
 *
 * The second gives an answer before the first prune ever happens. A node that
 * has finished syncing sits at a steady size: every cycle it takes on new
 * blocks and drops an equally old window of them. So whatever the volume grows
 * by between two prunes is very close to what the next prune releases, and that
 * can be read off after a couple of hours rather than after twelve.
 */
const HISTORY_FILE = path.join(CONF_DIR, 'pruning-history.json');
const MAX_EVENTS = 12;
const SAVE_EVERY_MS = 60_000;

function readHistory() {
    try {
        const raw = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
        return { seen: raw.seen ?? null, events: Array.isArray(raw.events) ? raw.events : [] };
    } catch {
        return { seen: null, events: [] };
    }
}

let history = null;
let savedAt = 0;

function writeHistory(force = false) {
    if (!force && Date.now() - savedAt < SAVE_EVERY_MS) return;
    savedAt = Date.now();
    try {
        fs.mkdirSync(CONF_DIR, { recursive: true });
        fs.writeFileSync(HISTORY_FILE, `${JSON.stringify(history, null, 2)}\n`);
    } catch {
        /* the countdown still works without a saved history */
    }
}

/**
 * Docker reports volume sizes as text like "19.58GB", which is all the
 * precision available without walking the whole volume ourselves. That lands at
 * roughly 10 MB resolution on a 20 GB database, well under the size of anything
 * a prune moves.
 */
export function parseSize(text) {
    const m = /^([\d.]+)\s*([KMGT]?i?B)$/i.exec(String(text ?? '').trim());
    if (!m) return null;
    const units = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 };
    const factor = units[m[2].toLowerCase()];
    return factor ? Number(m[1]) * factor : null;
}

function recordPoint({ pruningPointHash, pruningPointBlueScore, diskBytes, network, now }) {
    if (!history) history = readHistory();
    if (!pruningPointHash) return;

    const previous = history.seen;

    if (previous && previous.hash === pruningPointHash) {
        // Still the same window. Keep the latest reading so the growth since
        // the last prune, and the comparison across the next one, stay current.
        previous.bytesNow = diskBytes;
        previous.atNow = now;
        writeHistory();
        return;
    }

    // Readings only happen while somebody has the panel open. If the last one
    // is old, the pruning point may have moved several times since, and the
    // difference in volume size would be the net of all of them rather than the
    // effect of one prune. Better to restart the baseline than publish that.
    const readingIsFresh = previous && now - previous.atNow < 30 * 60_000;

    // A real prune moves the pruning point forward by one finality window, or
    // by two if a reading was missed. Anything outside that is not a prune at
    // all: switching between mainnet and testnet changes the blue scale
    // entirely, and wiping the data volume to resync starts it somewhere else
    // again. Both would otherwise be filed as an enormous amount of space
    // freed, so the size of the step is what tells them apart.
    const span =
        previous && Number.isFinite(pruningPointBlueScore) && Number.isFinite(previous.blueScore)
            ? pruningPointBlueScore - previous.blueScore
            : null;
    const { finalityDepth } = paramsFor(network);
    const stepLooksNormal = span != null && span > finalityDepth * 0.5 && span < finalityDepth * 2.5;

    if (readingIsFresh && stepLooksNormal && Number.isFinite(previous.bytesNow) && Number.isFinite(diskBytes)) {
        history.events.unshift({
            at: now,
            // Negative means the volume read larger afterwards, which happens
            // when RocksDB has not compacted the deleted blocks away yet. It is
            // reported as it was read rather than quietly dropped.
            freedBytes: previous.bytesNow - diskBytes,
            blueScore: pruningPointBlueScore ?? null,
            spanBlueScore: span,
        });
        history.events = history.events.slice(0, MAX_EVENTS);
    }

    history.seen = {
        hash: pruningPointHash,
        blueScore: pruningPointBlueScore ?? null,
        at: now,
        bytesAtChange: diskBytes,
        bytesNow: diskBytes,
        atNow: now,
    };
    writeHistory(true);
}

/**
 * What the next prune should release, from how much the volume has grown since
 * the last one, scaled up to a whole cycle. Needs a synced node, since one
 * still catching up grows for reasons that have nothing to do with the cycle,
 * and a couple of hours of readings before it says anything.
 */
function projectRelease(cycleSeconds, synced) {
    const seen = history?.seen;
    if (!synced || !seen || !Number.isFinite(seen.bytesAtChange) || !Number.isFinite(seen.bytesNow)) return null;

    const elapsed = (seen.atNow - seen.at) / 1000;
    const growth = seen.bytesNow - seen.bytesAtChange;

    // The database does not grow smoothly. RocksDB compacts on its own schedule,
    // so the figure drifts up and down regardless of what the chain is doing.
    // Half an hour of exact byte counts is enough for real growth to stand out
    // from that drift, and a reading that came out flat or negative is drift
    // with nothing underneath it.
    //
    // Longer than a cycle means a prune went by unseen, so the growth spans more
    // than one window and scaling it says nothing either way.
    if (elapsed < 1800 || elapsed > cycleSeconds * 1.2 || growth <= 0) return null;

    return {
        bytes: growth * (cycleSeconds / elapsed),
        // How much of the cycle the reading actually covers. A projection made
        // ten hours in is worth a lot more than one made forty minutes in.
        coverage: Math.min(1, elapsed / cycleSeconds),
        observedBytes: growth,
        observedSeconds: elapsed,
    };
}

/**
 * What a prune frees, worked out from what the node is holding right now.
 *
 * The consensus directory holds one rolling window of blocks, headers and DAG
 * data, and a prune drops one finality step out of it. So the average cost of a
 * block on disk, times the number of blocks in a step, is the size of what goes.
 *
 * This reads slightly high: the window also carries the pruning point's UTXO
 * set and some fixed overhead that no prune removes, and both get averaged into
 * the per-block figure. It is available the moment the node is up, though,
 * which the growth measurement is not, so it fills the gap until there is
 * something measured to replace it.
 */
function estimateFromWindow({ consensusBytes, retainedBlocks, finalityDepth }) {
    if (!Number.isFinite(consensusBytes) || !(retainedBlocks > 0)) return null;
    const perBlock = consensusBytes / retainedBlocks;
    return { bytes: perBlock * finalityDepth, perBlock, retainedBlocks };
}

// ------------------------------------------------------------------ status --

/**
 * @param {object} input
 * @param {string} input.network            mainnet or testnet-10
 * @param {number} input.sinkBlueScore      from getSinkBlueScore
 * @param {string} input.pruningPointHash   from getBlockDagInfo
 * @param {number} input.pruningPointBlueScore  the pruning point header's blue score
 * @param {number} input.consensusBytes     exact size of the consensus store,
 *                                          which is the part pruning drops
 * @param {number} input.blockCount         blocks held in the retained window
 * @param {boolean} input.synced            a node still catching up grows for
 *                                          reasons unrelated to pruning
 */
export function pruningStatus({
    network = 'mainnet',
    sinkBlueScore,
    pruningPointHash,
    pruningPointBlueScore,
    consensusBytes = null,
    blockCount = null,
    synced = false,
    now = Date.now(),
} = {}) {
    const { bps, finalityDepth, pruningDepth } = paramsFor(network);
    const base = {
        network,
        finalityDepth,
        pruningDepth,
        retentionHours: PRUNING_DURATION / 3600,
        stepHours: FINALITY_DURATION / 3600,
        blocksPerStep: finalityDepth,
    };

    const rate = observeRate(sinkBlueScore, now);
    recordPoint({ pruningPointHash, pruningPointBlueScore, diskBytes: consensusBytes, network, now });
    const events = (history ?? readHistory()).events;
    const measured = events.length ? events[0] : null;
    const effectiveRate = rate ?? bps;
    // One full cycle is a finality step at whatever rate the chain is moving.
    const projected = projectRelease(finalityDepth / effectiveRate, synced);
    const estimated = estimateFromWindow({ consensusBytes, retainedBlocks: blockCount, finalityDepth });

    // Best answer available, and how it was arrived at, so the panel can say
    // which without having to work it out from which fields are filled in.
    const freed = measured && measured.freedBytes > 100e6
        ? { bytes: measured.freedBytes, source: 'measured' }
        : projected
          ? { bytes: projected.bytes, source: 'growth' }
          : estimated
            ? { bytes: estimated.bytes, source: 'window' }
            : null;

    if (!Number.isFinite(sinkBlueScore) || !Number.isFinite(pruningPointBlueScore) || pruningPointBlueScore <= 0) {
        return { ...base, known: false, measured, projected, estimated, freed, history: events };
    }

    // The next sample sits on the following multiple of finality_depth, and the
    // pruning point moves to it once the sink is pruning_depth beyond it.
    const nextPointBlueScore = (Math.floor(pruningPointBlueScore / finalityDepth) + 1) * finalityDepth;
    const firesAtBlueScore = nextPointBlueScore + pruningDepth;
    const blueScoreRemaining = Math.max(0, firesAtBlueScore - sinkBlueScore);
    const secondsUntil = blueScoreRemaining / effectiveRate;

    return {
        ...base,
        known: true,
        pruningPointBlueScore,
        sinkBlueScore,
        // How much history is on disk right now, in blocks and in hours.
        retainedBlueScore: sinkBlueScore - pruningPointBlueScore,
        nextPointBlueScore,
        firesAtBlueScore,
        blueScoreRemaining,
        secondsUntil,
        at: new Date(now + secondsUntil * 1000).toISOString(),
        blueScorePerSecond: effectiveRate,
        // Whether that rate came from watching the chain or from the block rate
        // constant, so the panel can say which.
        rateMeasured: rate != null,
        consensusBytes,
        freed,
        measured,
        projected,
        estimated,
        history: events,
    };
}

