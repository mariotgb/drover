#!/bin/bash
# Run ON THE VPS (Debian/Ubuntu), as root. NOT for the Mac. Safe to re-run.
#
#   sudo --preserve-env=SSH_CONNECTION ./vps-setup.sh [--mac-key F] [--pc-key F] [--home-key F] \
#                       [--jump-mac-key F] [--jump-iphone-key F] [--yes]
#                       [--context HOST,CLIENT_IP,VPS_IP,SSH_PORT] [--retire-legacy]
#   sudo --preserve-env=SSH_CONNECTION ./vps-setup.sh --check          # only verify the live sshd config
#
# Every option names a file with ONE public key. Hub layout (all ports are
# loopback-only on the VPS, nothing is opened in the firewall):
#
#   user         key from          may do                                port(s)
#   bridge-mac   the MacBook       reverse tunnel only (-R)              2222 (ssh), 8780 (Drover site)
#   bridge-pc    the Windows PC    reverse tunnel only (-R)              2223
#   bridge-home  the home server   reverse tunnel only (-R)              2224
#   jump         iPhone / Mac      ProxyJump only (-L / -W), no -R       iPhone: 2222; Mac: 2223, 2224
#
# Needs OpenSSH >= 7.8 on the VPS (Debian 12+, Ubuntu 22.04+) for PermitListen.
# KEEP YOUR CURRENT ADMIN SESSION OPEN until a fresh login has been tested.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$here/lib.sh"

DROPIN_NAME="060-drover-hub.conf"  # old layout; removed during migration
POLICY_FILE="${POLICY_FILE:-/etc/ssh/drover-hub-policy.conf}"
HUB_CONTEXTS=""
RETIRE_LEGACY=0

# spec USER -> "forwarding-mode|PermitOpen|PermitListen"
spec() {
  case "$1" in
    bridge-mac)  echo "remote|none|127.0.0.1:2222 127.0.0.1:8780" ;;
    bridge-pc)   echo "remote|none|127.0.0.1:2223" ;;
    bridge-home) echo "remote|none|127.0.0.1:2224" ;;
    jump)        echo "local|127.0.0.1:2222 127.0.0.1:2223 127.0.0.1:2224|none" ;;
  esac
}
HUB_USERS="bridge-mac bridge-pc bridge-home jump"

render_dropin() {
  local u s mode open listen
  printf '%s\n' \
    '# Managed by vps-setup.sh — edit the script, not this file.' \
    '# One restricted user per machine. MaxSessions 0 forbids shells, commands and' \
    '# SFTP; only the forwarding listed per user remains.'
  for u in $HUB_USERS; do
    s="$(spec "$u")"; mode="${s%%|*}"; s="${s#*|}"; open="${s%%|*}"; listen="${s#*|}"
    printf '\nMatch User %s\n' "$u"
    printf '    %s\n' \
      "PubkeyAuthentication yes" \
      "PasswordAuthentication no" \
      "KbdInteractiveAuthentication no" \
      "AuthenticationMethods publickey" \
      "DisableForwarding no" \
      "AllowTcpForwarding $mode" \
      "PermitOpen $open" \
      "PermitListen $listen" \
      "GatewayPorts no" \
      "AllowStreamLocalForwarding no" \
      "PermitTunnel no" \
      "AllowAgentForwarding no" \
      "X11Forwarding no" \
      "PermitTTY no" \
      "MaxSessions 0" \
      "ClientAliveInterval 30" \
      "ClientAliveCountMax 3"
  done
  if [ "$RETIRE_LEGACY" = 1 ]; then
    printf '\nMatch User bridge\n    DenyUsers bridge\n    AuthenticationMethods any\n    HostbasedAuthentication no\n    GSSAPIAuthentication no\n    PubkeyAuthentication no\n    PasswordAuthentication no\n    KbdInteractiveAuthentication no\n    DisableForwarding yes\n    MaxSessions 0\n'
  fi
  # Close the last Match block so nothing read after this file can fall inside it.
  printf '\nMatch all\n'
}

# Every supplied context is an actual client's hostname/address and VPS listener.
# SSH_CONNECTION supplies the current administrator's real connection. --context
# lets the operator add the Mac/PC/home connections (host,addr,laddr,lport).
load_contexts() {
  local addr source laddr port host connection
  if [ -n "${SSH_CONNECTION:-}" ]; then
    connection="$SSH_CONNECTION"; set -- $connection
    [ "$#" = 4 ] || die "malformed SSH_CONNECTION"
    addr="$1"; laddr="$3"; port="$4"
    # Missing reverse DNS is normal for VPN/NAT clients; keep the real address.
    host="$(getent hosts "$addr" | awk 'NR==1 {print $2}' || true)"; host="${host:-$addr}"
    HUB_CONTEXTS="$host,$addr,$laddr,$port
$HUB_CONTEXTS"
  fi
  [ -n "$HUB_CONTEXTS" ] || die "provide actual --context HOST,CLIENT_IP,VPS_IP,SSH_PORT (or preserve SSH_CONNECTION through sudo)"
  while IFS=, read -r host addr laddr port extra; do
    [ -n "$host" ] || continue
    [ -z "${extra:-}" ] && [[ "$host" =~ ^[A-Za-z0-9._:-]+$ ]] && [[ "$addr" =~ ^[0-9A-Fa-f:.]+$ ]] && [[ "$laddr" =~ ^[0-9A-Fa-f:.]+$ ]] && [[ "$port" =~ ^[0-9]+$ ]] && [ "$port" -ge 1 ] && [ "$port" -le 65535 ] || die "invalid context: $host,$addr,$laddr,$port"
  done <<< "$HUB_CONTEXTS"
}
verify_hub() {
  local c="$1" u s mode open listen port addr laddr host out label
  for u in $HUB_USERS; do
    s="$(spec "$u")"; mode="${s%%|*}"; s="${s#*|}"; open="${s%%|*}"; listen="${s#*|}"
    while IFS=, read -r host addr laddr port; do
      [ -n "$host" ] || continue
      label="$u host=$host client=$addr local=$laddr:$port"
      out="$(SSHD_CTX_HOST="$host" sshd_T "$c" "$u" "$addr" "$laddr" "$port")" || return 1
      expect_eq "$out" allowtcpforwarding "$mode" "$label"
      expect_eq "$out" permitopen "$open" "$label"
      expect_eq "$out" permitlisten "$listen" "$label"
      expect_eq "$out" gatewayports no "$label"
      expect_eq "$out" allowstreamlocalforwarding no "$label"
      expect_eq "$out" permittunnel no "$label"
      expect_eq "$out" maxsessions 0 "$label"
      expect_eq "$out" pubkeyauthentication yes "$label"
      expect_eq "$out" passwordauthentication no "$label"
      expect_eq "$out" kbdinteractiveauthentication no "$label"
      expect_eq "$out" clientaliveinterval 30 "$label"
      expect_eq "$out" clientalivecountmax 3 "$label"
      expect_eq "$out" disableforwarding no "$label"
      expect_eq "$out" allowagentforwarding no "$label"
      expect_eq "$out" x11forwarding no "$label"
      expect_eq "$out" permittty no "$label"
      check_login_allowed "$out" "$u" "$label"
      if [ "$RETIRE_LEGACY" = 1 ]; then
        out="$(SSHD_CTX_HOST="$host" sshd_T "$c" bridge "$addr" "$laddr" "$port")" || return 1
        expect_eq "$out" denyusers bridge "legacy bridge"
        expect_eq "$out" pubkeyauthentication no "legacy bridge"
        expect_eq "$out" passwordauthentication no "legacy bridge"
        expect_eq "$out" kbdinteractiveauthentication no "legacy bridge"
        expect_eq "$out" disableforwarding yes "legacy bridge"
        expect_eq "$out" maxsessions 0 "legacy bridge"
      fi
    done <<< "$HUB_CONTEXTS"
  done
  [ "$VERIFY_FAIL" = 0 ]
}

# Retire only after the NEW account owns both reverse listeners. Never infer
# successful migration merely from a port number (it could be legacy bridge).
verify_new_tunnel() {
  local port lines pid owner ok
  for port in 2222 8780; do
    lines="$(ss -ltnpH | awk -v p="$port" '$4 == "127.0.0.1:" p')"
    ok=0
    for pid in $(printf '%s\n' "$lines" | grep -oE 'pid=[0-9]+' | cut -d= -f2); do
      owner="$(ps -o user= -p "$pid" | tr -d ' ')"
      [ "$owner" != bridge-mac ] || ok=1
    done
    [ "$ok" = 1 ] || die "cannot prove bridge-mac owns loopback port $port; start/check the new tunnel first"
  done
}

# Key options. permitlisten/permitopen repeat the sshd-level limits per key.
opts_listen() { local o="restrict,port-forwarding" a; for a in "$@"; do o="$o,permitlisten=\"$a\""; done; printf '%s' "$o"; }
opts_open()   { local o="restrict,port-forwarding" a; for a in "$@"; do o="$o,permitopen=\"$a\""; done; printf '%s' "$o"; }

hub_transaction_exit() {
  local status="$1" path backup u failed=0 transaction="$HUB_TRANSACTION"
  trap - EXIT
  if [ "$status" != 0 ]; then
    python3 "$here/hub-config.py" restore "$transaction" || failed=1
    while IFS='|' read -r path backup; do
      if [ -n "$backup" ]; then cp -p "$backup" "$path" || failed=1
      else rm -f "$path" || failed=1; fi
    done < "$transaction/keys"
    while IFS= read -r u; do
      if getent passwd "$u" >/dev/null; then userdel -r "$u" || failed=1; fi
    done < "$transaction/users"
    "$SSHD_BIN" -t -f "$SSHD_CONFIG" && reload_sshd || failed=1
    if [ "$failed" = 0 ]; then warn "previous config/keys/accounts restored and sshd reloaded"
    else warn "ROLLBACK INCOMPLETE; backups kept in $transaction; keep admin session open"; exit "$status"; fi
  fi
  rm -rf "$transaction"
  exit "$status"
}

main() {
  local mac="" pc="" home_key_file="" jmac="" jphone="" check=0 yes=0 ans
  while [ $# -gt 0 ]; do
    case "$1" in
      --mac-key) mac="${2:?}"; shift 2;;
      --pc-key) pc="${2:?}"; shift 2;;
      --home-key) home_key_file="${2:?}"; shift 2;;
      --jump-mac-key) jmac="${2:?}"; shift 2;;
      --jump-iphone-key) jphone="${2:?}"; shift 2;;
      --context) HUB_CONTEXTS="$HUB_CONTEXTS${2:?}
"; shift 2;;
      --retire-legacy) RETIRE_LEGACY=1; shift;;
      --check) check=1; shift;;
      --yes) yes=1; shift;;
      *) die "unknown option: $1";;
    esac
  done
  require_root; require_debian_like
  command -v ssh-keygen >/dev/null || die "ssh-keygen missing"
  command -v python3 >/dev/null || die "python3 is required for transactional Include placement"
  load_contexts
  local listeners u
  listeners="$(ssh_listener_ports)"; [ -n "$listeners" ] || die "no real SSH listener found"
  while IFS=, read -r host addr laddr port; do
    [ -z "$host" ] || printf '%s\n' "$listeners" | grep -qx "$port" || die "context port $port is not an SSH listener"
  done <<< "$HUB_CONTEXTS"
  # Preserve an earlier completed legacy retirement on every reinstallation.
  if [ -f "$POLICY_FILE" ] && grep -qx 'Match User bridge' "$POLICY_FILE"; then RETIRE_LEGACY=1; fi
  for u in $HUB_USERS; do check_hub_user "$u"; done
  if getent passwd bridge >/dev/null; then
    check_hub_user bridge
    if [ "$RETIRE_LEGACY" = 1 ] && ! grep -qx 'Match User bridge' "$POLICY_FILE" 2>/dev/null; then verify_new_tunnel; fi
  fi

  if [ "$check" = 1 ]; then
    VERIFY_FAIL=0; verify_hub "$SSHD_CONFIG"
    [ "$VERIFY_FAIL" = 0 ] || exit 1
    say "OK: live sshd config matches the hub layout"
    exit 0
  fi
  [ -n "$mac$pc$home_key_file$jmac$jphone" ] || [ "$RETIRE_LEGACY" = 1 ] || die "give at least one --*-key (see the header of this script)"

  # Validate EVERY key before changing anything.
  local k_mac="" k_pc="" k_home="" k_jmac="" k_jphone=""
  [ -z "$mac" ]    || k_mac="$(read_pubkey "$mac")"
  [ -z "$pc" ]     || k_pc="$(read_pubkey "$pc")"
  [ -z "$home_key_file" ]   || k_home="$(read_pubkey "$home_key_file")"
  [ -z "$jmac" ]   || k_jmac="$(read_pubkey "$jmac")"
  [ -z "$jphone" ] || k_jphone="$(read_pubkey "$jphone")"

  if [ "$yes" != 1 ]; then
    say "This will install $POLICY_FILE before the first Match, create/refresh the restricted users and reload sshd."
    say "Keep your current admin SSH session open until you have logged in again from a NEW terminal."
    read -r -p "Continue? [y/N] " ans
    [ "$ans" = y ] || [ "$ans" = Y ] || die "aborted"
  fi

  # Snapshot keys and the Include insertion point before ANY live modification.
  local transaction candidate home_dir idx=0 entry
  transaction="$(mktemp -d)"; HUB_TRANSACTION="$transaction"
  chmod 700 "$transaction"
  render_dropin > "$transaction/policy"
  candidate="$(python3 "$here/hub-config.py" prepare "$SSHD_CONFIG" "$DROPIN_DIR/$DROPIN_NAME" "$POLICY_FILE" "$transaction")"
  VERIFY_FAIL=0
  "$SSHD_BIN" -t -f "$candidate" && verify_hub "$candidate" || { rm -rf "$transaction"; die "candidate rejected; nothing changed"; }
  : > "$transaction/keys"; : > "$transaction/users"
  for u in $HUB_USERS; do
    if entry="$(getent passwd "$u")"; then
      home_dir="$(printf '%s' "$entry" | cut -d: -f6)"
      if [ -e "$home_dir/.ssh/authorized_keys" ]; then
        cp -p "$home_dir/.ssh/authorized_keys" "$transaction/key-$idx"
        printf '%s|%s\n' "$home_dir/.ssh/authorized_keys" "$transaction/key-$idx" >> "$transaction/keys"
      else printf '%s|\n' "$home_dir/.ssh/authorized_keys" >> "$transaction/keys"; fi
    else printf '%s\n' "$u" >> "$transaction/users"; fi
    idx=$((idx+1))
  done
  trap 'hub_transaction_exit $?' EXIT

  # 2) users and keys
  if [ -n "$k_mac" ]; then
    ensure_hub_user bridge-mac
    set_authorized_key bridge-mac "$(opts_listen 127.0.0.1:2222 127.0.0.1:8780)" "$k_mac" drover-mac-tunnel
  fi
  if [ -n "$k_pc" ]; then
    ensure_hub_user bridge-pc
    set_authorized_key bridge-pc "$(opts_listen 127.0.0.1:2223)" "$k_pc" drover-pc-tunnel
  fi
  if [ -n "$k_home" ]; then
    ensure_hub_user bridge-home
    set_authorized_key bridge-home "$(opts_listen 127.0.0.1:2224)" "$k_home" drover-home-tunnel
  fi
  if [ -n "$k_jmac$k_jphone" ]; then ensure_hub_user jump; fi
  if [ -n "$k_jphone" ]; then
    set_authorized_key jump "$(opts_open 127.0.0.1:2222)" "$k_jphone" drover-iphone
  fi
  if [ -n "$k_jmac" ]; then
    set_authorized_key jump "$(opts_open 127.0.0.1:2223 127.0.0.1:2224)" "$k_jmac" drover-mac-jump
  fi

  # Commit/reload is part of the transaction: reload failure is fatal, not hidden.
  python3 "$here/hub-config.py" commit "$transaction"
  VERIFY_FAIL=0
  "$SSHD_BIN" -t -f "$SSHD_CONFIG" && verify_hub "$SSHD_CONFIG" && reload_sshd || die "live validation/reload failed; rolling back"
  if [ "$RETIRE_LEGACY" = 1 ] && getent passwd bridge >/dev/null; then
    # Auth/forwarding are now denied for new connections. Close existing legacy
    # processes too; otherwise their already-open forwards survive a reload.
    pkill -u "$(id -u bridge)" || [ "$?" = 1 ] || die "failed to terminate legacy bridge sessions"
    say "legacy bridge disabled (authentication/forwarding denied; sessions closed)"
  elif getent passwd bridge >/dev/null; then
    warn "legacy bridge is still active: test bridge-mac's NEW tunnel and SSH login, then run $0 --retire-legacy"
  fi
  trap - EXIT
  rm -rf "$transaction"
  say "Done. Keep this session open and confirm a NEW administrator login."
  say "Check with: sudo --preserve-env=SSH_CONNECTION $0 --check"

}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
