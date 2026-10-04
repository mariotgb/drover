#!/bin/bash
# macOS ships Bash 3.2; only system utilities are used.
set -u
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
export LC_ALL=C
umask 077

PMSET=/usr/bin/pmset
IOREG=/usr/sbin/ioreg
TIMEOUT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/lid-awake-timeout.sh"
LOG=/Library/Logs/lid-awake.log
DRY_RUN=${DRY_RUN:-0}
POLL_SECONDS=15
RETRY_DELAYS=(30 60 120 120)
FAKE_MODE=0
fake_sleep_failures=0
last_value=
last_source=
last_known_source=
sleep_pending=0
sleep_attempts=0
next_sleep=0
pslog_pid=
event_dir=
event_fd_open=0

log() {
    local message
    message="$(/bin/date '+%Y-%m-%d %H:%M:%S') $*"
    if [ "$DRY_RUN" = 1 ]; then
        printf '%s\n' "$message" || :
    else
        # A broken log must never block power management, including cleanup.
        { printf '%s\n' "$message" >> "$LOG"; } 2>/dev/null || {
            printf '%s\n' "lid-awake: cannot write log: $message" >&2 || :
        }
    fi
    return 0
}

set_sleep() {
    if [ "$DRY_RUN" = 1 ]; then
        log "DRY_RUN: $PMSET -a disablesleep $1"
    else
        /bin/bash "$TIMEOUT" 10 "$PMSET" -a disablesleep "$1" >/dev/null 2>&1
    fi
}

cleanup() {
    local status=$?
    trap - EXIT
    trap '' TERM INT HUP
    if set_sleep 0; then
        log 'stopped; disablesleep=0'
    else
        log 'ERROR restoring disablesleep=0'
        status=1
    fi
    if [ -n "$pslog_pid" ]; then
        kill -KILL "$pslog_pid" 2>/dev/null || :
        wait "$pslog_pid" 2>/dev/null || :
    fi
    if [ "$event_fd_open" = 1 ]; then exec 3>&-; fi
    if [ -n "$event_dir" ]; then /bin/rm -rf "$event_dir"; fi
    exit "$status"
}

if [ "$DRY_RUN" != 1 ] && [ "$EUID" -ne 0 ]; then
    printf '%s\n' 'Run through the root LaunchDaemon, or use DRY_RUN=1.' >&2
    exit 1
fi
if [ "$DRY_RUN" != 1 ]; then
    for name in ${!LID_AWAKE_@}; do
        printf '%s\n' "Simulation variable $name requires DRY_RUN=1." >&2
        exit 1
    done
else
    POLL_SECONDS=${LID_AWAKE_POLL_SECONDS:-15}
    case "$POLL_SECONDS" in
        ''|*[!0-9]*|0|0*) printf '%s\n' 'Poll interval must be a positive integer.' >&2; exit 1 ;;
    esac
    fake_sleep_failures=${LID_AWAKE_FAKE_SLEEP_FAILURES:-0}
    case "$fake_sleep_failures" in
        ''|*[!0-9]*|0?*) printf '%s\n' 'Sleep failures must be a nonnegative integer.' >&2; exit 1 ;;
    esac
    if [ "${LID_AWAKE_RETRY_DELAYS+x}" = x ]; then
        read -r -a RETRY_DELAYS <<< "$LID_AWAKE_RETRY_DELAYS"
        [ "${#RETRY_DELAYS[@]}" -eq 4 ] || { printf '%s\n' 'Provide four retry delays.' >&2; exit 1; }
        for delay in "${RETRY_DELAYS[@]}"; do
            case "$delay" in ''|*[!0-9]*|0|0*) printf '%s\n' 'Retry delays must be positive integers.' >&2; exit 1 ;; esac
        done
    fi
    if [ "${LID_AWAKE_FAKE_PS+x}" = x ] || [ "${LID_AWAKE_FAKE_PS_FILE+x}" = x ]; then
        FAKE_MODE=1
    fi
fi
case "${1:-}" in ''|--guard) ;; *) printf '%s\n' 'Usage: lid-awake.sh [--guard]' >&2; exit 2 ;; esac

read_source() {
    local output first fake
    SOURCE=Unknown
    if [ "$FAKE_MODE" = 1 ]; then
        fake=${LID_AWAKE_FAKE_PS:-}
        if [ "${LID_AWAKE_FAKE_PS_FILE+x}" = x ]; then
            fake=
            if [ -f "$LID_AWAKE_FAKE_PS_FILE" ] && [ -r "$LID_AWAKE_FAKE_PS_FILE" ]; then
                IFS= read -r fake < "$LID_AWAKE_FAKE_PS_FILE" || :
            fi
        fi
        case "$fake" in AC|Battery) SOURCE=$fake ;; esac
    elif output=$(/bin/bash "$TIMEOUT" 10 "$PMSET" -g ps 2>/dev/null); then
        first=${output%%$'\n'*}
        case "$first" in
            "Now drawing from 'AC Power'"*) SOURCE=AC ;;
            "Now drawing from 'Battery Power'"*) SOURCE=Battery ;;
        esac
    fi
}

read_lid() {
    local output fake
    LID=Unknown
    if [ "$DRY_RUN" = 1 ] && {
        [ "${LID_AWAKE_FAKE_LID+x}" = x ] || [ "${LID_AWAKE_FAKE_LID_FILE+x}" = x ];
    }; then
        fake=${LID_AWAKE_FAKE_LID:-}
        if [ "${LID_AWAKE_FAKE_LID_FILE+x}" = x ]; then
            fake=
            if [ -f "$LID_AWAKE_FAKE_LID_FILE" ] && [ -r "$LID_AWAKE_FAKE_LID_FILE" ]; then
                IFS= read -r fake < "$LID_AWAKE_FAKE_LID_FILE" || :
            fi
        fi
        case "$fake" in closed|open) LID=$fake ;; esac
    elif output=$(/bin/bash "$TIMEOUT" 10 "$IOREG" -r -k AppleClamshellState -d 4 2>/dev/null); then
        if printf '%s\n' "$output" | /usr/bin/grep -Eq '"AppleClamshellState"[[:space:]]*=[[:space:]]*Yes([[:space:]]|$)'; then
            LID=closed
        elif printf '%s\n' "$output" | /usr/bin/grep -Eq '"AppleClamshellState"[[:space:]]*=[[:space:]]*No([[:space:]]|$)'; then
            LID=open
        fi
    fi
}

guard() {
    local output value
    read_source
    [ "$SOURCE" = Battery ] || return 0
    if [ "$DRY_RUN" = 1 ] && [ "${LID_AWAKE_FAKE_DISABLESLEEP+x}" = x ]; then
        value=$LID_AWAKE_FAKE_DISABLESLEEP
    else
        output=$(/bin/bash "$TIMEOUT" 10 "$PMSET" -g 2>/dev/null) || {
            log 'guard: cannot read disablesleep'; return 1;
        }
        value=$(printf '%s\n' "$output" | /usr/bin/awk 'tolower($1)=="sleepdisabled" || tolower($1)=="disablesleep" {print $2; exit}')
    fi
    [ "$value" = 1 ] || return 0
    read_source
    [ "$SOURCE" = Battery ] || return 0
    if set_sleep 0; then
        log 'guard: Battery; restored disablesleep=0'
    else
        log 'guard: ERROR restoring disablesleep=0'
        return 1
    fi
}

# Stateless guard: no main-daemon cleanup and never sleepnow.
if [ "${1:-}" = --guard ]; then
    guard
    exit $?
fi

trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
trap 'exit 129' HUP

retry_sleep() {
    local failed=1
    read_source
    if [ "$SOURCE" = AC ]; then
        sleep_pending=0
        log 'sleep retries cancelled: source=AC'
        return
    fi
    read_lid
    if [ "$LID" = open ]; then
        sleep_pending=0
        log 'sleep retries cancelled: lid=open'
        return
    fi
    sleep_attempts=$((sleep_attempts + 1))
    # Re-read after ioreg, immediately before the actual sleep request.
    read_source
    if [ "$SOURCE" = AC ]; then
        sleep_pending=0
        log 'sleep retries cancelled: source=AC'
        return
    fi
    if [ "$SOURCE" = Battery ] && [ "$LID" = closed ]; then
        log "lid=closed; sleepnow attempt $sleep_attempts/5"
        # Clear before sleep so resume cannot replay a successful request.
        sleep_pending=0
        if [ "$DRY_RUN" = 1 ]; then
            log "DRY_RUN: $PMSET sleepnow"
            if [ "$fake_sleep_failures" -gt 0 ]; then
                fake_sleep_failures=$((fake_sleep_failures - 1))
                log 'DRY_RUN: sleepnow failed'
            else
                failed=0
            fi
        elif /bin/bash "$TIMEOUT" 10 "$PMSET" sleepnow >/dev/null 2>&1; then
            failed=0
        fi
    else
        log "sleepnow check $sleep_attempts/5: source=$SOURCE; lid=$LID; deferred"
    fi
    if [ "$failed" = 0 ]; then
        log 'sleepnow succeeded; no further retries on this Battery entry'
    elif [ "$sleep_attempts" -lt 5 ]; then
        sleep_pending=1
        next_sleep=$((SECONDS + RETRY_DELAYS[sleep_attempts - 1]))
        log "sleepnow not completed; retry in ${RETRY_DELAYS[sleep_attempts - 1]}s"
    else
        sleep_pending=0
        log 'ERROR: sleepnow not completed after 5 checks; retries exhausted'
    fi
}

check_source() {
    local desired=0 battery_entry=0
    read_source
    if [ "$SOURCE" = AC ] && [ "$last_value" != 1 ]; then
        read_source
    fi
    if [ "$SOURCE" = AC ]; then desired=1; fi
    if [ "$last_value" != "$desired" ]; then
        if ! set_sleep "$desired"; then
            log "ERROR applying disablesleep=$desired; exiting to reset"
            exit 1
        fi
        if [ "$desired" = 1 ]; then
            # Catch power loss during the write, without waiting for another poll.
            read_source
            if [ "$SOURCE" != AC ]; then
                set_sleep 0 || { log 'ERROR restoring disablesleep=0'; exit 1; }
                desired=0
            fi
        fi
        last_value=$desired
    fi
    if [ "$SOURCE" = Battery ] && {
        [ -z "$last_known_source" ] || [ "$last_known_source" = AC ];
    }; then
        battery_entry=1
    fi
    case "$SOURCE" in AC|Battery) last_known_source=$SOURCE ;; esac
    if [ "$SOURCE" = AC ]; then
        if [ "$sleep_pending" = 1 ]; then log 'sleep retries cancelled: source=AC'; fi
        sleep_pending=0
    fi
    if [ "$last_source" != "$SOURCE" ]; then
        log "source=$SOURCE; disablesleep=$desired"
        last_source=$SOURCE
    fi
    if [ "$battery_entry" = 1 ]; then
        sleep_pending=1
        sleep_attempts=0
        next_sleep=$SECONDS
    fi
}

log "started; poll=${POLL_SECONDS}s; dry_run=$DRY_RUN"
if [ "$FAKE_MODE" = 0 ]; then
    event_dir=$(/usr/bin/mktemp -d /private/tmp/lid-awake.XXXXXX) || exit 1
    /usr/bin/mkfifo "$event_dir/events" || exit 1
    exec 3<> "$event_dir/events" || exit 1
    event_fd_open=1
    # pslog is intentionally a long-lived stream; queries/writes have timeouts.
    "$PMSET" -g pslog >&3 2>/dev/null &
    pslog_pid=$!
fi

check_source
if [ "$sleep_pending" = 1 ]; then retry_sleep; fi
next_poll=$((SECONDS + POLL_SECONDS))
while :; do
    if [ "$event_fd_open" = 1 ]; then
        if IFS= read -r -t 1 event <&3; then check_source; fi
        if [ -n "$pslog_pid" ] && ! kill -0 "$pslog_pid" 2>/dev/null; then
            wait "$pslog_pid" 2>/dev/null || :
            pslog_pid=
            exec 3>&-
            event_fd_open=0
            log 'pslog stopped; polling only'
        fi
    else
        /bin/sleep 1
    fi
    if [ "$SECONDS" -ge "$next_poll" ]; then
        check_source
        next_poll=$((SECONDS + POLL_SECONDS))
    fi
    if [ "$sleep_pending" = 1 ] && [ "$SECONDS" -ge "$next_sleep" ]; then retry_sleep; fi
done
