import fs from 'node:fs';
import os from 'node:os';

import { STACK_LOCAL } from './paths.js';
import { docker, containerState, STACK_CONTAINERS } from './dockerctl.js';

/**
 * What the machine itself is doing: its disk, its memory, and which of this
 * stack's containers are up.
 *
 * Every other page in the panel answers a question about one service. This one
 * answers the question people actually open the panel with -- "is the box all
 * right?" -- which is why it reads the host and not the node.
 *
 * The awkward part is that the panel runs *inside* a container, so the obvious
 * calls answer about the wrong machine:
 *
 *   os.hostname()   the container's hostname ("manager"), never the host's
 *   statfs('/')     the container's own filesystem, which is the image
 *   os.freemem()    counts page cache as used, so a healthy box reads as full
 *
 * Each one below therefore says where it gets its answer and why that source is
 * the host's rather than this container's.
 */

/**
 * Disk, measured where the stack actually writes.
 *
 * `/` inside this container is the image's overlay and tells you nothing. The
 * stack directory is a bind mount of a host directory, so statting it crosses
 * into the host filesystem and reports the volume the chain data, the database
 * and Nextcloud all land on -- the one that fills up.
 *
 * The percentage is `df`'s, not total-vs-free: some of a filesystem is reserved
 * for root and can never be handed out, so used/(used+available) is the figure
 * that matches what any other tool on the box will say.
 */
export async function storage(target = STACK_LOCAL) {
    for (const dir of [target, '/']) {
        try {
            const fsStat = await fs.promises.statfs(dir);
            const block = Number(fsStat.bsize);
            const total = Number(fsStat.blocks) * block;
            const available = Number(fsStat.bavail) * block;
            const used = (Number(fsStat.blocks) - Number(fsStat.bfree)) * block;
            const usable = used + available;
            if (!total) continue;
            return {
                path: dir,
                totalBytes: total,
                usedBytes: used,
                availableBytes: available,
                percent: usable ? Math.round((used / usable) * 100) : null,
            };
        } catch {
            /* try the next candidate */
        }
    }
    return null;
}

/**
 * Memory, from /proc/meminfo rather than os.freemem().
 *
 * Two reasons. /proc is not namespaced by a plain container, so its numbers are
 * the host's -- which is the machine someone is asking about. And MemAvailable
 * is the kernel's own estimate of what a new process could actually get, where
 * os.freemem() reports MemFree and counts the page cache as used. On a box that
 * has been up a week those differ by gigabytes, and the honest one is the one
 * that does not make a healthy machine look full.
 */
export function memory() {
    try {
        const info = fs.readFileSync('/proc/meminfo', 'utf8');
        const field = (name) => {
            const match = info.match(new RegExp(`^${name}:\\s+(\\d+) kB`, 'm'));
            return match ? Number(match[1]) * 1024 : null;
        };
        const total = field('MemTotal');
        const available = field('MemAvailable');
        if (total && available !== null) {
            const used = total - available;
            return {
                totalBytes: total,
                usedBytes: used,
                availableBytes: available,
                percent: Math.round((used / total) * 100),
            };
        }
    } catch {
        /* not Linux, or /proc is not there: fall through */
    }

    // macOS and Windows during `dev.sh`, where there is no /proc to read.
    const total = os.totalmem();
    const available = os.freemem();
    const used = total - available;
    return {
        totalBytes: total,
        usedBytes: used,
        availableBytes: available,
        percent: total ? Math.round((used / total) * 100) : null,
    };
}

/**
 * The host's identity, asked of the Docker daemon.
 *
 * The daemon runs on the host, so `docker info` describes the host: its name,
 * its kernel, how many cores it really has. Asking Node instead would describe
 * this container. It shells out, so it is held for a minute -- none of it
 * changes between two polls.
 */
let machineCache = { at: 0, value: null };
const MACHINE_TTL_MS = 60_000;

export async function machine({ force = false } = {}) {
    if (!force && machineCache.value && Date.now() - machineCache.at < MACHINE_TTL_MS) {
        return machineCache.value;
    }

    let value = {
        hostname: null,
        system: null,
        kernel: null,
        arch: os.arch(),
        cores: os.cpus().length || null,
    };

    try {
        const { stdout } = await docker([
            'info',
            '--format',
            '{{.Name}}|{{.OperatingSystem}}|{{.KernelVersion}}|{{.Architecture}}|{{.NCPU}}',
        ]);
        const [hostname, system, kernel, arch, cores] = stdout.trim().split('|');
        value = {
            hostname: hostname || null,
            system: system || null,
            kernel: kernel || null,
            arch: arch || value.arch,
            cores: Number(cores) || value.cores,
        };
    } catch {
        // No daemon (or it is busy): report what this process can see. The
        // hostname stays null rather than becoming "manager", because a
        // container name shown as the machine's name is worse than a dash.
        value.system = `${os.type()} ${os.release()}`;
    }

    machineCache = { at: Date.now(), value };
    return value;
}

/**
 * Every container this stack can run, and whether it is up.
 *
 * Containers that do not exist are kept, not filtered out: "not installed" is a
 * real answer to "what is on this machine", and dropping them made the list
 * silently shorter on a fresh install with nothing to explain the gap.
 */
export async function services() {
    return Promise.all(
        STACK_CONTAINERS.map(async ({ key, label, name }) => {
            const state = await containerState(name);
            return {
                key,
                label,
                name,
                installed: state.exists,
                running: state.running,
                status: state.status,
                health: state.health,
                startedAt: state.running ? state.startedAt : null,
            };
        }),
    );
}

/** Everything the Overview page shows, in one round trip. */
export async function snapshot() {
    const [disk, host, containers] = await Promise.all([storage(), machine(), services()]);
    return {
        storage: disk,
        memory: memory(),
        machine: {
            ...host,
            // os.uptime() and os.loadavg() read /proc too, so on Linux these are
            // the host's figures even from in here.
            uptimeSeconds: Math.floor(os.uptime()),
            loadAverage: os.loadavg().map((n) => Number(n.toFixed(2))),
        },
        services: containers,
    };
}
