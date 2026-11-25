import fs from 'node:fs';
import crypto from 'node:crypto';

/**
 * A self-signed certificate for nginx's gRPC listener, made with nothing but
 * node:crypto.
 *
 * Only cloudflared ever connects to that listener, over the stack's own docker
 * network, and it is told not to check the certificate (noTLSVerify on the
 * route). The certificate is there because cloudflared only speaks HTTP/2 to an
 * origin over TLS, and gRPC needs HTTP/2. So what matters is that it parses and
 * offers h2, not who signed it. Neither the nginx image nor this panel's image
 * has openssl, and the panel keeps to the Node standard library, hence the few
 * lines of DER below: an EC P-256 key and a v3 certificate with no extensions.
 */

function len(n) {
    if (n < 0x80) return Buffer.from([n]);
    const bytes = [];
    for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
    return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const tlv = (tag, ...parts) => {
    const body = Buffer.concat(parts);
    return Buffer.concat([Buffer.from([tag]), len(body.length), body]);
};
const seq = (...parts) => tlv(0x30, ...parts);
// A DER INTEGER is signed: a leading byte with its top bit set needs a zero in front.
const int = (buf) => tlv(0x02, buf[0] & 0x80 ? Buffer.concat([Buffer.from([0]), buf]) : buf);

function oid(dotted) {
    const [a, b, ...rest] = dotted.split('.').map(Number);
    const out = [40 * a + b];
    for (const n of rest) {
        const chunk = [n & 0x7f];
        for (let v = n >> 7; v > 0; v >>= 7) chunk.unshift((v & 0x7f) | 0x80);
        out.push(...chunk);
    }
    return tlv(0x06, Buffer.from(out));
}

// UTCTime (YYMMDDHHMMSSZ), which RFC 5280 requires for dates before 2050.
const utcTime = (date) => tlv(0x17, Buffer.from(`${date.toISOString().slice(2, 19).replace(/[-:T]/g, '')}Z`));
const commonName = (cn) => seq(tlv(0x31, seq(oid('2.5.4.3'), tlv(0x0c, Buffer.from(cn)))));
const ECDSA_SHA256 = seq(oid('1.2.840.10045.4.3.2'));

/** A new key and certificate for `cn`, both PEM. Valid from yesterday for twenty years. */
export function selfSigned(cn, { now = new Date() } = {}) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const notBefore = new Date(now.getTime() - 86_400_000);
    const notAfter = new Date(now.getTime());
    notAfter.setUTCFullYear(notAfter.getUTCFullYear() + 20);
    const serial = crypto.randomBytes(16);
    serial[0] &= 0x7f;

    const tbs = seq(
        tlv(0xa0, int(Buffer.from([2]))),
        int(serial),
        ECDSA_SHA256,
        commonName(cn),
        seq(utcTime(notBefore), utcTime(notAfter)),
        commonName(cn),
        publicKey.export({ type: 'spki', format: 'der' }),
    );
    const signature = crypto.sign('sha256', tbs, privateKey);
    const der = seq(tbs, ECDSA_SHA256, tlv(0x03, Buffer.from([0]), signature));

    const b64 = der.toString('base64').replace(/.{1,64}/g, '$&\n');
    return {
        cert: `-----BEGIN CERTIFICATE-----\n${b64}-----END CERTIFICATE-----\n`,
        key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    };
}

/** Writes the pair once; a certificate that is already there and parses is kept. */
export function ensureCert(certFile, keyFile, cn) {
    try {
        if (fs.existsSync(keyFile)) {
            new crypto.X509Certificate(fs.readFileSync(certFile));
            return false;
        }
    } catch {
        // Missing or unreadable: make a new pair below.
    }
    const { cert, key } = selfSigned(cn);
    fs.writeFileSync(keyFile, key, { mode: 0o600 });
    fs.chmodSync(keyFile, 0o600);
    fs.writeFileSync(certFile, cert, 'utf8');
    return true;
}
