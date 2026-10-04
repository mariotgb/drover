#!/bin/bash
# VPS only. --reset removes old rules; otherwise existing ALLOW rules remain.
# A root-owned systemd timer restores the old ufw state in five minutes unless
# --confirm TOKEN is run from a NEW SSH connection. Keep the old session open.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$here/lib.sh"
STATE=/var/lib/drover-firewall

valid_firewall_token() { [[ "$1" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$ ]]; }

cancel_firewall_timer() {
  local unit="$1" state
  if systemctl stop "$unit.timer" 2>/dev/null; then return 0; fi
  # A transient unit can already have been garbage-collected. That is also
  # cancellation, not a reason to leave a completed transaction blocking reuse.
  state="$(systemctl show "$unit.timer" -p LoadState --value 2>/dev/null || true)"
  [ "$state" = not-found ]
}

main() {
  local reset=0 yes=0 confirm="" ports p ans token unit pending active current_token
  while [ $# -gt 0 ]; do
    case "$1" in --reset) reset=1; shift;; --yes) yes=1; shift;;
      --confirm) confirm="${2:?}"; shift 2;; *) die "unknown option: $1";; esac
  done
  require_root; require_debian_like
  command -v systemd-run >/dev/null || die "systemd-run is needed for automatic rollback"
  command -v flock >/dev/null || die "flock missing"
  [ ! -L "$STATE" ] || die "$STATE is a symlink"
  install -d -m 700 -o root -g root "$STATE"
  exec 9>"$STATE/lock"; flock -x 9
  # Never reuse a legacy shared pending directory: an old callback may still
  # reference it. The operator must settle that installation first.
  [ ! -e "$STATE/pending" ] && [ ! -L "$STATE/pending" ] || die "legacy pending exists; settle/cancel its old timer before using this installer"
  [ ! -L "$STATE/transactions" ] || die "transactions directory is a symlink"
  install -d -m 700 -o root -g root "$STATE/transactions"
  current_token=""
  [ ! -L "$STATE/current" ] || die "current pointer is a symlink"
  if [ -e "$STATE/current" ]; then
    current_token="$(cat "$STATE/current")"
    valid_firewall_token "$current_token" || die "invalid current transaction token; refusing to adopt it"
    pending="$STATE/transactions/$current_token"
    [ ! -L "$pending" ] && [ ! -L "$pending/token" ] && [ -f "$pending/token" ] && [ "$(cat "$pending/token")" = "$current_token" ] || die "current transaction identity mismatch; refusing to adopt it"
    [ "$(cat "$pending/owner" 2>/dev/null)" = drover-firewall-v1 ] && [ "$(cat "$pending/unit" 2>/dev/null)" = "drover-firewall-$current_token" ] && [ -f "$pending/rollback.sh" ] || die "foreign current transaction; refusing to adopt it"
  fi
  if [ -n "$confirm" ]; then
    valid_firewall_token "$confirm" && [ "$current_token" = "$confirm" ] || die "no matching current change"
    [ ! -e "$pending/rolled-back" ] && [ ! -e "$pending/confirmed" ] && [ ! -e "$pending/aborted" ] || die "change already rolled back/confirmed/aborted"
    [ -n "${SSH_CONNECTION:-}" ] && [ "$SSH_CONNECTION" != "$(cat "$pending/connection")" ] || die "confirm from a NEW SSH connection, preserving SSH_CONNECTION through sudo"
    unit="drover-firewall-$confirm"
    touch "$pending/confirmed" # A queued callback must never roll back after approval.
    cancel_firewall_timer "$unit"
    systemctl stop "$unit.service" 2>/dev/null || true
    rm -f "$STATE/current"
    say "Confirmed from a new SSH connection; rollback timer cancelled."
    return
  fi
  if [ -n "$current_token" ]; then
    if [ -e "$pending/confirmed" ] || [ -e "$pending/rolled-back" ] || [ -e "$pending/aborted" ]; then
      cancel_firewall_timer "drover-firewall-$current_token" || die "cannot cancel previous transaction's timer"
      rm -f "$STATE/current"
    else die "a firewall change is still pending; confirm it or wait for its rollback"; fi
  fi
  command -v ufw >/dev/null || die "install ufw first, then re-run"
  grep -qx 'IPV6=yes' /etc/default/ufw || die "enable IPV6=yes in /etc/default/ufw first (IPv6 must be filtered too)"
  ports="$(ssh_listener_ports)"; [ -n "$ports" ] || die "no actual SSH listeners found"
  say "Live SSH ports (ss -ltnp + SSH_CONNECTION): $(echo $ports)"
  say "SSH ALLOW rules go first, followed by HTTP/HTTPS; default incoming DENY."
  [ "$reset" = 1 ] || warn "existing ALLOW rules remain; only --reset limits inbound ports to SSH/80/443"
  if [ "$yes" != 1 ]; then
    read -r -p 'Apply with a five-minute automatic rollback? [y/N] ' ans
    [ "$ans" = y ] || [ "$ans" = Y ] || die "aborted"
  fi
  token="$(cat /proc/sys/kernel/random/uuid)"
  valid_firewall_token "$token" || die "invalid generated transaction token"
  pending="$STATE/transactions/$token"; mkdir -m 700 "$pending"
  unit="drover-firewall-$token"
  printf 'drover-firewall-v1\n' > "$pending/owner"
  printf '%s\n' "$token" > "$pending/token"; printf '%s\n' "$unit" > "$pending/unit"
  printf '%s\n' "${SSH_CONNECTION:-}" > "$pending/connection"
  active=0; ufw status | grep -q '^Status: active' && active=1
  printf '%s\n' "$active" > "$pending/active"
  tar -C / -cpf "$pending/config.tar" etc/ufw etc/default/ufw
  cat > "$pending/rollback.sh" <<'ROLLBACK'
#!/bin/bash
set -euo pipefail
cancel_firewall_timer() {
  local unit="$1" state
  if systemctl stop "$unit.timer" 2>/dev/null; then return 0; fi
  # A transient unit can already have been garbage-collected. That is also
  # cancellation, not a reason to leave a completed transaction blocking reuse.
  state="$(systemctl show "$unit.timer" -p LoadState --value 2>/dev/null || true)"
  [ "$state" = not-found ]
}

STATE=/var/lib/drover-firewall
expected_token="${1:-}"
[[ "$expected_token" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$ ]] || exit 1
transaction="$STATE/transactions/$expected_token"
# The timer's argv and immutable script path must identify the same transaction.
[ "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)" = "$transaction" ] || exit 1
[ ! -L "$transaction" ] && [ "$(cat "$transaction/token")" = "$expected_token" ] || exit 1
unit="drover-firewall-$expected_token"
exec 9>"$STATE/lock"; flock -x 9
cd "$transaction"
if [ -f confirmed ] || [ -f rolled-back ] || [ -f aborted ]; then
  cancel_firewall_timer "$unit"
  exit 0
fi
# Even an already queued old callback cannot act on a later transaction.
if [ ! -f "$STATE/current" ] || [ "$(cat "$STATE/current")" != "$expected_token" ]; then
  cancel_firewall_timer "$unit"
  exit 0
fi
ufw --force disable
tar -C / -xpf config.tar
if [ "$(cat active)" = 1 ]; then ufw --force enable; else ufw --force disable; fi
touch rolled-back
cancel_firewall_timer "$unit" # Includes immediate rollback after an apply error.
# Still under the lock, and remove only our own current pointer.
[ "$(cat "$STATE/current")" != "$expected_token" ] || rm -f "$STATE/current"
logger -t drover-firewall "Firewall transaction $expected_token rolled back"
ROLLBACK
  chmod 700 "$pending/rollback.sh"
  # Arm BEFORE any mutation; the timer survives SSH disconnection/script failure.
  printf '%s\n' "$token" > "$STATE/current.new"; mv "$STATE/current.new" "$STATE/current"
  if ! systemd-run --unit="$unit" --on-active=5m --timer-property=AccuracySec=1s --property=Type=oneshot /bin/bash "$pending/rollback.sh" "$token" || ! systemctl is-active --quiet "$unit.timer"; then
    touch "$pending/aborted"
    cancel_firewall_timer "$unit" || warn "failed to cancel aborted timer (its callback cannot change rules)"
    rm -f "$STATE/current"
    die "rollback timer did not start; no firewall change made"
  fi
  FIREWALL_ROLLBACK_UNIT="$unit"
  trap 'status=$?; if [ "$status" != 0 ]; then warn "apply failed: requesting immediate rollback"; flock -u 9; systemctl start "$FIREWALL_ROLLBACK_UNIT.service" || warn "rollback start failed; timer remains armed"; fi' EXIT
  [ "$reset" != 1 ] || ufw --force reset >/dev/null
  # Unlike "insert 1", prepend also accepts the empty ruleset after --reset.
  for p in $ports; do ufw prepend allow "$p/tcp" comment 'drover SSH rescue' >/dev/null; done
  ufw allow 80/tcp comment 'caddy http/acme' >/dev/null
  ufw allow 443/tcp comment 'caddy https' >/dev/null
  ufw default allow outgoing >/dev/null
  ufw default deny incoming >/dev/null
  ufw --force enable >/dev/null
  # Duplicate rules may not be moved by ufw. Reject a retained DENY before SSH;
  # validate each address family's leading rules instead of assuming insert worked.
  ufw status numbered | awk -v ports="$(echo $ports)" '
    BEGIN {n=split(ports,p," "); for(i=1;i<=n;i++) wanted[p[i] "/tcp"]=1}
    /^\[/ {line=$0; sub(/^\[[^]]*\][[:space:]]*/,"",line); family=(line ~ /\(v6\)/ ? 6 : 4);
      if (++seen[family]<=n && (!( $0 ~ /ALLOW IN/) || !wanted[linekey(line)])) bad=1}
    function linekey(s) {split(s,a,/ +/); return a[1]}
    END {if(seen[4]<n || seen[6]<n || bad) exit 1}' || die "SSH rules are not first for IPv4/IPv6; refusing unsafe ordering"
  trap - EXIT
  ufw status verbose
  say "From a NEW SSH login within five minutes run:"
  say "  sudo --preserve-env=SSH_CONNECTION $0 --confirm $token"
  say "Until confirmed, automatic rollback remains armed. Existing ALLOW rules and Docker-published ports need separate review."
}
if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
