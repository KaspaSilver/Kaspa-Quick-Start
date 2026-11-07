import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { CONF_DIR, STACK_LOCAL, hostPath } from './paths.js';
import { docker } from './dockerctl.js';

/**
 * KasSigner: an air-gapped signing device, not a service.
 *
 * Everything else in this stack is a container that runs. This is a tool that
 * writes firmware to a board over USB and then gets out of the way, so there is
 * nothing here to keep running and nothing to expose. "Switched on" means the
 * firmware has been fetched and checked, so a device can be set up offline
 * afterwards.
 *
 * The device holds keys. That shapes two decisions:
 *
 *   - only signed production images are offered. The unsigned set exists so a
 *     build can be reproduced and compared, which is not what flashing is for.
 *   - a download is never written to a board until its SHA-256 matches the hash
 *     the release notes publish. No hash, no flash, with no way to skip it from
 *     the panel.
 */

export const REPO = 'InKasWeRust/KasSigner';
const API = `https://api.github.com/repos/${REPO}`;
const ghHeaders = { Accept: 'application/vnd.github+json', 'User-Agent': 'kaspa-one-click-panel' };

export const STATE_FILE = path.join(CONF_DIR, 'kassigner.json');
export const FIRMWARE_DIR = path.join(CONF_DIR, 'kassigner-firmware');

/**
 * The boards the firmware is built for. Waveshare ships with two camera modules
 * and the autofocus one is mounted flipped, so it needs its own image; it is a
 * variant of the same board rather than a third board.
 */
// Order matters: this is the order the cards appear in.
export const BOARDS = {
    m5stack: {
        // Named for what the shop sells, since that is what somebody matches
        // against the board in front of them. The firmware target and the
        // release assets still call it CoreS3 Lite.
        label: 'M5Stack CoreS3 SE',
        blurb: 'Built as CoreS3 Lite in the firmware. Its reset button doubles as the BOOT button when reflashing.',
        asset: 'm5stack',
        hashKey: 'M5Stack',
        buy: {
            url: 'https://shop.m5stack.com/products/m5stack-cores3-se-iot-controller-w-o-battery-bottom',
            label: 'M5Stack store',
        },
    },
    // The same Waveshare board twice, because the camera module decides the
    // image. The autofocus one is mounted flipped and needs its own build, so
    // guessing between them would leave somebody with an upside-down scanner on
    // a device whose whole job is reading QR codes.
    waveshare: {
        label: 'Waveshare ESP32-S3-Touch-LCD-2',
        blurb: 'A 2 inch touch screen. Pick this one for the standard camera module.',
        asset: 'waveshare',
        hashKey: 'Waveshare',
        buy: { url: 'https://www.waveshare.com/esp32-s3-touch-lcd-2.htm', label: 'Waveshare store' },
    },
    'waveshare-af': {
        label: 'Waveshare, autofocus camera',
        blurb: 'The same board with the autofocus module. It is mounted the other way up, so it gets its own firmware.',
        asset: 'waveshare-af',
        hashKey: 'Waveshare-AF',
        buy: { url: 'https://www.waveshare.com/esp32-s3-touch-lcd-2.htm', label: 'Waveshare store' },
    },
};

/** Which image, and where it is written. Straight from the project's README. */
export const IMAGES = {
    // A blank or unknown board gets the lot: bootloader, partition table, app.
    full: { suffix: '-full', offset: '0x0', label: 'complete firmware' },
    // An already-set-up board only needs the application replaced.
    app: { suffix: '', offset: '0x10000', label: 'application only' },
};

const readState = () => {
    try {
        return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch {
        return { enabled: false, release: null, verifiedAt: null, images: {} };
    }
};
const writeState = (s) => {
    fs.mkdirSync(CONF_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE, `${JSON.stringify(s, null, 2)}\n`);
};

export const loadState = readState;

// ------------------------------------------------------------- upstream ----

/**
 * Pulls the published SHA-256 table out of a release's notes.
 *
 * The notes group the twelve hashes under Signed/Unsigned and then App-only/
 * Full-flash, with one board per line. Nothing machine readable is published
 * alongside them, so the table is read as it is written.
 */
export function parseHashes(body) {
    const out = {};
    let signed = null;
    let kind = null;

    for (const raw of String(body || '').split('\n')) {
        const line = raw.trim();
        if (/^\*\*Signed\*\*/i.test(line)) signed = true;
        else if (/^\*\*Unsigned\*\*/i.test(line)) signed = false;
        else if (/^App-only/i.test(line)) kind = 'app';
        else if (/^Full-flash/i.test(line)) kind = 'full';

        const m = /^([A-Za-z0-9-]+):\s+([0-9a-f]{64})$/.exec(line);
        if (m && signed !== null && kind) {
            out[`${signed ? 'signed' : 'unsigned'}:${kind}:${m[1]}`] = m[2];
        }
    }
    return out;
}

let releaseCache = { at: 0, value: null };
const RELEASE_CACHE_MS = 10 * 60_000;

export async function listReleases({ force = false } = {}) {
    if (!force && releaseCache.value && Date.now() - releaseCache.at < RELEASE_CACHE_MS) return releaseCache.value;

    const res = await fetch(`${API}/releases?per_page=20`, { headers: ghHeaders, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) {
        throw new Error(`GitHub returned ${res.status}${res.status === 403 ? ' (rate limit, try again shortly)' : ''}`);
    }
    const value = (await res.json())
        .filter((r) => !r.draft)
        .map((r) => ({
            tag: r.tag_name,
            prerelease: Boolean(r.prerelease),
            publishedAt: r.published_at,
            hashes: parseHashes(r.body),
            assets: Object.fromEntries(r.assets.map((a) => [a.name, a.browser_download_url])),
        }));

    releaseCache = { at: Date.now(), value };
    return value;
}

export async function findRelease(tag) {
    const releases = await listReleases();
    const wanted = tag ? releases.find((r) => r.tag === tag) : releases.find((r) => !r.prerelease) ?? releases[0];
    if (!wanted) throw new Error(`No KasSigner release found${tag ? ` for ${tag}` : ''}.`);
    return wanted;
}

// ------------------------------------------------------------- firmware ----

const assetName = (board, image) => `kassigner-${board}${IMAGES[image].suffix}.bin`;
const localPath = (tag, board, image) => path.join(FIRMWARE_DIR, tag, assetName(board, image));

const sha256 = (file) =>
    new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        fs.createReadStream(file)
            .on('data', (d) => hash.update(d))
            .on('end', () => resolve(hash.digest('hex')))
            .on('error', reject);
    });

/**
 * Fetches one image and checks it against the published hash.
 *
 * A file that does not match is deleted rather than kept: leaving it on disk
 * invites a later run from finding it, assuming it is fine because it is there,
 * and writing it to a device that holds keys.
 */
export async function fetchImage(release, boardAsset, image, hashKey, onLine = () => {}) {
    const expected = release.hashes[`signed:${image}:${hashKey}`];
    if (!expected) {
        throw new Error(`${release.tag} does not publish a hash for the signed ${image} image, so it will not be used.`);
    }

    const file = localPath(release.tag, boardAsset, image);
    if (fs.existsSync(file) && (await sha256(file)) === expected) {
        onLine(`${path.basename(file)} already here and verified.`);
        return { file, sha256: expected, cached: true };
    }

    const url = release.assets[assetName(boardAsset, image)];
    if (!url) throw new Error(`${release.tag} has no ${assetName(boardAsset, image)}.`);

    onLine(`Downloading ${assetName(boardAsset, image)}...`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const res = await fetch(url, { headers: { 'User-Agent': ghHeaders['User-Agent'] }, signal: AbortSignal.timeout(300_000) });
    if (!res.ok) throw new Error(`Download failed with ${res.status}.`);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));

    const actual = await sha256(file);
    if (actual !== expected) {
        fs.unlinkSync(file);
        throw new Error(
            `${assetName(boardAsset, image)} does not match the hash in the release notes. Expected ${expected.slice(0, 16)}…, ` +
                `got ${actual.slice(0, 16)}…. The file has been deleted and nothing was written to any device.`,
        );
    }
    onLine(`${path.basename(file)} verified against the release notes.`);
    return { file, sha256: actual, cached: false };
}

/** Fetches and verifies every image for every board, which is what "on" means. */
export async function prepare(tag, onLine = () => {}) {
    const release = await findRelease(tag);
    onLine(`KasSigner ${release.tag}, published ${new Date(release.publishedAt).toLocaleDateString()}.`);

    const targets = [];
    for (const board of Object.values(BOARDS)) {
        targets.push({ asset: board.asset, hashKey: board.hashKey });
    }

    const images = {};
    for (const t of targets) {
        for (const image of Object.keys(IMAGES)) {
            const r = await fetchImage(release, t.asset, image, t.hashKey, onLine);
            images[`${t.asset}:${image}`] = { sha256: r.sha256, file: r.file };
        }
    }

    const state = { ...readState(), enabled: true, release: release.tag, verifiedAt: new Date().toISOString(), images };
    writeState(state);
    onLine(`All ${Object.keys(images).length} images verified. A device can be set up now.`);
    return state;
}

/**
 * Re-checks every firmware file on disk against the hashes GitHub publishes.
 *
 * The hashes are fetched again rather than read back out of kassigner.json. A
 * file and a hash written at the same moment agree with each other by
 * construction, so comparing those two proves only that the disk has not
 * rotted. Asking GitHub again is what makes this a check: it catches a file
 * altered since it was fetched, and a release re-cut under the same tag.
 *
 * What it establishes is narrow and worth stating plainly: that the bytes here
 * are the bytes this project published. Not that the firmware is good. The
 * unsigned images exist for that -- they are what a build from source is
 * compared against -- and their hashes are printed here for anyone doing it.
 */
export async function verify(tag = null, onLine = () => {}) {
    const state = readState();
    const wanted = tag ?? state.release;
    if (!wanted) throw new Error('No firmware has been fetched yet, so there is nothing to check.');

    onLine(`Asking GitHub for the release notes of ${wanted}, rather than trusting the copy here.`);
    await listReleases({ force: true });
    const release = await findRelease(wanted);
    onLine(`${release.tag}, published ${new Date(release.publishedAt).toLocaleDateString()}.`);
    onLine('');

    const results = [];
    for (const board of Object.values(BOARDS)) {
        for (const image of Object.keys(IMAGES)) {
            const name = assetName(board.asset, image);
            const file = localPath(release.tag, board.asset, image);
            const expected = release.hashes[`signed:${image}:${board.hashKey}`] ?? null;

            if (!expected) {
                onLine(`- ${name}: the release notes publish no hash for it. It would not be flashed.`);
                results.push({ name, status: 'no-hash' });
                continue;
            }
            if (!fs.existsSync(file)) {
                onLine(`- ${name}: not downloaded here.`);
                results.push({ name, status: 'missing', expected });
                continue;
            }

            const actual = await sha256(file);
            const ok = actual === expected;
            onLine(`${ok ? 'OK  ' : 'BAD '} ${name}`);
            onLine(`      published ${expected}`);
            onLine(`      on disk   ${actual}`);
            results.push({ name, status: ok ? 'ok' : 'mismatch', expected, actual });
        }
    }

    const checked = results.filter((r) => r.status === 'ok' || r.status === 'mismatch');
    const bad = results.filter((r) => r.status === 'mismatch');

    onLine('');
    if (bad.length) {
        onLine(`${bad.length} of ${checked.length} files do NOT match what ${release.tag} publishes.`);
        onLine('Do not flash a device from this machine until that is explained. Switching KasSigner');
        onLine('off and on again downloads them afresh.');
    } else if (checked.length) {
        onLine(`All ${checked.length} files match the hashes published for ${release.tag}.`);
    } else {
        onLine('Nothing to check: no firmware has been downloaded yet.');
    }

    // The reference for anyone reproducing the build themselves, which is the
    // only check that says anything about the source rather than the bytes.
    const unsigned = Object.entries(release.hashes).filter(([key]) => key.startsWith('unsigned:'));
    if (unsigned.length) {
        onLine('');
        onLine('The same release publishes unsigned hashes. Build the firmware from source at');
        onLine(`${REPO}@${release.tag} and compare against these -- that is what checks the code,`);
        onLine('where everything above only checks the download:');
        for (const [key, value] of unsigned) onLine(`  ${key.replace('unsigned:', '')}  ${value}`);
    }

    onLine('');
    onLine('This proves the bytes here are the bytes the project published. It does not');
    onLine('prove the firmware is good, and no hash can.');

    return { tag: release.tag, results, ok: bad.length === 0 && checked.length > 0 };
}

/**
 * Removes everything KasSigner has put on this machine.
 *
 * It is not a container, which is why it was missed when the other services got
 * an uninstall -- but "not a container" is not "nothing to remove". It leaves
 * tens of megabytes of firmware, a state file recording what was verified and
 * when, and an image built once for flashing over USB.
 */
export async function uninstall(onLine = () => {}) {
    const removed = { firmware: 0, bytes: 0, image: false };

    if (fs.existsSync(FIRMWARE_DIR)) {
        // Counted before deleting, so the log can say what went rather than
        // that something did.
        for (const release of fs.readdirSync(FIRMWARE_DIR)) {
            const dir = path.join(FIRMWARE_DIR, release);
            for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.bin'))) {
                removed.bytes += fs.statSync(path.join(dir, file)).size;
                removed.firmware += 1;
            }
        }
        fs.rmSync(FIRMWARE_DIR, { recursive: true, force: true });
        onLine(`Deleted ${removed.firmware} firmware file(s), ${(removed.bytes / 1e6).toFixed(0)} MB.`);
    } else {
        onLine('No firmware was downloaded.');
    }
    if (fs.existsSync(FACTORY_DIR)) {
        fs.rmSync(FACTORY_DIR, { recursive: true, force: true });
        onLine('Deleted the factory firmware kept for restoring a board.');
    }

    try {
        await docker(['image', 'rm', '-f', ESPTOOL_IMAGE], { timeoutMs: 60_000 });
        removed.image = true;
        onLine('Removed the flashing tool image.');
    } catch {
        onLine('The flashing tool image was not here.');
    }

    try {
        fs.rmSync(STATE_FILE, { force: true });
    } catch {
        /* nothing recorded */
    }
    onLine('KasSigner is back to how it was before it was set up.');

    // A device already flashed keeps working. Nothing here reaches it, and
    // somebody uninstalling the panel's copy of the firmware should not be left
    // wondering about the board in their hand.
    onLine('Any device you have already flashed is unaffected.');
    return removed;
}

export function disable() {
    writeState({ ...readState(), enabled: false });
}

// --------------------------------------------------------------- device ----

/**
 * Serial ports the host can see.
 *
 * The manager is in a container, so it cannot look at the host's devices
 * directly. Bind-mounting /dev into a throwaway container is how everything
 * else in here reaches the host, and it works for this too. /dev/serial/by-id
 * is what identifies a board: the symlink names carry the USB manufacturer and
 * product, so an ESP32-S3 announces itself without needing to parse sysfs,
 * which Docker overlays with its own anyway.
 */
export async function detectDevices() {
    try {
        const { stdout } = await docker(
            [
                'run',
                '--rm',
                '-v',
                '/dev:/dev:ro',
                'alpine:3.21',
                'sh',
                '-c',
                // `exit 0` at the end on purpose: with nothing plugged in both
                // globs fail and the shell would exit non-zero, turning "no
                // device yet" into an error when it is the expected state.
                'ls -l /dev/serial/by-id/ 2>/dev/null; echo "---"; ls /dev/ttyACM* /dev/ttyUSB* 2>/dev/null; exit 0',
            ],
            { timeoutMs: 30_000 },
        );

        const [byIdBlock, plainBlock] = stdout.split('---');
        const devices = new Map();

        for (const line of (byIdBlock || '').split('\n')) {
            // "usb-Espressif_USB_JTAG_serial_debug_unit_XX-if00 -> ../../ttyACM0"
            const m = /(\S+)\s+->\s+.*\/(tty\w+)/.exec(line);
            if (!m) continue;
            const id = m[1];
            devices.set(`/dev/${m[2]}`, {
                port: `/dev/${m[2]}`,
                id,
                // The board is inferred from what the USB descriptor says, which
                // is a hint for the UI, not something the flash depends on.
                looksLikeEsp32: /espressif|usb.?jtag|cp210|ch34|ch910|silicon.?labs/i.test(id),
            });
        }
        for (const line of (plainBlock || '').split('\n')) {
            const port = line.trim();
            if (port && !devices.has(port)) devices.set(port, { port, id: null, looksLikeEsp32: null });
        }

        return [...devices.values()];
    } catch (err) {
        throw new Error(`Could not look at the host's USB ports: ${err.message}`);
    }
}

// ---------------------------------------------------------------- flash ----

export const ESPTOOL_IMAGE = 'kaspa-one-click/esptool:1';

/** Builds the little esptool image, once. */
export async function ensureEsptool(onLine = () => {}) {
    try {
        await docker(['image', 'inspect', ESPTOOL_IMAGE], { timeoutMs: 30_000 });
        return;
    } catch {
        /* not built yet */
    }
    onLine('Building the flashing tool (once)...');
    // The build context is read by the docker CLI, which is in this container,
    // so it takes the local path. The volume mount below is resolved by the
    // daemon instead and has to be the host's. Mixing them up is the easiest
    // way to break this stack, which is why paths.js keeps them apart.
    await docker(['build', '-t', ESPTOOL_IMAGE, path.join(STACK_LOCAL, 'kassigner')], {
        onLine,
        timeoutMs: 15 * 60_000,
    });
}

const PORT_RE = /^\/dev\/tty(ACM|USB)\d+$/;

/**
 * Writes an image to a board.
 *
 * The port is checked against a strict pattern before it reaches a command
 * line: it arrives from a browser, and everything else here treats it as
 * untrusted. The image is re-hashed immediately beforehand, so a file that
 * changed after it was verified cannot be written.
 */
export async function flash({ port, board, image = 'full', onLine = () => {} }) {
    if (!PORT_RE.test(port)) throw new Error(`"${port}" is not a serial port this can write to.`);

    const state = readState();
    const entry = state.images?.[`${board}:${image}`];
    if (!entry) throw new Error('That firmware has not been downloaded yet. Switch KasSigner on first.');

    const actual = await sha256(entry.file);
    if (actual !== entry.sha256) {
        throw new Error('The firmware on disk no longer matches the hash it was verified against. Nothing was written.');
    }

    await ensureEsptool(onLine);

    const { offset, label } = IMAGES[image];
    onLine(`Writing the ${label} for ${board} to ${port} at ${offset}.`);
    onLine(`SHA-256 ${actual}`);

    await docker(
        [
            'run',
            '--rm',
            '--device',
            `${port}:${port}`,
            '-v',
            `${hostPath('conf/kassigner-firmware')}:/fw:ro`,
            ESPTOOL_IMAGE,
            // `python -m esptool`, which is how the project's own README
            // invokes it. The package installs `esptool.py`, not `esptool`.
            'python',
            '-m',
            'esptool',
            '--chip',
            'esp32s3',
            '--port',
            port,
            '--baud',
            '460800',
            'write_flash',
            offset,
            `/fw/${path.relative(FIRMWARE_DIR, entry.file)}`,
        ],
        { onLine, timeoutMs: 20 * 60_000 },
    );

    onLine('Done. The board reboots into the firmware on its own.');
    onLine('A released build closes its USB port a second or two after booting. That is the firmware working, not a failed write.');
    return { ok: true, port, board, image, sha256: actual };
}

// -------------------------------------------------------------- factory ----

/**
 * The software a board came with, for putting it back the way it was bought.
 *
 * M5Stack publishes its factory demo through M5Burner, whose catalogue gives a
 * download and no hash. So the file is pinned here with the SHA-256 it had when
 * this was added, and the same rule as the KasSigner images applies: no match,
 * nothing written. If M5Stack replaces the file, restoring stops until someone
 * has looked at the new one, which is the right failure for a tool that erases
 * a board.
 *
 * Only the M5Stack board so far. Waveshare does not publish its factory image
 * anywhere a hash could be pinned against.
 */
export const FACTORY = {
    m5stack: {
        label: 'M5Stack CoreS3 SE',
        name: 'CoreS3SE UserDemo v0.6',
        publisher: 'M5Stack, through M5Burner',
        publishedAt: '2024-05-24',
        url: 'https://m5burner-cdn.m5stack.com/firmware/fed93812db65b5347b706d1f237021b9.bin',
        file: 'm5stack-cores3se-userdemo-v0.6.bin',
        sha256: 'c6990a38bd3c42ab85ad77d377ebf47118b43a126c7623022e102f9f4d60063a',
    },
};

// Beside the KasSigner firmware rather than in it: a firmware folder with
// anything in it is what counts as KasSigner being installed (lifecycle.js), and
// fetching this to get rid of KasSigner should not install it.
const FACTORY_DIR = path.join(CONF_DIR, 'kassigner-factory');

async function fetchFactory(image, onLine) {
    const file = path.join(FACTORY_DIR, image.file);
    if (fs.existsSync(file) && (await sha256(file)) === image.sha256) {
        onLine(`${image.file} already here and verified.`);
        return file;
    }

    onLine(`Downloading ${image.name} from ${image.publisher}...`);
    fs.mkdirSync(FACTORY_DIR, { recursive: true });
    const res = await fetch(image.url, { headers: { 'User-Agent': ghHeaders['User-Agent'] }, signal: AbortSignal.timeout(300_000) });
    if (!res.ok) throw new Error(`Download failed with ${res.status}.`);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));

    const actual = await sha256(file);
    if (actual !== image.sha256) {
        fs.unlinkSync(file);
        throw new Error(
            `${image.name} does not match the hash pinned for it. Expected ${image.sha256.slice(0, 16)}…, got ${actual.slice(0, 16)}…. ` +
                'The file has been deleted and nothing was written to any device.',
        );
    }
    onLine(`${image.file} verified.`);
    return file;
}

/**
 * Erases the whole board and writes the factory image back.
 *
 * Erasing everything rather than writing over the top, so nothing of KasSigner
 * is left behind in a partition the factory layout does not use.
 *
 * A board someone has run the KasSigner eFuse runbook on cannot go back: Secure
 * Boot is burned in for good and the factory image is not signed with their
 * key, so it would never start. So the board's security state is read first,
 * which changes nothing, and the erase only happens if it is clear. esptool's
 * own refusal (no --force is ever passed) stays behind that as a second guard,
 * but it is skipped in Secure Download Mode, which is why it is not the only one.
 */
export async function restoreFactory({ port, board, onLine = () => {} }) {
    if (!PORT_RE.test(port)) throw new Error(`"${port}" is not a serial port this can write to.`);
    const image = FACTORY[board];
    if (!image) throw new Error('There is no factory firmware for that board here.');

    const file = await fetchFactory(image, onLine);
    // Again, right before writing, as flash() does.
    if ((await sha256(file)) !== image.sha256) {
        throw new Error('The factory firmware on disk no longer matches its hash. Nothing was written.');
    }

    await ensureEsptool(onLine);

    const esptool = (args) => [
        'run',
        '--rm',
        '--device',
        `${port}:${port}`,
        '-v',
        `${hostPath('conf/kassigner-factory')}:/fw:ro`,
        ESPTOOL_IMAGE,
        'python',
        '-m',
        'esptool',
        '--chip',
        'esp32s3',
        '--port',
        port,
        ...args,
    ];

    onLine(`Reading the security settings on ${port}. This changes nothing.`);
    // --after no_reset leaves it in download mode for the write. Reset, a
    // released KasSigner would boot and close its USB port again.
    const { stdout } = await docker(esptool(['--after', 'no_reset', 'get_security_info']), { onLine, timeoutMs: 2 * 60_000 });
    const locked = [
        [/Secure Download Mode/i, 'Secure Download Mode'],
        [/Secure Boot: Enabled/i, 'Secure Boot'],
        [/Flash Encryption: Enabled/i, 'flash encryption'],
    ].filter(([re]) => re.test(stdout)).map(([, name]) => name);
    if (locked.length) {
        throw new Error(
            `This board has ${locked.join(' and ')} burned into its eFuses, from the KasSigner eFuse runbook. eFuses ` +
                'cannot be undone and the factory firmware is not signed with your key, so it would never start. ' +
                'Nothing was erased. This board can only run firmware signed with that key from now on.',
        );
    }
    if (!/Secure Boot: Disabled/i.test(stdout)) {
        throw new Error('Could not read the security settings on this board, so it was left alone. Nothing was erased.');
    }
    onLine('No Secure Boot or flash encryption. Safe to restore.');
    onLine('');

    onLine(`Erasing ${port} and writing ${image.name} for the ${image.label} at 0x0.`);
    onLine(`SHA-256 ${image.sha256}`);

    let securityRefused = false;
    try {
        await docker(esptool(['--baud', '460800', 'write_flash', '--erase-all', '0x0', `/fw/${image.file}`]), {
            onLine: (line) => {
                if (/Active security features detected|Secure Boot detected/.test(line)) securityRefused = true;
                onLine(line);
            },
            timeoutMs: 20 * 60_000,
        });
    } catch (err) {
        if (securityRefused) {
            throw new Error('esptool found security features on this board and refused to erase it. Nothing was erased.');
        }
        throw err;
    }

    onLine(`Done. The board restarts into ${image.name}, as it came from ${image.label.split(' ')[0]}.`);
    onLine('Nothing of KasSigner is left on it.');
    return { ok: true, port, board, sha256: image.sha256 };
}
