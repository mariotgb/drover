#!/bin/bash
set -euo pipefail
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
export LC_ALL=C
umask 022
DRY_RUN=${DRY_RUN:-0}
SOURCE_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
LABELS=(dev.drover.lid-awake dev.drover.lid-awake-guard)
TIMEOUT="$SOURCE_DIR/lid-awake-timeout.sh"
LOG=/Library/Logs/lid-awake.log

run() {
    if [ "$DRY_RUN" = 1 ]; then
        printf 'DRY_RUN:'; printf ' %q' "$@"; printf '\n'
    else
        "$@"
    fi
}

reset_sleep() {
    run /bin/bash "$TIMEOUT" 10 /usr/bin/pmset -a disablesleep 0
}

# Check every existing component, not only the final file.
no_symlinks() {
    local path="$1"
    while [ "$path" != / ]; do
        if [ -L "$path" ]; then
            printf 'ERROR: symlink refused: %s\n' "$path" >&2
            return 1
        fi
        path=${path%/*}
        [ -n "$path" ] || path=/
    done
}

# launchctl print returns 113 for an absent service on this macOS.
# Treat all other failures as errors, including failures after bootout.
stop_service() {
    local label="$1" output rc
    if [ "$DRY_RUN" = 1 ]; then
        printf 'DRY_RUN: verify/bootout system/%s (only status 113 means absent)\n' "$label"
        return 0
    fi
    if output=$(/bin/launchctl print "system/$label" 2>&1); then
        /bin/launchctl bootout "system/$label" || return 1
        if output=$(/bin/launchctl print "system/$label" 2>&1); then
            printf 'ERROR: service still loaded: %s\n' "$label" >&2
            return 1
        else
            rc=$?
        fi
    else
        rc=$?
    fi
    if [ "$rc" -ne 113 ]; then
        printf 'ERROR checking %s (status %s): %s\n' "$label" "$rc" "$output" >&2
        return 1
    fi
}

if [ "$DRY_RUN" != 1 ] && [ "$EUID" -ne 0 ]; then
    printf '%s\n' 'Run with sudo, or use DRY_RUN=1.' >&2
    exit 1
fi

# Always attempt a reset, even if service inspection/stopping/removal fails.
cleanup() {
    local status=$?
    trap - EXIT
    if ! reset_sleep; then
        printf '%s\n' 'ERROR restoring disablesleep=0.' >&2
        status=1
    fi
    exit "$status"
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
trap 'exit 129' HUP
for label in "${LABELS[@]}"; do no_symlinks "/Library/LaunchDaemons/$label.plist"; done
no_symlinks /usr/local/libexec/lid-awake.sh
no_symlinks /usr/local/libexec/lid-awake-timeout.sh
no_symlinks "$LOG"

stopped=1
for label in "${LABELS[@]}"; do
    run /bin/launchctl disable "system/$label" || stopped=0
    stop_service "$label" || stopped=0
done
if [ "$stopped" != 1 ]; then
    printf '%s\n' 'ERROR stopping daemons; files retained. A running daemon may re-enable sleep blocking; retry uninstall.' >&2
    exit 1
fi
run /bin/rm -f /Library/LaunchDaemons/dev.drover.lid-awake.plist \
    /Library/LaunchDaemons/dev.drover.lid-awake-guard.plist \
    /usr/local/libexec/lid-awake.sh /usr/local/libexec/lid-awake-timeout.sh
reset_sleep
trap - EXIT
printf '%s\n' 'Removed both daemons; disablesleep=0; log retained (DRY_RUN prints actions only).'
