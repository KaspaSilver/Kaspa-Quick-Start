import fs from 'node:fs';
import { compose, docker, containerState } from './dockerctl.js';
import { FIRMWARE_DIR, uninstall as uninstallKassigner } from './kassigner.js';

/**
 * Install, start, stop, uninstall -- for everything in the stack that is a
 * container somebody switches on.
 *
 * The switch used to mean two different things at once. Turning an app off
 * removed its containers, so "off" and "never installed" were the same state
 * and the difference between pausing something and throwing it away came down
 * to which toggle you happened to flip. An hour of building was one careless
 * click from gone.
 *
 * Three states now, and they are separate on purpose:
 *
 *   not installed   nothing built, nothing to run. Install builds it.
 *   installed       the container exists. The switch starts and stops it, and
 *                   stopping keeps everything: the container, its data, the
 *                   image it took an hour to build.
 *   uninstalled     asked for explicitly, on its own tab, and it takes the data
 *                   with it. Nothing else in here removes a volume.
 */

/**
 * What each service is made of. Volumes are listed by their real docker names
 * rather than their compose keys, because that is what has to be removed and
 * getting it wrong deletes somebody else's data.
 */
export const UNITS = {
    kachat: {
        label: 'KaChat-Indexer',
        profile: 'kachat',
        services: ['kachat-db', 'kachat-app'],
        containers: ['kaspa-node-kachat', 'kaspa-node-kachat-db'],
        // The container that decides whether this is installed. A dependency
        // being absent is a broken install; this one being absent is no install.
        primary: 'kaspa-node-kachat',
        volumes: ['kaspa-node-kachat-db-data', 'kaspa-node-kachat-app-data'],
        images: ['kaspa-one-click/kachat'],
        buildable: ['kachat-app'],
        data: 'the indexed chat history and the Postgres database',
    },
    desktop: {
        label: 'KaChat-Desktop',
        profile: 'kachat-desktop',
        services: ['kachat-desktop'],
        containers: ['kaspa-node-kachat-desktop'],
        primary: 'kaspa-node-kachat-desktop',
        volumes: [],
        images: ['kaspa-one-click/kachat-desktop'],
        buildable: ['kachat-desktop'],
        data: 'nothing: it keeps no state of its own',
    },
    nextcloud: {
        label: 'Nextcloud',
        profile: 'nextcloud',
        services: ['nextcloud-db', 'nextcloud-redis', 'nextcloud-imaginary', 'nextcloud'],
        containers: [
            'kaspa-node-nextcloud',
            'kaspa-node-nextcloud-db',
            'kaspa-node-nextcloud-redis',
            'kaspa-node-nextcloud-imaginary',
        ],
        primary: 'kaspa-node-nextcloud',
        volumes: ['kaspa-node-nextcloud-data', 'kaspa-node-nextcloud-db-data'],
        images: ['kaspa-one-click/nextcloud'],
        buildable: ['nextcloud'],
        data: 'every file, photo and calendar stored in it',
    },
    gift: {
        label: 'KaChat Gift Service',
        profile: 'gift',
        services: ['gift'],
        containers: ['kaspa-node-gift'],
        primary: 'kaspa-node-gift',
        volumes: ['kaspa-node-gift-data'],
        images: ['kaspa-one-click/gift'],
        buildable: ['gift'],
        data: 'the record of who has already claimed a gift',
    },
    mining: {
        label: 'Stratum bridge',
        profile: 'mining',
        services: ['bridge'],
        containers: ['kaspa-node-bridge'],
        primary: 'kaspa-node-bridge',
        volumes: ['kaspa-node-bridge-data'],
        images: ['kaspa-one-click/bridge'],
        buildable: ['bridge'],
        data: "the bridge's own share and block records",
    },
    proxy: {
        label: 'Reverse proxy',
        profile: 'proxy',
        services: ['proxy'],
        containers: ['kaspa-node-proxy'],
        primary: 'kaspa-node-proxy',
        volumes: [],
        // nginx is pulled, not built here, and is very likely in use by
        // something else on this machine. Never removed.
        images: [],
        buildable: [],
        data: 'nothing. Your domains and certificates live in the stack directory and are kept',
    },
};

/**
 * KasSigner is not a container, which is why it was missed when everything else
 * got an install and uninstall. It still puts tens of megabytes of firmware on
 * the machine, a record of what was verified, and an image built for flashing,
 * so it belongs here -- just without a container's states. `runnable: false`
 * says so: there is nothing to start or stop, and the sidebar leaves its own
 * switch alone.
 */
UNITS.kassigner = {
    label: 'KasSigner',
    runnable: false,
    data: 'the downloaded firmware and the record of what was verified',
    uninstall: uninstallKassigner,
};

export const unitFor = (key) => UNITS[key] ?? null;

/** Installed means the container exists, whether or not it is running. */
export async function status(key) {
    const unit = unitFor(key);
    if (!unit) return null;

    // Something with no container is installed when its files are here.
    if (unit.runnable === false) {
        const installed = fs.existsSync(FIRMWARE_DIR) && fs.readdirSync(FIRMWARE_DIR).length > 0;
        return { key, label: unit.label, runnable: false, installed, running: false, status: installed ? 'ready' : 'absent' };
    }

    const state = await containerState(unit.primary);
    return {
        key,
        label: unit.label,
        runnable: true,
        installed: state.exists,
        running: state.running,
        status: state.status,
        health: state.health,
    };
}

export async function statusAll() {
    return Object.fromEntries(await Promise.all(Object.keys(UNITS).map(async (key) => [key, await status(key)])));
}

/**
 * Builds the images and creates the containers. The long one: a first install
 * compiles from source for some of these.
 */
export async function install(key, onLine = () => {}) {
    const unit = unitFor(key);
    if (!unit) throw new Error(`No such service: ${key}`);

    if (unit.buildable.length) {
        onLine(`Building ${unit.label}. The first time can take a while.`);
        await compose(['build', ...unit.buildable], { onLine, profile: unit.profile, timeoutMs: 120 * 60_000 });
    }
    onLine(`Starting ${unit.label}.`);
    await compose(['up', '-d', ...unit.services], { onLine, profile: unit.profile, timeoutMs: 20 * 60_000 });
}

/**
 * Starts or stops. Never removes anything: a stopped service keeps its
 * container, its volumes and its image, and starting it again is immediate.
 */
export async function setRunning(key, running, onLine = () => {}) {
    const unit = unitFor(key);
    if (!unit) throw new Error(`No such service: ${key}`);

    if (running) {
        onLine(`Starting ${unit.label}.`);
        // `up -d` rather than `start`, so a container whose configuration
        // changed while it was stopped comes back with the new one.
        await compose(['up', '-d', ...unit.services], { onLine, profile: unit.profile, timeoutMs: 10 * 60_000 });
    } else {
        onLine(`Stopping ${unit.label}. Nothing is removed.`);
        await compose(['stop', ...unit.services], { onLine, profile: unit.profile, timeoutMs: 5 * 60_000 });
    }
}

/**
 * Removes everything this service owns, and says what it removed.
 *
 * `keepData` exists because "uninstall" means two things to two people: get rid
 * of the software, or get rid of all of it. The panel asks which, and the
 * volumes are the difference.
 */
export async function uninstall(key, { keepData = false, onLine = () => {} } = {}) {
    const unit = unitFor(key);
    if (!unit) throw new Error(`No such service: ${key}`);
    // Something that owns files rather than containers removes its own.
    if (unit.uninstall) return unit.uninstall(onLine);

    const removed = { containers: [], volumes: [], images: [] };

    onLine(`Removing the ${unit.label} containers.`);
    await compose(['rm', '-sf', ...unit.services], { onLine, profile: unit.profile, timeoutMs: 10 * 60_000 }).catch(
        (err) => onLine(`compose could not remove them cleanly: ${err.message}`),
    );
    // Anything compose missed, by name. A container created by an older version
    // of this stack is not in today's compose file but is still on the machine.
    for (const name of unit.containers) {
        const state = await containerState(name);
        if (!state.exists) continue;
        await docker(['rm', '-f', name], { timeoutMs: 60_000 }).catch(() => {});
        removed.containers.push(name);
    }

    if (keepData) {
        onLine(`Keeping ${unit.volumes.length} volume${unit.volumes.length === 1 ? '' : 's'}: ${unit.data}.`);
    } else {
        for (const volume of unit.volumes) {
            onLine(`Deleting volume ${volume}. This is not recoverable.`);
            await docker(['volume', 'rm', volume], { timeoutMs: 60_000 })
                .then(() => removed.volumes.push(volume))
                .catch((err) => onLine(`  ${volume} was not removed: ${err.message}`));
        }
    }

    for (const image of unit.images) {
        // Tagged by ref or version, so every tag of ours goes, and nothing that
        // is not ours is touched.
        const { stdout } = await docker(['images', '--format', '{{.Repository}}:{{.Tag}}', image], {
            timeoutMs: 30_000,
        }).catch(() => ({ stdout: '' }));
        for (const tag of stdout.split('\n').map((t) => t.trim()).filter(Boolean)) {
            await docker(['image', 'rm', '-f', tag], { timeoutMs: 60_000 })
                .then(() => removed.images.push(tag))
                .catch(() => {});
        }
    }

    onLine(
        `${unit.label} removed: ${removed.containers.length} container(s), ${removed.volumes.length} volume(s), ` +
            `${removed.images.length} image(s). It can be installed again from its tab.`,
    );
    return removed;
}
