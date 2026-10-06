import crypto from 'node:crypto';

import { readEnvFile } from './store.js';

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

// Stateless sessions: "<expiry>.<random>.<hmac>". Nothing to persist, and a
// manager restart simply invalidates everything, which is the safe direction.
export function issueSession() {
    const expires = Date.now() + SESSION_TTL_MS;
    const nonce = crypto.randomBytes(16).toString('hex');
    const payload = `${expires}.${nonce}`;
    const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
    return { token: `${payload}.${sig}`, expires };
}

export function validateSession(token) {
    if (!token) return false;
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const [expires, nonce, sig] = parts;
    const expected = crypto.createHmac('sha256', SESSION_SECRET).update(`${expires}.${nonce}`).digest('hex');
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
        out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
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

// ---- login throttling (KQS-005) ----
//
// Per client: 5 wrong passwords lock that client out for a minute. Behind the
// panel's own nginx every request arrives from the proxy container, so the client
// is the right-most X-Forwarded-For hop (the one nginx appended). A direct caller
// can forge that header to look like many clients, so there is also a global
// ceiling: 30 failures a minute from anyone pauses all logins for a minute, and
// at most 2 password checks run at once.
const PER_CLIENT_FAILS = 5;
const GLOBAL_FAILS = 30;
const LOCK_MS = 60_000;
const MAX_CONCURRENT = 2;
const failures = new Map(); // client -> { count, first, lockedUntil }
let globalFails = { count: 0, first: 0, lockedUntil: 0 };
let inFlight = 0;

export function clientKey(req) {
    const xff = String(req.headers['x-forwarded-for'] || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    return xff.length ? xff[xff.length - 1] : req.socket?.remoteAddress || 'unknown';
}

/** Seconds to wait before this client may try again, or 0. */
export function loginBlockedFor(key, now = Date.now()) {
    const until = Math.max(failures.get(key)?.lockedUntil || 0, globalFails.lockedUntil);
    return until > now ? Math.ceil((until - now) / 1000) : 0;
}

export function recordLoginFailure(key, now = Date.now()) {
    const bump = (f, limit) => {
        if (now - f.first > LOCK_MS) Object.assign(f, { count: 0, first: now });
        f.count += 1;
        if (f.count >= limit) Object.assign(f, { lockedUntil: now + LOCK_MS, count: 0, first: now });
        return f;
    };
    failures.set(key, bump(failures.get(key) || { count: 0, first: now, lockedUntil: 0 }, PER_CLIENT_FAILS));
    bump(globalFails, GLOBAL_FAILS);
    // Forget stale clients so the map cannot grow without bound.
    if (failures.size > 10_000) {
        for (const [k, f] of failures) if (now - f.first > LOCK_MS && f.lockedUntil < now) failures.delete(k);
    }
}

export const recordLoginSuccess = (key) => failures.delete(key);

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
