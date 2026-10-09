import fs from 'node:fs';
import path from 'node:path';

import { docker } from './dockerctl.js';
import { hostPath, NAMES_DIR } from './paths.js';
import { readEnvFile } from './store.js';

/**
 * ".kachat domains" as an installable tool (kachat-domains docs/KQS.md).
 *
 * KaspaSilver/kachat-domains publishes a Docker image holding the registry's contracts, params,
 * compiled artifacts and deployed manifests, plus a `publish` command that recompiles the
 * contracts, refuses any manifest that does not match them, and only then writes the verified
 * manifest (and a summary, kachat-domains.json) into conf/names for the testnet indexer.
 *
 * It is a tool, not a service: no long-running container and no port. Every action is a
 * `docker run --rm`. Updating it is how a redeployed registry reaches the indexer, with no
 * Kaspa Quick Start commit per deployment.
 */
export const REPO = 'KaspaSilver/kachat-domains';
export const SUMMARY_FILE = 'kachat-domains.json';

/**
 * One tool image serves both networks; each network installs and switches on its own.
 * `unit` is the lifecycle key, `marker` the .env flag that records the install (the image is
 * shared, so it cannot be the record), and the rest is that network's indexer.
 *
 * Mainnet has no registry yet: `publish` only writes the testnet-10 manifest today. When
 * kachat-domains publishes `kachat-names-mainnet.json` (docs/KQS.md, "Network switch"), the
 * mainnet switch starts working with no change here.
 */
export const NETWORKS = {
    mainnet: {
        network: 'mainnet',
        unit: 'kachat-domains',
        marker: 'KACHAT_DOMAINS_MAINNET',
        manifestFile: 'kachat-names-mainnet.json',
        envManifest: 'KACHAT_NAMES_MANIFEST_MAINNET',
        indexerUnit: 'kachat',
        container: 'kaspa-node-kachat',
        host: 'kachat-app',
        label: 'mainnet',
    },
    testnet: {
        network: 'testnet-10',
        unit: 'kachat-domains-testnet',
        marker: 'KACHAT_DOMAINS_TESTNET',
        manifestFile: 'kachat-names-testnet-10.json',
        envManifest: 'KACHAT_NAMES_MANIFEST_TESTNET',
        indexerUnit: 'kachat-testnet',
        container: 'kaspa-node-kachat-testnet',
        host: 'kachat-app-testnet',
        label: 'testnet',
    },
};
export const netOf = (v) => (v === 'testnet' ? 'testnet' : 'mainnet');

/**
 * Whether this network has .kachat Domains installed. The testnet install predates the
 * marker, so a testnet with the image and no marker at all counts as installed.
 */
export function installedFor(net, revision) {
    if (revision === null) return false;
    const v = readEnvFile()[NETWORKS[net].marker];
    return net === 'testnet' ? v !== '0' : v === '1';
}

/** The network's indexer follows the manifest this tool published for it. */
export const onFor = (net) =>
    (readEnvFile()[NETWORKS[net].envManifest] || '').trim() === `/names/${NETWORKS[net].manifestFile}` && Boolean(summaryFor(net));
const REVISION_LABEL = 'org.opencontainers.image.revision';

export const ref = () => (readEnvFile().KACHAT_DOMAINS_REF || 'main').trim();
export const imageTag = () => `kaspa-one-click/kachat-domains:${ref()}`;

/** The commit the installed image was built from, or null when it is not installed. */
export async function installedRevision() {
    try {
        const { stdout } = await docker(['image', 'inspect', '-f', `{{index .Config.Labels "${REVISION_LABEL}"}}`, imageTag()], {
            timeoutMs: 15_000,
        });
        const sha = stdout.trim();
        return sha && sha !== '<no value>' ? sha : 'unknown';
    } catch {
        return null;
    }
}

/** The last verify summary `publish` wrote (conf/names/kachat-domains.json), or null. */
export function summary() {
    try {
        return JSON.parse(fs.readFileSync(path.join(NAMES_DIR, SUMMARY_FILE), 'utf8'));
    } catch {
        return null;
    }
}

/**
 * The verified summary for one network, or null when the tool has published nothing for it.
 * Today's summary covers one network (`network`); a later one may list several under
 * `networks` (an array or an object keyed by network), and both shapes are read.
 */
export function summaryFor(net) {
    const want = NETWORKS[net].network;
    const s = summary();
    if (!s) return null;
    if (s.networks) {
        const list = Array.isArray(s.networks) ? s.networks : Object.entries(s.networks).map(([k, v]) => ({ network: k, ...v }));
        const hit = list.find((n) => n?.network === want);
        return hit ? { ok: s.ok, commit: s.commit, ...hit } : null;
    }
    if (s.network !== want) return null;
    return fs.existsSync(path.join(NAMES_DIR, NETWORKS[net].manifestFile)) ? s : null;
}

/**
 * Build the image from GitHub at `sha` (the commit the update check found), labelled with it.
 * The first build compiles the CLI's Rust dependencies and is slow (15+ minutes on a small
 * server); later ones reuse BuildKit's cache.
 */
export async function build(sha, onLine) {
    onLine(`Building ${imageTag()} from ${REPO}@${ref()} (${sha.slice(0, 12)}). The first build compiles the contracts' tooling and can take 15 minutes or more.`);
    await docker(
        [
            'build',
            '--pull',
            '-t',
            imageTag(),
            '--build-arg',
            `KACHAT_DOMAINS_COMMIT=${sha}`,
            `https://github.com/${REPO}.git#${sha}`,
        ],
        { onLine, timeoutMs: 120 * 60_000, env: { DOCKER_BUILDKIT: '1' } },
    );
}

/**
 * Verify, then publish the manifest into conf/names. `publish` writes nothing unless the
 * manifest matches the contracts (atomic temp + rename), so a failure leaves the previous,
 * still-verified manifest in place. Returns the new summary.
 */
export async function publish(onLine) {
    fs.mkdirSync(NAMES_DIR, { recursive: true });
    onLine('Verifying the manifest against the contract source, then publishing it.');
    await docker(['run', '--rm', '-v', `${hostPath('conf', 'names')}:/names`, imageTag(), 'publish', '/names'], {
        onLine,
        timeoutMs: 10 * 60_000,
    });
    const s = summary();
    if (!s?.ok) throw new Error('publish finished but wrote no verified summary.');
    return s;
}

/** One line naming what a summary verified. */
export const describe = (s) => `registry v${s.registryVersion} ${s.registryCovenantId} on ${s.network}`;

/** Whether a new summary changes what the indexer follows (only then restart it). */
export const registryChanged = (before, after) =>
    !before || before.registryCovenantId !== after.registryCovenantId || before.manifestSha256 !== after.manifestSha256;

/** Remove the tool's image. The published manifest stays, so the indexer keeps following it. */
export async function removeImage(onLine) {
    await docker(['image', 'rm', imageTag()], { onLine, timeoutMs: 60_000 }).catch((e) => onLine(`  not removed: ${e.message}`));
}
