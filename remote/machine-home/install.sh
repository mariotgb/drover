#!/bin/bash
# Run ON THE HOME SERVER (Linux with systemd; Debian/Ubuntu, Fedora, Arch), as root.
#
#   sudo ./install.sh --vps-host H --agent-key agents_ed25519.pub \
#        [--vps-user bridge-home] [--vps-port 22] [--keep-password-login] \
#        [--key-login-confirmed] [--no-start] [--yes]
#
# Copy this folder AND ../bridge/ (it needs lib.sh) to the server first:
#   scp -r bridge machine-home you@home-server:
#
# What it does:
#   1. user "agent": passwordless sudo (/etc/sudoers.d/agent, checked with visudo -c),
#      logs in with the Mac agents' key ONLY.
#   2. sshd: password and keyboard-interactive login off for everybody (key only).
#      Drop-in 050-drover-agent.conf, validated on a temp copy first, auto-rollback.
#   3. systemd service drover-tunnel (user "drover-tunnel", own key) keeping
#      127.0.0.1:2224 on the VPS pointed at this machine's sshd (Restart=always).
# Agents can do EVERYTHING on this machine (root via sudo) — that is intentional.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../bridge/lib.sh
. "$here/../bridge/lib.sh"

PORT=2224
UNIT=drover-tunnel
TUNNEL_USER=drover-tunnel
TUNNEL_HOME=/var/lib/drover-tunnel
DROPIN_NAME=050-drover-agent.conf

pm=""
detect_pm() {
  if command -v apt-get >/dev/null; then pm=apt
  elif command -v dnf >/dev/null; then pm=dnf
  elif command -v pacman >/dev/null; then pm=pacman
  else die "no apt/dnf/pacman found; install openssh-server, openssh-client and sudo yourself and re-run"; fi
}
pm_install() {   # pm_install <apt-names> <dnf-names> <pacman-names>
  case "$pm" in
    apt)    apt-get update -qq && apt-get install -y $1;;
    dnf)    dnf install -y $2;;
    pacman) pacman -S --noconfirm --needed $3;;
  esac
}

verify_home() {
  local c="$1" caddr out
  for caddr in 127.0.0.1 203.0.113.9; do
    out="$(sshd_T "$c" agent "$caddr" 127.0.0.1 22)"
    expect_eq "$out" passwordauthentication no "agent client=$caddr"
    expect_eq "$out" kbdinteractiveauthentication no "agent client=$caddr"
    expect_eq "$out" pubkeyauthentication yes "agent client=$caddr"
    check_login_allowed "$out" agent "agent client=$caddr"
  done
}

ensure_agent_user() {
  local entry
  if entry="$(getent passwd agent)"; then
    [ "$(printf '%s' "$entry" | cut -d: -f3)" != 0 ] || die "user agent has UID 0"
    [ "$(printf '%s' "$entry" | cut -d: -f5 | cut -d, -f1)" = "$HUB_TAG" ] \
      || die "user agent already exists and was not created by this script; refusing to reuse it"
    say "user agent exists (ours)"
  else
    useradd --create-home --shell /bin/bash --comment "$HUB_TAG" agent
    usermod -p '*' agent    # no password login; key only
    say "created user agent"
  fi
}

install_sudoers() {
  local tmp; tmp="$(mktemp)"
  printf 'agent ALL=(ALL:ALL) NOPASSWD: ALL\n' > "$tmp"
  command -v visudo >/dev/null || die "visudo not found"
  visudo -cf "$tmp" >/dev/null || { rm -f "$tmp"; die "visudo rejected the sudoers entry; nothing installed"; }
  grep -rqsE '^[#@]includedir[[:space:]]+/etc/sudoers\.d' /etc/sudoers || warn "/etc/sudoers has no includedir for /etc/sudoers.d; the rule may be ignored"
  install -m 440 -o root -g root "$tmp" /etc/sudoers.d/agent
  rm -f "$tmp"
  visudo -c >/dev/null || { rm -f /etc/sudoers.d/agent; die "visudo -c failed after install; the agent sudoers file was removed"; }
  say "sudoers: agent has passwordless sudo"
}

render_unit() {
  local t; t="$(cat "$here/drover-tunnel.service.template")"
  # Values are validated to [A-Za-z0-9._:-], so plain substitution is safe.
  t="${t//__PORT__/$PORT}"; t="${t//__VPS_PORT__/$1}"; t="${t//__VPS_USER__/$2}"; t="${t//__VPS_HOST__/$3}"
  printf '%s\n' "$t"
}

main() {
  local host="" vuser="bridge-home" vport=22 akey="" keep_pw=0 force=0 confirmed=0 nostart=0 yes=0 ans
  while [ $# -gt 0 ]; do
    case "$1" in
      --vps-host) host="${2:?}"; shift 2;;
      --vps-user) vuser="${2:?}"; shift 2;;
      --vps-port) vport="${2:?}"; shift 2;;
      --agent-key) akey="${2:?}"; shift 2;;
      --keep-password-login) keep_pw=1; shift;;
      --force-key-only) die "--force-key-only was removed: use --key-login-confirmed AFTER a fresh key login";;
      --key-login-confirmed) confirmed=1; shift;;
      --no-start) nostart=1; shift;;
      --yes) yes=1; shift;;
      *) die "unknown option: $1";;
    esac
  done
  require_root
  command -v systemctl >/dev/null || die "systemd is required"
  [ -n "$host" ] && [ -n "$akey" ] || die "--vps-host and --agent-key are required"
  case "$host" in *[!A-Za-z0-9.:-]*|"") die "--vps-host: unexpected characters";; esac
  case "$vuser" in *[!a-z0-9_-]*|"") die "--vps-user: unexpected characters";; esac
  case "$vport" in *[!0-9]*|"") die "--vps-port must be a number";; esac
  [ "$vport" -ge 1 ] && [ "$vport" -le 65535 ] || die "--vps-port must be 1-65535"
  local k_agent; k_agent="$(read_pubkey "$akey")"

  # Key-only login must not lock the administrator out.
  if [ "$keep_pw" != 1 ] && [ "$force" != 1 ]; then
    local admin="${SUDO_USER:-root}" ahome
    ahome="$(getent passwd "$admin" | cut -d: -f6)"
    ssh-keygen -lf "$ahome/.ssh/authorized_keys" >/dev/null 2>&1 \
      || die "$admin has no SSH key in $ahome/.ssh/authorized_keys: turning passwords off could lock you out. Add a key, or pass --keep-password-login."
  fi

  if [ "$yes" != 1 ]; then
    say "Will: create user agent with passwordless sudo, install the agents' key, install a sshd drop-in"
    [ "$keep_pw" = 1 ] && say "      (password login stays ON)" || say "      (password login goes OFF for all users)"
    say "      and a systemd tunnel to $vuser@$host:$vport (VPS port 127.0.0.1:$PORT)."
    say "Keep your current SSH session open until a fresh key login has been tested."
    read -r -p "Continue? [y/N] " ans
    [ "$ans" = y ] || [ "$ans" = Y ] || die "aborted"
  fi

  detect_pm
  command -v sshd >/dev/null 2>&1 || [ -x /usr/sbin/sshd ] || pm_install "openssh-server" "openssh-server" "openssh"
  command -v ssh >/dev/null 2>&1 || pm_install "openssh-client" "openssh-clients" "openssh"
  command -v sudo >/dev/null 2>&1 || pm_install "sudo" "sudo" "sudo"
  command -v visudo >/dev/null 2>&1 || die "visudo missing after installing sudo"
  SSHD_BIN="$(command -v sshd || echo /usr/sbin/sshd)"

  check_hub_user "$TUNNEL_USER"

  # 1) agent user, sudo, key
  ensure_agent_user
  install_sudoers
  set_authorized_key agent "" "$k_agent" drover-agents
  command -v restorecon >/dev/null 2>&1 && restorecon -R /home/agent/.ssh 2>/dev/null || true

  # A valid key file is not proof of a working login. --yes never bypasses this.
  if [ "$keep_pw" != 1 ] && [ "$confirmed" != 1 ]; then
    say "From a NEW terminal verify public-key login as your admin and as agent."
    read -r -p 'Type KEY LOGIN VERIFIED after both logins succeed: ' ans
    [ "$ans" = 'KEY LOGIN VERIFIED' ] || die "hardening refused; use --keep-password-login until fresh key logins work"
  fi

  # 2) sshd: key only
  local svc="sshd"; systemctl cat ssh.service >/dev/null 2>&1 && svc="ssh"
  systemctl enable --now "$svc" >/dev/null 2>&1 || warn "could not enable/start $svc.service"
  if [ "$keep_pw" != 1 ]; then
    local tmp; tmp="$(mktemp)"; HOME_KEY_TMP="$tmp"; trap 'rm -f "$HOME_KEY_TMP"' EXIT
    printf '%s\n' \
      '# Managed by machine-home/install.sh: public-key login only.' \
      'PasswordAuthentication no' \
      'KbdInteractiveAuthentication no' \
      'PubkeyAuthentication yes' > "$tmp"
    local previous="" destination="$DROPIN_DIR/$DROPIN_NAME"
    [ ! -e "$destination" ] || { previous="$(mktemp)"; cp -p "$destination" "$previous"; }
    install_dropin "$DROPIN_NAME" "$tmp" verify_home
    if ! reload_sshd; then
      if [ -n "$previous" ]; then cp -p "$previous" "$destination"; else rm -f "$destination"; fi
      "$SSHD_BIN" -t -f "$SSHD_CONFIG" && reload_sshd || die "reload failed; previous config restored BUT sshd needs manual recovery"
      rm -f "$previous"; die "reload failed; previous config restored and reloaded"
    fi
    rm -f "$previous"
  else
    warn "password login left as it was (--keep-password-login)"
  fi

  # 3) tunnel service
  if ! getent passwd "$TUNNEL_USER" >/dev/null; then
    useradd --system --user-group --home-dir "$TUNNEL_HOME" --create-home --shell "$(command -v nologin || echo /usr/sbin/nologin)" --comment "$HUB_TAG" "$TUNNEL_USER"
  fi
  install -d -m 700 -o "$TUNNEL_USER" -g "$TUNNEL_USER" "$TUNNEL_HOME/.ssh"
  [ ! -L "$TUNNEL_HOME" ] && [ ! -L "$TUNNEL_HOME/.ssh" ] && [ ! -L "$TUNNEL_HOME/.ssh/id_ed25519" ] && [ ! -L "$TUNNEL_HOME/.ssh/id_ed25519.pub" ] && [ ! -L "$TUNNEL_HOME/known_hosts" ] || die "symlink in tunnel key path"
  if [ ! -f "$TUNNEL_HOME/.ssh/id_ed25519" ]; then
    runuser -u "$TUNNEL_USER" -- ssh-keygen -q -t ed25519 -N '' -C "tunnel-home@$(hostname -s)" -f "$TUNNEL_HOME/.ssh/id_ed25519"
  fi
  chown "$TUNNEL_USER:$TUNNEL_USER" "$TUNNEL_HOME/.ssh/id_ed25519"; chmod 600 "$TUNNEL_HOME/.ssh/id_ed25519"
  runuser -u "$TUNNEL_USER" -- ssh-keygen -y -P '' -f "$TUNNEL_HOME/.ssh/id_ed25519" > "$TUNNEL_HOME/.ssh/id_ed25519.pub"
  chown "$TUNNEL_USER:$TUNNEL_USER" "$TUNNEL_HOME/.ssh/id_ed25519.pub"; chmod 644 "$TUNNEL_HOME/.ssh/id_ed25519.pub"
  if ! grep -q . "$TUNNEL_HOME/known_hosts" 2>/dev/null; then
    say "Fetching the VPS host key ..."
    local scan; scan="$(ssh-keyscan -T 10 -p "$vport" -t ed25519 "$host" 2>/dev/null || true)"
    [ -n "$scan" ] || die "could not fetch an ed25519 host key from $host:$vport"
    printf '%s\n' "$scan" | ssh-keygen -lf -
    say "Compare with the VPS: ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub"
    read -r -p "Does it match? [y/N] " ans
    [ "$ans" = y ] || [ "$ans" = Y ] || die "aborted before installing the tunnel"
    printf '%s\n' "$scan" > "$TUNNEL_HOME/known_hosts"; chmod 644 "$TUNNEL_HOME/known_hosts"
  fi
  local unit_tmp; unit_tmp="$(mktemp -d)/drover-tunnel.service"
  render_unit "$vport" "$vuser" "$host" > "$unit_tmp"
  systemd-analyze verify "$unit_tmp" || die "generated tunnel unit failed validation"
  install -m 644 -o root -g root "$unit_tmp" "/etc/systemd/system/$UNIT.service"; rm -f "$unit_tmp"; rmdir "$(dirname "$unit_tmp")"
  systemctl daemon-reload
  if [ "$nostart" = 1 ]; then systemctl enable "$UNIT" >/dev/null
  else systemctl enable "$UNIT"; systemctl restart "$UNIT"; fi

  say ""
  say "Tunnel public key — give THIS to the VPS (vps-setup.sh --home-key <file>):"
  cat "$TUNNEL_HOME/.ssh/id_ed25519.pub"
  say ""
  say "Status:  systemctl status $UNIT      Logs: journalctl -u $UNIT -f"
  say "From the Mac, once the VPS side is ready:  ssh homeserver"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
