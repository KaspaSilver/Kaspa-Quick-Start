import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import path from 'node:path';

import { CONF_DIR } from './paths.js';
import { readEnvFile, updateEnvFile } from './store.js';

// A sign-in lasts SESSION_MAX_AGE_MS from when its token was issued, and opening the panel
// swaps an older token for a fresh one (refreshedCookie), so a panel in use never signs out
// while one left alone for a month does. Before, sessions never ran out at all, and a signed-
// out cookie came back to life once its nonce fell off the bounded revoked list; now the
// list only has to outlast a token's own lifetime. Sign out, Sign out everywhere and a new
// password still end sessions at once.
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
// How old a token gets before opening the panel replaces it. Not every request: a fresh
// token each time would make every open tab's cookie a different one for no gain.
const SESSION_RENEW_AFTER_MS = 24 * 60 * 60 * 1000;
// Tokens issued before sessions could expire count from this moment instead of their own
// `issued`, so an existing sign-in gets a full lifetime (and a renewal on the next open)
// rather than being dropped by the update that introduced the limit.
const SESSION_LEGACY_FLOOR = Date.parse('2026-11-26T00:00:00Z');
const COOKIE_MAX_AGE_S = SESSION_MAX_AGE_MS / 1000;
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
    const issued = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const payload = `${issued}.${nonce}`;
    return { token: `${payload}.${sign(payload)}` };
}

// Sign out ends that one session for good, not just this browser's copy of the cookie: its
// nonce goes on this list, which a session is checked against. A copied cookie would
// otherwise live on until it expires (SESSION_MAX_AGE_MS).
const REVOKED_FILE = path.join(CONF_DIR, 'revoked-sessions.json');
const REVOKED_MAX = 2000;
let revoked = new Set();
try {
    revoked = new Set(JSON.parse(fs.readFileSync(REVOKED_FILE, 'utf8')).nonces ?? []);
} catch {
    /* none yet */
}
function saveRevoked() {
    try {
        fs.writeFileSync(REVOKED_FILE, `${JSON.stringify({ nonces: [...revoked].slice(-REVOKED_MAX) })}\n`, { mode: 0o600 });
    } catch {
        /* best effort: the cookie is still cleared */
    }
}

/** End one session (Sign out). */
export function revokeSession(token) {
    if (!validateSession(token)) return;
    revoked.add(token.split('.')[1]);
    if (revoked.size > REVOKED_MAX) revoked = new Set([...revoked].slice(-REVOKED_MAX));
    saveRevoked();
}

/** End every session, this one included (a new one is issued to the caller separately). */
export function revokeAllSessions() {
    updateEnvFile({ SESSION_EPOCH: crypto.randomBytes(8).toString('hex') });
    // The new epoch ends every earlier session by itself, so the list starts over.
    revoked = new Set();
    saveRevoked();
}

/** When a token was issued, for expiry: the legacy floor for tokens older than expiry itself. */
const issuedAt = (issued) => Math.max(Number(issued), SESSION_LEGACY_FLOOR);

export function validateSession(token, now = Date.now()) {
    if (!token) return false;
    const parts = token.split('.');
    if (parts.length !== 3) return false;
    const [issued, nonce, sig] = parts;
    if (!/^[0-9a-f]+$/.test(sig) || revoked.has(nonce)) return false;
    // The time check before the signature only saves the HMAC: `issued` is signed, so an
    // altered one fails below anyway. Sign out everywhere and a new password change the epoch
    // the signature is bound to, which ends a session before its time.
    if (!/^\d{1,15}$/.test(issued) || now - issuedAt(issued) > SESSION_MAX_AGE_MS) return false;
    const expected = sign(`${issued}.${nonce}`);
    const a = Buffer.from(sig, 'hex');
    const b = Buffer.from(expected, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
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
        `Max-Age=${COOKIE_MAX_AGE_S}`,
    ];
    if (secure) attrs.push('Secure');
    return attrs.join('; ');
}

export const clearCookie = () => `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;

export const requestToken = (req) => parseCookies(req.headers.cookie || '')[COOKIE_NAME];
export const isAuthenticated = (req) => validateSession(requestToken(req));

/**
 * The caller's session cookie sent again, or null when it has none that is valid. A token
 * past SESSION_RENEW_AFTER_MS is swapped for a new one, which is what makes the lifetime
 * slide while the panel is in use. The old token is not revoked: it simply runs out.
 */
export function refreshedCookie(req, { secure }, now = Date.now()) {
    const token = requestToken(req);
    if (!validateSession(token, now)) return null;
    const fresh = now - issuedAt(token.split('.')[0]) > SESSION_RENEW_AFTER_MS ? issueSession().token : token;
    return sessionCookie(fresh, { secure });
}

export { COOKIE_NAME };

/** Password hash for nginx `auth_basic_user_file` ({SHA} is understood by nginx). */
export function htpasswdLine(user, password) {
    // Salted ({SSHA}, which nginx reads natively), so two names with the same password do not
    // share a hash and a precomputed table is no use. Lines saved before stay {SHA} and work.
    const salt = crypto.randomBytes(8);
    const digest = crypto.createHash('sha1').update(password).update(salt).digest();
    return `${user}:{SSHA}${Buffer.concat([digest, salt]).toString('base64')}`;
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
//
// The spacing between checks during a burst is kept per client too. One queue for everyone
// let ~50 wrong tries a minute, spread over 10 addresses, fill it for good, and the owner got
// "Busy checking other sign-ins" with the right password. Each client now waits behind its
// own earlier tries only, so a guesser's many parallel requests still go one at a time, and
// a stranger's queue is never the owner's.
const PER_CLIENT_FAILS = 5;
const GLOBAL_SLOW_AFTER = 30;
const LOCK_MS = 60_000;
const MAX_CONCURRENT = 2;
const THROTTLE_FILE = path.join(CONF_DIR, 'login-throttle.json');
const failures = new Map(); // client -> { count, first, lockedUntil }
let globalFails = { count: 0, first: 0 };
let inFlight = 0;
const nextStart = new Map(); // client -> during a burst, when its next password check may begin
const MAX_WAIT_MS = 15_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

/**
 * One IPv6 network counts as one client: anyone holding a /64 (the usual home or VPS
 * allocation) can use any address in it, so keying on the full address would hand each
 * guesser 2^64 fresh per-client allowances. IPv4 addresses are keyed as they are.
 */
export function throttleKey(ip) {
    if (!ip.includes(':')) return ip;
    const [head, tail = ''] = ip.split('::');
    const left = head ? head.split(':') : [];
    const right = ip.includes('::') && tail ? tail.split(':') : [];
    const groups = ip.includes('::') ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
    return `${groups.slice(0, 4).map((g) => (parseInt(g, 16) || 0).toString(16)).join(':')}::/64`;
}

export function clientKey(req) {
    const peer = bare(req.socket?.remoteAddress) || 'unknown';
    if (!proxyAddresses.has(peer)) return throttleKey(peer);
    const xff = String(req.headers['x-forwarded-for'] || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    return throttleKey(bare(xff.length ? xff[xff.length - 1] : peer));
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

/** How far apart password checks start while the panel is seeing a burst of wrong answers. */
function burstSpacing(now) {
    if (now - globalFails.first > LOCK_MS) return 0;
    const over = globalFails.count - GLOBAL_SLOW_AFTER;
    return over > 0 ? Math.min(4500, over * 250) : 0;
}

/**
 * Runs `fn` once a slot is free; null when the wait would be too long. In a burst one client's
 * checks start one at a time, spaced out, so its many requests in parallel guess no faster than
 * one after another. Outside a burst a busy moment is waited out briefly rather than refused.
 *
 * `key` is the caller's clientKey(). Without one every caller shares a single queue, which is
 * the old behaviour and the one that let strangers crowd the owner out.
 */
export async function withLoginSlot(fn, key = '*') {
    const now = Date.now();
    const spacing = burstSpacing(now);
    if (spacing) {
        const at = Math.max(now, nextStart.get(key) || 0);
        if (at - now > MAX_WAIT_MS) return null;
        nextStart.set(key, at + spacing);
        // Clients whose turn has passed hold nothing, so the map stays as small as the burst.
        if (nextStart.size > 10_000) for (const [k, t] of nextStart) if (t <= now) nextStart.delete(k);
        if (at > now) await sleep(at - now);
    }
    const deadline = Date.now() + 5000;
    while (inFlight >= MAX_CONCURRENT) {
        if (Date.now() > deadline) return null;
        await sleep(50);
    }
    inFlight += 1;
    try {
        return await fn();
    } finally {
        inFlight -= 1;
    }
}
