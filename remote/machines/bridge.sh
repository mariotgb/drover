#!/bin/bash
# Dynamic Machines bridge; run only via the pinned-key backend transport as root.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$here/../bridge/lib.sh"
require_root; require_debian_like
manifest="${1:?manifest required}"
STATE="${DROVER_BRIDGE_STATE:-/var/lib/drover-machines}"
POLICY="${DROVER_BRIDGE_POLICY:-/etc/ssh/drover-machines-policy.conf}"
export DROVER_POLICY_MARK='# drover-machines-policy (managed)'
[ ! -L "$STATE" ] && [ ! -L "$POLICY" ] || die 'unsafe bridge paths'
for path in "$STATE/capabilities" "$STATE/lock" "$STATE/state.json"; do [ ! -L "$path" ] || die 'unsafe bridge state'; done
install -d -m 700 "$STATE" "$STATE/capabilities"
command -v flock >/dev/null || die 'flock required'
exec 9>"$STATE/lock"; flock -x 9
action=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["action"])' "$manifest")
case "$action" in
  retire)
    # Inventory only our recorded targets and jump account; never inspect/stop
    # unrelated SSH users. No account/config recreation on retirement.
    users=$(python3 - "$STATE/state.json" <<'DROVER_RETIRE'
import json,pathlib,re,sys
p=pathlib.Path(sys.argv[1]);names=['drover-jump']
if p.exists():
 for t in json.loads(p.read_text()).get('targets',[]):
  if not re.fullmatch('dt-[0-9a-f]{16}',t['user']):raise ValueError('foreign account')
  names.append(t['user'])
print('\n'.join(names))
DROVER_RETIRE
)
    while IFS= read -r u; do
      if getent passwd "$u" >/dev/null; then
        check_hub_user "$u"
        account_home=$(getent passwd "$u" | cut -d: -f6)
        [ ! -L "$account_home/.ssh/authorized_keys" ] || die 'unsafe retired key path'
        [ ! -e "$account_home/.ssh/authorized_keys" ] || { : > "$account_home/.ssh/authorized_keys"; chmod 600 "$account_home/.ssh/authorized_keys"; }
        pkill -u "$(id -u "$u")" || [ "$?" = 1 ]
      fi
    done <<< "$users"
    python3 - "$STATE/capabilities" <<'DROVER_RETIRE_CAPS'
import pathlib,sys
for p in pathlib.Path(sys.argv[1]).glob('*.json'):p.unlink()
DROVER_RETIRE_CAPS
    exit 0;;
  revoke-jump)
    check_hub_user drover-jump
    account_home=$(getent passwd drover-jump | cut -d: -f6 || true)
    [ -n "$account_home" ] || exit 0
    python3 - "$manifest" "$account_home/.ssh/authorized_keys" <<'DROVER_REVOKE_JUMP'
import json,pathlib,sys
d=json.load(open(sys.argv[1]));p=pathlib.Path(sys.argv[2]);body=d['publicKey'].split()[1]
if p.is_symlink():raise ValueError('symlink')
if p.exists():
 lines=[s for s in p.read_text().splitlines() if body not in s.split()]
 p.write_text('\n'.join(lines)+('\n' if lines else ''));p.chmod(0o600)
DROVER_REVOKE_JUMP
    # Existing jump sessions could retain forwarding after key revocation.
    pkill -u "$(id -u drover-jump)" || [ "$?" = 1 ]
    exit 0;;
  report|capability|revoke-capabilities)
    python3 - "$manifest" "$STATE/capabilities" <<'DROVER_CAPABILITY'
import json,os,pathlib,re,sys,time
d=json.load(open(sys.argv[1]));root=pathlib.Path(sys.argv[2])
if d['action']=='revoke-capabilities':
 for p in root.glob('*.json'):p.unlink()
 sys.exit()
token=d['token']
if not re.fullmatch('[A-Za-z0-9_-]{43}',token):raise ValueError('token')
p=root/(token+'.json')
if d['action']=='report':
 if p.exists():
  cap=json.loads(p.read_text())
  if cap.get('report') and cap['expiresAt']>time.time()*1000:print('DROVER_REPORT '+json.dumps(cap['report']))
 sys.exit()
if not time.time()*1000<d['expiresAt']<=time.time()*1000+7200000:raise ValueError('expiry')
c=d['credentials']
cap=dict(expiresAt=d['expiresAt'],script=d['script'],credentials=c,receipt=c['receipt'],machineId=c['machineId'],os=c['os'])
if c.get('recoveryCleanup'):cap['cleanupId']=c['recoveryCleanup']['id']
with p.open('x') as f:
 os.fchmod(f.fileno(),0o600);f.write(json.dumps(cap));f.flush();os.fsync(f.fileno())
# Clean expired key downloads without touching active credentials.
for old in root.glob('*.json'):
 if json.loads(old.read_text())['expiresAt']<=time.time()*1000:old.unlink()
DROVER_CAPABILITY
    exit 0;;
  setup|remove) ;;
  *) die 'unknown bridge operation';;
esac
command -v ssh-keygen >/dev/null && command -v python3 >/dev/null || die 'OpenSSH and Python 3 required'
if [ "$action" = setup ]; then python3 "$here/bridge-data.py" caddy-safe /etc/caddy/Caddyfile; fi
work=$(mktemp -d); chmod 700 "$work"
trap 'rm -rf "$work"' EXIT
python3 "$here/bridge-data.py" plan "$manifest" "$STATE/state.json" "$work"
verify_machines() {
  local cfg="$1" u mode open listen out addr laddr=127.0.0.1 lport=22
  if [ -n "${SSH_CONNECTION:-}" ]; then read -r addr _ laddr lport <<< "$SSH_CONNECTION"; else addr=127.0.0.1; fi
  while IFS='|' read -r u mode open listen; do
    out=$(sshd_T "$cfg" "$u" "$addr" "$laddr" "$lport") || return 1
    expect_eq "$out" allowtcpforwarding "$mode" "$u"
    expect_eq "$out" permitopen "$open" "$u"
    expect_eq "$out" permitlisten "$listen" "$u"
    expect_eq "$out" gatewayports no "$u"
    expect_eq "$out" maxsessions 0 "$u"
    expect_eq "$out" passwordauthentication no "$u"
    expect_eq "$out" kbdinteractiveauthentication no "$u"
    expect_eq "$out" pubkeyauthentication yes "$u"
    expect_eq "$out" authenticationmethods publickey "$u"
    expect_eq "$out" disableforwarding no "$u"
    expect_eq "$out" allowstreamlocalforwarding no "$u"
    expect_eq "$out" allowagentforwarding no "$u"
    expect_eq "$out" permittunnel no "$u"
    expect_eq "$out" permittty no "$u"
    expect_eq "$out" x11forwarding no "$u"
    check_login_allowed "$out" "$u" "$u"
  done < "$work/checks"
  [ "$VERIFY_FAIL" = 0 ]
}
candidate=$(python3 "$here/../bridge/hub-config.py" prepare "$SSHD_CONFIG" "$DROPIN_DIR/060-drover-machines-old.conf" "$POLICY" "$work")
VERIFY_FAIL=0
"$SSHD_BIN" -t -f "$candidate" && verify_machines "$candidate" || { rm -rf "$work"; die 'candidate SSH policy rejected; nothing changed'; }
: > "$work/keys"; : > "$work/users"
rotate_jump=0
if [ -f "$STATE/state.json" ]; then
  rotate_jump=$(python3 - "$STATE/state.json" "$manifest" <<'DROVER_ROTATION'
import json,sys
old=json.load(open(sys.argv[1])).get('agentsPublicKey');new=json.load(open(sys.argv[2]))['agentsPublicKey']
print(1 if old and old!=new else 0)
DROVER_ROTATION
)
fi
rollback() {
  local status=$? path backup u
  trap - EXIT
  if [ "$status" != 0 ]; then
    python3 "$here/../bridge/hub-config.py" restore "$work" || true
    while IFS='|' read -r path backup; do if [ -n "$backup" ]; then cp -p "$backup" "$path"; else rm -f "$path"; fi; done < "$work/keys"
    while IFS= read -r u; do userdel -r "$u" || true; done < "$work/users"
    "$SSHD_BIN" -t -f "$SSHD_CONFIG" && reload_sshd || warn 'rollback needs manual sshd reload'
  fi
  rm -rf "$work"; exit "$status"
}
trap rollback EXIT
idx=0
while IFS='|' read -r u opts pub; do
  # Cleanup changes tunnel grants/policy only. Keep jump authorized_keys intact:
  # rewriting it could resurrect a key revoked after this job was queued.
  if [ "$action" = remove ] && [ "$u" = drover-jump ]; then continue; fi
  check_hub_user "$u"
  if getent passwd "$u" >/dev/null; then
    account_home=$(getent passwd "$u" | cut -d: -f6)
    if [ -f "$account_home/.ssh/authorized_keys" ]; then
      cp -p "$account_home/.ssh/authorized_keys" "$work/key-$idx"
      printf '%s|%s\n' "$account_home/.ssh/authorized_keys" "$work/key-$idx" >> "$work/keys"
    else printf '%s|\n' "$account_home/.ssh/authorized_keys" >> "$work/keys"; fi
  else printf '%s\n' "$u" >> "$work/users"; fi
  ensure_hub_user "$u"
  # Dedicated account: replace the entire file so revoked keys cannot survive.
  account_home=$(getent passwd "$u" | cut -d: -f6)
  install -d -m 700 -o "$u" -g "$(id -gn "$u")" "$account_home/.ssh"
  printf '%s %s drover-machines\n' "$opts" "$pub" > "$account_home/.ssh/authorized_keys"
  chown "$u:$(id -gn "$u")" "$account_home/.ssh/authorized_keys"; chmod 600 "$account_home/.ssh/authorized_keys"
  idx=$((idx+1))
done < "$work/keys-plan"
python3 "$here/../bridge/hub-config.py" commit "$work"
VERIFY_FAIL=0
"$SSHD_BIN" -t -f "$SSHD_CONFIG" && verify_machines "$SSHD_CONFIG" && reload_sshd || die 'SSH policy reload failed'
if [ "$action" = setup ] && [ "$rotate_jump" = 1 ]; then pkill -u "$(id -u drover-jump)" || [ "$?" = 1 ]; fi
# Only our removed account sessions are stopped. Unrelated SSH processes stay live.
while IFS= read -r u; do
  [ -n "$u" ] || continue
  check_hub_user "$u"
  if getent passwd "$u" >/dev/null; then pkill -u "$(id -u "$u")" || [ "$?" = 1 ]; account_home=$(getent passwd "$u" | cut -d: -f6); : > "$account_home/.ssh/authorized_keys"; fi
done < "$work/removed"
install -m 600 "$work/state" "$STATE/state.json"
trap 'rm -rf "$work"' EXIT
if [ "$action" = setup ]; then
  [ ! -L "$STATE/capability-server.py" ] && [ ! -L /etc/systemd/system/drover-machine-installers.service ] || die 'unsafe installer service path'
  install -m 700 "$here/capability-server.py" "$STATE/capability-server.py"
  cat > /etc/systemd/system/drover-machine-installers.service <<'DROVER_UNIT'
[Unit]
Description=Drover one-time machine installers (loopback behind Caddy)
After=network.target
[Service]
ExecStart=/usr/bin/python3 /var/lib/drover-machines/capability-server.py
Restart=on-failure
UMask=0077
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
ReadWritePaths=/var/lib/drover-machines/capabilities
PrivateTmp=yes
[Install]
WantedBy=multi-user.target
DROVER_UNIT
  systemctl daemon-reload; systemctl enable drover-machine-installers.service; systemctl restart drover-machine-installers.service
  command -v caddy >/dev/null || { apt-get update -qq; apt-get install -y caddy; }
  # Keep an existing Caddy deployment intact unless it is our own/legacy Drover file.
  cfg=/etc/caddy/Caddyfile
  [ ! -L "$cfg" ] || die 'Caddyfile is a symlink'
  python3 "$here/bridge-data.py" caddy-safe "$cfg"
  python3 "$here/bridge-data.py" caddy "$manifest" > "$work/Caddyfile"
  caddy validate --config "$work/Caddyfile" --adapter caddyfile
  [ ! -f "$cfg" ] || cp -p "$cfg" "$work/caddy-backup"
  install -m 644 "$work/Caddyfile" "$cfg"
  if ! systemctl enable --now caddy || ! systemctl reload caddy; then
    if [ -f "$work/caddy-backup" ]; then cp -p "$work/caddy-backup" "$cfg"; systemctl reload caddy || true; else rm -f "$cfg"; fi
    die 'Caddy failed; its previous configuration was restored'
  fi
  # Additive firewall rules only; never reset/enable the user's firewall or open reverse ports.
  if command -v ufw >/dev/null && ufw status | grep -q '^Status: active'; then ufw allow 80/tcp comment 'Drover Caddy ACME'; ufw allow 443/tcp comment 'Drover Caddy HTTPS'; fi
fi
rm -rf "$work"
printf 'DROVER_BRIDGE_READY\n'
