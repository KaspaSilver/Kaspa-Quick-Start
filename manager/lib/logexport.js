import fs from 'node:fs';
import path from 'node:path';

import { CommandError, containerState, docker, logSource, stripAnsi } from './dockerctl.js';
import { ENV_FILE as BOT_ENV_FILE } from './bot.js';
import { BOTS_FILE } from './bots.js';
import { loadManagerConfig, readEnvFile } from './store.js';
import { CONF_DIR } from './paths.js';

/**
 * "Download logs" on the Logs page (handoff docs/DOWNLOAD-LOGS.md, from the KaChat Desktop
 * session, 2026-10-23): one plain-text file the owner can hand to a Claude session that has no
 * access to this machine. A preset of log sources over a real time window (`docker logs --since`),
 * a header with each container's image, status, uptime and restart count, one section per source
 * capped at the newest lines, and secrets redacted, because the file leaves the machine.
 */

const MAX_LINES = 5000;
export const WINDOWS = { '1h': 3600, '6h': 6 * 3600, '24h': 24 * 3600 };

/**
 * The KaPosts processor's push-related lines the push service's own filter (/push/i) does not
 * already carry: KaPosts and "quiet" (old transaction, no push) lines without the word push.
 */
const KAPOSTS_PUSH = { test: (l) => /kaposts|quiet/i.test(l) && !/push/i.test(l) };

/**
 * Presets: sections of [source key, optional extra filter, title]. Testnet keys are added when
 * the testnet stack has a container (the export checks each one exists).
 */
export const PRESETS = {
    push: {
        label: 'Push & notifications',
        sections: [
            ['kachat-push', null, null],
            ['kachat', KAPOSTS_PUSH, 'KaPosts processor push lines'],
            ['kachat-push-testnet', null, null],
            ['kachat-testnet', KAPOSTS_PUSH, 'KaPosts processor push lines (testnet)'],
        ],
    },
    indexer: { label: 'KaChat indexer', sections: [['kachat', null, null], ['kachat-testnet', null, null]] },
    database: { label: 'KaChat database', sections: [['kachat-db', null, null], ['kachat-db-testnet', null, null]] },
    node: { label: 'Node', sections: [['kaspad', null, null], ['kaspad-testnet', null, null]] },
    everything: { label: 'Everything', sections: null },
};

// ---------------------------------------------------------------- redaction ---

const SECRET_NAME = /pass|secret|token|private|seed|mnemonic|hash|_key$|^key$|api_?key/i;

/** Every secret string this machine holds, collected by value so an echo anywhere is caught. */
function collectSecrets() {
    const found = new Set();
    const add = (v) => {
        const s = String(v ?? '').trim();
        // Short values ("true", a port) would shred the logs; real secrets are long.
        if (s.length >= 8) found.add(s);
    };
    const fromEnvText = (text) => {
        for (const line of String(text).split('\n')) {
            const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
            if (m && SECRET_NAME.test(m[1])) add(m[2].replace(/^['"]|['"]$/g, ''));
        }
    };
    const walk = (o, key = '') => {
        if (o == null) return;
        if (typeof o === 'object') {
            for (const [k, v] of Object.entries(o)) walk(v, k);
        } else if (SECRET_NAME.test(key)) add(o);
    };
    try {
        for (const [k, v] of Object.entries(readEnvFile())) if (SECRET_NAME.test(k)) add(v);
    } catch {
        /* no .env yet */
    }
    for (const file of [BOT_ENV_FILE, path.join(CONF_DIR, 'cloudflare', 'tunnel.env')]) {
        try {
            fromEnvText(fs.readFileSync(file, 'utf8'));
        } catch {
            /* not installed */
        }
    }
    // The Cloudflare API token is the whole file, no NAME= in front of it.
    try {
        add(fs.readFileSync(path.join(CONF_DIR, 'cloudflare', 'api-token'), 'utf8'));
    } catch {
        /* not connected */
    }
    try {
        walk(JSON.parse(fs.readFileSync(BOTS_FILE, 'utf8')));
    } catch {
        /* no bots */
    }
    try {
        walk(loadManagerConfig());
    } catch {
        /* defaults */
    }
    // Longest first, so a secret that contains another is replaced whole.
    return [...found].sort((a, b) => b.length - a.length);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const PATTERNS = [
    // Bearer tokens anywhere, then header values that authenticate (a scheme word such as
    // Bearer or Basic is taken together with the token after it).
    [/(\bBearer\s+)[A-Za-z0-9._~+/=-]+/g, '$1[redacted]'],
    [/((?:x-internal-secret|authorization)\s*[:=]\s*)("?)(?:(?:Bearer|Basic|Token)\s+)?(?!\[redacted\])[^\s",}]+/gi, '$1$2[redacted]'],
    // JWT-looking strings.
    [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted]'],
    // Web Push endpoints: keep the host, drop the per-browser path.
    [/(https:\/\/(?:web\.push\.apple\.com|fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|[a-z0-9.-]*notify\.windows\.com)\/)[^\s"',)]+/gi, '$1[redacted]'],
    // A 64-hex value right after a key/secret/private/seed word.
    [/((?:key|secret|private|seed)[A-Za-z_]*["']?\s*[:=]?\s*["']?)[0-9a-fA-F]{64}\b/gi, '$1[redacted]'],
    // Twelve or more short lowercase words in a row: what a seed phrase looks like.
    [/\b(?:[a-z]{3,8} ){11,23}[a-z]{3,8}\b/g, '[redacted]'],
];

export function makeRedactor(secrets = collectSecrets()) {
    const byValue = secrets.length ? new RegExp(secrets.map(escapeRe).join('|'), 'g') : null;
    return (line) => {
        let out = byValue ? line.replace(byValue, '[redacted]') : line;
        for (const [re, sub] of PATTERNS) out = out.replace(re, sub);
        return out;
    };
}

// ------------------------------------------------------------------- export ---

async function logsSince(name, seconds) {
    try {
        const { stdout, stderr } = await docker(['logs', '--since', `${seconds}s`, '--timestamps', name], {
            timeoutMs: 60_000,
        });
        return `${stdout}${stderr}`;
    } catch (err) {
        return err instanceof CommandError ? `${err.stdout || ''}${err.stderr || ''}` : '';
    }
}

const fmtUptime = (startedAt) => {
    const t = Date.parse(startedAt ?? '');
    if (Number.isNaN(t)) return '';
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
};

/**
 * The file for `preset` over `window` ('1h' | '6h' | '24h'), as one string. Sources whose
 * container does not exist are left out (a testnet section on a mainnet-only machine).
 */
export async function build({ preset, window, panelVersion, allKeys }) {
    const P = PRESETS[preset];
    const seconds = WINDOWS[window];
    if (!P || !seconds) throw new Error('Unknown preset or window.');
    const redact = makeRedactor();
    const sections = P.sections ?? allKeys.map((k) => [k, null, null]);

    // Which containers exist, inspected once each.
    const states = new Map();
    for (const [key] of sections) {
        const src = logSource(key);
        if (src && !states.has(src.name)) states.set(src.name, await containerState(src.name).catch(() => null));
    }
    const present = sections.filter(([key]) => {
        const src = logSource(key);
        return src && states.get(src.name)?.exists;
    });

    const now = new Date();
    const head = [
        'KaChat / Kaspa Quick Start log export',
        `Generated: ${now.toISOString().replace(/\.\d+Z$/, 'Z')}   Window: last ${window}   Preset: ${P.label}`,
        `KQS panel version: ${panelVersion}`,
        'Containers:',
    ];
    for (const [name, st] of states) {
        if (!st?.exists) continue;
        head.push(
            `  ${name}  image=${st.image || '?'}  status=${st.status}${st.running ? ` (up ${fmtUptime(st.startedAt)})` : ''}` +
                `  restarts=${st.restarts}${st.health ? `  health=${st.health}` : ''}`,
        );
    }
    if (!present.length) head.push('  (none of this preset\'s containers exist on this machine)');

    // One `docker logs` per container, shared by the sections that read it.
    const raw = new Map();
    const body = [];
    for (const [key, extra, title] of present) {
        const src = logSource(key);
        if (!raw.has(src.name)) raw.set(src.name, (await logsSince(src.name, seconds)).split('\n').map(stripAnsi));
        let lines = raw.get(src.name).filter((l) => l.trim());
        if (src.match) lines = lines.filter((l) => (src.match instanceof RegExp ? src.match.test(l) : l.includes(src.match)));
        if (extra) lines = lines.filter((l) => extra.test(l));
        const total = lines.length;
        const cut = total > MAX_LINES;
        if (cut) lines = lines.slice(-MAX_LINES);
        const what = title ?? `${src.label} (${src.name}${src.match ? ', filtered' : ''})`;
        body.push('', `===== ${what}: ${total.toLocaleString('en-US')} lines${cut ? `, newest ${MAX_LINES.toLocaleString('en-US')} kept` : ''} =====`);
        body.push(...lines.map(redact));
    }
    const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').slice(0, 13) + 'Z';
    return { filename: `kqs-logs-${preset}-${stamp}.txt`, text: `${[...head, ...body].join('\n')}\n` };
}
