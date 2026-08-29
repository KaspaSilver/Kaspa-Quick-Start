import crypto from 'node:crypto';

const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const COOKIE_NAME = 'kaspa_node_session';
const SCRYPT_KEYLEN = 32;

const SESSION_SECRET =
    process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 16
        ? process.env.SESSION_SECRET
        : crypto.randomBytes(32).toString('hex');

// Optional. The panel is bound to 127.0.0.1 by default, where "can reach the
// port" already means "is sitting at this machine", so a password buys nothing.
// Set one (install.sh --password) when binding the panel to a real interface or
// proxying it to a domain -- the manager holds the Docker socket, which is root
// on the host, so an exposed panel without a password is a full compromise.
const PASSWORD_HASH = (process.env.ADMIN_PASSWORD_HASH || '').trim();

export const authConfigured = () => PASSWORD_HASH.length > 0;

/**
 * True when a password is stored but cannot possibly be verified.
 *
 * Hashes written before the separator changed reached the container truncated,
 * because docker compose interpolated the `$` in them while reading .env. The
 * panel would then refuse every password including the right one, with nothing
 * to say why. Naming the state is what turns a lockout into an instruction.
 */
export const passwordUnusable = () => {
    if (!authConfigured()) return false;
    const [scheme, saltHex, hashHex] = PASSWORD_HASH.split(/[:$]/);
    return scheme !== 'scrypt' || !saltHex || !hashHex;
};

/** True when a caller must sign in. Mirrors authConfigured, named for intent. */
export const authRequired = () => authConfigured();

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
    if (!authConfigured()) return false;
    // `$` is the separator this used to use. Accepted so an install that set a
    // password before the change keeps working -- if compose left it intact.
    const [scheme, saltHex, hashHex] = PASSWORD_HASH.split(/[:$]/);
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
