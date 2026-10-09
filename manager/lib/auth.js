import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import path from 'node:path';

import { CONF_DIR } from './paths.js';
import { readEnvFile, updateEnvFile } from './store.js';

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const COOKIE_NAME = 'kaspa_node_session';
const SCRYPT_KEYLEN = 32;

const SESSION_SECRET =
    process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 16
        ? process.env.SESSION_SECRET
        : crypto.randomBytes(32).toString('hex');

// Always required (kachat-audits KQS-001). Even on 127.0.0.1 a password-less panel
// is reachable by any web page through DNS rebinding, and the manager holds the
// Docker socket, which is root on the host. Until one is set the panel serves only
// its set-password screen. The session cookie is SameSite=Strict and host-only, so
// a page on another site (or a rebound one) never carries it.
//
// Read live from the .env file the panel mounts, not captured at startup. That
// is what lets setting a password take effect at once, with no need to recreate
// this container -- which used to fail on Docker Desktop, where a Windows host
// path (C:\...) cannot be bind-mounted into the Linux sidecar a restart needs.
// The .env file is also the source of truth: it is what the set-password
// endpoint writes, and its value is un-mangled, where process.env has had its
// `$` interpolated by docker compose. process.env is the fallback for the rare
// case the file cannot be read at all.
function currentHash() {
    const env = readEnvFile();
    if (env.ADMIN_PASSWORD_HASH !== undefined) return String(env.ADMIN_PASSWORD_HASH).trim();
    return (process.env.ADMIN_PASSWORD_HASH || '').trim();
}

export const authConfigured = () => currentHash().length > 0;

/**
 * True when a password is stored but cannot possibly be verified.
 *
 * Hashes written before the separator changed reached the container truncated,
 * because docker compose interpolated the `$` in them while reading .env. The
 * panel would then refuse every password including the right one, with nothing
 * to say why. Naming the state is what turns a lockout into an instruction.
 */
export const passwordUnusable = () => {
    const hash = currentHash();
    if (!hash) return false;
    const [scheme, saltHex, hashHex] = hash.split(/[:$]/);
    return scheme !== 'scrypt' || !saltHex || !hashHex;
};

/** True when a caller must sign in: always (KQS-001). */
export const authRequired = () => true;

export function hashPassword(password, salt = crypto.randomBytes(16)) {
    const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
    // Colons, not dollars. This value is stored in .env, and docker compose
    // interpolates $NAME when it reads that file, so `scrypt$salt$hash` reached
    // the container with everything from the second $ replaced by nothing --
    // whenever the hash happened to start with a letter, which is most of the
    // time. It failed silently: the panel simply refused the right password.
    return `scrypt:${salt.toString('hex')}:${derived.toString('hex')}`;
}

export function verifyPassword(password) {
    const hash = currentHash();
    if (!hash) return false;
    // `$` is the separator this used to use. Accepted so an install that set a
    // password before the change keeps working -- if compose left it intact.
    const [scheme, saltHex, hashHex] = hash.split(/[:$]/);
    if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
    let derived;
    try {
        derived = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), SCRYPT_KEYLEN);
    } catch {
        return false;
    }
    const expected = Buffer.from(hashHex, 'hex');
    if (expected.length !== derived.length) return false;
    return crypto.timingSafeEqual(expected, derived);
}

// Stateless sessions: "<expiry>.<random>.<hmac>". The HMAC also covers the session epoch:
// the stored password hash plus SESSION_EPOCH from .env. Changing the password (here or with
// the installer) or "Sign out everywhere" changes it, and every session issued before is
// refused at once (KQS-018). Both are read live, like the hash itself.
const sessionEpoch = () => `${String(readEnvFile().SESSION_EPOCH ?? '').trim()}:${currentHash().slice(0, 40)}`;
const sign = (payload) =>
    crypto.createHmac('sha256', SESSION_SECRET).update(`${payload}.${sessionEpoch()}`).digest('hex');

export function issueSession() {
    const expires = Date.now() + SESSION_TTL_MS;
    const nonce = crypto.randomBytes(16).toString('hex');
    const payload = `${expires}.${nonce}`;
    return { token: `${payload}.${sign(payload)}`, expires };
}

/** End every session, this one included (a new one is issued to the caller separately). */
export function revokeAllSessions() {
    updateEnvFile({ SESSION_EPOCH: crypto.randomBytes(8).toString('hex') });
}

export function validateSession(token) {
    if (!token) return false;
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const [expires, nonce, sig] = parts;
    if (!/^[0-9a-f]+$/.test(sig)) return false;
    const expected = sign(`${expires}.${nonce}`);
    const a = Buffer.from(sig, 'hex');
    const b = Buffer.from(expected, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
    return Number(expires) > Date.now();
}

export function parseCookies(header = '') {
    const out = {};
    for (const part of header.split(';')) {
        const idx = part.indexOf('=');
        if (idx < 0) continue;
        const raw = part.slice(idx + 1).trim();
        // A malformed escape (`x=%`) must not throw: it ran before any try and an
        // unhandled rejection takes the whole panel down (KQS-012). Keep it raw.
        let value = raw;
        try {
            value = decodeURIComponent(raw);
        } catch {
            /* not percent-encoded; use it as sent */
        }
        out[part.slice(0, idx).trim()] = value;
    }
    return out;
}

export function sessionCookie(token, { secure }) {
    const attrs = [
        `${COOKIE_NAME}=${token}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Strict',
        `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    ];
    if (secure) attrs.push('Secure');
    return attrs.join('; ');
}

export const clearCookie = () => `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;

export const isAuthenticated = (req) => validateSession(parseCookies(req.headers.cookie || '')[COOKIE_NAME]);

export { COOKIE_NAME };

/** Password hash for nginx `auth_basic_user_file` ({SHA} is understood by nginx). */
export function htpasswdLine(user, password) {
    const digest = crypto.createHash('sha1').update(password).digest('base64');
    return `${user}:{SHA}${digest}`;
}

/**
 * verifyPassword without blocking the event loop: scrypt runs on the thread pool,
 * so a burst of login attempts cannot stall every other request (KQS-005).
 */
export async function verifyPasswordAsync(password) {
    const hash = currentHash();
    if (!hash) return false;
    const [scheme, saltHex, hashHex] = hash.split(/[:$]/);
    if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
    let derived;
    try {
        derived = await new Promise((resolve, reject) =>
            crypto.scrypt(password, Buffer.from(saltHex, 'hex'), SCRYPT_KEYLEN, (err, key) => (err ? reject(err) : resolve(key))),
        );
    } catch {
        return false;
    }
    const expected = Buffer.from(hashHex, 'hex');
    if (expected.length !== derived.length) return false;
    return crypto.timingSafeEqual(expected, derived);
}

// ---- login throttling (KQS-005, KQS-017) ----
//
// Per client: 5 wrong passwords lock that client out for a minute. The client is the TCP peer,
// except when the peer is this stack's own nginx (`proxy` on kaspa-node-net): then it is the
// right-most X-Forwarded-For hop, the one nginx appended. A header from anyone else is ignored,
// so a direct caller cannot pose as many clients.
//
// There is no global hard lock any more: it let anyone lock the owner out with 30 bad tries a
// minute. Past that rate every *wrong* answer is slowed down instead (up to 5 s), so guessing
// gets slower for everyone while the right password still signs in. Locks are written to
// conf/ so a restart does not reset them.
const PER_CLIENT_FAILS = 5;
const GLOBAL_SLOW_AFTER = 30;
const LOCK_MS = 60_000;
const MAX_CONCURRENT = 2;
const THROTTLE_FILE = path.join(CONF_DIR, 'login-throttle.json');
const failures = new Map(); // client -> { count, first, lockedUntil }
let globalFails = { count: 0, first: 0 };
let inFlight = 0;

// The proxy's address on the stack network, refreshed in the background.
let proxyAddresses = new Set();
async function refreshProxyAddress() {
    try {
        const found = await dns.lookup('proxy', { all: true });
        proxyAddresses = new Set(found.map((a) => a.address));
    } catch {
        proxyAddresses = new Set();
    }
}
refreshProxyAddress();
setInterval(refreshProxyAddress, 60_000).unref?.();

const bare = (ip) => String(ip || '').replace(/^::ffff:/, '');

export function clientKey(req) {
    const peer = bare(req.socket?.remoteAddress) || 'unknown';
    if (!proxyAddresses.has(peer)) return peer;
    const xff = String(req.headers['x-forwarded-for'] || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    return xff.length ? xff[xff.length - 1] : peer;
}

function loadLocks() {
    try {
        const saved = JSON.parse(fs.readFileSync(THROTTLE_FILE, 'utf8'));
        const now = Date.now();
        for (const [k, until] of Object.entries(saved.locks ?? {})) {
            if (Number(until) > now) failures.set(k, { count: 0, first: now, lockedUntil: Number(until) });
        }
    } catch {
        /* none saved */
    }
}
loadLocks();

function saveLocks(now = Date.now()) {
    const locks = {};
    for (const [k, f] of failures) if (f.lockedUntil > now) locks[k] = f.lockedUntil;
    try {
        fs.writeFileSync(THROTTLE_FILE, `${JSON.stringify({ locks })}\n`, { mode: 0o600 });
    } catch {
        /* best effort */
    }
}

/** Seconds to wait before this client may try again, or 0. */
export function loginBlockedFor(key, now = Date.now()) {
    const until = failures.get(key)?.lockedUntil || 0;
    return until > now ? Math.ceil((until - now) / 1000) : 0;
}

/** Records a wrong password; returns how long to hold the answer back (ms). */
export function recordLoginFailure(key, now = Date.now()) {
    const f = failures.get(key) || { count: 0, first: now, lockedUntil: 0 };
    if (now - f.first > LOCK_MS) Object.assign(f, { count: 0, first: now });
    f.count += 1;
    let locked = false;
    if (f.count >= PER_CLIENT_FAILS) {
        Object.assign(f, { lockedUntil: now + LOCK_MS, count: 0, first: now });
        locked = true;
    }
    failures.set(key, f);
    if (now - globalFails.first > LOCK_MS) globalFails = { count: 0, first: now };
    globalFails.count += 1;
    // Forget stale clients so the map cannot grow without bound.
    if (failures.size > 10_000) {
        for (const [k, v] of failures) if (now - v.first > LOCK_MS && v.lockedUntil < now) failures.delete(k);
    }
    if (locked) saveLocks(now);
    const over = globalFails.count - GLOBAL_SLOW_AFTER;
    return 500 + (over > 0 ? Math.min(4500, over * 250) : 0);
}

export const recordLoginSuccess = (key) => {
    if (failures.delete(key)) saveLocks();
};

/** Runs `fn` if fewer than MAX_CONCURRENT checks are running; null when busy. */
export async function withLoginSlot(fn) {
    if (inFlight >= MAX_CONCURRENT) return null;
    inFlight += 1;
    try {
        return await fn();
    } finally {
        inFlight -= 1;
    }
}
