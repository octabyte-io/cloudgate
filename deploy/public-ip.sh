# shellcheck shell=bash
#
# The platform host's public IP address, which deploy/install.sh hands the
# backend as CLOUDGATE_PUBLIC_IP so a fresh instance starts with Settings >
# Instance's public address filled in. That address is what the free sslip.io
# Domains for what runs on the platform host are made from; while it is empty,
# generating one only says to set it. Sourced by install.sh; defines functions
# and runs nothing. backend/test/deploy/public-ip.spec.ts drives them directly.
#
# The backend writes it only into a public address that was never set, so an
# owner's own value, or one they cleared, is never replaced
# (SettingsService.prefillServerIp).

# The echo services asked, in order. Each answers with the caller's address and
# nothing else. Several, because any one of them can be down or blocked.
PUBLIC_IP_LOOKUPS="${PUBLIC_IP_LOOKUPS:-https://api.ipify.org https://checkip.amazonaws.com https://ipv4.icanhazip.com}"

# 0 when $1 is an IPv4 address, four octets of 0-255.
ipv4_literal() {
  local IFS=. octet
  # Word splitting on the dots is the point.
  # shellcheck disable=SC2086
  set -- $1
  [ "$#" -eq 4 ] || return 1
  for octet in "$@"; do
    case "$octet" in '' | *[!0-9]*) return 1 ;; esac
    [ "${#octet}" -le 3 ] && [ "$octet" -le 255 ] || return 1
  done
}

# 0 when $1 is an IPv4 address the internet can reach: not private, loopback,
# link-local, carrier-grade NAT, a documentation range, multicast or reserved.
# An sslip.io name on any of those resolves to an address no visitor can open.
public_ipv4() {
  ipv4_literal "$1" || return 1
  local a b
  a="${1%%.*}"
  b="${1#*.}"
  b="${b%%.*}"
  case "$a" in
    0 | 10 | 127) return 1 ;;
    100) [ "$b" -ge 64 ] && [ "$b" -le 127 ] && return 1 ;;
    169) [ "$b" -eq 254 ] && return 1 ;;
    172) [ "$b" -ge 16 ] && [ "$b" -le 31 ] && return 1 ;;
    192)
      [ "$b" -eq 168 ] && return 1
      case "$1" in 192.0.0.* | 192.0.2.*) return 1 ;; esac
      ;;
    198)
      [ "$b" -eq 18 ] || [ "$b" -eq 19 ] && return 1
      case "$1" in 198.51.100.*) return 1 ;; esac
      ;;
    203) case "$1" in 203.0.113.*) return 1 ;; esac ;;
  esac
  [ "$a" -lt 224 ]
}

# Prints this host's public IPv4 address as the first echo service that
# answers sees it, and fails when none answers with a public one within its
# timeout. A lookup that is down, slow or answers with something else is
# skipped for the next one.
detect_public_ipv4() {
  local lookup address
  for lookup in $PUBLIC_IP_LOOKUPS; do
    address="$(curl -4 -fsS --max-time 5 "$lookup" 2>/dev/null | tr -d '[:space:]')" || continue
    if public_ipv4 "$address"; then
      printf '%s\n' "$address"
      return 0
    fi
  done
  return 1
}

# Prints the address the backend is to prefill the public address with, or
# nothing when there is none to give. In order:
#
#   CLOUDGATE_PUBLIC_IP, when the operator sets it: used as given, private or
#     not, since they know their network. It must be an IP address; `none`
#     turns the prefill off.
#   CLOUDGATE_PUBLIC_HOST, when it is an IP address: used when it is public,
#     and nothing otherwise. An install on a private address was asked for,
#     and the NAT's address is not this host's.
#   CLOUDGATE_PUBLIC_HOST, when it is a hostname: the address the echo
#     services see, when one answers. `localhost` is the SSH-tunnel setup and
#     gets nothing.
#
# Fails, printing why, only when CLOUDGATE_PUBLIC_IP is not an address.
platform_public_ip() {
  local given="${CLOUDGATE_PUBLIC_IP:-}" host="${CLOUDGATE_PUBLIC_HOST:-}"
  given="${given#\[}"
  given="${given%\]}"
  if [ -n "$given" ]; then
    [ "$given" = none ] && return 0
    if ipv4_literal "$given"; then
      printf '%s\n' "$given"
      return 0
    fi
    case "$given" in
      *:*:*)
        case "$given" in *[!0-9A-Fa-f:]*) ;; *) printf '%s\n' "$given" && return 0 ;; esac
        ;;
    esac
    echo "CLOUDGATE_PUBLIC_IP is this host's public IP address alone, such as 203.0.113.10," >&2
    echo "or none to leave Settings > Instance's public address empty, not \"$given\"." >&2
    return 1
  fi
  if ipv4_literal "$host"; then
    public_ipv4 "$host" && printf '%s\n' "$host"
    return 0
  fi
  # An IPv6 address is passed on; the backend keeps only a public one.
  case "$host" in *:*)
    printf '%s\n' "$host"
    return 0
    ;;
  esac
  case "$host" in '' | localhost | *.localhost) return 0 ;; esac
  detect_public_ipv4 || true
}
