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

for file in lid-awake.sh lid-awake-timeout.sh; do
    /bin/bash -n "$SOURCE_DIR/$file"
done
for label in "${LABELS[@]}"; do
    /usr/bin/plutil -lint "$SOURCE_DIR/$label.plist"
    no_symlinks "/Library/LaunchDaemons/$label.plist"
    [ ! -e "/Library/LaunchDaemons/$label.plist" ] || [ -f "/Library/LaunchDaemons/$label.plist" ]
done
for path in /usr/local/libexec/lid-awake.sh /usr/local/libexec/lid-awake-timeout.sh "$LOG"; do
    no_symlinks "$path"
    [ ! -e "$path" ] || [ -f "$path" ] || { printf 'ERROR: not a regular file: %s\n' "$path" >&2; exit 1; }
done
# Reject writable/non-root existing parents before installing privileged code.
for path in /usr /usr/local /usr/local/libexec /Library /Library/LaunchDaemons /Library/Logs; do
    if [ -e "$path" ]; then
        [ -d "$path" ] || { printf 'ERROR: not a directory: %s\n' "$path" >&2; exit 1; }
        owner=$(/usr/bin/stat -f %u "$path")
        mode=$(/usr/bin/stat -f %Lp "$path")
        [ "$owner" -eq 0 ] && [ "$((8#$mode & 0022))" -eq 0 ] || {
            printf 'ERROR: unsafe parent permissions: %s\n' "$path" >&2; exit 1;
        }
        # Conservatively reject extended ACLs on the installation directories.
        if /bin/ls -lde "$path" | /usr/bin/grep -Eq '^[[:space:]]*[0-9]+:'; then
            printf 'ERROR: parent has an ACL; inspect before installing: %s\n' "$path" >&2; exit 1
        fi
    fi
done

# Protect interruptions during stopping as well as partial installation.
cleanup() {
    local status=$?
    trap - EXIT
    if [ "$status" -ne 0 ]; then
        for label in "${LABELS[@]}"; do
            run /bin/launchctl disable "system/$label" || :
            stop_service "$label" || :
        done
        reset_sleep || printf '%s\n' 'ERROR restoring disablesleep=0.' >&2
    fi
    exit "$status"
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
trap 'exit 129' HUP
# Stop both, even if stopping one fails. Disable prevents reload after a failure.
stopped=1
for label in "${LABELS[@]}"; do
    run /bin/launchctl disable "system/$label" || stopped=0
    stop_service "$label" || stopped=0
done
if [ "$stopped" != 1 ]; then
    printf '%s\n' 'ERROR stopping daemons; files retained. A running daemon may re-enable sleep blocking.' >&2
    exit 1
fi
reset_sleep
run /usr/bin/install -d -o root -g wheel -m 755 /usr/local/libexec
for file in lid-awake.sh lid-awake-timeout.sh; do
    run /usr/bin/install -o root -g wheel -m 755 "$SOURCE_DIR/$file" "/usr/local/libexec/$file"
done
for label in "${LABELS[@]}"; do
    run /usr/bin/install -o root -g wheel -m 644 "$SOURCE_DIR/$label.plist" "/Library/LaunchDaemons/$label.plist"
done
run /usr/bin/touch "$LOG"
run /usr/sbin/chown root:wheel "$LOG"
run /bin/chmod 644 "$LOG"
# Start the guard first, so it is already available when the main job enables AC.
for label in dev.drover.lid-awake-guard dev.drover.lid-awake; do
    run /bin/launchctl enable "system/$label"
    run /bin/launchctl bootstrap system "/Library/LaunchDaemons/$label.plist"
done
printf '%s\n' 'Installed lid-awake and lid-awake-guard (DRY_RUN prints actions only).'
