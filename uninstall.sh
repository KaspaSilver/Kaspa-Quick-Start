#!/usr/bin/env bash
#
# Removes everything install.sh created.
#
#   curl -fsSL https://raw.githubusercontent.com/KaspaSilver/Quick-Start-Kaspa/main/uninstall.sh | bash
#
# This removes what the installer added: the containers, images, the chain-data
# volume, the network and the install directory.
#
# Docker itself is deliberately never touched. It is shared machine-wide, and
# uninstalling it would take every unrelated container, image and volume with
# it. Remove Docker yourself if you want it gone.
#
# Pass --keep-data to preserve the synced blockchain.

set -euo pipefail

STACK_DIR="${KASPA_STACK_DIR:-$HOME/.kaspa-node}"
ASSUME_YES="${KASPA_YES:-0}"
KEEP_DATA=0
KEEP_BASE_IMAGES=0

while [ $# -gt 0 ]; do
    case "$1" in
        --dir) STACK_DIR="$2"; shift 2 ;;
        --keep-data) KEEP_DATA=1; shift ;;
        --keep-base-images) KEEP_BASE_IMAGES=1; shift ;;
        --yes|-y) ASSUME_YES=1; shift ;;
        --help|-h)
            cat <<'USAGE'
Usage: uninstall.sh [options]

  --dir <path>          Install directory (default: ~/.kaspa-node)
  --keep-data           Keep the synced blockchain volume
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
    printf '%s  chain data will be KEPT%s\n\n' "$DIM" "$R"
else
    printf '%s  chain data will be DELETED (re-syncing takes hours)%s\n\n' "$YLW" "$R"
fi

confirm "Proceed?" || { echo "Nothing was removed."; exit 0; }

# ------------------------------------------------------------- containers ----

if command -v docker >/dev/null 2>&1 && d info >/dev/null 2>&1; then
    if [ -f "$STACK_DIR/docker-compose.yml" ]; then
        say "Stopping the stack"
        compose_files=(-f "$STACK_DIR/docker-compose.yml")
        [ -f "$STACK_DIR/conf/ports.yml" ] && compose_files+=(-f "$STACK_DIR/conf/ports.yml")
        # --profile mining makes compose aware of the stratum bridge; without
        # it the bridge container and volume are left behind as orphans.
        down=(--profile mining --profile kachat --profile nextcloud --profile proxy down --remove-orphans --rmi local)
        [ "$KEEP_DATA" = "1" ] || down+=(--volumes)
        d compose "${compose_files[@]}" --project-directory "$STACK_DIR" "${down[@]}" 2>/dev/null \
            || warn "compose down reported an error; removing objects individually."
    fi

    say "Removing leftover containers"
    for name in kaspa-node-kaspad kaspa-node-manager kaspa-node-proxy kaspa-node-bridge \
               kaspa-node-kachat kaspa-node-kachat-db \
               kaspa-node-nextcloud kaspa-node-nextcloud-db kaspa-node-nextcloud-redis kaspa-node-nextcloud-imaginary; do
        d rm -f "$name" >/dev/null 2>&1 && ok "removed container $name" || true
    done

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
        say "Removing volumes"
        for volume in kaspa-node-data kaspa-node-bridge-data \
                      kaspa-node-kachat-db-data kaspa-node-kachat-app-data \
                      kaspa-node-nextcloud-db-data kaspa-node-nextcloud-data; do
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
else
    warn "Docker is not available — skipping container, image and volume removal."
fi

# -------------------------------------------------------------- directory ----

if [ -d "$STACK_DIR" ]; then
    if [ "$KEEP_DATA" = "1" ]; then
        say "Removing the install directory (chain data lives in a docker volume, not here)"
    else
        say "Removing $STACK_DIR"
    fi
    # Refuse to delete anything that is not recognisably our install directory.
    if [ -f "$STACK_DIR/docker-compose.yml" ] || [ -f "$STACK_DIR/.env" ]; then
        rm -rf "${STACK_DIR:?}"
        ok "removed $STACK_DIR"
    else
        warn "$STACK_DIR does not look like a Kaspa node install — leaving it alone."
    fi
fi

printf '\n%sDone.%s Every container, image, volume and file this stack created is gone.\n' "$GRN$B" "$R"
printf '%sDocker itself was left installed.%s\n\n' "$DIM" "$R"
