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
 * manifest (and a summary, kachat-domains.json) into conf/names for the names servers.
 *
 * The tool itself has no long-running container and no port: every action is a
 * `docker run --rm`. Updating it is how a redeployed registry reaches the names servers, with
 * no Kaspa Quick Start commit per deployment.
 */
export const REPO = 'KaspaSilver/kachat-domains';
export const SUMMARY_FILE = 'kachat-domains.json';
const REVISION_LABEL = 'org.opencontainers.image.revision';

export const ref = () => (readEnvFile().KACHAT_DOMAINS_REF || 'main').trim();
export const imageTag = () => `kaspa-one-click/kachat-domains:${ref()}`;

/**
 * .kachat Domains on one network is two things: the shared tool image above (verifies and
 * publishes the manifest), and that network's own names server -- a Postgres plus the
 * KaChat-Indexer `kachat-names` image (names follower, profiles follower, names-only API;
 * docs/KACHAT_NAMES_STANDALONE.md there). It needs the node and nothing else: no KaChat
 * Indexer. `compose` is the lifecycle shape of that server, `marker` the .env flag the proxy
 * reads to route the names paths on the indexer's name to it.
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
        envPush: 'KACHAT_NAMES_PUSH_URL_MAINNET',
        nodeUnit: 'node',
        indexerUnit: 'kachat',
        indexerHost: 'kachat-app',
        container: 'kaspa-node-kachat-names',
        host: 'kachat-names',
        label: 'mainnet',
        compose: {
            label: '.kachat Domains server',
            profile: 'kachat-names',
            services: ['kachat-names-db', 'kachat-names'],
            containers: ['kaspa-node-kachat-names', 'kaspa-node-kachat-names-db'],
            primary: 'kaspa-node-kachat-names',
            volumes: ['kaspa-node-kachat-names-db-data'],
            images: ['kaspa-one-click/kachat-names'],
            buildable: ['kachat-names'],
            data: 'the indexed .kachat registry and its Postgres database',
        },
    },
    testnet: {
        network: 'testnet-10',
        unit: 'kachat-domains-testnet',
        marker: 'KACHAT_DOMAINS_TESTNET',
        manifestFile: 'kachat-names-testnet-10.json',
        envManifest: 'KACHAT_NAMES_MANIFEST_TESTNET',
        envPush: 'KACHAT_NAMES_PUSH_URL_TESTNET',
        nodeUnit: 'node-testnet',
        indexerUnit: 'kachat-testnet',
        indexerHost: 'kachat-app-testnet',
        container: 'kaspa-node-kachat-names-testnet',
        host: 'kachat-names-testnet',
        label: 'testnet',
        compose: {
            label: '.kachat Domains server (testnet-10)',
            profile: 'testnet-kachat-names',
            services: ['kachat-names-db-testnet', 'kachat-names-testnet'],
            containers: ['kaspa-node-kachat-names-testnet', 'kaspa-node-kachat-names-db-testnet'],
            primary: 'kaspa-node-kachat-names-testnet',
            volumes: ['kaspa-node-kachat-names-db-testnet-data'],
            images: ['kaspa-one-click/kachat-names-testnet'],
            buildable: ['kachat-names-testnet'],
            data: 'the indexed testnet .kachat registry and its Postgres database',
        },
    },
};
export const netOf = (v) => (v === 'testnet' ? 'testnet' : 'mainnet');

/** Whether the proxy should send this network's names paths to its .kachat Domains server. */
export const routed = (net) => readEnvFile()[NETWORKS[net].marker] === '1';

/** The network's server is set to follow the manifest this tool published for it. */
export const manifestSet = (net) =>
    (readEnvFile()[NETWORKS[net].envManifest] || '').trim() === `/names/${NETWORKS[net].manifestFile}` && Boolean(summaryFor(net));

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

/** Each network's own verify summary, written by `publish` (kachat-domains docs/KQS.md §5). */
export const summaryFile = (net) => `kachat-domains-${NETWORKS[net].network}.json`;

/**
 * The verified summary for one network, or null when the tool has published nothing for it.
 * `publish` writes one per network (`kachat-domains-<network>.json`); images from before that
 * wrote only `kachat-domains.json` (testnet-10), which is still read as the fallback. A summary
 * counts only while the manifest it describes is there.
 */
export function summaryFor(net) {
    const want = NETWORKS[net].network;
    const hasManifest = fs.existsSync(path.join(NAMES_DIR, NETWORKS[net].manifestFile));
    let own = null;
    try {
        own = JSON.parse(fs.readFileSync(path.join(NAMES_DIR, summaryFile(net)), 'utf8'));
    } catch {
        /* not written by this image, or not deployed on this network */
    }
    if (own?.ok && own.network === want) return hasManifest ? own : null;
    const s = summary();
    if (!s || s.network !== want) return null;
    return hasManifest ? s : null;
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
    onLine('Verifying each network\'s manifest against the contract source, then publishing it.');
    try {
        await docker(['run', '--rm', '-v', `${hostPath('conf', 'names')}:/names`, imageTag(), 'publish', '/names'], {
            onLine,
            timeoutMs: 10 * 60_000,
        });
    } catch (err) {
        // `publish` verifies each network on its own: one that fails gets nothing written and
        // keeps its previous verified manifest, while the others are still published, and
        // the exit is 1 (docs/KQS.md §5). Only nothing verified anywhere is a failure here.
        if (!Object.keys(NETWORKS).some((n) => summaryFor(n))) throw err;
        onLine(`A network failed verification and keeps its previous manifest: ${err.message}`);
    }
    if (!Object.keys(NETWORKS).some((n) => summaryFor(n))) throw new Error('publish finished but wrote no verified summary.');
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
