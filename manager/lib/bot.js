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
export const DEFAULT_MESSAGE = 'Reward: {reward} KAS\nBalance: {balance} KAS';

export const PLACEHOLDERS = {
    reward: 'the block reward, in KAS',
    balance: "the mining address's balance afterwards, in KAS",
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

    const values = {
        MINING_ADDRESS: String(input.miningAddress ?? '').trim(),
        PRIVATE_KEY_HEX: key,
        RECEIVER_ALIAS: String(input.receiverAlias ?? '').trim(),
        RECEIVER_PUBKEY_X: String(input.receiverPubkeyX ?? '').trim().toLowerCase(),
        MIN_REWARD_KAS: String(Number(input.minRewardKas ?? 0)),
        MESSAGE_TEMPLATE: escapeNewlines(
            input.message === undefined || input.message === null || !String(input.message).trim()
                ? unescapeNewlines(existing.MESSAGE_TEMPLATE || DEFAULT_MESSAGE)
                : input.message,
        ),
    };

    const body =
        '# Written by the Kaspa Quick Start panel. Contains a wallet key.\n' +
        '# Edits here are overwritten the next time the KaChat Bot tab is saved.\n' +
        Object.entries(values)
            .map(([name, value]) => `${name}=${value}`)
            .join('\n') +
        '\n';

    fs.mkdirSync(BOT_DIR, { recursive: true });
    fs.writeFileSync(ENV_FILE, body, { mode: 0o600 });
    // Set every time, not only on creation: a file from an earlier version, or
    // restored from a backup, must not stay readable by everything on the box.
    fs.chmodSync(ENV_FILE, 0o600);
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
