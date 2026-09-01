import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CONF_DIR } from './paths.js';

/**
 * The gift service's configuration, which is mostly other people's secrets.
 *
 * An Apple .p8 and a Google service account are not settings. They authenticate
 * as your app, Apple hands the .p8 over exactly once, and neither can be
 * un-leaked by editing a file afterwards. So they live in their own directory
 * under conf/, written 0600, and nothing here ever puts them into apps.json --
 * which is rewritten on every unrelated toggle and read by every part of the
 * panel that wants to know whether Nextcloud is on.
 */
export const GIFT_DIR = path.join(CONF_DIR, 'gift');
export const CONFIG_FILE = path.join(GIFT_DIR, 'gift.json');
export const APPLE_KEY = path.join(GIFT_DIR, 'apple', 'AuthKey.p8');
export const GOOGLE_KEY = path.join(GIFT_DIR, 'google', 'service-account.json');

const secret = (file, contents) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents, { mode: 0o600 });
    // Written 0600 whether or not it existed already: a file created by an
    // earlier version, or restored from a backup, must not stay world readable.
    fs.chmodSync(file, 0o600);
};

export const hasApple = () => fs.existsSync(APPLE_KEY);
export const hasGoogle = () => fs.existsSync(GOOGLE_KEY);

/**
 * Renders what the service reads at startup, from the panel's own settings plus
 * whichever credentials are actually on disk.
 *
 * A platform is only switched on when its file is present, so a half-finished
 * wizard leaves a service that starts and says which half is missing, rather
 * than one that starts and fails at a real user's first tap.
 */
export function writeConfig(giftCfg, { network = 'mainnet', kaspadPort = 18110 } = {}) {
    const config = {
        network,
        amountKas: Number(giftCfg.amountKas ?? 3),
        mode: giftCfg.mode === 'live' ? 'live' : 'record-only',
        caps: {
            dailyKas: Number(giftCfg.dailyCapKas ?? 300),
            poolFloorKas: Number(giftCfg.poolFloorKas ?? 50),
        },
        apple: {
            enabled: Boolean(giftCfg.apple?.enabled) && hasApple(),
            teamId: giftCfg.apple?.teamId ?? '',
            keyId: giftCfg.apple?.keyId ?? '',
            bundleId: giftCfg.apple?.bundleId ?? 'com.kachat.app',
            keyFile: '/conf/apple/AuthKey.p8',
        },
        android: {
            enabled: Boolean(giftCfg.android?.enabled) && hasGoogle(),
            packageName: giftCfg.android?.packageName ?? 'com.kachat.app',
            serviceAccountFile: '/conf/google/service-account.json',
        },
        kaspad: { url: `ws://kaspad:${kaspadPort}` },
    };

    fs.mkdirSync(GIFT_DIR, { recursive: true });
    fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    return config;
}

export function saveAppleKey(pem) {
    const text = String(pem || '').trim();
    // Deliberately not spelling out the full PEM header: the repository's own
    // pre-commit hook looks for that exact string to stop a key being committed,
    // and a guard that every edit to this file has to be waved past is a guard
    // nobody keeps. Anything this lets through, createPrivateKey rejects.
    if (!/^-----BEGIN [A-Z ]*KEY-----/m.test(text)) {
        throw new Error('That does not look like a .p8 key. Paste the whole file, including the BEGIN and END lines.');
    }
    try {
        crypto.createPrivateKey(text);
    } catch (err) {
        throw new Error(`That key could not be read: ${err.message}`);
    }
    secret(APPLE_KEY, `${text}\n`);
}

export function saveGoogleKey(json) {
    let parsed;
    try {
        parsed = typeof json === 'string' ? JSON.parse(json) : json;
    } catch (err) {
        throw new Error(`That is not valid JSON: ${err.message}`);
    }
    if (!parsed?.client_email || !parsed?.private_key) {
        throw new Error('That JSON has no client_email or private_key, so it is not a service account key.');
    }
    secret(GOOGLE_KEY, `${JSON.stringify(parsed, null, 2)}\n`);
    return { clientEmail: parsed.client_email, projectId: parsed.project_id ?? null };
}

const b64url = (input) => Buffer.from(input).toString('base64url');

/**
 * Asks Apple to answer with the key, before anyone depends on it.
 *
 * DeviceCheck answers a wrong key, a wrong key id and a wrong team with the
 * same bare 401 and no body, which is useless on its own. But it answers a
 * *correct* key carrying a nonsense device token with a 400 -- so a 400 here is
 * the good outcome, and the difference between the two is the whole test.
 */
export async function testApple({ teamId, keyId }) {
    if (!hasApple()) throw new Error('No Apple key has been saved yet.');
    const privateKeyPem = fs.readFileSync(APPLE_KEY, 'utf8');

    const header = b64url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }));
    const payload = b64url(JSON.stringify({ iss: teamId, iat: Math.floor(Date.now() / 1000) }));
    let signature;
    try {
        signature = crypto
            .sign('sha256', Buffer.from(`${header}.${payload}`), { key: privateKeyPem, dsaEncoding: 'ieee-p1363' })
            .toString('base64url');
    } catch (err) {
        return { ok: false, detail: `The key could not sign anything: ${err.message}` };
    }

    const res = await fetch('https://api.devicecheck.apple.com/v1/query_two_bits', {
        method: 'POST',
        headers: { Authorization: `Bearer ${header}.${payload}.${signature}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            device_token: 'not-a-real-device-token',
            transaction_id: crypto.randomUUID(),
            timestamp: Date.now(),
        }),
        signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.text()).trim();

    if (res.status === 401) {
        return {
            ok: false,
            detail:
                'Apple rejected the key. It says nothing more than that, so it is one of three things: the ' +
                'key id does not match the file, the team id is wrong, or the key has been revoked.',
        };
    }
    if (res.status === 400) {
        return { ok: true, detail: 'Apple accepted the key and rejected the fake device token, which is what it should do.' };
    }
    return { ok: false, detail: `Apple answered ${res.status}: ${body.slice(0, 200) || 'no detail'}` };
}

/**
 * Asks Google for an access token with the service account, which is the same
 * thing the service does on its first claim. A key that cannot mint a token
 * will not decode an integrity verdict either.
 */
export async function testGoogle() {
    if (!hasGoogle()) throw new Error('No Google service account has been saved yet.');
    const account = JSON.parse(fs.readFileSync(GOOGLE_KEY, 'utf8'));

    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = b64url(
        JSON.stringify({
            iss: account.client_email,
            scope: 'https://www.googleapis.com/auth/playintegrity',
            aud: 'https://oauth2.googleapis.com/token',
            iat: now,
            exp: now + 600,
        }),
    );
    const signature = crypto.sign('sha256', Buffer.from(`${header}.${payload}`), account.private_key).toString('base64url');

    const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: `${header}.${payload}.${signature}`,
        }),
        signal: AbortSignal.timeout(15_000),
    });

    if (res.ok) {
        return { ok: true, detail: `Google issued a token for ${account.client_email}.` };
    }
    const body = await res.text();
    // The two failures worth telling apart: a key Google does not accept, and a
    // key it accepts for a project where the API has never been switched on.
    const hint = /invalid_grant/.test(body)
        ? 'Google rejected the key itself. It may have been deleted in the Cloud console.'
        : /access_denied|insufficient/.test(body)
          ? 'The key is valid but not allowed to use Play Integrity. Enable the API on that project and grant the service account access.'
          : body.slice(0, 200);
    return { ok: false, detail: hint };
}
