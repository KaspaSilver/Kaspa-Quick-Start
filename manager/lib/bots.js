import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { BOT_DIR } from './bot.js';

/**
 * KaChat Bot v2: several bots in the one kachat-bot container, each with its own wallet,
 * owner and conversation (KaspaSilver/KaChat-Bot, branch bots). The panel only writes which
 * bots exist (conf/bot/bots.json, mounted read-only at /conf/bots.json) and reads what each
 * reports (conf/bot/state/bots/<id>.json + .history.jsonl). Everything a bot watches is set
 * up in KaChat, by talking to it: fund its address, send it the pairing code, answer it.
 */
export const BOTS_FILE = path.join(BOT_DIR, 'bots.json');
const STATE_DIR = path.join(BOT_DIR, 'state', 'bots');

/** The bots on offer: one square each in the Bot tab. */
export const CATALOG = [
    {
        type: 'mining',
        title: 'Mining notifier',
        description: 'Tells you every time your mining address finds a block: the reward, your balance and your miners’ hashrate. Can also warn when the hashrate drops.',
        asks: 'which mining address to watch',
    },
    {
        type: 'price',
        title: 'Price bot',
        description: 'Kaspa price alerts: when it goes above or below a level you pick, a daily price summary, or big moves within a day.',
        asks: 'which alerts you want',
    },
    {
        type: 'wallet',
        title: 'Wallet watcher',
        description: 'Tells you when an address you care about receives or sends KAS, with the amount and the transaction.',
        asks: 'which addresses to watch',
    },
];
export const catalogType = (type) => CATALOG.find((c) => c.type === type) ?? null;

const ID_RE = /^[a-z0-9-]{1,32}$/;

/** The bots file, created empty the first time so the container always has one to read. */
export function readBots() {
    try {
        const doc = JSON.parse(fs.readFileSync(BOTS_FILE, 'utf8'));
        return { version: 1, bots: Array.isArray(doc.bots) ? doc.bots : [] };
    } catch {
        return { version: 1, bots: [] };
    }
}

/** Written whole, atomically (the bot polls it), and readable only by its owner: it holds keys. */
export function writeBots(doc) {
    fs.mkdirSync(BOT_DIR, { recursive: true });
    const tmp = `${BOTS_FILE}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, bots: doc.bots }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, BOTS_FILE);
    fs.chmodSync(BOTS_FILE, 0o600);
}

export function ensureBotsFile() {
    if (!fs.existsSync(BOTS_FILE)) writeBots({ bots: [] });
    fs.mkdirSync(STATE_DIR, { recursive: true });
}

export const newPairingCode = () => String(crypto.randomInt(100000, 1000000));
export const newId = (type) => `${type}-${crypto.randomBytes(2).toString('hex')}`;

export function findBot(id) {
    if (!ID_RE.test(String(id))) return null;
    return readBots().bots.find((b) => b.id === id) ?? null;
}

/** What the bot last reported about itself, or null before it has run. */
export function status(id) {
    if (!ID_RE.test(String(id))) return null;
    try {
        return JSON.parse(fs.readFileSync(path.join(STATE_DIR, `${id}.json`), 'utf8'));
    } catch {
        return null;
    }
}

/** The newest `limit` messages to and from this bot, newest first. */
export function history(id, limit = 30) {
    if (!ID_RE.test(String(id))) return [];
    let raw = '';
    try {
        raw = fs.readFileSync(path.join(STATE_DIR, `${id}.history.jsonl`), 'utf8');
    } catch {
        return [];
    }
    const out = [];
    for (const line of raw.split('\n').filter(Boolean).slice(-limit)) {
        try {
            const m = JSON.parse(line);
            out.push({ ts: Number(m.ts) || null, dir: m.dir === 'in' ? 'in' : 'out', text: String(m.text ?? '').slice(0, 2000), txid: m.txid ?? null });
        } catch {
            /* a half-written line */
        }
    }
    return out.reverse();
}

/** A bot as the panel shows it: its config without the key, plus what it reports. */
export function view(b) {
    const st = status(b.id);
    return {
        id: b.id,
        type: b.type,
        title: catalogType(b.type)?.title ?? b.type,
        enabled: b.enabled !== false,
        address: b.address,
        pairingCode: b.pairingCode,
        status: st,
    };
}
