#!/bin/bash
# Bound a single process (pmset/ioreg), without GNU timeout.
set -u
export PATH=/usr/bin:/bin:/usr/sbin:/sbin
limit=${1:-}
case "$limit" in ''|*[!0-9]*|0|0*) exit 2 ;; esac
shift
[ "$#" -gt 0 ] || exit 2
pid=
stop() {
    if [ -n "$pid" ]; then
        kill -KILL "$pid" 2>/dev/null || :
        wait "$pid" 2>/dev/null || :
    fi
}
trap 'stop; exit 143' TERM
trap 'stop; exit 130' INT
trap 'stop; exit 129' HUP
"$@" &
pid=$!
deadline=$((SECONDS + limit))
while kill -0 "$pid" 2>/dev/null; do
    if [ "$SECONDS" -ge "$deadline" ]; then
        stop
        exit 124
    fi
    /bin/sleep 0.1
done
wait "$pid"
status=$?
pid=
exit "$status"
