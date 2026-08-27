import { compose, imageVersion, KASPAD_CONTAINER } from './dockerctl.js';
import { readEnvFile, updateEnvFile, loadManagerConfig, saveManagerConfig } from './store.js';
import { rpc } from './rpc.js';

const REPO = process.env.UPSTREAM_REPO || 'kaspanet/rusty-kaspa';
const API = `https://api.github.com/repos/${REPO}`;
const TAG_RE = /^v?\d+\.\d+\.\d+/;

const ghHeaders = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'kaspa-one-click-node-manager',
    'X-GitHub-Api-Version': '2022-11-28',
};

/** Compares tags like v2.0.1 / v1.3.0-toc.5; pre-release tags sort below their release. */
export function compareVersions(a, b) {
    const parse = (v) => {
        const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(String(v || '').trim());
        return m ? { nums: [+m[1], +m[2], +m[3]], pre: m[4] ?? null } : null;
    };
    const pa = parse(a);
    const pb = parse(b);
    if (!pa || !pb) return 0;
    for (let i = 0; i < 3; i++) {
        if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i] ? -1 : 1;
    }
    if (pa.pre === pb.pre) return 0;
    if (pa.pre === null) return 1; // 2.0.0 > 2.0.0-rc1
    if (pb.pre === null) return -1;
    return pa.pre < pb.pre ? -1 : 1;
}

/**
 * The version the node is actually running. The RPC answer is authoritative
 * because it comes from the process itself; the image label is the fallback for
 * a node that is stopped or still starting.
 */
export async function runningVersion() {
    try {
        const info = await rpc.call('getInfo', {}, 4000);
        if (info?.serverVersion) return { version: `v${String(info.serverVersion).replace(/^v/, '')}`, source: 'rpc' };
    } catch {
        /* fall through to the image label */
    }
    const label = await imageVersion(KASPAD_CONTAINER);
    if (label) return { version: label, source: 'image' };
    const env = readEnvFile();
    return env.KASPAD_VERSION ? { version: env.KASPAD_VERSION, source: 'env' } : { version: null, source: 'unknown' };
}

/**
 * Asks the official rusty-kaspa repository what the newest release is.
 * `includePrereleases` walks the release list instead of /releases/latest,
 * which GitHub defines as the newest non-prerelease, non-draft release.
 */
export async function checkLatest({ includePrereleases = false } = {}) {
    const url = includePrereleases ? `${API}/releases?per_page=20` : `${API}/releases/latest`;
    const res = await fetch(url, { headers: ghHeaders, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
        const hint = res.status === 403 ? ' (GitHub API rate limit - try again in a few minutes)' : '';
        throw new Error(`GitHub returned ${res.status}${hint}`);
    }
    const body = await res.json();

    const releases = (Array.isArray(body) ? body : [body])
        .filter((r) => r && !r.draft && TAG_RE.test(r.tag_name || ''))
        .filter((r) => includePrereleases || !r.prerelease);

    if (!releases.length) throw new Error('No usable release found upstream.');

    releases.sort((a, b) => compareVersions(b.tag_name, a.tag_name));
    const latest = releases[0];

    // Only versions that ship a linux archive can be installed on amd64 without
    // a source build, so surface that up front instead of failing mid-update.
    const hasLinuxAsset = (latest.assets || []).some((a) => /linux-amd64\.zip$/.test(a.name || ''));

    const current = await runningVersion();
    const cfg = loadManagerConfig();
    cfg.updates.lastCheckedAt = new Date().toISOString();
    cfg.updates.latestKnown = latest.tag_name;
    saveManagerConfig(cfg);

    return {
        repo: REPO,
        latest: latest.tag_name,
        name: latest.name,
        publishedAt: latest.published_at,
        prerelease: Boolean(latest.prerelease),
        url: latest.html_url,
        notes: (latest.body || '').slice(0, 4000),
        hasLinuxAsset,
        current: current.version,
        currentSource: current.source,
        updateAvailable: Boolean(current.version) && compareVersions(current.version, latest.tag_name) < 0,
        checkedAt: cfg.updates.lastCheckedAt,
    };
}

/**
 * Rebuilds the kaspad image at `version` and restarts the container.
 * The chain data lives in a named volume that is never touched, so an update is
 * a binary swap, not a resync.
 */
export async function applyUpdate(version, onLine = () => {}) {
    if (!TAG_RE.test(version)) throw new Error(`Refusing to install "${version}": not a release tag.`);

    const previous = readEnvFile().KASPAD_VERSION || null;
    onLine(`Updating kaspad ${previous ?? '(unknown)'} -> ${version}`);

    updateEnvFile({ KASPAD_VERSION: version });

    try {
        onLine('Building the kaspad image...');
        await compose(['build', '--pull', 'kaspad'], { onLine, timeoutMs: 90 * 60_000 });

        onLine('Restarting the node...');
        await compose(['up', '-d', '--force-recreate', 'kaspad'], { onLine, timeoutMs: 10 * 60_000 });

        onLine(`kaspad is now running ${version}.`);
        return { ok: true, version, previous };
    } catch (err) {
        // Put the pin back so a failed build does not leave the stack claiming a
        // version it never managed to produce.
        if (previous) updateEnvFile({ KASPAD_VERSION: previous });
        onLine(`Update failed: ${err.message}`);
        if (previous) onLine(`Reverted the configured version to ${previous}.`);
        throw err;
    }
}
