import fs from 'node:fs';
import path from 'node:path';

import { docker } from './dockerctl.js';
import { COMPOSE_FILE, CONF_DIR, PORTS_OVERRIDE, STACK_HOST, STACK_LOCAL } from './paths.js';

/*
 * Two jobs that cannot run where every other job runs.
 *
 * Updating the panel replaces the container executing the update. Removing the
 * stack deletes it outright. Either way this process is gone half way through
 * and the remaining steps never happen.
 *
 * So both hand off to a detached container that outlives this one. It is the
 * usual shape for this: the thing being replaced starts its replacement and
 * then stops mattering.
 *
 * Both mount the stack at its *host* path rather than at /stack. The docker CLI
 * resolves build contexts and volume sources itself, so a path that only exists
 * inside this container yields a build quietly made from the wrong files.
 * Mounting host-path onto the same host-path makes the CLI and the daemon agree.
 */

// Status is written as key=value lines rather than JSON. Emitting valid JSON
// from shell means escaping quotes and backslashes in error text, which is
// exactly the kind of thing that works until the day an error message contains
// a quote. One key per line cannot be malformed.
const STATUS_LOCAL = path.join(STACK_LOCAL, 'conf', 'last-update.txt');

/** Reads back what the detached updater recorded, once the panel is up again. */
export function lastUpdate() {
    let raw;
    try {
        raw = fs.readFileSync(STATUS_LOCAL, 'utf8');
    } catch {
        return null;
    }
    const out = { steps: [] };
    for (const line of raw.split('\n')) {
        const at = line.indexOf('=');
        if (at < 1) continue;
        const key = line.slice(0, at);
        const value = line.slice(at + 1);
        if (key === 'step') out.steps.push(value);
        else out[key] = value;
    }
    if (!out.result) return null;
    return { ...out, ok: out.result === 'ok' };
}

/**
 * Launches a detached container that survives this one being replaced.
 * `--rm` so a finished run leaves nothing behind to clean up.
 *
 * The stack is mounted at the fixed Linux path /stack -- the same place the
 * running panel mounts it -- rather than at its host path. Two reasons, both
 * about working on every OS: `--mount` (not `-v`) with an explicit source keeps
 * a Windows host path (C:\Users\...) from being split on its drive colon, and a
 * Linux target (/stack) is valid inside this Linux sidecar where a Windows path
 * is not. Compose reads the files and streams the (relative) build context from
 * /stack, while the manager's own volume stays the absolute ${STACK_DIR} from
 * .env, which the daemon resolves -- so the result is identical on Linux, Mac
 * and Windows.
 */
async function detach({ name, image, script, bind }) {
    // A run that died mid-way would still hold the name.
    await docker(['rm', '-f', name], { timeoutMs: 30_000 }).catch(() => {});

    const args = ['run', '--detach', '--rm', '--name', name, '-v', '/var/run/docker.sock:/var/run/docker.sock'];
    if (bind) {
        // --mount, not -v: an explicit source= keeps a Windows host path
        // (C:\Users\...) from being split on its drive colon the way -v does,
        // and hands it to the daemon whole. The target is always a Linux path.
        args.push('--mount', `type=bind,source=${bind.source},target=${bind.target}`);
    }
    args.push(image, 'sh', '-c', script);

    const { stdout } = await docker(args, { timeoutMs: 60_000 });
    return stdout.trim().slice(0, 12);
}

// --------------------------------------------------------- panel restart ---

/**
 * Recreates the panel's own container.
 *
 * Used when a setting only takes effect at container creation -- the panel's
 * own port (GUI_PORT), which is a compose port mapping fixed when the container
 * is made. The panel cannot recreate the container serving the request itself
 * -- the command would die with the process running it -- so a detached sidecar
 * does it a moment later, from this same image, which already has compose in
 * it. (The admin password no longer needs this: auth reads it live from .env.)
 */
export async function restartManager() {
    const compose = `docker compose ${composeFileArgs()} --project-directory "${STACK_LOCAL}"`;
    const script = `
set -u
# Long enough for the response to this request to have been written.
sleep 2
${compose} up -d --force-recreate manager
`;
    const container = await detach({
        name: 'kaspa-node-panel-restart',
        image: 'kaspa-one-click/manager:1',
        script,
        bind: { source: STACK_HOST, target: STACK_LOCAL },
    });
    return { started: true, container };
}

// ------------------------------------------------------------- panel update ---

const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
// No "..", so a ref cannot climb out of the URL path it is pasted into.
const REF_RE = /^(?!.*\.\.)[A-Za-z0-9._/-]{1,120}$/;

// Exactly the set install.sh replaces on a re-install. conf/ holds generated
// state and proxy/ holds issued certificates, so neither is listed: wiping
// either would cost real work to get back.
const CODE_ITEMS = [
    'docker-compose.yml',
    'kaspad',
    'manager',
    'bridge',
    'kachat',
    'kassigner',
    'nextcloud',
    'uninstall.sh',
    'uninstall.ps1',
    'README.md',
];

const ghHeaders = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'kaspa-quick-start-panel',
};

/**
 * GitHub, with the first lookup allowed to miss.
 *
 * These calls run in a container whose DNS resolver can be a moment from warm,
 * so the very first request sometimes fails with "could not resolve host" where
 * a retry a second later succeeds -- which is why an update used to need two
 * clicks. Only a rejected fetch (a network/DNS/timeout error) is retried; an
 * HTTP response, even a 404 or a rate-limit, is a real answer and is returned
 * as-is for the caller to read.
 */
async function ghFetch(url) {
    let lastErr;
    for (let attempt = 1; attempt <= 4; attempt++) {
        try {
            return await fetch(url, { headers: ghHeaders, signal: AbortSignal.timeout(15_000) });
        } catch (err) {
            lastErr = err;
            if (attempt < 4) await new Promise((r) => setTimeout(r, 1500 * attempt));
        }
    }
    throw new Error(
        `Could not reach GitHub (${lastErr?.message || 'network error'}). This is usually a brief DNS or connection hiccup; try again in a moment.`,
    );
}

/** The commit a branch or tag currently points at. */
export async function latestCommit({ repo = 'KaspaSilver/Kaspa-Quick-Start', ref = 'main' } = {}) {
    if (!REPO_RE.test(repo)) throw new Error(`"${repo}" is not a valid owner/repo.`);
    if (!REF_RE.test(ref)) throw new Error(`"${ref}" is not a valid branch, tag or commit.`);

    const res = await ghFetch(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`);
    if (res.status === 404) throw new Error(`${repo}@${ref} does not exist.`);
    // Unauthenticated GitHub allows 60 requests an hour per address, which a
    // manual check will never reach, but the message should say so if it does.
    if (res.status === 403 || res.status === 429) throw new Error('GitHub is rate limiting this address. Try again in a few minutes.');
    if (!res.ok) throw new Error(`GitHub returned ${res.status}.`);

    const c = await res.json();
    return {
        sha: c.sha,
        shortSha: String(c.sha || '').slice(0, 7),
        date: c.commit?.committer?.date ?? c.commit?.author?.date ?? null,
        message: String(c.commit?.message || '').split('\n')[0].slice(0, 140),
        url: c.html_url ?? null,
    };
}

/**
 * How far behind the installed commit is. Skipped when nothing recorded an
 * installed sha, which is every install that has never used this button.
 */
export async function compareToInstalled({ repo, base, head }) {
    if (!base || !head || base === head) return null;
    try {
        const res = await ghFetch(`https://api.github.com/repos/${repo}/compare/${base}...${head}`);
        if (!res.ok) return null;
        const c = await res.json();
        return { behind: Number(c.ahead_by) || 0, status: c.status ?? null };
    } catch {
        return null;
    }
}

/**
 * The `-f` list for the detached container, as paths under /stack.
 *
 * It is the same set the panel uses for every other compose command, built the
 * same way. Rebuilding with only docker-compose.yml looks fine and is not: the
 * published port overrides live in conf/*.yml, so a manager recreated without
 * them comes back with no host port mapping, and the panel that started the
 * update never reappears. These are /stack paths (STACK_LOCAL), not host paths,
 * because the sidecar mounts the stack there -- which is what makes this work
 * on Docker Desktop, where a Windows host path is not a usable path inside a
 * Linux container.
 */
function composeFileArgs() {
    const files = [COMPOSE_FILE];
    if (fs.existsSync(PORTS_OVERRIDE)) files.push(PORTS_OVERRIDE);
    for (const name of ['bridge-ports.yml', 'apps-ports.yml']) {
        const override = path.join(CONF_DIR, name);
        if (fs.existsSync(override)) files.push(override);
    }
    return files.map((f) => `-f "${f}"`).join(' ');
}

export async function updatePanel({ repo = 'KaspaSilver/Kaspa-Quick-Start', ref = 'main' } = {}) {
    if (!REPO_RE.test(repo)) throw new Error(`"${repo}" is not a valid owner/repo.`);
    if (!REF_RE.test(ref)) throw new Error(`"${ref}" is not a valid branch, tag or commit.`);

    // Pinned to a resolved commit rather than the branch name, so what gets
    // recorded as installed is exactly what was downloaded. A branch moves.
    const head = await latestCommit({ repo, ref }).catch(() => null);
    const download = head?.sha || ref;

    const compose = `docker compose ${composeFileArgs()} --project-directory "${STACK_LOCAL}"`;

    const script = `
set -u
S=${STATUS_LOCAL}
: > "$S"
echo "kind=panel-update" >> "$S"
echo "repo=${repo}" >> "$S"
echo "ref=${ref}" >> "$S"
echo "sha=${head?.sha || ''}" >> "$S"
echo "at=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$S"
step() { echo "step=$1" >> "$S"; echo "$1"; }
fail() { echo "error=$1" >> "$S"; echo "result=fail" >> "$S"; exit 1; }

step "Downloading ${repo}@${ref}"
tmp=$(mktemp -d) || fail "Could not create a temporary directory."
arc="$tmp/stack.tar.gz"
# Download to a file (not straight into a pipe) so curl's own exit status is
# what we test, then retry it. This sidecar is freshly started, so its DNS
# resolver can miss the first lookup -- "could not resolve host" -- and succeed
# a second later. Retrying here is what removes the need for a second click.
n=1
while :; do
  if curl -fsSL "https://codeload.github.com/${repo}/tar.gz/${download}" -o "$arc"; then
    break
  fi
  if [ "$n" -ge 5 ]; then
    fail "Could not download ${repo}@${ref} after 5 tries. This is usually a brief DNS or network hiccup; check your connection and the branch or tag name."
  fi
  echo "download attempt $n failed (often a transient DNS timeout); retrying in $((n*3))s..." >> "$S"
  sleep $((n*3))
  n=$((n+1))
done
tar -xzf "$arc" -C "$tmp" --strip-components=1 || fail "The downloaded archive could not be unpacked."
[ -f "$tmp/docker-compose.yml" ] || fail "That archive does not look like the stack."

step "Replacing the panel files"
for item in ${CODE_ITEMS.join(' ')}; do
  [ -e "$tmp/$item" ] || continue
  rm -rf "${STACK_LOCAL}/$item"
  cp -a "$tmp/$item" "${STACK_LOCAL}/" || fail "Could not write $item."
done
rm -rf "$tmp"

step "Rebuilding the panel image"
${compose} build manager || fail "The panel image did not build. The old panel is still running."

step "Restarting the panel"
echo "result=ok" >> "$S"
${compose} up -d --force-recreate manager || {
  echo "error=The image built, but the panel container did not come back." >> "$S"
  echo "result=fail" >> "$S"
  exit 1
}
`;

    // Runs from the panel's own image, which already carries docker, compose,
    // buildx and curl, so nothing extra is pulled to do this.
    const container = await detach({
        name: 'kaspa-node-panel-update',
        image: 'kaspa-one-click/manager:1',
        script,
        bind: { source: STACK_HOST, target: STACK_LOCAL },
    });
    return { started: true, container, repo, ref };
}

// ----------------------------------------------------------------- teardown ---

const CONTAINERS = [
    'kaspa-node-kaspad',
    'kaspa-node-proxy',
    'kaspa-node-bridge',
    'kaspa-node-kachat',
    'kaspa-node-kachat-db',
    'kaspa-node-kachat-desktop',
    'kaspa-node-kachat-bot',
    'kaspa-node-libretranslate',
    'kaspa-node-gift',
    'kaspa-node-nextcloud',
    'kaspa-node-nextcloud-db',
    'kaspa-node-nextcloud-redis',
    'kaspa-node-nextcloud-imaginary',
];

/**
 * The panel, removed on its own at the very end.
 *
 * It used to go with the rest, in the first step, which meant the screen that
 * asked for this vanished before the removal had done anything and the person
 * who pressed the button never saw a word of it. Everything it can narrate
 * happens first; it is taken away last, and its disappearing is the finish.
 */
const PANEL_CONTAINER = 'kaspa-node-manager';

const VOLUMES = [
    'kaspa-node-data',
    'kaspa-node-bridge-data',
    'kaspa-node-kachat-db-data',
    'kaspa-node-kachat-app-data',
    'kaspa-node-nextcloud-db-data',
    'kaspa-node-nextcloud-data',
    'kaspa-node-gift-data',
    'kaspa-node-libretranslate-models',
];

// Pulled by the stack but not built by it, so they may well be shared with
// something else on the machine. Docker refuses when they are, which is the
// behaviour we want: nothing unrelated gets broken.
const BASE_IMAGES = [
    'nginx:1.27-alpine',
    'certbot/certbot:latest',
    'node:22-alpine',
    'alpine:3.21',
    'postgres:17-alpine',
    'mariadb:10.11',
    'redis:7-alpine',
    'nextcloud/aio-imaginary:latest',
    'nextcloud:stable',
];

/**
 * Removes everything this stack put on the machine and leaves Docker itself
 * installed, which is the whole point of doing it this way rather than telling
 * people to uninstall Docker.
 */
export async function teardown() {
    const parent = path.posix.dirname(STACK_HOST.replace(/\\/g, '/'));
    const base = path.posix.basename(STACK_HOST.replace(/\\/g, '/'));
    // Refuse the cases where deleting "the parent's child" would mean deleting
    // something enormous by accident.
    if (!base || base === '.' || base === '/' || parent === base) {
        throw new Error(`Refusing to remove ${STACK_HOST}: it has no parent directory to work from.`);
    }

    // Ordered so the panel can report on it. Everything up to the last block
    // leaves the manager running, so the overlay showing this is fed by the
    // same docker logs the sidecar is writing; the last block takes the panel
    // away and the log ends there because there is nothing left to carry it.
    const script = `
set -u
echo "Removing containers"
for c in ${CONTAINERS.join(' ')}; do
  docker rm -f "$c" >/dev/null 2>&1 && echo "  removed $c" || true
done

echo "Removing images the stack built"
docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null \\
  | grep '^kaspa-one-click/' \\
  | grep -v '^kaspa-one-click/manager' \\
  | while read -r i; do docker rmi -f "$i" >/dev/null 2>&1 && echo "  removed $i" || true; done

echo "Removing base images (skipped where something else still uses them)"
for i in ${BASE_IMAGES.join(' ')}; do
  docker rmi "$i" >/dev/null 2>&1 && echo "  removed $i" || echo "  kept $i, something else uses it"
done

echo "Removing volumes. This is the chain data and every app's files."
for v in ${VOLUMES.join(' ')}; do
  docker volume rm -f "$v" >/dev/null 2>&1 && echo "  removed $v" || true
done

echo "Removing the control panel itself. This is where the log stops."
sleep 2
docker rm -f ${PANEL_CONTAINER} >/dev/null 2>&1 || true
docker images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null \\
  | grep '^kaspa-one-click/manager' \\
  | while read -r i; do docker rmi -f "$i" >/dev/null 2>&1 || true; done

# Only once every container is off it.
docker network rm kaspa-node-net >/dev/null 2>&1 || true
# Our images are gone by now, so their build cache is dangling and this reclaims
# it. Without -a, cache that other projects still reference is left alone.
docker builder prune -f >/dev/null 2>&1 || true

# The parent is mounted rather than the stack directory itself, because a bind
# mount cannot delete its own mount point: mounted at itself, rm -rf empties the
# directory but leaves it behind. Guarded exactly as uninstall.sh guards it, so
# a directory that is not recognisably this install is never touched.
if [ -f "/host/${base}/docker-compose.yml" ] || [ -f "/host/${base}/.env" ]; then
  rm -rf "/host/${base}" && echo "Removed ${STACK_HOST}"
else
  echo "${STACK_HOST} does not look like a Kaspa node install, so leaving it alone."
fi
echo "Done. Docker itself was left installed."
`;

    // Deliberately not the panel's image: this has to delete every
    // kaspa-one-click image including the one the panel runs from, and Docker
    // will not remove an image that a running container is using.
    const container = await detach({
        name: 'kaspa-node-teardown',
        image: 'docker:cli',
        script,
        bind: { source: parent, target: '/host' },
    });
    return { started: true, container, removes: STACK_HOST };
}
