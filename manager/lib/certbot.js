import { docker } from './dockerctl.js';
import { hostPath } from './paths.js';

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
