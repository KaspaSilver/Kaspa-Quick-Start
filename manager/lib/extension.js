import fs from 'node:fs';
import path from 'node:path';
import { CONF_DIR, hostPath } from './paths.js';
import { docker } from './dockerctl.js';

/**
 * The KaPay browser extension (KaChat's wallet for Chrome, Brave, Edge and Firefox).
 *
 * Nothing runs here. Installing it builds the extension from its repository the way its
 * README does (`npm run package`) in a throwaway Node container, and leaves the result on
 * this machine: an unpacked folder per browser, which developer mode loads as it is ("Load
 * unpacked" in Chrome or Brave), and the same folders zipped for loading it on another
 * computer. A build that fails leaves the previous one in place.
 */

export const REPO = 'KaspaSilver/KaPay-Browser-Extension';
export const REF = 'main';
const BUILD_IMAGE = 'node:22-alpine';

export const DIR = path.join(CONF_DIR, 'kapay-extension');
const CURRENT = path.join(DIR, 'current');
const NEXT = path.join(DIR, 'next');
const BUILD_FILE = path.join(CURRENT, 'build.json');

/** The two builds, by the name the download route takes. */
export const TARGETS = {
    chromium: { folder: 'chromium', label: 'Chrome, Brave and Edge' },
    firefox: { folder: 'firefox', label: 'Firefox' },
};

export const isInstalled = () => fs.existsSync(path.join(CURRENT, 'chromium', 'manifest.json'));

/** What was built and when, or null before the first build. */
export function buildInfo() {
    if (!isInstalled()) return null;
    let build = {};
    try {
        build = JSON.parse(fs.readFileSync(BUILD_FILE, 'utf8'));
    } catch {
        /* built, but the record is missing: show what the manifest says */
    }
    let version = build.version ?? null;
    if (!version) {
        try {
            version = JSON.parse(fs.readFileSync(path.join(CURRENT, 'chromium', 'manifest.json'), 'utf8')).version ?? null;
        } catch {
            /* leave it unknown */
        }
    }
    return {
        version,
        sha: build.sha ?? null,
        ref: build.ref ?? REF,
        builtAt: build.builtAt ?? null,
        // Where "Load unpacked" finds each build when the browser is on this machine. The host's
        // path, not this container's: it is the browser on the host that opens it.
        folders: Object.fromEntries(Object.entries(TARGETS).map(([key, t]) => [key, hostPath('conf', 'kapay-extension', 'current', t.folder)])),
    };
}

/** The zip of one build, for the download route; null when there is none. */
export function packageFile(target) {
    const t = TARGETS[target];
    if (!t || !isInstalled()) return null;
    const dir = path.join(CURRENT, 'packages');
    const name = fs.existsSync(dir) ? fs.readdirSync(dir).find((f) => f.endsWith(`-${target}.zip`)) : null;
    return name ? { file: path.join(dir, name), name } : null;
}

// Runs inside the build container. /out is conf/kapay-extension on the host; the build lands in
// /out/next and is only swapped in by build() once it is complete.
const BUILD_SCRIPT = `set -e
apk add --no-cache git zip >/dev/null
echo "Fetching $REPO ($REF)..."
git clone --quiet --depth 1 --branch "$REF" "https://github.com/$REPO.git" /src
cd /src
echo "Commit $(git rev-parse --short HEAD): $(git log -1 --format=%s)"
echo "Installing its dependencies..."
npm ci --no-audit --no-fund
echo "Building..."
npm run package
rm -rf /out/next
mkdir -p /out/next
cp -r dist /out/next/chromium
cp -r dist-firefox /out/next/firefox
cp -r packages /out/next/packages
git rev-parse HEAD > /out/next/commit
chown -R "$(stat -c %u:%g /out)" /out/next
`;

/** Builds the extension from REPO at REF and swaps it in; the previous build stays on failure. */
export async function build(onLine = () => {}) {
    fs.mkdirSync(DIR, { recursive: true });
    fs.rmSync(NEXT, { recursive: true, force: true });
    await docker(
        ['run', '--rm', '-e', `REPO=${REPO}`, '-e', `REF=${REF}`, '-v', `${hostPath('conf', 'kapay-extension')}:/out`, BUILD_IMAGE, 'sh', '-c', BUILD_SCRIPT],
        { onLine, timeoutMs: 15 * 60_000 },
    );
    if (!fs.existsSync(path.join(NEXT, 'chromium', 'manifest.json'))) {
        throw new Error('The build finished without an extension in it; the previous build is kept.');
    }
    const sha = fs.readFileSync(path.join(NEXT, 'commit'), 'utf8').trim();
    const { version } = JSON.parse(fs.readFileSync(path.join(NEXT, 'chromium', 'manifest.json'), 'utf8'));
    fs.writeFileSync(path.join(NEXT, 'build.json'), `${JSON.stringify({ sha, ref: REF, version, builtAt: new Date().toISOString() }, null, 2)}\n`);
    fs.rmSync(CURRENT, { recursive: true, force: true });
    fs.renameSync(NEXT, CURRENT);
    onLine(`KaPay Extension ${version} built from ${sha.slice(0, 12)}.`);
    onLine('If it is already loaded in your browser, press its reload button on the extensions page to pick this up.');
}

/** Removes every build from this machine. A browser that loaded it keeps its own copy until removed there. */
export function uninstall(onLine = () => {}) {
    fs.rmSync(DIR, { recursive: true, force: true });
    onLine('The KaPay Extension builds are removed from this machine. Remove it from your browser on its extensions page.');
}
