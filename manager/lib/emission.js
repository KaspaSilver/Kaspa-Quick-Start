import { SUBSIDY_BY_MONTH_SOMPI_PER_SECOND as TABLE } from './subsidy-table.js';

/**
 * Kaspa's emission curve, mirroring consensus/src/processes/coinbase.rs.
 *
 * Kaspa does not halve yearly in one step: the reward drops every month by
 * 2^(-1/12), so twelve months compound to exactly half. The node carries a
 * precomputed table of per-second rewards and divides by the block rate, which
 * is what is reproduced here -- the table is generated from that same source
 * file rather than transcribed.
 *
 * Everything below is arithmetic on chain constants. It is not a price
 * prediction and knows nothing about difficulty changing in the future.
 */

export const SOMPI_PER_KAS = 100_000_000;
const SECONDS_PER_MONTH = 2_629_800; // 30.4375 days, as the node defines it

// consensus/core/src/config/params.rs, MAINNET_PARAMS / TESTNET_PARAMS.
export const NETWORK_EMISSION = {
    mainnet: {
        deflationaryPhaseDaaScore: 15_778_800 - 259_200,
        preDeflationaryPhaseBaseSubsidy: 50_000_000_000,
        crescendoActivationDaaScore: 110_165_000,
        bpsBefore: 1,
        bpsAfter: 10,
    },
    'testnet-10': {
        deflationaryPhaseDaaScore: 15_778_800 - 259_200,
        preDeflationaryPhaseBaseSubsidy: 50_000_000_000,
        crescendoActivationDaaScore: 88_657_000,
        bpsBefore: 1,
        bpsAfter: 10,
    },
};

const ceilDiv = (a, b) => Math.ceil(a / b);

/** Seconds of emission time elapsed at a DAA score, per the node's accounting. */
function emissionSeconds(daaScore, p) {
    if (p.crescendoActivationDaaScore < p.deflationaryPhaseDaaScore) {
        return Math.floor((daaScore - p.deflationaryPhaseDaaScore) / p.bpsAfter);
    }
    if (daaScore < p.crescendoActivationDaaScore) {
        return Math.floor((daaScore - p.deflationaryPhaseDaaScore) / p.bpsBefore);
    }
    // The usual case today: count at 1 BPS up to Crescendo, 10 BPS after it.
    return (
        Math.floor((p.crescendoActivationDaaScore - p.deflationaryPhaseDaaScore) / p.bpsBefore) +
        Math.floor((daaScore - p.crescendoActivationDaaScore) / p.bpsAfter)
    );
}

export function subsidyMonth(daaScore, network = 'mainnet') {
    const p = NETWORK_EMISSION[network] ?? NETWORK_EMISSION.mainnet;
    if (daaScore < p.deflationaryPhaseDaaScore) return -1; // still pre-deflationary
    return Math.floor(emissionSeconds(daaScore, p) / SECONDS_PER_MONTH);
}

/** Reward per block in sompi at a given DAA score. */
export function blockSubsidySompi(daaScore, network = 'mainnet') {
    const p = NETWORK_EMISSION[network] ?? NETWORK_EMISSION.mainnet;
    if (daaScore < p.deflationaryPhaseDaaScore) return p.preDeflationaryPhaseBaseSubsidy;
    const month = Math.min(subsidyMonth(daaScore, network), TABLE.length - 1);
    const bps = p.crescendoActivationDaaScore <= daaScore ? p.bpsAfter : p.bpsBefore;
    return ceilDiv(TABLE[month], bps);
}

/** Reward per block in sompi for a whole month index, at today's block rate. */
function monthSubsidySompi(month, network = 'mainnet') {
    const p = NETWORK_EMISSION[network] ?? NETWORK_EMISSION.mainnet;
    if (month >= TABLE.length) return 0;
    return ceilDiv(TABLE[month], p.bpsAfter);
}

/** The DAA score at which a given month index begins. */
function daaScoreAtMonth(month, network = 'mainnet') {
    const p = NETWORK_EMISSION[network] ?? NETWORK_EMISSION.mainnet;
    const secondsBeforeCrescendo = Math.floor(
        (p.crescendoActivationDaaScore - p.deflationaryPhaseDaaScore) / p.bpsBefore,
    );
    const targetSeconds = month * SECONDS_PER_MONTH;
    return p.crescendoActivationDaaScore + (targetSeconds - secondsBeforeCrescendo) * p.bpsAfter;
}

/**
 * Current reward and the next reduction.
 *
 * The date is derived from how far away the next month boundary is in DAA
 * score, divided by the block rate. That is an estimate: DAA score tracks
 * network time, so it drifts slightly from wall-clock.
 */
export function rewardStatus(daaScore, network = 'mainnet') {
    const p = NETWORK_EMISSION[network] ?? NETWORK_EMISSION.mainnet;
    const month = subsidyMonth(daaScore, network);
    const current = blockSubsidySompi(daaScore, network);

    const nextMonth = month + 1;
    const nextSubsidy = monthSubsidySompi(nextMonth, network);
    const nextDaaScore = daaScoreAtMonth(nextMonth, network);
    const daaUntil = Math.max(0, nextDaaScore - daaScore);
    const secondsUntil = daaUntil / p.bpsAfter;

    return {
        network,
        month,
        blocksPerSecond: p.bpsAfter,
        currentSompi: current,
        currentKas: current / SOMPI_PER_KAS,
        next: {
            month: nextMonth,
            sompi: nextSubsidy,
            kas: nextSubsidy / SOMPI_PER_KAS,
            daaScore: nextDaaScore,
            daaUntil,
            secondsUntil,
            at: new Date(Date.now() + secondsUntil * 1000).toISOString(),
            dropPercent: current ? ((current - nextSubsidy) / current) * 100 : 0,
        },
    };
}

/**
 * Projected earnings, walking the emission table month by month.
 *
 * Assumes your hashrate and the network's stay where they are now -- the whole
 * projection scales linearly with that ratio, and neither number is
 * predictable. It is what today's conditions would pay if they held, not a
 * forecast.
 */
export function projectEarnings({ hashrate, networkHashrate, daaScore, network = 'mainnet', horizons = [1, 6, 12] }) {
    const p = NETWORK_EMISSION[network] ?? NETWORK_EMISSION.mainnet;
    const share = networkHashrate > 0 ? hashrate / networkHashrate : 0;
    if (!(share > 0)) return { share: 0, horizons: horizons.map((m) => ({ months: m, kas: 0 })), perDayKas: 0 };

    const startMonth = subsidyMonth(daaScore, network);
    // Where we are inside the current month, so the first partial month is not
    // counted as a whole one.
    const secondsIntoMonth = emissionSeconds(daaScore, p) % SECONDS_PER_MONTH;

    const maxMonths = Math.max(...horizons);
    const results = new Map();
    let total = 0;
    let secondsAccounted = 0;

    for (let i = 0; i <= maxMonths; i++) {
        const monthIndex = startMonth + i;
        const seconds = i === 0 ? SECONDS_PER_MONTH - secondsIntoMonth : SECONDS_PER_MONTH;
        const subsidy = monthSubsidySompi(monthIndex, network);
        // blocks/sec * share * reward, over this month's seconds
        total += p.bpsAfter * share * subsidy * seconds;
        secondsAccounted += seconds;

        for (const h of horizons) {
            // A horizon of h months covers h * SECONDS_PER_MONTH of emission.
            if (!results.has(h) && secondsAccounted >= h * SECONDS_PER_MONTH) {
                const overshoot = secondsAccounted - h * SECONDS_PER_MONTH;
                const perSecondThisMonth = p.bpsAfter * share * subsidy;
                results.set(h, (total - overshoot * perSecondThisMonth) / SOMPI_PER_KAS);
            }
        }
    }

    const perSecondNow = p.bpsAfter * share * blockSubsidySompi(daaScore, network);
    return {
        share,
        perDayKas: (perSecondNow * 86_400) / SOMPI_PER_KAS,
        perMonthFlatKas: (perSecondNow * SECONDS_PER_MONTH) / SOMPI_PER_KAS,
        horizons: horizons.map((m) => ({ months: m, kas: results.get(m) ?? 0 })),
        // How much the decay costs you over a year, versus naively assuming
        // today's reward held flat.
        decayDragPercent: (() => {
            const flat = (perSecondNow * 12 * SECONDS_PER_MONTH) / SOMPI_PER_KAS;
            const real = results.get(12) ?? 0;
            return flat > 0 ? ((flat - real) / flat) * 100 : 0;
        })(),
    };
}
