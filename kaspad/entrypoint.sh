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
# --utxoindex is a setting now and arrives in the args file like any other flag.
# kaspad has no flag for the off state, though, so "switched off" and "written
# before this was a setting" both look like an absent line. The panel marks
# every file it writes, and only a marked file is trusted to mean off: an
# unmarked one belongs to an install that has been indexing all along, and
# forcing it on there keeps that node's index rather than dropping it silently.
UTXOINDEX=--utxoindex
if [ -f "$ARGS_FILE" ] && grep -q '^# utxoindex-managed:' "$ARGS_FILE"; then
    UTXOINDEX=""
fi

# UTXOINDEX is deliberately unquoted: empty has to disappear, not become "".
echo "kaspad --appdir=${APPDIR} --yes ${UTXOINDEX} $*"
# shellcheck disable=SC2086
exec kaspad --appdir="$APPDIR" --yes ${UTXOINDEX} "$@"
