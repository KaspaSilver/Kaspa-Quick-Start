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

# --utxoindex and --appdir are enforced here rather than in the args file so the
# UI cannot turn them off, and --yes keeps kaspad from blocking on a prompt.
echo "kaspad --appdir=${APPDIR} --yes --utxoindex $*"
exec kaspad --appdir="$APPDIR" --yes --utxoindex "$@"
