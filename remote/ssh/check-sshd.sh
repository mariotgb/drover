#!/bin/bash
# Check ssh/050-drover-bridge.conf (or the file given as $1) against a temporary
# copy of the system sshd config. Needs no sudo and changes nothing.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=../bridge/lib.sh
. "$here/../bridge/lib.sh"

MAC_USER="${MAC_USER:-$(id -un)}"
[[ "$MAC_USER" =~ ^[A-Za-z_][A-Za-z0-9_.-]*$ ]] || die "invalid MAC_USER"
candidate="${1:-$here/050-drover-bridge.conf}"
name="050-drover-bridge.conf"
[ -r "$candidate" ] || die "cannot read $candidate"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp" "${cand_dir:-}"' EXIT
if [ "$#" = 0 ]; then
  sed "s/__MAC_USER__/$MAC_USER/g" "$candidate" > "$tmp/$name"
  candidate="$tmp/$name"
fi
ssh-keygen -q -t ed25519 -N '' -f "$tmp/host_key"
export SSHD_TEST_HOSTKEY="$tmp/host_key"

cand_dir="$(build_candidate_config "$name" "$candidate")"
cfg="$cand_dir/sshd_config"
"$SSHD_BIN" -t -f "$cfg"
say "sshd -t: syntax OK"

# verify_mac CONFIG — assert the values that matter, for a local and a remote client.
verify_mac() {
  local c="$1" addr out
  for addr in 127.0.0.1 203.0.113.9; do
    out="$(sshd_T "$c" "$MAC_USER" "$addr" 127.0.0.1 22)"
    expect_eq "$out" passwordauthentication no "client $addr"
    expect_eq "$out" kbdinteractiveauthentication no "client $addr"
    expect_eq "$out" pubkeyauthentication yes "client $addr"
    expect_eq "$out" permitrootlogin no "client $addr"
    expect_eq "$out" allowusers "$MAC_USER" "client $addr"
    check_login_allowed "$out" "$MAC_USER" "client $addr"
  done
}
VERIFY_FAIL=0
verify_mac "$cfg"
[ "$VERIFY_FAIL" = 0 ] || die "effective sshd settings differ from the expected ones (see FAIL lines)"
say "effective settings: passwords off, keyboard-interactive off, pubkey on, root off, AllowUsers $MAC_USER (exact)"
