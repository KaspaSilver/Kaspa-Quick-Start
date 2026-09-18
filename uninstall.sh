#!/usr/bin/env bash
#
# Removes everything install.sh created.
#
#   curl -fsSL https://raw.githubusercontent.com/KaspaSilver/Kaspa-Quick-Start/main/uninstall.sh | bash
#
# By default this is a TRUE uninstall: nothing from the install is left behind.
# It removes the containers, the built images, the network, every data volume
# (including the synced blockchain), and the install directory. A later reinstall
# starts clean and re-syncs the chain from scratch (that takes hours).
#
# Want a reinstall to be instant instead? Pass --keep-data: it keeps the synced
# chain, the app data volumes and the install directory, so a reinstall re-adopts
# them and the node is already synced.
#
# Docker itself is deliberately never touched. It is shared machine-wide, and
# uninstalling it would take every unrelated container, image and volume with
# it. Remove Docker yourself if you want it gone.

set -euo pipefail

STACK_DIR="${KASPA_STACK_DIR:-$HOME/.kaspa-node}"
ASSUME_YES="${KASPA_YES:-0}"
# A true uninstall by default: wipe everything, so nothing lingers. --keep-data
# opts into keeping the synced chain + install dir for an instant reinstall.
KEEP_DATA=0
KEEP_BASE_IMAGES=0

while [ $# -gt 0 ]; do
    case "$1" in
        --dir) STACK_DIR="$2"; shift 2 ;;
        --keep-data) KEEP_DATA=1; shift ;;
        --delete-data|--purge|--remove-data) KEEP_DATA=0; shift ;;
        --keep-base-images) KEEP_BASE_IMAGES=1; shift ;;
        --yes|-y) ASSUME_YES=1; shift ;;
        --help|-h)
            cat <<'USAGE'
Usage: uninstall.sh [options]

  --dir <path>          Install directory (default: ~/.kaspa-node)
  --keep-data           Keep the synced blockchain, the app data volumes and the
                        install directory, so a reinstall is instant (already
                        synced). Without this, uninstall removes everything.
  --delete-data         Full wipe (the default): also removes the chain, the data
                        volumes and the install directory. Accepted for clarity.
  --keep-base-images    Keep nginx / node / alpine / certbot images
  --yes, -y             Do not ask for confirmation
USAGE
            exit 0 ;;
        *) echo "Unknown option: $1 (try --help)" >&2; exit 2 ;;
    esac
done

if [ -t 1 ]; then
    B=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; CYN=$'\033[36m'; R=$'\033[0m'
else
    B=""; DIM=""; RED=""; GRN=""; YLW=""; CYN=""; R=""
fi
say()  { printf '%s==>%s %s\n' "$CYN" "$R" "$*"; }
ok()   { printf '%s  ok%s %s\n' "$GRN" "$R" "$*"; }
warn() { printf '%swarn%s %s\n' "$YLW" "$R" "$*" >&2; }

confirm() {
    [ "$ASSUME_YES" = "1" ] && return 0
    [ -e /dev/tty ] || return 1
    printf '%s [y/N] ' "$1" > /dev/tty
    local reply; read -r reply < /dev/tty || reply=""
    case "$reply" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

SUDO=""
if [ "$(id -u)" -ne 0 ] && command -v sudo >/dev/null 2>&1; then SUDO="sudo"; fi

DOCKER_SUDO=""
if command -v docker >/dev/null 2>&1; then
    docker info >/dev/null 2>&1 || DOCKER_SUDO="$SUDO"
fi
d() { $DOCKER_SUDO docker "$@"; }

printf '\n%sRemove the Kaspa one-click node%s\n' "$B" "$R"
printf '%s  directory %s%s\n' "$DIM" "$STACK_DIR" "$R"
if [ "$KEEP_DATA" = "1" ]; then
    printf '%s  chain + app data and %s will be KEPT (a reinstall is instant)%s\n\n' "$DIM" "$STACK_DIR" "$R"
else
    printf '%s  EVERYTHING is removed: containers, images, network, the chain +%s\n' "$YLW" "$R"
    printf '%s  all app data, and %s. A reinstall re-syncs from scratch (hours).%s\n' "$YLW" "$STACK_DIR" "$R"
    printf '%s  run with --keep-data to keep the chain for an instant reinstall%s\n\n' "$DIM" "$R"
fi

confirm "Proceed?" || { echo "Nothing was removed."; exit 0; }

# ------------------------------------------------------------- containers ----

if ! command -v docker >/dev/null 2>&1; then
    warn "Docker is not installed, so there are no containers, images or volumes to remove."
elif ! d info >/dev/null 2>&1; then
    # Docker is here but this user can't reach the daemon (not in the docker group
    # yet, or it needs elevated access). Say so plainly and stop -- silently doing
    # nothing is exactly how a "panel still running after uninstall" happens.
    warn "Docker is installed but not reachable as this user (permission denied, or the daemon is down)."
    warn "Re-run the uninstall with elevated access, for example:"
    warn "    sudo bash \"$STACK_DIR/uninstall.sh\"${*:+ $*}"
    exit 1
else
    # Graceful path: compose down with EVERY profile (gift/bot/translate were
    # missing before, so those services were left running) and --remove-orphans.
    if [ -f "$STACK_DIR/docker-compose.yml" ]; then
        say "Stopping the stack (docker compose down)"
        compose_files=(-f "$STACK_DIR/docker-compose.yml")
        [ -f "$STACK_DIR/conf/ports.yml" ] && compose_files+=(-f "$STACK_DIR/conf/ports.yml")
        down=(--profile mining --profile kachat --profile kachat-desktop --profile nextcloud \
              --profile proxy --profile gift --profile bot --profile translate \
              down --remove-orphans --rmi local)
        [ "$KEEP_DATA" = "1" ] || down+=(--volumes)
        d compose "${compose_files[@]}" --project-directory "$STACK_DIR" "${down[@]}" 2>/dev/null \
            || warn "compose down reported an error; sweeping objects directly."
    fi

    # Hard backstop: sweep EVERY container this stack created -- by name prefix AND
    # by the compose-project label -- instead of trusting a hardcoded list or the
    # right set of profiles. This is what guarantees the panel (and every other
    # service, present or future) is actually stopped and removed.
    say "Removing all Kaspa Quick Start containers"
    ids="$( { d ps -aq --filter 'name=^kaspa-node-' 2>/dev/null; \
              d ps -aq --filter 'label=com.docker.compose.project=kaspa-node' 2>/dev/null; } \
            | sort -u )" || ids=""
    if [ -n "$ids" ]; then
        # shellcheck disable=SC2086
        if d rm -f $ids >/dev/null 2>&1; then
            ok "removed $(printf '%s\n' "$ids" | grep -c .) container(s)"
        else
            warn "some containers would not remove (checked again below)"
        fi
    else
        ok "no Kaspa Quick Start containers were running"
    fi

    say "Removing images"
    # Images this stack built.
    while read -r image; do
        [ -n "$image" ] || continue
        d rmi -f "$image" >/dev/null 2>&1 && ok "removed image $image" || true
    done < <(d images --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | grep '^kaspa-one-click/' || true)

    if [ "$KEEP_BASE_IMAGES" = "0" ]; then
        # Base images the stack pulled. These may be shared with other projects,
        # so a refusal here is expected and harmless.
        for image in nginx:1.27-alpine certbot/certbot:latest node:22-alpine alpine:3.21 \
                     postgres:17-alpine mariadb:10.11 redis:7-alpine \
                     nextcloud/aio-imaginary:latest nextcloud:stable; do
            d rmi "$image" >/dev/null 2>&1 && ok "removed image $image" || true
        done
    fi

    if [ "$KEEP_DATA" = "0" ]; then
        say "Removing data volumes"
        # Sweep by name prefix so a newly-added data volume can't be missed.
        vols="$(d volume ls -q --filter 'name=kaspa-node-' 2>/dev/null || true)"
        for volume in $vols; do
            d volume rm -f "$volume" >/dev/null 2>&1 && ok "removed volume $volume" || true
        done
    fi

    say "Removing the network"
    d network rm kaspa-node-net >/dev/null 2>&1 && ok "removed network kaspa-node-net" || true

    # Our images are gone by this point, so their build cache is now dangling
    # and this reclaims it (several GB after an arm64 source build). Plain
    # `prune` without -a leaves cache that other projects' images still
    # reference, which is the point -- nothing unrelated gets touched.
    d builder prune -f >/dev/null 2>&1 || true

    # Verify: never claim success while a container is still up. This is the check
    # that would have caught "panel still running" instead of printing Done.
    survivors="$(d ps -aq --filter 'name=^kaspa-node-' 2>/dev/null | grep -c . || true)"
    if [ "${survivors:-0}" != "0" ]; then
        warn "$survivors Kaspa Quick Start container(s) are STILL present after uninstall:"
        d ps -a --filter 'name=^kaspa-node-' --format '       {{.Names}}  ({{.Status}})' 2>/dev/null >&2 || true
        warn "Remove them by hand with:"
        warn "    $DOCKER_SUDO docker rm -f \$($DOCKER_SUDO docker ps -aq --filter name=kaspa-node-)"
        exit 1
    fi
    ok "verified: no Kaspa Quick Start containers remain"
fi

# -------------------------------------------------------------- directory ----

if [ -d "$STACK_DIR" ]; then
    if [ "$KEEP_DATA" = "1" ]; then
        # The directory holds .env, and install.sh re-reads its password hash and
        # session secret. Keeping it (and the data volumes) is what lets a
        # reinstall re-adopt the synced chain and the apps' databases as-is.
        say "Keeping $STACK_DIR (its .env holds what a reinstall needs to re-adopt your data)"
    else
        say "Removing $STACK_DIR"
        # Refuse to delete anything that is not recognisably our install directory.
        if [ -f "$STACK_DIR/docker-compose.yml" ] || [ -f "$STACK_DIR/.env" ]; then
            # Containers run as root and can leave root-owned files in the bind-
            # mounted config, which a normal-user rm can't delete -- fall back to sudo.
            rm -rf "${STACK_DIR:?}" 2>/dev/null || $SUDO rm -rf "${STACK_DIR:?}" 2>/dev/null || true
            if [ -d "$STACK_DIR" ]; then
                warn "Could not fully remove $STACK_DIR (root-owned files?). Run: sudo rm -rf \"$STACK_DIR\""
            else
                ok "removed $STACK_DIR"
            fi
        else
            warn "$STACK_DIR does not look like a Kaspa node install, so leaving it alone."
        fi
    fi
fi

if [ "$KEEP_DATA" = "1" ]; then
    printf '\n%sDone.%s The containers, images and network are gone; your synced chain,\n' "$GRN$B" "$R"
    printf 'app data and %s were kept. Reinstall any time and it picks up where it left off.\n\n' "$STACK_DIR"
else
    printf '\n%sDone.%s Nothing from the install is left: every container, image, volume,\n' "$GRN$B" "$R"
    printf 'the network and %s are gone. Only Docker itself was left installed.\n' "$STACK_DIR"
    printf '%sNext time, uninstall with --keep-data to keep the chain for an instant reinstall.%s\n\n' "$DIM" "$R"
fi
