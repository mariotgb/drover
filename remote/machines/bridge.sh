#!/bin/bash
# Dynamic Machines bridge; run only via the pinned-key backend transport as root.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$here/../bridge/lib.sh"
require_root; require_debian_like
manifest="${1:?manifest required}"
# Legacy adoption is metadata only. Dispatch before creating state, capabilities
# or a lock, so even an incomplete manual installation stays untouched.
action=$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["action"])' "$manifest")
case "$action" in
  verify|adopt) exec python3 "$here/bridge-adopt.py" "$manifest";;
esac
STATE="${DROVER_BRIDGE_STATE:-/var/lib/drover-machines}"
POLICY="${DROVER_BRIDGE_POLICY:-/etc/ssh/drover-machines-policy.conf}"
export DROVER_POLICY_MARK='# drover-machines-policy (managed)'
[ ! -L "$STATE" ] && [ ! -L "$POLICY" ] || die 'unsafe bridge paths'
for path in "$STATE/capabilities" "$STATE/lock" "$STATE/state.json"; do [ ! -L "$path" ] || die 'unsafe bridge state'; done
install -d -m 700 "$STATE" "$STATE/capabilities"
command -v flock >/dev/null || die 'flock required'
exec 9>"$STATE/lock"; flock -x 9
case "$action" in
  retire)
    # Inventory only our recorded targets and jump account; never inspect/stop
    # unrelated SSH users. No account/config recreation on retirement.
    users=$(python3 "$here/bridge-data.py" cleanup-users "$STATE/state.json")
    # Validate every account/key record before the first credential is removed.
    while IFS= read -r u; do
      if getent passwd "$u" >/dev/null; then
        check_hub_user "$u"
        account_home=$(getent passwd "$u" | cut -d: -f6)
        python3 "$here/bridge-data.py" cleanup-key "$STATE/state.json" "$u" "$account_home/.ssh/authorized_keys" check
      fi
    done <<< "$users"
    while IFS= read -r u; do
      if getent passwd "$u" >/dev/null; then
        check_hub_user "$u"
        account_home=$(getent passwd "$u" | cut -d: -f6)
        python3 "$here/bridge-data.py" cleanup-key "$STATE/state.json" "$u" "$account_home/.ssh/authorized_keys" apply
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
  setup|repair|remove) ;;
  *) die 'unknown bridge operation';;
esac
command -v ssh-keygen >/dev/null && command -v python3 >/dev/null || die 'OpenSSH and Python 3 required'
cfg="${CADDYFILE:-/etc/caddy/Caddyfile}"
if [ "$action" = setup ]; then python3 "$here/bridge-data.py" caddy-safe "$cfg"; fi
work=$(mktemp -d); chmod 700 "$work"
trap 'rm -rf "$work"' EXIT
cat > "$work/installer.service" <<'DROVER_UNIT'
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
# Reject ambiguous Caddy composition before changing accounts, keys or SSH.
if [ "$action" = repair ]; then
  if ! python3 "$here/bridge-data.py" caddy-repair "$manifest" "$cfg" > "$work/Caddyfile"; then
    printf 'DROVER_BRIDGE_ERROR {"code":"caddy_repair_requires_manual_integration"}\n'; exit 1
  fi
  command -v caddy >/dev/null && caddy validate --config "$work/Caddyfile" --adapter caddyfile >/dev/null 2>&1 || {
    printf 'DROVER_BRIDGE_ERROR {"code":"caddy_repair_requires_manual_integration"}\n'; exit 1;
  }
fi
python3 "$here/bridge-data.py" plan "$manifest" "$STATE/state.json" "$work"
# Removed accounts are preflighted before the SSH/key transaction. Ownership
# comes from saved public credentials, never from the generic account comment.
while IFS= read -r u; do
  [ -n "$u" ] || continue
  check_hub_user "$u"
  if getent passwd "$u" >/dev/null; then
    account_home=$(getent passwd "$u" | cut -d: -f6)
    python3 "$here/bridge-data.py" cleanup-key "$STATE/state.json" "$u" "$account_home/.ssh/authorized_keys" check
  fi
done < "$work/removed"
if [ "$action" = repair ]; then
  python3 "$here/bridge-data.py" ports-safe "$manifest" "$STATE/state.json"
  unit=/etc/systemd/system/drover-machine-installers.service
  [ ! -L "$unit" ] && [ ! -L "$STATE/capability-server.py" ] || die 'unsafe installer service path'
  if [ -f "$unit" ] && ! cmp -s "$work/installer.service" "$unit"; then
    printf 'DROVER_BRIDGE_ERROR {"code":"permission_denied"}\n'; die 'foreign installer service'
  fi
fi
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
prepare=prepare
if [ "$action" = repair ] || { [ -f "$STATE/state.json" ] && python3 - "$STATE/state.json" <<'DROVER_ADDITIVE'
import json,sys
sys.exit(0 if json.load(open(sys.argv[1])).get('additive') else 1)
DROVER_ADDITIVE
}; then prepare=prepare-additive; fi
candidate=$(python3 "$here/../bridge/hub-config.py" "$prepare" "$SSHD_CONFIG" "$DROPIN_DIR/060-drover-machines-old.conf" "$POLICY" "$work")
VERIFY_FAIL=0
"$SSHD_BIN" -t -f "$candidate" && verify_machines "$candidate" || {
  [ "$action" != repair ] || printf 'DROVER_BRIDGE_ERROR {"code":"bridge_policy_missing"}\n'
  rm -rf "$work"; die 'candidate SSH policy rejected; nothing changed';
}
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
  # Removal changes policy and affected credentials only. Every survivor's
  # authorized_keys stays byte-for-byte, including unowned keys and comments.
  # Keeping jump keys also avoids reviving a key revoked after a queued job.
  if [ "$action" = remove ]; then continue; fi
  check_hub_user "$u"
  if getent passwd "$u" >/dev/null; then
    account_home=$(getent passwd "$u" | cut -d: -f6)
    if [ -f "$account_home/.ssh/authorized_keys" ]; then
      cp -p "$account_home/.ssh/authorized_keys" "$work/key-$idx"
      printf '%s|%s\n' "$account_home/.ssh/authorized_keys" "$work/key-$idx" >> "$work/keys"
    else printf '%s|\n' "$account_home/.ssh/authorized_keys" >> "$work/keys"; fi
  else printf '%s\n' "$u" >> "$work/users"; fi
  ensure_hub_user "$u"
  # Repair adds grants; normal setup retains its existing dedicated-key policy.
  account_home=$(getent passwd "$u" | cut -d: -f6)
  install -d -m 700 -o "$u" -g "$(id -gn "$u")" "$account_home/.ssh"
  if [ "$action" = repair ]; then
    python3 "$here/bridge-data.py" additive-key "$account_home/.ssh/authorized_keys" "$opts" "$pub" "$work/key-new-$idx"
    if ! cmp -s "$work/key-new-$idx" "$account_home/.ssh/authorized_keys"; then
      install -m 600 "$work/key-new-$idx" "$account_home/.ssh/authorized_keys"
    fi
  else printf '%s %s drover-machines\n' "$opts" "$pub" > "$account_home/.ssh/authorized_keys"; fi
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
  if getent passwd "$u" >/dev/null; then
    account_home=$(getent passwd "$u" | cut -d: -f6)
    python3 "$here/bridge-data.py" cleanup-key "$STATE/state.json" "$u" "$account_home/.ssh/authorized_keys" apply
    pkill -u "$(id -u "$u")" || [ "$?" = 1 ]
  fi
done < "$work/removed"
install -m 600 "$work/state" "$STATE/state.json"
trap 'rm -rf "$work"' EXIT
if [ "$action" = setup ] || [ "$action" = repair ]; then
  [ ! -L "$STATE/capability-server.py" ] && [ ! -L /etc/systemd/system/drover-machine-installers.service ] || die 'unsafe installer service path'
  if [ "$action" != repair ] || [ ! -f "$STATE/capability-server.py" ]; then install -m 700 "$here/capability-server.py" "$STATE/capability-server.py"; fi
  unit=/etc/systemd/system/drover-machine-installers.service
  if [ "$action" = repair ] && [ -f "$unit" ] && ! cmp -s "$work/installer.service" "$unit"; then
    printf 'DROVER_BRIDGE_ERROR {"code":"permission_denied"}\n'; die 'foreign installer service'
  fi
  if ! cmp -s "$work/installer.service" "$unit"; then install -m 644 "$work/installer.service" "$unit"; systemctl daemon-reload; fi
  systemctl enable drover-machine-installers.service
  if [ "$action" = repair ]; then
    systemctl is-active --quiet drover-machine-installers.service || systemctl start drover-machine-installers.service
  else systemctl restart drover-machine-installers.service; fi
  command -v caddy >/dev/null || { apt-get update -qq; apt-get install -y caddy; }
  # Keep an existing Caddy deployment intact unless it is our own/legacy Drover file.
  [ ! -L "$cfg" ] || die 'Caddyfile is a symlink'
  if [ "$action" = setup ]; then
    python3 "$here/bridge-data.py" caddy-safe "$cfg"
    python3 "$here/bridge-data.py" caddy "$manifest" > "$work/Caddyfile"
  fi
  caddy validate --config "$work/Caddyfile" --adapter caddyfile
  [ ! -f "$cfg" ] || cp -p "$cfg" "$work/caddy-backup"
  caddy_changed=0
  if ! cmp -s "$work/Caddyfile" "$cfg"; then
    # Existing Basic authentication can make the file group-readable only.
    if [ -f "$cfg" ]; then cat "$work/Caddyfile" > "$cfg"; else install -m 644 "$work/Caddyfile" "$cfg"; fi
    caddy_changed=1
  fi
  if ! systemctl enable --now caddy || { [ "$caddy_changed" = 1 ] && ! systemctl reload caddy; }; then
    if [ -f "$work/caddy-backup" ]; then cp -p "$work/caddy-backup" "$cfg"; systemctl reload caddy || true; else rm -f "$cfg"; fi
    die 'Caddy failed; its previous configuration was restored'
  fi
  # Additive firewall rules only; never reset/enable the user's firewall or open reverse ports.
  if command -v ufw >/dev/null && ufw status | grep -q '^Status: active'; then ufw allow 80/tcp comment 'Drover Caddy ACME'; ufw allow 443/tcp comment 'Drover Caddy HTTPS'; fi
  systemctl is-active --quiet drover-machine-installers.service && systemctl is-active --quiet caddy || die 'installer services inactive'
  if [ "$action" = repair ]; then
    python3 - "$here" "$manifest" <<'DROVER_REPAIR_ROUTE'
import json,sys
sys.path.insert(0,sys.argv[1])
from importlib.machinery import SourceFileLoader
module=SourceFileLoader('bridge_adopt',sys.argv[1]+'/bridge-adopt.py').load_module()
data=json.load(open(sys.argv[2]))
if not module.caddy_report(data['origin'],data['phonePort'])['installerRoute']:
 print('DROVER_BRIDGE_ERROR {"code":"caddy_repair_requires_manual_integration"}')
 sys.exit(1)
DROVER_REPAIR_ROUTE
  fi
fi
rm -rf "$work"
printf 'DROVER_BRIDGE_READY\n'
