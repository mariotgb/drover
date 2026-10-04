#!/bin/bash
# Drover bridge installer for THIS Mac. Run it yourself, one step at a time.
#
#   ./install.sh keys                          create the three Mac keys (never overwrites)
#   ./install.sh add-key 'ssh-ed25519 AAAA…'   let the iPhone key log in to this Mac
#   VPS_HOST=… [VPS_USER=bridge-mac] [VPS_PORT=22] ./install.sh bridge
#                                              pin the VPS host key, install + load the LaunchAgent
#   ./install.sh ssh                           [SUDO] sshd hardening (do it AFTER the iPhone login works)
#   VPS_HOST=… [VPS_PORT=22] ./install.sh ssh-config
#                                              write bridge/mac-ssh-config (Host pc / homeserver for agents)
#   ./install.sh status                        read-only checks
#   ./install.sh render                        print the LaunchAgent plist, change nothing
#   ./install.sh uninstall                     remove agent + pinned key; [SUDO] removes the drop-in
#
# Remote Login is NOT switched on here: do it in System Settings (see ../docs/remote-access.md).
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LABEL="dev.drover.bridge"
SSH_DIR="$HOME/.ssh"
KEY_BRIDGE="$SSH_DIR/mac_bridge_ed25519"    # tunnel -> VPS user bridge-mac
KEY_JUMP="$SSH_DIR/mac_jump_ed25519"        # Mac agents -> VPS user jump (forwarding to 2223/2224 only)
KEY_AGENTS="$SSH_DIR/agents_ed25519"        # Mac agents -> user "agent" on the PC / home server
KNOWN="$SSH_DIR/mac_bridge_known_hosts"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DROPIN_NAME="050-drover-bridge.conf"
DROPIN_DST="/etc/ssh/sshd_config.d/$DROPIN_NAME"
DOMAIN="gui/$(id -u)"
VPS_PORT="${VPS_PORT:-22}"
VPS_USER="${VPS_USER:-bridge-mac}"
MAC_USER="$(id -un)"

say()  { printf '%s\n' "$*"; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
sudo_note() { say ""; say "[SUDO] $*"; }

# --- literal string helpers (no sed/awk replacement syntax, so & \ / # are harmless) ---
subst() {   # subst STRING KEY VALUE — replace every KEY with VALUE, literally
  local s="$1" k="$2" v="$3" out=""
  while [[ "$s" == *"$k"* ]]; do out="$out${s%%"$k"*}$v"; s="${s#*"$k"}"; done
  printf '%s' "$out$s"
}
xml_escape() {
  local s="$1"
  s="$(subst "$s" '&' '&amp;')"; s="$(subst "$s" '<' '&lt;')"; s="$(subst "$s" '>' '&gt;')"
  s="$(subst "$s" '"' '&quot;')"; s="$(subst "$s" "'" '&apos;')"
  printf '%s' "$s"
}
validate_target() {
  [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]*$ ]] || die "VPS_HOST has unexpected characters: $1"
  [[ "$2" =~ ^[a-z_][a-z0-9_-]*$ ]]           || die "VPS_USER has unexpected characters: $2"
  [[ "$3" =~ ^[0-9]+$ ]] && [ "$3" -ge 1 ] && [ "$3" -le 65535 ] || die "VPS_PORT must be 1-65535: $3"
}

fill_template() {   # fill_template FILE — substitutes __HOME__ __VPS_*__ with XML-escaped values
  local t host user port home
  host="${VPS_HOST:-__VPS_HOST__}"; user="$VPS_USER"; port="$VPS_PORT"; home="$HOME"
  [ -z "${VPS_HOST:-}" ] || validate_target "$host" "$user" "$port"
  t="$(cat "$1")"
  t="$(subst "$t" __VPS_HOST__ "$(xml_escape "$host")")"
  t="$(subst "$t" __VPS_USER__ "$(xml_escape "$user")")"
  t="$(subst "$t" __VPS_PORT__ "$(xml_escape "$port")")"
  t="$(subst "$t" __HOME__ "$(xml_escape "$home")")"
  printf '%s\n' "$t"
}
render_plist() { fill_template "$root/bridge/$LABEL.plist.template"; }

# --- keys ---------------------------------------------------------------------------------
ensure_ssh_dir() {
  mkdir -p "$SSH_DIR"; chmod 700 "$SSH_DIR"
  [ "$(stat -f %u "$SSH_DIR")" = "$(id -u)" ] || die "$SSH_DIR is not owned by you"
}
ensure_key() {   # ensure_key PATH COMMENT
  local k="$1" c="$2"
  if [ -e "$k" ]; then
    [ "$(stat -f %u "$k")" = "$(id -u)" ] || die "$k is not owned by you"
    [ "$(stat -f %Lp "$k")" = 600 ] || die "$k must have mode 0600 (found $(stat -f %Lp "$k")); fix it with chmod 600 and re-run"
    [ -f "$k.pub" ] || ssh-keygen -y -f "$k" > "$k.pub"
    say "key exists: $k (kept)"
  else
    ssh-keygen -q -t ed25519 -N '' -C "$c@$(scutil --get LocalHostName 2>/dev/null || hostname -s)" -f "$k"
    say "key created: $k"
  fi
}
cmd_keys() {
  ensure_ssh_dir
  ensure_key "$KEY_BRIDGE" mac-bridge
  ensure_key "$KEY_JUMP" mac-jump
  ensure_key "$KEY_AGENTS" drover-agents
  say ""
  say "Public keys to hand out:"
  say "  $KEY_BRIDGE.pub  -> VPS:  vps-setup.sh --mac-key"
  say "  $KEY_JUMP.pub    -> VPS:  vps-setup.sh --jump-mac-key"
  say "  $KEY_AGENTS.pub  -> PC / home server:  --agent-key"
}

# --- LaunchAgent (with rollback) -------------------------------------------------------------
cmd_bridge() {
  [ -n "${VPS_HOST:-}" ] || die "set VPS_HOST, e.g. VPS_HOST=203.0.113.5 ./install.sh bridge"
  validate_target "$VPS_HOST" "$VPS_USER" "$VPS_PORT"
  ensure_ssh_dir; ensure_key "$KEY_BRIDGE" mac-bridge

  if ! grep -q . "$KNOWN" 2>/dev/null; then
    say "Fetching the VPS host key (the only network access this script makes) ..."
    local scan; scan="$(ssh-keyscan -T 10 -p "$VPS_PORT" -t ed25519 "$VPS_HOST" 2>/dev/null)" || true
    [ -n "$scan" ] || die "could not fetch an ed25519 host key from $VPS_HOST:$VPS_PORT"
    printf '%s\n' "$scan" | ssh-keygen -lf -
    say "Compare this fingerprint with the VPS: ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub"
    local ok; read -r -p "Does it match? [y/N] " ok
    [ "$ok" = y ] || [ "$ok" = Y ] || die "aborted, nothing installed"
    printf '%s\n' "$scan" > "$KNOWN"; chmod 600 "$KNOWN"
  fi

  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
  local new old="" had_old=0
  new="$(mktemp)"; render_plist > "$new"
  plutil -lint "$new" >/dev/null || { rm -f "$new"; die "generated plist is invalid; nothing changed"; }
  if [ -f "$PLIST" ]; then old="$(mktemp)"; cp -p "$PLIST" "$old"; had_old=1; fi
  install -m 644 "$new" "$PLIST"; rm -f "$new"

  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  if ! launchctl bootstrap "$DOMAIN" "$PLIST"; then
    if [ "$had_old" = 1 ]; then
      cp -p "$old" "$PLIST"
      if launchctl bootstrap "$DOMAIN" "$PLIST"; then
        rm -f "$old"; die "bootstrap failed; previous LaunchAgent restored and loaded"
      fi
      rm -f "$old"; die "bootstrap failed; previous plist restored BUT LaunchAgent remains unloaded; load it manually with launchctl bootstrap $DOMAIN $PLIST"
    fi
    rm -f "$PLIST"; die "bootstrap failed; the new plist was removed"
  fi
  rm -f "$old"
  sleep 3
  say "Loaded $LABEL. Log: ~/Library/Logs/$LABEL.log"
  launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -E '^\s*(state|pid|last exit code) ' || true
  say "If it keeps restarting, run vps-setup.sh on the VPS first (see ../docs/remote-access.md)."
}

# --- sshd hardening (with rollback) ---------------------------------------------------------------
live_ok() {   # live_ok — effective settings of the REAL sshd config after install
  local out
  out="$(sudo /usr/sbin/sshd -T -C user=$MAC_USER,host=localhost,addr=203.0.113.9,laddr=127.0.0.1,lport=22)" || return 1
  printf '%s\n' "$out" | grep -qx 'passwordauthentication no' \
    && printf '%s\n' "$out" | grep -qx 'kbdinteractiveauthentication no' \
    && printf '%s\n' "$out" | grep -qx 'permitrootlogin no' \
    && [ "$(printf '%s\n' "$out" | grep -c '^allowusers ')" = 1 ] && printf '%s\n' "$out" | grep -qx "allowusers $MAC_USER"
}
cmd_ssh() {
  local candidate; candidate="$(mktemp)"
  subst "$(cat "$root/ssh/$DROPIN_NAME")" __MAC_USER__ "$MAC_USER" > "$candidate"
  "$root/ssh/check-sshd.sh" "$candidate"
  local bak="" dst_dir; dst_dir="$(dirname "$DROPIN_DST")"
  [ -f "$DROPIN_DST" ] && { bak="$(mktemp)"; cp -p "$DROPIN_DST" "$bak"; }
  sudo_note "Installing $DROPIN_DST (atomic) and re-checking the live sshd config. You will be asked for your password."
  sudo install -m 644 -o root -g wheel "$candidate" "$dst_dir/.$DROPIN_NAME.new"
  sudo mv -f "$dst_dir/.$DROPIN_NAME.new" "$DROPIN_DST"
  rm -f "$candidate"
  if ! sudo /usr/sbin/sshd -t || ! live_ok; then
    if [ -n "$bak" ]; then sudo install -m 644 -o root -g wheel "$bak" "$DROPIN_DST"; else sudo rm -f "$DROPIN_DST"; fi
    rm -f "$bak"
    die "the live sshd config failed its checks; the previous state was restored"
  fi
  rm -f "$bak"
  say "OK: live sshd now refuses passwords; only keys for $MAC_USER. sshd reads it on every new connection."
  say "NEXT: from the iPhone open a NEW session and confirm the key login still works."
}

# --- agent ssh config ----------------------------------------------------------------------------------
cmd_ssh_config() {
  [ -n "${VPS_HOST:-}" ] || die "set VPS_HOST, e.g. VPS_HOST=203.0.113.5 ./install.sh ssh-config"
  local out="$root/bridge/mac-ssh-config" tmp
  tmp="$(mktemp)"
  # Host/user/port are validated to plain characters, so the XML escaping is a no-op here.
  fill_template "$root/bridge/mac-ssh-config.template" > "$tmp"
  ssh -G -F "$tmp" pc >/dev/null && ssh -G -F "$tmp" homeserver >/dev/null || { rm -f "$tmp"; die "generated ssh config does not parse"; }
  install -m 644 "$tmp" "$out"; rm -f "$tmp"
  say "Wrote $out  (your ~/.ssh/config was not touched)"
  say "Parsed OK:  $(ssh -G -F "$out" pc | awk '$1=="proxyjump"{print "pc -> proxyjump " $2}'), $(ssh -G -F "$out" homeserver | awk '$1=="port"{print "homeserver port " $2}')"
  say "To activate, add this ONE line at the very top of ~/.ssh/config yourself:"
  say "    Include \"$out\""
}

cmd_add_key() {
  local k="${1:-}" fingerprint line current
  [ -n "$k" ] || die "usage: ./install.sh add-key 'ssh-ed25519 AAAA… iphone'"
  [ "$(printf '%s\n' "$k" | wc -l | tr -d ' ')" = 1 ] || die "give exactly one public key line"
  fingerprint="$(printf '%s\n' "$k" | ssh-keygen -lf - -E sha256 | awk '{print $2}')" || die "not a valid public key"
  ensure_ssh_dir
  touch "$SSH_DIR/authorized_keys"; chmod 600 "$SSH_DIR/authorized_keys"
  while IFS= read -r line || [ -n "$line" ]; do
    current="$(printf '%s\n' "$line" | ssh-keygen -lf - -E sha256 2>/dev/null | awk '{print $2}')" || current=""
    if [ "$current" = "$fingerprint" ]; then say "key already present"; return; fi
  done < "$SSH_DIR/authorized_keys"
  printf '%s\n' "$k" >> "$SSH_DIR/authorized_keys"; say "key added to ~/.ssh/authorized_keys"
}

cmd_status() {
  local k
  for k in "$KEY_BRIDGE" "$KEY_JUMP" "$KEY_AGENTS"; do
    say "key $(basename "$k"): $([ -f "$k" ] && ssh-keygen -lf "$k.pub" | awk '{print $2}' || echo MISSING)"
  done
  say "sshd drop-in:   $([ -f "$DROPIN_DST" ] && echo installed || echo 'not installed')"
  if nc -z -G 2 127.0.0.1 22 2>/dev/null; then say "Remote Login:   ON (port 22 answers)"; else say "Remote Login:   OFF (port 22 closed)"; fi
  say "LaunchAgent:    $([ -f "$PLIST" ] && echo 'plist present' || echo 'plist absent')"
  if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
    launchctl print "$DOMAIN/$LABEL" | grep -E '^\s*(state|pid|last exit code) ' || true
  else say "                 not loaded"; fi
  [ -f "$root/bridge/mac-ssh-config" ] && say "agent ssh cfg:  bridge/mac-ssh-config present" || say "agent ssh cfg:  not generated"
  if [ -f "$HOME/Library/Logs/$LABEL.log" ]; then say "log tail:"; tail -n 5 "$HOME/Library/Logs/$LABEL.log"; fi
}

cmd_uninstall() {
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  rm -f "$PLIST" "$KNOWN"
  say "LaunchAgent and pinned VPS host key removed. Your keys in ~/.ssh are kept; delete them yourself if you want."
  if [ -f "$DROPIN_DST" ]; then
    sudo_note "Removing $DROPIN_DST"
    sudo rm -f "$DROPIN_DST"
  fi
  say "Switch Remote Login off in System Settings if you no longer need it."
}

main() {
  case "${1:-}" in
    keys)       cmd_keys ;;
    ssh)        cmd_ssh ;;
    ssh-config) cmd_ssh_config ;;
    bridge)     cmd_bridge ;;
    add-key)    shift; cmd_add_key "$@" ;;
    status)     cmd_status ;;
    render)     render_plist ;;
    uninstall)  cmd_uninstall ;;
    *) sed -n '2,15p' "$0"; exit 1 ;;
  esac
}
if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
