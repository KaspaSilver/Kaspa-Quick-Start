#!/bin/sh
# Builds the kaspad command line from /conf/kaspad.args (one argument per line,
# written by the manager UI) and always forces the flags the stack depends on.
set -eu

ARGS_FILE="${KASPAD_ARGS_FILE:-/conf/kaspad.args}"
APPDIR="${KASPAD_APPDIR:-/data}"

set --

if [ -f "$ARGS_FILE" ]; then
    # `read` drops the final line when the file has no trailing newline, so feed
    # it one. IFS is cleared to preserve leading/trailing spaces inside a value.
    while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in
            '' | '#'*) continue ;;
        esac
        set -- "$@" "$line"
    done <"$ARGS_FILE"
fi

# --appdir is enforced here rather than in the args file so the UI cannot turn
# it off, and --yes keeps kaspad from blocking on a prompt.
#
# --utxoindex is a setting now, and it is read from the args file's
# `# utxoindex-managed:` marker rather than from an argument. kaspad has no flag
# for the off state and refuses a repeated --utxoindex, so the flag itself can
# only ever be added here, exactly once.
#
# No marker means the file was written before the setting existed, by an install
# that has been indexing all along, so the index stays on for it.
UTXOINDEX=--utxoindex
if [ -f "$ARGS_FILE" ] && grep -q '^# utxoindex-managed: off' "$ARGS_FILE"; then
    UTXOINDEX=""
fi

# UTXOINDEX is deliberately unquoted: empty has to disappear, not become "".
echo "kaspad --appdir=${APPDIR} --yes ${UTXOINDEX} $*"
# shellcheck disable=SC2086
exec kaspad --appdir="$APPDIR" --yes ${UTXOINDEX} "$@"
