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
export const MANIFEST_FILE = 'kachat-names-testnet-10.json';
export const SUMMARY_FILE = 'kachat-domains.json';
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

/** Whether a new summary changes what the indexer follows (only then restart it). */
export const registryChanged = (before, after) =>
    !before || before.registryCovenantId !== after.registryCovenantId || before.manifestSha256 !== after.manifestSha256;

/** Remove the tool's image. The published manifest stays, so the indexer keeps following it. */
export async function removeImage(onLine) {
    await docker(['image', 'rm', imageTag()], { onLine, timeoutMs: 60_000 }).catch((e) => onLine(`  not removed: ${e.message}`));
}
