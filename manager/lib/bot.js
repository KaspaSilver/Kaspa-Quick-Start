import fs from 'node:fs';
import path from 'node:path';
import { CONF_DIR } from './paths.js';

/**
 * The block notifier's settings, one of which is a wallet key.
 *
 * PRIVATE_KEY_HEX controls spending from the wallet that sends the
 * notifications. That is not a setting, it is a credential, and it decides the
 * shape of everything here:
 *
 *   - it is written to conf/bot/bot.env at 0600 and never into apps.json,
 *     which is rewritten on every unrelated toggle and read by every screen;
 *   - it never comes back out. The panel reports whether a key is set, never
 *     what it is, so a screenshot of this tab gives nothing away;
 *   - it does not go in the stack's .env, which is not 0600 and which docker
 *     compose runs `$` interpolation over.
 *
 * Upstream reads all of this from the environment, so the file is an env file
 * rather than JSON, referenced by the compose service.
 */
export const BOT_DIR = path.join(CONF_DIR, 'bot');
export const ENV_FILE = path.join(BOT_DIR, 'bot.env');
// Written by the watcher (mounted at /state), one JSON object per line. The
// panel only ever reads it.
export const HISTORY_FILE = path.join(BOT_DIR, 'state', 'notifications.jsonl');

/**
 * The most recent notifications the bot has sent, newest first. Each line is a
 * self-contained JSON object; a malformed one (a half-written final line, say)
 * is skipped rather than allowed to break the list. Absent file -> empty, which
 * is the normal state before the first block is found.
 */
export function readHistory(limit = 50) {
    let lines;
    try {
        lines = fs.readFileSync(HISTORY_FILE, 'utf8').split('\n');
    } catch {
        return [];
    }
    const out = [];
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
        const line = lines[i].trim();
        if (!line) continue;
        try {
            out.push(JSON.parse(line));
        } catch {
            /* skip a torn or partial line */
        }
    }
    return out;
}

/** Every key the watcher reads, and which ones it refuses to start without. */
const REQUIRED = ['MINING_ADDRESS', 'PRIVATE_KEY_HEX', 'RECEIVER_ALIAS', 'RECEIVER_PUBKEY_X'];

/**
 * The notification text, and what can be put in it.
 *
 * The default is exactly what the watcher sent before this was a setting, so a
 * bot that predates it and one that has never been edited say the same thing.
 *
 * Newlines travel as a literal backslash-n. An env file has no way to carry a
 * real one -- every value is a single line -- so the template is stored escaped
 * and the watcher unescapes it. That also means a message can be written on
 * several lines here without the file format having an opinion about it.
 */
export const DEFAULT_MESSAGE = 'Reward: {reward} KAS\nBalance: {balance} KAS\nHashrate: {hashrate}';

export const PLACEHOLDERS = {
    reward: 'the block reward, in KAS',
    balance: "the mining address's balance afterwards, in KAS",
    hashrate: 'the total hashrate of your connected miners',
    txid: 'the transaction that paid the reward',
    address: 'the mining address being watched',
    network: 'mainnet or testnet-10',
    time: 'when the reward arrived, on the machine running the bot',
};

// A message is encrypted into a transaction payload and written to the chain,
// so its length is not free, and neither is it unbounded.
const MESSAGE_MAX = 500;

const escapeNewlines = (text) => String(text).replace(/\r\n?|\n/g, '\\n');
const unescapeNewlines = (text) => String(text).replace(/\\n/g, '\n');

const ADDRESS_RE = /^kaspa(test)?:[a-z0-9]{55,}$/i;
const HEX64_RE = /^[0-9a-f]{64}$/i;
// The alias is a short handle KaChat shows on a sent message. Upstream does not
// document a character set, so this only rejects what would break the payload
// it is interpolated into: `ciph_msg:1:comm:<alias>:<body>`.
const ALIAS_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** Parses the env file into a plain object. Missing file is not an error. */
export function readEnv() {
    if (!fs.existsSync(ENV_FILE)) return {};
    const out = {};
    for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
        const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
        if (match) out[match[1]] = match[2];
    }
    return out;
}

/** True when a wallet key is stored, which is all anybody is told about it. */
export const hasKey = () => Boolean(readEnv().PRIVATE_KEY_HEX);

/**
 * What the panel is allowed to show.
 *
 * The addresses and the alias are yours and are on the chain anyway; the key is
 * the one field that is write-only.
 */
export function readConfig() {
    const env = readEnv();
    return {
        miningAddress: env.MINING_ADDRESS ?? '',
        receiverAlias: env.RECEIVER_ALIAS ?? '',
        receiverPubkeyX: env.RECEIVER_PUBKEY_X ?? '',
        minRewardKas: Number(env.MIN_REWARD_KAS ?? 0),
        // Shown with real newlines; stored with escaped ones.
        message: unescapeNewlines(env.MESSAGE_TEMPLATE || DEFAULT_MESSAGE),
        // Notify when the pool hashrate falls this far below its recent level.
        hashrateAlert: env.HASHRATE_ALERT === '1',
        hashrateDropPct: Number(env.HASHRATE_DROP_PCT ?? 25) || 25,
        // Notify when the sending wallet runs low, while it still has enough to
        // send the warning. The default leaves room for a few more fee-paying
        // messages before it is empty.
        lowBalanceAlert: env.LOW_BALANCE_ALERT === '1',
        lowBalanceKas: Number(env.LOW_BALANCE_KAS ?? 0.5) || 0.5,
        hasKey: Boolean(env.PRIVATE_KEY_HEX),
        // Every required value present, which is the difference between a bot
        // that will start and one that exits on its first line.
        complete: REQUIRED.every((key) => Boolean(env[key])),
    };
}

/** Everything wrong with a proposed configuration, in the order it is read. */
export function validate(input, { existingKey = false } = {}) {
    const problems = [];

    if (!ADDRESS_RE.test(String(input.miningAddress ?? '').trim())) {
        problems.push('The mining address does not look like a Kaspa address.');
    }
    if (!ALIAS_RE.test(String(input.receiverAlias ?? '').trim())) {
        problems.push('The receiver alias is missing, or has characters that would break the message payload.');
    }
    if (!HEX64_RE.test(String(input.receiverPubkeyX ?? '').trim())) {
        problems.push('The receiver public key must be 64 hexadecimal characters (x-only, no 02/03 prefix).');
    }

    const key = String(input.privateKeyHex ?? '').trim();
    if (key) {
        if (!HEX64_RE.test(key)) problems.push('The private key must be 64 hexadecimal characters.');
    } else if (!existingKey) {
        problems.push('A private key is needed for the wallet that sends the notifications.');
    }

    const min = Number(input.minRewardKas ?? 0);
    if (!Number.isFinite(min) || min < 0) problems.push('The minimum reward must be zero or more.');

    problems.push(...messageProblems(input.message));

    return problems;
}

/**
 * What is wrong with a message template, if anything.
 *
 * Checked here rather than left to the bot, because the bot only finds out when
 * a block is found -- which might be next week -- and the failure would be a
 * notification that never arrives with nothing on screen to explain it.
 */
export function messageProblems(message) {
    const text = message === undefined || message === null ? DEFAULT_MESSAGE : String(message);
    const problems = [];

    if (!text.trim()) return ['The message cannot be empty.'];
    if (text.length > MESSAGE_MAX) {
        problems.push(`The message is ${text.length} characters; ${MESSAGE_MAX} is the most that fits comfortably.`);
    }

    const unknown = [...text.matchAll(/\{([^{}]*)\}/g)]
        .map((m) => m[1])
        .filter((name) => !Object.hasOwn(PLACEHOLDERS, name));
    if (unknown.length) {
        problems.push(
            `${unknown.map((n) => `{${n}}`).join(', ')} ${unknown.length === 1 ? 'is not something' : 'are not things'} ` +
                `the bot can fill in. It knows ${Object.keys(PLACEHOLDERS).map((n) => `{${n}}`).join(', ')}.`,
        );
    }
    // An unpaired brace reaches the bot as a formatting error at the moment a
    // block is found, which is the worst possible time to discover it.
    if (text.replace(/\{[^{}]*\}/g, '').match(/[{}]/)) {
        problems.push('There is a { or } on its own. Braces are only for placeholders.');
    }

    return problems;
}

/** Fills a template in the same way the bot will, for the preview. */
export function renderMessage(message, sample = {}) {
    const values = {
        reward: '112.50000000',
        balance: '1043.21000000',
        hashrate: '4.22 TH/s',
        txid: '1943b508e4d1c0f9a7b6e5d4c3b2a1908f7e6d5c4b3a29180f1e2d3c4b5a6978',
        address: 'kaspa:qrxmpl…',
        network: 'mainnet',
        time: '2026-09-04 14:22:07',
        ...sample,
    };
    return String(message ?? DEFAULT_MESSAGE).replace(/\{([^{}]*)\}/g, (whole, name) =>
        Object.hasOwn(values, name) ? values[name] : whole,
    );
}

/**
 * Writes what the container reads.
 *
 * An empty key in the request means "leave the stored one alone", so saving an
 * unrelated setting does not require pasting a wallet key back in -- and does
 * not make a screen that must ask for one to change anything at all.
 */
export function writeConfig(input) {
    const existing = readEnv();
    const key = String(input.privateKeyHex ?? '').trim() || existing.PRIVATE_KEY_HEX || '';
    // A different key means the stored address belongs to the old one, so drop
    // it and let the next wallet read re-derive from the new key. An unchanged
    // key keeps its address.
    const keyChanged = key.toLowerCase() !== String(existing.PRIVATE_KEY_HEX ?? '').toLowerCase();

    writeEnvFile({
        MINING_ADDRESS: String(input.miningAddress ?? '').trim(),
        PRIVATE_KEY_HEX: key,
        WALLET_ADDRESS: keyChanged ? '' : existing.WALLET_ADDRESS || '',
        RECEIVER_ALIAS: String(input.receiverAlias ?? '').trim(),
        RECEIVER_PUBKEY_X: String(input.receiverPubkeyX ?? '').trim().toLowerCase(),
        MIN_REWARD_KAS: String(Number(input.minRewardKas ?? 0)),
        MESSAGE_TEMPLATE: escapeNewlines(
            input.message === undefined || input.message === null || !String(input.message).trim()
                ? unescapeNewlines(existing.MESSAGE_TEMPLATE || DEFAULT_MESSAGE)
                : input.message,
        ),
    });
    return readConfig();
}

/** Writes the env file, 0600, from a plain object. The one place that does it. */
function writeEnvFile(values) {
    const body =
        '# Written by the Kaspa Quick Start panel. Contains a wallet key.\n' +
        '# Edits here are overwritten the next time the KaChat Bot tab is saved.\n' +
        Object.entries(values)
            .filter(([, value]) => value !== undefined && value !== null)
            .map(([name, value]) => `${name}=${value}`)
            .join('\n') +
        '\n';

    fs.mkdirSync(BOT_DIR, { recursive: true });
    fs.writeFileSync(ENV_FILE, body, { mode: 0o600 });
    // Set every time, not only on creation: a file from an earlier version, or
    // restored from a backup, must not stay readable by everything on the box.
    fs.chmodSync(ENV_FILE, 0o600);
}

/** The address the bot sends from, if one has been recorded. */
export const walletAddress = () => readEnv().WALLET_ADDRESS || '';

/** The stored wallet key. Only ever returned to the loopback panel on request. */
export const walletKey = () => readEnv().PRIVATE_KEY_HEX || '';

/**
 * Stores a generated (or derived) wallet without disturbing the rest of the
 * config. The key and its address travel together, so a later address read
 * never belongs to a different key.
 */
export function saveWallet({ privateKeyHex, address }) {
    const env = readEnv();
    if (privateKeyHex !== undefined) env.PRIVATE_KEY_HEX = String(privateKeyHex).trim();
    if (address !== undefined) env.WALLET_ADDRESS = String(address).trim();
    writeEnvFile(env);
    return { address: env.WALLET_ADDRESS || '', hasKey: Boolean(env.PRIVATE_KEY_HEX) };
}

/** The env key each single-field save maps to. Network/ref live in apps.json. */
const FIELD_TO_ENV = {
    miningAddress: 'MINING_ADDRESS',
    receiverAlias: 'RECEIVER_ALIAS',
    receiverPubkeyX: 'RECEIVER_PUBKEY_X',
    minRewardKas: 'MIN_REWARD_KAS',
    message: 'MESSAGE_TEMPLATE',
};

/** What is wrong with one field on its own, so it can be saved independently. */
export function validateField(field, value) {
    const v = String(value ?? '');
    switch (field) {
        case 'miningAddress':
            return ADDRESS_RE.test(v.trim()) ? [] : ['The mining address does not look like a Kaspa address.'];
        case 'receiverAlias':
            return ALIAS_RE.test(v.trim()) ? [] : ['The receiver alias is missing, or has characters that would break the message payload.'];
        case 'receiverPubkeyX':
            return HEX64_RE.test(v.trim()) ? [] : ['The receiver public key must be 64 hexadecimal characters (x-only, no 02/03 prefix).'];
        case 'minRewardKas': {
            const n = Number(v);
            return Number.isFinite(n) && n >= 0 ? [] : ['The minimum reward must be zero or more.'];
        }
        case 'message':
            return messageProblems(v);
        case 'hashrateAlert':
            return []; // any truthy/falsy is fine
        case 'hashrateDropPct': {
            const n = Number(v);
            return Number.isFinite(n) && n >= 1 && n <= 99 ? [] : ['The drop percentage must be between 1 and 99.'];
        }
        case 'lowBalanceAlert':
            return []; // any truthy/falsy is fine
        case 'lowBalanceKas': {
            const n = Number(v);
            return Number.isFinite(n) && n >= 0 ? [] : ['The low-balance threshold must be zero or more.'];
        }
        case 'network':
            return ['mainnet', 'testnet-10'].includes(v) ? [] : ['Choose mainnet or testnet-10.'];
        case 'ref':
            return v.trim() ? [] : ['Enter a branch, tag or commit.'];
        default:
            return ['Unknown field.'];
    }
}

/**
 * Saves one field, leaving the rest of the config alone. This is what lets each
 * field have its own save button: a value locked in here survives a refresh,
 * and saving one never depends on the others being filled in yet.
 */
export function savePartial(patch) {
    const env = readEnv();
    for (const [field, envKey] of Object.entries(FIELD_TO_ENV)) {
        if (!Object.hasOwn(patch, field)) continue;
        let value = String(patch[field] ?? '').trim();
        if (field === 'receiverPubkeyX') value = value.toLowerCase();
        else if (field === 'minRewardKas') value = String(Number(patch[field] ?? 0));
        else if (field === 'message') value = escapeNewlines(String(patch[field] ?? ''));
        env[envKey] = value;
    }
    if (Object.hasOwn(patch, 'hashrateAlert')) {
        env.HASHRATE_ALERT =
            patch.hashrateAlert === true || patch.hashrateAlert === '1' || patch.hashrateAlert === 'true' ? '1' : '0';
    }
    if (Object.hasOwn(patch, 'hashrateDropPct')) {
        env.HASHRATE_DROP_PCT = String(Math.max(1, Math.min(99, Math.round(Number(patch.hashrateDropPct) || 25))));
    }
    if (Object.hasOwn(patch, 'lowBalanceAlert')) {
        env.LOW_BALANCE_ALERT =
            patch.lowBalanceAlert === true || patch.lowBalanceAlert === '1' || patch.lowBalanceAlert === 'true' ? '1' : '0';
    }
    if (Object.hasOwn(patch, 'lowBalanceKas')) {
        env.LOW_BALANCE_KAS = String(Math.max(0, Number(patch.lowBalanceKas) || 0.5));
    }
    writeEnvFile(env);
    return readConfig();
}

/**
 * Makes sure the file the compose service points at exists.
 *
 * `required: false` in the compose file covers its absence, but an empty file
 * is tidier than relying on that, and it means the bot can be installed and
 * then configured rather than only the other way round.
 */
export function ensureEnvFile() {
    if (fs.existsSync(ENV_FILE)) {
        fs.chmodSync(ENV_FILE, 0o600);
        return;
    }
    fs.mkdirSync(BOT_DIR, { recursive: true });
    fs.writeFileSync(ENV_FILE, '# Written by the Kaspa Quick Start panel when the KaChat Bot is set up.\n', {
        mode: 0o600,
    });
}
