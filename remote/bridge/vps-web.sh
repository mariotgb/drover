#!/bin/bash
# Run ON THE VPS (Debian/Ubuntu), as root. Publishes the Drover site through Caddy:
#
#   https://<a-b-c-d>.sslip.io  ->  127.0.0.1:8780  (the reverse tunnel to the Mac's 127.0.0.1:7780)
#
#   sudo ./vps-web.sh [--ip A.B.C.D] [--basic-auth USER] [--max-body 20MiB] [--yes]
#
# sslip.io resolves a-b-c-d.sslip.io to a.b.c.d, so Caddy can get a Let's Encrypt
# certificate without you owning a domain. Ports 80/443 must be reachable from the
# internet (vps-firewall.sh opens them).
# --basic-auth adds a password prompt in front of the site; use it unless the
# Drover site has its own login — it controls coding agents.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
. "$here/lib.sh"

CADDYFILE="${CADDYFILE:-/etc/caddy/Caddyfile}"
UPSTREAM="127.0.0.1:8780"

valid_ipv4() {
  local ip="$1" o
  case "$ip" in *[!0-9.]*|""|*..*|.*|*.) return 1;; esac
  [ "$(printf '%s' "$ip" | tr -cd . | wc -c | tr -d ' ')" = 3 ] || return 1
  for o in $(printf '%s' "$ip" | tr . ' '); do [ "$o" -le 255 ] || return 1; done
}
is_private_ipv4() {
  case "$1" in
    10.*|127.*|192.168.*|169.254.*|100.6[4-9].*|100.[7-9][0-9].*|100.1[01][0-9].*|100.12[0-7].*) return 0;;
    172.1[6-9].*|172.2[0-9].*|172.3[01].*) return 0;;
  esac
  return 1
}
detect_ipv4() { ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") {print $(i + 1); exit}}'; }

# render_caddyfile HOST MAXBODY [BASIC_USER BASIC_HASH]
render_caddyfile() {
  local host="$1" body="$2" user="${3:-}" hash="${4:-}"
  cat <<CADDY
# Managed by vps-web.sh
{
	# Redact the entire URI also in runtime/error logs (e.g. upstream 502).
	log default {
		format filter {
			wrap json
			fields {
				request>uri delete
				request>headers>Referer delete
			}
		}
	}
	servers {
		timeouts {
			read_header 10s
			idle 5m
		}
	}
}

$host {
	encode zstd gzip

	# Largest request body accepted from a browser (WebSocket frames are not counted).
	request_body {
		max_size $body
	}

	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options "nosniff"
		X-Frame-Options "DENY"
		Referrer-Policy "no-referrer"
		Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=()"
		Cross-Origin-Opener-Policy "same-origin"
		-Server
	}
CADDY
  if [ -n "$user" ]; then
    printf '\n\tbasic_auth {\n\t\t%s %s\n\t}\n' "$user" "$hash"
  fi
  cat <<CADDY

	# WebSocket upgrades are proxied automatically by Caddy v2; flush_interval -1
	# streams responses immediately (chat output, SSE).
	reverse_proxy $UPSTREAM {
		flush_interval -1
		transport http {
			dial_timeout 5s
		}
	}

	# No access log: pairing URLs contain a one-time secret (/pair?code=...).
}
CADDY
}

install_caddy() {
  command -v caddy >/dev/null 2>&1 && return 0
  say "Installing Caddy from the official Debian/Ubuntu repository ..."
  apt-get update -qq
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y caddy
}

main() {
  local ip="" user="" body="20MiB" yes=0 host hash="" pw ans tmp bak=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --ip) ip="${2:?}"; shift 2;;
      --basic-auth) user="${2:?}"; shift 2;;
      --max-body) body="${2:?}"; shift 2;;
      --yes) yes=1; shift;;
      *) die "unknown option: $1";;
    esac
  done
  require_root; require_debian_like
  case "$user" in ""|*[!A-Za-z0-9_.-]*) [ -z "$user" ] || die "--basic-auth user: letters, digits . _ - only";; esac
  case "$body" in *[!0-9A-Za-z]*|"") die "--max-body looks wrong (example: 20MiB)";; esac

  if [ -z "$ip" ]; then
    ip="$(detect_ipv4)"
    [ -n "$ip" ] || die "could not detect the public IPv4; pass --ip A.B.C.D"
    if is_private_ipv4 "$ip"; then die "detected $ip is a private address (NAT?); pass the public one with --ip"; fi
  fi
  valid_ipv4 "$ip" || die "not an IPv4 address: $ip"
  host="$(printf '%s' "$ip" | tr . -).sslip.io"

  say "Site:     https://$host"
  say "Upstream: $UPSTREAM (reverse tunnel to the Mac)"
  say "Body cap: $body    Basic auth: ${user:-none}"
  if [ "$yes" != 1 ]; then
    read -r -p "Continue? [y/N] " ans
    [ "$ans" = y ] || [ "$ans" = Y ] || die "aborted"
  fi

  install_caddy
  if [ -n "$user" ]; then
    read -r -s -p "Password for $user: " pw; echo
    [ "${#pw}" -ge 12 ] || die "use at least 12 characters"
    hash="$(caddy hash-password --plaintext "$pw")"; pw=""
  fi

  tmp="$(mktemp)"; WEB_TMP="$tmp"; trap 'rm -f "$WEB_TMP"' EXIT
  render_caddyfile "$host" "$body" "$user" "$hash" > "$tmp"
  caddy validate --config "$tmp" --adapter caddyfile >/dev/null || die "Caddy rejected the generated Caddyfile; nothing changed"

  mkdir -p "$(dirname "$CADDYFILE")"
  if [ -e "$CADDYFILE" ]; then bak="$CADDYFILE.bak.$(date +%Y%m%d%H%M%S)"; cp -p "$CADDYFILE" "$bak"; say "backed up $CADDYFILE to $bak"; fi
  install -m 644 "$tmp" "$CADDYFILE"
  if [ -n "$user" ]; then chmod 640 "$CADDYFILE"; chown root:caddy "$CADDYFILE" 2>/dev/null || true; fi

  if systemctl is-active --quiet caddy; then
    systemctl reload caddy || { rollback "$bak"; die "caddy reload failed; previous Caddyfile restored"; }
  else
    systemctl enable --now caddy || { rollback "$bak"; die "caddy failed to start; previous Caddyfile restored"; }
  fi
  say ""
  say "Done: https://$host"
  say "The first request may take a few seconds while the certificate is issued."
  say "A 502 is normal until the Mac's tunnel (port 8780) and the Drover site (Mac port 7780) are up."
}

rollback() {
  if [ -n "${1:-}" ] && [ -e "$1" ]; then cp -p "$1" "$CADDYFILE"; systemctl reload caddy 2>/dev/null || systemctl restart caddy 2>/dev/null || true; fi
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then main "$@"; fi
