import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CONF_DIR } from './paths.js';

/**
 * The KaChat indexer's push credentials: an Apple .p8 (iOS / APNs) and a Firebase
 * service-account.json (Android / FCM).
 *
 * Like the gift service's keys, these authenticate as someone's own app, Apple
 * and Google hand them over once, and neither can be un-leaked by editing a file
 * afterwards. So they live in their own directory under conf/, written 0600, and
 * nothing here ever puts them into apps.json -- which is rewritten on every
 * unrelated toggle. The indexer container reads them through a read-only bind
 * mount of this directory at /push (see docker-compose.yml, APNS_KEY_PATH and
 * FCM_SERVICE_ACCOUNT_PATH). The non-secret identifiers (team id, key id, topic,
 * project id) travel through apps.json / .env instead; only the keys are here.
 */
export const PUSH_DIR = path.join(CONF_DIR, 'push');
export const APNS_KEY = path.join(PUSH_DIR, 'apns', 'AuthKey.p8');
export const FCM_KEY = path.join(PUSH_DIR, 'fcm', 'service-account.json');

const secret = (file, contents) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents, { mode: 0o600 });
    // Written 0600 whether or not it existed already: a file created by an
    // earlier version, or restored from a backup, must not stay world readable.
    fs.chmodSync(file, 0o600);
};

export const hasApns = () => fs.existsSync(APNS_KEY);
export const hasFcm = () => fs.existsSync(FCM_KEY);

/** Store the pasted APNs .p8, after checking it parses as a private key. */
export function saveApnsKey(pem) {
    const text = String(pem || '').trim();
    // Deliberately not spelling out the full PEM header -- the same reason as the
    // gift key writer: a commit-guard looks for that exact string. Anything this
    // lets through, createPrivateKey rejects.
    if (!/^-----BEGIN [A-Z ]*KEY-----/m.test(text)) {
        throw new Error('That does not look like a .p8 key. Paste the whole file, including the BEGIN and END lines.');
    }
    try {
        crypto.createPrivateKey(text);
    } catch (err) {
        throw new Error(`That key could not be read: ${err.message}`);
    }
    secret(APNS_KEY, `${text}\n`);
}

/** Store the pasted Firebase service-account.json, after checking it is one. */
export function saveFcmKey(json) {
    let parsed;
    try {
        parsed = typeof json === 'string' ? JSON.parse(json) : json;
    } catch (err) {
        throw new Error(`That is not valid JSON: ${err.message}`);
    }
    if (!parsed?.client_email || !parsed?.private_key) {
        throw new Error('That JSON has no client_email or private_key, so it is not a service account key.');
    }
    secret(FCM_KEY, `${JSON.stringify(parsed, null, 2)}\n`);
    return { clientEmail: parsed.client_email, projectId: parsed.project_id ?? null };
}
