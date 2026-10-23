import fs from 'node:fs';
import path from 'node:path';
import { CONF_DIR } from './paths.js';

/**
 * The mobile push credentials an earlier panel stored: an Apple .p8 (APNs) and a Firebase
 * service-account.json (FCM), under conf/push/. Push is web only now (the owner's call,
 * 2026-10-22): nothing writes these any more, the indexer is no longer given them, and
 * removeMobileCredentials deletes whatever an earlier version left behind.
 */
export const PUSH_DIR = path.join(CONF_DIR, 'push');
export const APNS_KEY = path.join(PUSH_DIR, 'apns', 'AuthKey.p8');
export const FCM_KEY = path.join(PUSH_DIR, 'fcm', 'service-account.json');

export const hasMobileCredentials = () => fs.existsSync(APNS_KEY) || fs.existsSync(FCM_KEY);

/** Deletes the stored mobile keys and their directory. Returns what was there. */
export function removeMobileCredentials() {
    const removed = [APNS_KEY, FCM_KEY].filter((f) => fs.existsSync(f));
    fs.rmSync(PUSH_DIR, { recursive: true, force: true });
    return removed.map((f) => path.relative(CONF_DIR, f));
}
