# shellcheck shell=bash
# Shared helpers for vps-setup.sh, machine-home/install.sh and ssh/check-sshd.sh.
# Source it; do not run it. Kept free of bash-4-only features so it also runs
# under macOS's bash 3.2 (the checks are tested there).

SSHD_BIN="${SSHD_BIN:-$(command -v sshd || echo /usr/sbin/sshd)}"
SSHD_CONFIG="${SSHD_CONFIG:-/etc/ssh/sshd_config}"
DROPIN_DIR="${DROPIN_DIR:-/etc/ssh/sshd_config.d}"
HUB_TAG="Drover hub"          # GECOS marker: users carrying it were created by these scripts
VERIFY_FAIL=0

say()  { printf '%s\n' "$*"; }
warn() { printf 'WARN  %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

require_root() { [ "$(id -u)" -eq 0 ] || die "run as root (sudo)"; }

is_debian_like() {
  ( . /etc/os-release 2>/dev/null; case " ${ID:-} ${ID_LIKE:-} " in *" debian "*|*" ubuntu "*) exit 0;; esac; exit 1 )
}
require_debian_like() { is_debian_like || die "this script supports Debian/Ubuntu only"; }

# --- public keys -------------------------------------------------------------

# Print "<type> <base64>" for a file holding exactly one public key; die otherwise.
read_pubkey() {
  local f="$1" n
  [ -r "$f" ] || die "cannot read $f"
  n="$(grep -cve '^[[:space:]]*$' "$f" || true)"
  [ "$n" = 1 ] || die "$f must contain exactly one public key"
  ssh-keygen -lf "$f" >/dev/null 2>&1 || die "$f is not a valid public key"
  case "$(awk 'NF {print $1; exit}' "$f")" in
    ssh-ed25519|ssh-rsa|ecdsa-sha2-*|sk-*) ;;
    *) die "$f: the line must start with the key type (no options, no private key)";;
  esac
  awk 'NF >= 2 {print $1, $2; exit}' "$f"
}

# ssh-keygen parses authorized_keys options and ignores key-looking comments.
key_fingerprint() {
  local result
  result="$(printf '%s\n' "$1" | ssh-keygen -lf - -E sha256 2>/dev/null)" || return 1
  [ "$(printf '%s\n' "$result" | wc -l | tr -d ' ')" = 1 ] || return 1
  printf '%s\n' "$result" | awk '$2 ~ /^SHA256:/ {print $2; ok=1} END {if (!ok) exit 1}'
}

# Check an existing dedicated account without mutating it.
check_hub_user() {
  local u="$1" entry uid tag shell account_home
  entry="$(getent passwd "$u")" || return 0
  uid="$(printf '%s' "$entry" | cut -d: -f3)"
  tag="$(printf '%s' "$entry" | cut -d: -f5 | cut -d, -f1)"
  shell="$(printf '%s' "$entry" | cut -d: -f7)"
  account_home="$(printf '%s' "$entry" | cut -d: -f6)"
  [ "$uid" != 0 ] || die "$u has UID 0"
  [ "$tag" = "$HUB_TAG" ] || die "user $u is not script-owned; refusing to reuse it"
  case "$shell" in */nologin|/bin/false) ;; *) die "$u is not a shell-less account";; esac
  [ ! -L "$account_home" ] && [ ! -L "$account_home/.ssh" ] && [ ! -L "$account_home/.ssh/authorized_keys" ] || die "$u: symlink in key path"
}

# set_authorized_key USER OPTIONS "<type> <base64>" [COMMENT]
# Drops lines with the same parsed SHA256 fingerprint, appends the key with the
# requested options, and swaps the file in atomically. Other keys are kept.
set_authorized_key() {
  local u="$1" opts="$2" key="$3" comment="${4:-drover-hub}" key_home grp dir file tmp fingerprint current line others
  key_home="$(getent passwd "$u" | cut -d: -f6)"; [ -n "$key_home" ] || die "no such user: $u"
  grp="$(id -gn "$u")"
  dir="$key_home/.ssh"; file="$dir/authorized_keys"
  [ ! -L "$dir" ] && [ ! -L "$file" ] || die "$dir or $file is a symlink; refusing to touch it"
  install -d -m 700 -o "$u" -g "$grp" "$dir"
  [ -e "$file" ] || install -m 600 -o "$u" -g "$grp" /dev/null "$file"
  fingerprint="$(key_fingerprint "$key")" || die "invalid replacement key"
  tmp="$(mktemp "$dir/.authorized_keys.XXXXXX")"
  while IFS= read -r line || [ -n "$line" ]; do
    current="$(key_fingerprint "$line" 2>/dev/null)" || current=""
    [ "$current" = "$fingerprint" ] || printf '%s\n' "$line" >> "$tmp"
  done < "$file"
  others="$(grep -cvE '^[[:space:]]*(#|$)' "$tmp" || true)"
  if [ -n "$opts" ]; then printf '%s %s %s\n' "$opts" "$key" "$comment" >> "$tmp"
  else printf '%s %s\n' "$key" "$comment" >> "$tmp"; fi
  chown "$u:$grp" "$tmp"; chmod 600 "$tmp"
  mv -f "$tmp" "$file"
  say "$u: key installed with current options"
  [ "${others:-0}" -eq 0 ] || warn "$u: authorized_keys holds $others other key(s); they were left untouched, review $file"
}

# ensure_hub_user NAME — create a shell-less user, or accept one made by us earlier.
ensure_hub_user() {
  local u="$1" entry nologin shell uid tag
  check_hub_user "$u"
  nologin="$(command -v nologin || echo /usr/sbin/nologin)"
  if entry="$(getent passwd "$u")"; then
    uid="$(printf '%s' "$entry" | cut -d: -f3)"
    tag="$(printf '%s' "$entry" | cut -d: -f5 | cut -d, -f1)"
    shell="$(printf '%s' "$entry" | cut -d: -f7)"
    [ "$uid" != 0 ] || die "$u has UID 0"
    [ "$tag" = "$HUB_TAG" ] || die "user $u already exists and was not created by these scripts; refusing to reuse it"
    case "$shell" in */nologin|/bin/false) ;; *) die "user $u has shell $shell; expected nologin";; esac
    say "user $u exists (ours), keeping it"
  else
    useradd --user-group --create-home --shell "$nologin" --comment "$HUB_TAG" "$u"
    usermod -p '*' "$u"    # no password login, but not "locked" (a locked account can refuse key logins)
    say "created user $u (shell $nologin)"
  fi
}

# --- sshd config -------------------------------------------------------------

# build_candidate_config NAME FILE — print the path of a temporary directory
# holding sshd_config (a copy of the real one whose sshd_config.d Include points
# at d/) and d/ (the current drop-ins, with the candidate NAME copied last so
# an installed file of the same name can never shadow it).
build_candidate_config() {
  local name="$1" file="$2" tmp f
  grep -Eq "^[[:space:]]*Include[[:space:]].*sshd_config\.d" "$SSHD_CONFIG" \
    || die "$SSHD_CONFIG has no Include for sshd_config.d; drop-ins would be ignored"
  tmp="$(mktemp -d)"
  mkdir "$tmp/d"
  if [ -d "$DROPIN_DIR" ]; then
    for f in "$DROPIN_DIR"/*; do
      [ -e "$f" ] || continue
      [ "$(basename "$f")" = "$name" ] && continue
      cp "$f" "$tmp/d/" || die "cannot copy $f"
    done
  fi
  cp "$file" "$tmp/d/$name" || die "cannot copy $file"
  {
    # A throwaway host key lets non-root users run the syntax check.
    [ -n "${SSHD_TEST_HOSTKEY:-}" ] && printf 'HostKey %s\n' "$SSHD_TEST_HOSTKEY"
    sed -E "s#^([[:space:]]*Include[[:space:]]+)(/etc/ssh/)?sshd_config\\.d/#\\1$tmp/d/#" "$SSHD_CONFIG"
  } > "$tmp/sshd_config"
  grep -qF "$tmp/d/" "$tmp/sshd_config" || die "could not repoint the sshd_config.d Include"
  printf '%s\n' "$tmp"
}

# sshd_T CONFIG USER CLIENT_ADDR LOCAL_ADDR LOCAL_PORT — effective settings for that connection.
sshd_T() {
  "$SSHD_BIN" -T -f "$1" -C "user=$2,host=${SSHD_CTX_HOST:-localhost},addr=$3,laddr=$4,lport=$5"
}

cfg_get() { printf '%s\n' "$1" | awk -v k="$2" '$1 == k { $1 = ""; sub(/^ /, ""); v = (v == "" ? $0 : v " " $0) } END { print v }'; }
norm()    { printf '%s\n' "$1" | tr -s ' ' '\n' | sed '/^$/d' | sort -u | tr '\n' ' ' | sed 's/ $//'; }

# expect_eq CFGTEXT KEY EXPECTED LABEL — compares as sorted sets; flags VERIFY_FAIL.
expect_eq() {
  local got exp
  got="$(norm "$(cfg_get "$1" "$2")")"; exp="$(norm "$3")"
  if [ "$got" != "$exp" ]; then
    printf 'FAIL  %s: %s = "%s", expected "%s"\n' "$4" "$2" "$got" "$exp"; VERIFY_FAIL=1
  fi
}
# Same, but only when sshd prints the key at all (older versions lack some).
expect_eq_if_set() { [ -z "$(cfg_get "$1" "$2")" ] || expect_eq "$1" "$2" "$3" "$4"; }

# check_login_allowed CFGTEXT USER LABEL — the user must not be filtered out by Allow/DenyUsers.
check_login_allowed() {
  local cfg="$1" u="$2" label="$3" allow deny p hit groups group
  allow="$(cfg_get "$cfg" allowusers)"; deny="$(cfg_get "$cfg" denyusers)"
  # A user-only glob comparison cannot model OpenSSH's hostname/IP/CIDR
  # semantics. Fail closed for these policies instead of silently approving one.
  set -f
  for p in $allow; do
    case "$p" in *@*) printf 'FAIL  %s: AllowUsers pattern "%s" uses unsupported USER@HOST; cannot verify hostname/IP/CIDR policy\n' "$label" "$p"; VERIFY_FAIL=1; set +f; return 1;; esac
  done
  for p in $deny; do
    case "$p" in *@*) printf 'FAIL  %s: DenyUsers pattern "%s" uses unsupported USER@HOST; cannot verify hostname/IP/CIDR policy\n' "$label" "$p"; VERIFY_FAIL=1; set +f; return 1;; esac
  done
  set +f
  set -f
  if [ -n "$allow" ]; then
    hit=0; for p in $allow; do case "$u" in $p) hit=1;; esac; done
    [ "$hit" = 1 ] || { printf 'FAIL  %s: AllowUsers "%s" does not include %s\n' "$label" "$allow" "$u"; VERIFY_FAIL=1; }
  fi
  hit=0; for p in $deny; do case "$u" in $p) hit=1;; esac; done
  [ "$hit" = 0 ] || { printf 'FAIL  %s: DenyUsers "%s" blocks %s\n' "$label" "$deny" "$u"; VERIFY_FAIL=1; }
  set +f
  groups="$(id -Gn "$u" 2>/dev/null)" || groups="$u" # planned new hub user has its own primary group
  allow="$(cfg_get "$cfg" allowgroups)"; deny="$(cfg_get "$cfg" denygroups)"
  set -f
  if [ -n "$allow" ]; then
    hit=0; for group in $groups; do for p in $allow; do case "$group" in $p) hit=1;; esac; done; done
    [ "$hit" = 1 ] || { printf 'FAIL  %s: AllowGroups blocks %s\n' "$label" "$u"; VERIFY_FAIL=1; }
  fi
  for group in $groups; do for p in $deny; do case "$group" in $p) printf 'FAIL  %s: DenyGroups blocks %s\n' "$label" "$u"; VERIFY_FAIL=1;; esac; done; done
  set +f
  case "$(cfg_get "$cfg" authenticationmethods)" in
    ""|any|publickey) ;;
    *) printf 'FAIL  %s: AuthenticationMethods "%s" is not plain publickey\n' "$label" "$(cfg_get "$cfg" authenticationmethods)"; VERIFY_FAIL=1;;
  esac
}

# install_dropin NAME FILE VERIFY_FN
# VERIFY_FN CONFIG must set VERIFY_FAIL=1 on problems. It runs on a temporary
# candidate config first (nothing on the system changes if it fails), then on
# the real config after install, with automatic rollback.
install_dropin() {
  local name="$1" file="$2" verify="$3" dst tmpd bak="" new
  dst="$DROPIN_DIR/$name"
  tmpd="$(build_candidate_config "$name" "$file")"
  VERIFY_FAIL=0
  if ! "$SSHD_BIN" -t -f "$tmpd/sshd_config" || ! "$verify" "$tmpd/sshd_config" || [ "$VERIFY_FAIL" != 0 ]; then
    rm -rf "$tmpd"
    die "the candidate config was rejected (see above); nothing was changed"
  fi
  rm -rf "$tmpd"
  mkdir -p "$DROPIN_DIR"
  if [ -e "$dst" ]; then bak="$(mktemp)"; cp -p "$dst" "$bak"; fi
  new="$DROPIN_DIR/.$name.new"          # leading dot: the Include glob skips it
  if [ "$(id -u)" -eq 0 ]; then install -m 644 -o root -g root "$file" "$new"; else install -m 644 "$file" "$new"; fi
  mv -f "$new" "$dst"
  VERIFY_FAIL=0
  if ! "$SSHD_BIN" -t -f "$SSHD_CONFIG" || ! "$verify" "$SSHD_CONFIG" || [ "$VERIFY_FAIL" != 0 ]; then
    if [ -n "$bak" ]; then cp -p "$bak" "$dst"; else rm -f "$dst"; fi
    rm -f "$bak"
    die "the installed config failed its checks; previous state restored"
  fi
  rm -f "$bak"
  say "installed $dst"
}

reload_sshd() {
  if command -v systemctl >/dev/null 2>&1; then
    systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null && { say "sshd reloaded"; return 0; }
  fi
  warn "could not reload sshd"
  return 1
}

# Actual listeners, including ssh.socket activation. Configuration alone is not
# evidence of a listener. Caller must be root so ss includes process ownership.
ssh_listener_ports() {
  local sockets lines current="" socket_ports p endpoint pid info line
  command -v ss >/dev/null || die "ss (iproute2) is required"
  lines="$(ss -ltnpH)" || die "ss -ltnp failed"
  sockets="$(systemctl show ssh.socket sshd.socket -p Listen --value 2>/dev/null || true)"
  socket_ports="$(printf '%s\n' "$sockets" | grep -oE ':[0-9]+ \(Stream\)' | sed -E 's/^:([0-9]+).*/\1/' || true)"
  if [ -n "${SSH_CONNECTION:-}" ]; then
    set -- $SSH_CONNECTION
    [ "$#" = 4 ] || die "malformed SSH_CONNECTION"
    current="$4"
    [[ "$current" =~ ^[0-9]+$ ]] && [ "$current" -ge 1 ] && [ "$current" -le 65535 ] || die "invalid SSH_CONNECTION port"
    printf '%s\n' "$lines" | awk -v p="$current" '$4 ~ (":" p "$") {ok=1} END {exit !ok}' || die "current SSH_CONNECTION port $current has no live listener"
  fi
  {
    while IFS= read -r line; do
      case "$line" in *'"sshd"'*) ;; *) continue;; esac
      endpoint="$(printf '%s\n' "$line" | awk '{print $4}')"
      for pid in $(printf '%s\n' "$line" | grep -oE 'pid=[0-9]+' | cut -d= -f2); do
        info="$(ps -o uid= -o args= -p "$pid")" || continue
        # A reverse-forward socket also belongs to sshd, but to a per-user
        # session, never the root admission listener. Don't expose hub ports.
        printf '%s\n' "$info" | grep -qE '^[[:space:]]*0[[:space:]]' || continue
        printf '%s\n' "$info" | grep -qE 'sshd(-session)?: [A-Za-z0-9_-]+( |@|\[)' && continue
        printf '%s\n' "${endpoint##*:}"
      done
    done <<< "$lines"
    for p in $socket_ports; do
      printf '%s\n' "$lines" | awk -v p="$p" '$4 ~ (":" p "$") && /users:.*"systemd"/ {print p}'
    done
    [ -z "$current" ] || printf '%s\n' "$current"
  } | sort -un
}
