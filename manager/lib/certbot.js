import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { docker } from './dockerctl.js';
import { hostPath, WEBROOT_DIR } from './paths.js';

const IMAGE = 'certbot/certbot:latest';

// certbot runs as a throwaway container rather than a stack service: it needs
// to run rarely, and the volumes it wants are the same host directories nginx
// already serves the ACME webroot from. Paths must be the *host* paths because
// it is the Docker daemon, not this container, that resolves them.
function volumeArgs() {
    return [
        '-v',
        `${hostPath('proxy', 'letsencrypt')}:/etc/letsencrypt`,
        '-v',
        `${hostPath('proxy', 'webroot')}:/var/www/certbot`,
    ];
}

/**
 * An ACME account can be registered without a contact address, and this one is.
 *
 * The address only ever receives expiry warnings, and this stack renews on a
 * daily timer and shows the expiry date in the panel, so the warning would be
 * telling someone something their own screen already says. Asking for it made
 * every setup one field longer for that.
 */
export async function issue(domain, email, { staging = false, onLine } = {}) {
    const contact = String(email || '').trim();
    const args = [
        'run',
        '--rm',
        ...volumeArgs(),
        IMAGE,
        'certonly',
        '--webroot',
        '-w',
        '/var/www/certbot',
        '--non-interactive',
        // Inside the letsencrypt volume, so the log outlives this throwaway
        // container. certbot's own error message points at it, and until now it
        // named a path that ceased to exist the moment it was printed.
        '--logs-dir',
        '/etc/letsencrypt/logs',
        '--agree-tos',
        '--no-eff-email',
        '--keep-until-expiring',
        ...(contact ? ['-m', contact] : ['--register-unsafely-without-email']),
        '-d',
        domain,
    ];
    if (staging) args.push('--staging');
    return docker(args, { onLine, timeoutMs: 5 * 60_000 });
}

/**
 * Serves a file the way Let's Encrypt is about to ask for one, and fetches it
 * back through nginx.
 *
 * A failed challenge has two very different causes -- this machine not serving
 * it, or the internet not reaching this machine -- and certbot cannot tell them
 * apart. This can: if the file comes back over the internal network, everything
 * on this side is right and what is missing is the route in.
 */
export async function selfTest(domain) {
    const token = `panel-check-${crypto.randomBytes(8).toString('hex')}`;
    const dir = path.join(WEBROOT_DIR, '.well-known', 'acme-challenge');
    const file = path.join(dir, token);
    const expected = `served-by-${domain}`;

    try {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(file, expected, 'utf8');
        const res = await fetch(`http://proxy/.well-known/acme-challenge/${token}`, {
            headers: { Host: domain },
            signal: AbortSignal.timeout(5000),
        });
        return { ok: res.ok && (await res.text()).trim() === expected };
    } catch (err) {
        return { ok: false, error: err.message };
    } finally {
        try {
            fs.rmSync(file);
        } catch {
            /* nothing to clean up */
        }
    }
}

export async function renew({ onLine } = {}) {
    return docker(
        ['run', '--rm', ...volumeArgs(), IMAGE, 'renew', '--webroot', '-w', '/var/www/certbot', '--non-interactive'],
        { onLine, timeoutMs: 10 * 60_000 },
    );
}

export async function revokeAndDelete(domain, { onLine } = {}) {
    return docker(
        ['run', '--rm', ...volumeArgs(), IMAGE, 'delete', '--cert-name', domain, '--non-interactive'],
        { onLine, timeoutMs: 2 * 60_000 },
    );
}
