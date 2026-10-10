import { docker } from './dockerctl.js';

/**
 * x4kas (github.com/smartgoo/x4kas, MIT): the Kaspa terminal desktop app. It runs natively on
 * your own computer; this panel gives you the download for it and this node's address to
 * connect it to, and makes the node reachable for it. Nothing of x4kas runs on the server.
 */
export const REPO = 'smartgoo/x4kas';

/** Which platform a release asset is for, from its name (x4kas-<ver>-<target>.<ext>). */
const PLATFORMS = [
    { key: 'macos-arm64', label: 'macOS (Apple silicon)', match: /aarch64-apple-darwin/ },
    { key: 'macos-x64', label: 'macOS (Intel)', match: /x86_64-apple-darwin/ },
    { key: 'windows-x64', label: 'Windows (64-bit)', match: /x86_64-pc-windows/ },
    { key: 'linux-x64', label: 'Linux (x86_64)', match: /x86_64-unknown-linux/ },
    { key: 'linux-arm64', label: 'Linux (ARM64)', match: /aarch64-unknown-linux/ },
];

let releaseCache = { at: 0, value: null };

/**
 * The newest x4kas release with a download per platform, cached for 10 minutes (GitHub's API
 * limit is per IP and shared with the rest of the panel).
 */
export async function latestRelease({ force = false } = {}) {
    if (!force && releaseCache.value && Date.now() - releaseCache.at < 10 * 60_000) return releaseCache.value;
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { accept: 'application/vnd.github+json', 'user-agent': 'kaspa-quick-start' },
        signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
        const hint = res.status === 403 ? ' (GitHub API rate limit - try again shortly)' : '';
        throw new Error(`GitHub returned ${res.status} for ${REPO} releases${hint}`);
    }
    const r = await res.json();
    const assets = Array.isArray(r.assets) ? r.assets : [];
    const value = {
        tag: String(r.tag_name || ''),
        url: r.html_url,
        publishedAt: r.published_at,
        prerelease: Boolean(r.prerelease),
        downloads: PLATFORMS.flatMap((p) => {
            const a = assets.find((x) => p.match.test(x.name));
            return a ? [{ key: p.key, label: p.label, name: a.name, url: a.browser_download_url, size: a.size }] : [];
        }),
        checksums: assets.find((x) => x.name === 'SHA256SUMS')?.browser_download_url ?? null,
    };
    releaseCache = { at: Date.now(), value };
    return value;
}

/**
 * The streamed x4kas (an earlier version of this branch ran it on the server and drew it into
 * the panel) is gone: remove its container, image and index volume if they are still here.
 */
export async function removeStreamedApp(log = () => {}) {
    const exists = await docker(['container', 'inspect', 'kaspa-node-x4kas'], { timeoutMs: 15_000 })
        .then(() => true)
        .catch(() => false);
    if (!exists) return;
    log('x4kas: removing the streamed app from the server (x4kas now runs natively on your computer).');
    await docker(['rm', '-f', 'kaspa-node-x4kas'], { timeoutMs: 60_000 }).catch(() => {});
    const { stdout } = await docker(['images', '--format', '{{.Repository}}:{{.Tag}}', 'kaspa-one-click/x4kas'], { timeoutMs: 30_000 }).catch(
        () => ({ stdout: '' }),
    );
    for (const tag of stdout.split('\n').map((t) => t.trim()).filter(Boolean)) {
        await docker(['image', 'rm', tag], { timeoutMs: 120_000 }).catch(() => {});
    }
    await docker(['volume', 'rm', 'kaspa-node-x4kas-data'], { timeoutMs: 60_000 }).catch(() => {});
}
