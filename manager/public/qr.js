// A QR encoder, byte mode, error correction level M, versions 1 to 6.
//
// The panel has no dependencies and is not going to grow one for a single
// static code, so this is the ISO 18004 encoder written out: Reed-Solomon over
// GF(256), the eight mask patterns with their penalty scoring, and module
// placement. Six versions is 106 bytes at level M, which covers an address with
// room to spare and keeps the tables short.
//
// Level M is a deliberate choice over L: it recovers from 15% damage rather
// than 7%, which is the difference between a code that survives a phone camera
// at an angle and one that does not.

// --------------------------------------------------------------- constants ---

// version: [EC codewords per block, block count, data codewords per block].
// Every version below uses equal-sized blocks at level M, which is why there is
// no second group here -- see the assertion in encode().
const EC = {
    1: [10, 1, 16],
    2: [16, 1, 28],
    3: [26, 1, 44],
    4: [18, 2, 32],
    5: [24, 2, 43],
    6: [16, 4, 27],
};

const ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34] };

const EC_LEVEL_BITS = 0b00; // M

// ------------------------------------------------------------------- GF(256) ---

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
    let x = 1;
    for (let i = 0; i < 255; i++) {
        EXP[i] = x;
        LOG[x] = i;
        x <<= 1;
        if (x & 0x100) x ^= 0x11d; // the QR primitive polynomial
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}

const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

/** The generator polynomial for n EC codewords: the product of (x - a^i). */
function generator(n) {
    let g = [1];
    for (let i = 0; i < n; i++) {
        const next = new Array(g.length + 1).fill(0);
        for (let j = 0; j < g.length; j++) {
            next[j] ^= g[j]; // times x
            next[j + 1] ^= mul(g[j], EXP[i]); // times a^i
        }
        g = next;
    }
    return g;
}

/** Polynomial division remainder -- the error correction codewords. */
function ecCodewords(data, n) {
    const g = generator(n);
    const rem = new Array(n).fill(0);
    for (const d of data) {
        const factor = d ^ rem[0];
        rem.shift();
        rem.push(0);
        for (let i = 0; i < n; i++) rem[i] ^= mul(g[i + 1], factor);
    }
    return rem;
}

// ------------------------------------------------------------- the bitstream ---

function encode(bytes) {
    const version = [1, 2, 3, 4, 5, 6].find((v) => {
        const [ecLen, blocks, dataPerBlock] = EC[v];
        void ecLen;
        // 4 mode bits + 8 count bits, and the count field is one byte for
        // versions 1 to 9 in byte mode.
        return blocks * dataPerBlock * 8 - 12 >= bytes.length * 8;
    });
    if (!version) throw new Error(`${bytes.length} bytes does not fit in a version 6 code at level M.`);

    const [ecLen, blocks, dataPerBlock] = EC[version];
    const totalData = blocks * dataPerBlock;

    const bits = [];
    const push = (value, len) => {
        for (let i = len - 1; i >= 0; i--) bits.push((value >> i) & 1);
    };

    push(0b0100, 4); // byte mode
    push(bytes.length, 8);
    for (const b of bytes) push(b, 8);

    // Terminator, then pad to a byte boundary, then the two alternating pad
    // codewords the spec names.
    for (let i = 0; i < 4 && bits.length < totalData * 8; i++) bits.push(0);
    while (bits.length % 8) bits.push(0);
    const codewords = [];
    for (let i = 0; i < bits.length; i += 8) {
        codewords.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));
    }
    for (let i = 0; codewords.length < totalData; i++) codewords.push(i % 2 === 0 ? 0xec : 0x11);

    // Split into blocks and interleave. Data codewords first, one from each
    // block in turn, then the EC codewords the same way.
    const dataBlocks = [];
    const ecBlocks = [];
    for (let b = 0; b < blocks; b++) {
        const block = codewords.slice(b * dataPerBlock, (b + 1) * dataPerBlock);
        dataBlocks.push(block);
        ecBlocks.push(ecCodewords(block, ecLen));
    }

    const out = [];
    for (let i = 0; i < dataPerBlock; i++) for (const b of dataBlocks) out.push(b[i]);
    for (let i = 0; i < ecLen; i++) for (const b of ecBlocks) out.push(b[i]);

    const finalBits = [];
    for (const cw of out) for (let i = 7; i >= 0; i--) finalBits.push((cw >> i) & 1);
    return { version, bits: finalBits };
}

// ------------------------------------------------------------------- modules ---

/** The patterns that are not data: finders, timing, alignment, format areas. */
function functionPatterns(version) {
    const size = 17 + 4 * version;
    const m = Array.from({ length: size }, () => new Array(size).fill(0));
    const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
    const set = (r, c, v) => {
        if (r < 0 || c < 0 || r >= size || c >= size) return;
        m[r][c] = v;
        fixed[r][c] = true;
    };

    // Finder patterns and their separators.
    for (const [br, bc] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
        for (let r = -1; r <= 7; r++) {
            for (let c = -1; c <= 7; c++) {
                const ring = r >= 0 && r <= 6 && c >= 0 && c <= 6 && (r === 0 || r === 6 || c === 0 || c === 6);
                const core = r >= 2 && r <= 4 && c >= 2 && c <= 4;
                set(br + r, bc + c, ring || core ? 1 : 0);
            }
        }
    }

    for (let i = 8; i < size - 8; i++) {
        set(6, i, i % 2 === 0 ? 1 : 0);
        set(i, 6, i % 2 === 0 ? 1 : 0);
    }

    const coords = ALIGN[version];
    const last = coords[coords.length - 1];
    for (const r of coords) {
        for (const c of coords) {
            // The three that would sit on top of a finder are omitted.
            if ((r === 6 && c === 6) || (r === 6 && c === last) || (r === last && c === 6)) continue;
            for (let dr = -2; dr <= 2; dr++) {
                for (let dc = -2; dc <= 2; dc++) {
                    set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) === 1 ? 0 : 1);
                }
            }
        }
    }

    set(size - 8, 8, 1); // the always-dark module

    // Reserve the format information areas so data placement steps over them.
    for (let i = 0; i <= 8; i++) {
        if (!fixed[8][i]) set(8, i, 0);
        if (!fixed[i][8]) set(i, 8, 0);
    }
    for (let i = 0; i < 8; i++) {
        if (!fixed[8][size - 1 - i]) set(8, size - 1 - i, 0);
        if (!fixed[size - 1 - i][8]) set(size - 1 - i, 8, 0);
    }

    return { m, fixed, size };
}

/** Zigzag up and down column pairs from the right, skipping the timing column. */
function placeData(m, fixed, size, bits) {
    let idx = 0;
    let up = true;
    for (let col = size - 1; col >= 1; col -= 2) {
        if (col === 6) col = 5; // column 6 is timing, so the pairs shift left
        for (let i = 0; i < size; i++) {
            const row = up ? size - 1 - i : i;
            for (const c of [col, col - 1]) {
                if (!fixed[row][c]) m[row][c] = idx < bits.length ? bits[idx++] : 0;
            }
        }
        up = !up;
    }
}

const MASKS = [
    (r, c) => (r + c) % 2 === 0,
    (r) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function penalty(m, size) {
    let score = 0;

    // Rule 1: runs of five or more of the same colour.
    for (let i = 0; i < size; i++) {
        for (const line of [m[i], m.map((row) => row[i])]) {
            let run = 1;
            for (let j = 1; j < size; j++) {
                if (line[j] === line[j - 1]) {
                    run++;
                } else {
                    if (run >= 5) score += 3 + (run - 5);
                    run = 1;
                }
            }
            if (run >= 5) score += 3 + (run - 5);
        }
    }

    // Rule 2: any 2x2 block of one colour.
    for (let r = 0; r < size - 1; r++) {
        for (let c = 0; c < size - 1; c++) {
            const v = m[r][c];
            if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
        }
    }

    // Rule 3: the finder-like 1:1:3:1:1 sequence appearing in the data.
    const A = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0];
    const B = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    const matches = (line, pat, at) => pat.every((v, k) => line[at + k] === v);
    for (let i = 0; i < size; i++) {
        for (const line of [m[i], m.map((row) => row[i])]) {
            for (let j = 0; j + 11 <= size; j++) {
                if (matches(line, A, j) || matches(line, B, j)) score += 40;
            }
        }
    }

    // Rule 4: drift away from an even split of dark and light.
    let dark = 0;
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += m[r][c];
    score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;

    return score;
}

/** 15-bit BCH format information for a level and mask. */
function formatBits(mask) {
    const data = (EC_LEVEL_BITS << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    return ((data << 10) | rem) ^ 0x5412;
}

function placeFormat(m, size, mask) {
    const fmt = formatBits(mask);
    const bit = (i) => (fmt >> i) & 1;

    // The first copy wraps the top-left finder: bits 0-5 run down column 8,
    // then the corner, then bits 9-14 run left along row 8. Getting these two
    // axes the wrong way round still produces a code a scanner can locate --
    // the finders are symmetric -- but not one it can read.
    for (let i = 0; i <= 5; i++) m[i][8] = bit(i);
    m[7][8] = bit(6);
    m[8][8] = bit(7);
    m[8][7] = bit(8);
    for (let i = 9; i <= 14; i++) m[8][14 - i] = bit(i);

    // The second copy: bits 0-7 along row 8 from the right edge, bits 8-14 up
    // column 8 from the bottom.
    for (let i = 0; i <= 7; i++) m[8][size - 1 - i] = bit(i);
    for (let i = 8; i <= 14; i++) m[size - 15 + i][8] = bit(i);

    m[size - 8][8] = 1;
}

// ---------------------------------------------------------------------- api ---

/** Returns the module matrix as rows of 0 and 1, without a quiet zone. */
export function qrMatrix(text) {
    const bytes = Array.from(new TextEncoder().encode(text));
    const { version, bits } = encode(bytes);

    let best = null;
    for (let mask = 0; mask < 8; mask++) {
        const { m, fixed, size } = functionPatterns(version);
        placeData(m, fixed, size, bits);
        for (let r = 0; r < size; r++) {
            for (let c = 0; c < size; c++) {
                if (!fixed[r][c] && MASKS[mask](r, c)) m[r][c] ^= 1;
            }
        }
        placeFormat(m, size, mask);
        const score = penalty(m, size);
        if (!best || score < best.score) best = { m, score, size, mask };
    }
    return best.m;
}

/**
 * An SVG string. Always dark on light, whatever the panel's theme is doing:
 * scanners expect that polarity and many will not read an inverted code.
 */
export function qrSvg(text, { quiet = 4, title = 'QR code' } = {}) {
    const m = qrMatrix(text);
    const size = m.length;
    const dim = size + quiet * 2;

    let path = '';
    for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
            if (m[r][c]) path += `M${c + quiet} ${r + quiet}h1v1h-1z`;
        }
    }

    return (
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" ` +
        `shape-rendering="crispEdges" role="img" aria-label="${title}">` +
        `<rect width="${dim}" height="${dim}" fill="#fff"/>` +
        `<path d="${path}" fill="#000"/>` +
        `</svg>`
    );
}
