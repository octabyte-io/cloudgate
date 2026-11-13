#!/bin/sh
#
# Cloudgate: the one-command Self-hosted install.
#
#     curl -fsSL https://raw.githubusercontent.com/octabyte-io/cloudgate/main/install.sh | sudo sh
#
# On a bare Ubuntu 24.04 host it puts the checkout at /opt/cloudgate (cloning
# it over HTTPS, or fast-forwarding the one already there) and hands over to
# deploy/install.sh, which does the install itself. Running it again is the
# upgrade, as re-running deploy/install.sh is (docs/deploy.md §7).
#
# Inputs, all optional, read from the environment (`| sudo VAR=value sh`):
#
#   CLOUDGATE_PUBLIC_HOST  the public IP or hostname browsers will use. It is
#                          built into the console, so changing it is a rebuild.
#                          Default: the value the last install on this host was
#                          given, and on a first install this host's public
#                          IPv4 address, as api.ipify.org sees it.
#   CLOUDGATE_REF          the branch to install. Default: main.
#   CLOUDGATE_REPOSITORY   where to clone from. Default: the public repository.
#
# Everything else in the environment (HOSTED_MODE and its inputs, CONSOLE_PORT,
# SWAP_SIZE, ...) reaches deploy/install.sh unchanged.
#
# POSIX sh, not bash: `curl | sh` runs it under dash on Ubuntu. The body is one
# function called on the last line, so a download cut short runs nothing.

set -eu

CHECKOUT=/opt/cloudgate
CONSOLE_ENV_FILE=/etc/default/cloudgate-console

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
fail() {
  printf '%s\n' "$@" >&2
  exit 1
}

# git as root on a checkout deploy/install.sh gave to the cloudgate user:
# without safe.directory, git refuses it as "dubious ownership".
checkout_git() {
  git -c safe.directory="$CHECKOUT" -C "$CHECKOUT" "$@"
}

# The host the previous install gave the console, read back from the console's
# environment file, so a re-run with no input is an upgrade of the same
# instance rather than an install for a newly guessed address. A file written
# before the console read its address at start (ADR-0082) names it
# NEXT_PUBLIC_API_URL; that line is read only here, so such a box keeps its
# address when this run rewrites the file with CLOUDGATE_API_URL.
previous_public_host() {
  [ -r "$CONSOLE_ENV_FILE" ] || return 0
  sed -n \
    -e 's|^CLOUDGATE_API_URL=http://\(.*\):[0-9][0-9]*$|\1|p' \
    -e 's|^NEXT_PUBLIC_API_URL=http://\(.*\):[0-9][0-9]*$|\1|p' \
    "$CONSOLE_ENV_FILE" | tail -n 1
}

detect_public_ipv4() {
  for lookup in https://api.ipify.org https://checkip.amazonaws.com; do
    address="$(curl -4 -fsS --max-time 10 "$lookup" 2>/dev/null | tr -d '[:space:]')" || continue
    case "$address" in
      *[!0-9.]* | '') continue ;;
      *.*.*.*) printf '%s\n' "$address" && return 0 ;;
    esac
  done
  return 1
}

main() {
  [ "$(id -u)" -eq 0 ] || fail \
    "Run it as root:" \
    "    curl -fsSL https://raw.githubusercontent.com/octabyte-io/cloudgate/main/install.sh | sudo sh"

  # The two things deploy/install.sh needs and would only find out later.
  os_id=''
  os_version=''
  if [ -r /etc/os-release ]; then
    os_id="$(. /etc/os-release && printf '%s' "${ID:-}")"
    os_version="$(. /etc/os-release && printf '%s' "${VERSION_ID:-}")"
  fi
  [ "$os_id" = ubuntu ] && [ "$os_version" = 24.04 ] || fail \
    "Cloudgate installs on Ubuntu 24.04; this host is ${os_id:-unknown} ${os_version:-unknown}." \
    "docs/deploy.md §1 lists what the host needs."
  [ "$(uname -m)" = x86_64 ] || fail \
    "Cloudgate installs on amd64 (x86_64); this host is $(uname -m)."

  ref="${CLOUDGATE_REF:-main}"
  repository="${CLOUDGATE_REPOSITORY:-https://github.com/octabyte-io/cloudgate.git}"

  for tool in git curl; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      say "Installing $tool"
      apt-get update -qq
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git curl ca-certificates
      break
    fi
  done

  if [ -d "$CHECKOUT/.git" ]; then
    say "Updating $CHECKOUT to $ref"
    checkout_git fetch origin "$ref" || fail \
      "Could not fetch $ref from this checkout's origin ($(checkout_git remote get-url origin))." \
      "An install made before the repository was public may still name the SSH address;" \
      "point it at HTTPS and run this again:" \
      "    git -C $CHECKOUT remote set-url origin https://github.com/octabyte-io/cloudgate.git"
    checkout_git merge --ff-only FETCH_HEAD || fail \
      "$CHECKOUT has commits or changes of its own, so it cannot be fast-forwarded to $ref." \
      "Nothing was changed. Look at it with: git -C $CHECKOUT status"
  elif [ -e "$CHECKOUT" ]; then
    fail "$CHECKOUT exists but is not a git checkout. Move it aside and run this again."
  else
    say "Cloning Cloudgate ($ref) into $CHECKOUT"
    git clone --branch "$ref" "$repository" "$CHECKOUT"
  fi

  public_host="${CLOUDGATE_PUBLIC_HOST:-}"
  if [ -z "$public_host" ]; then
    public_host="$(previous_public_host)"
    [ -z "$public_host" ] || echo "Public host: $public_host (the one the last install used)"
  fi
  if [ -z "$public_host" ]; then
    public_host="$(detect_public_ipv4)" || fail \
      "Could not find this host's public IP address. Name it and run this again:" \
      "    curl -fsSL https://raw.githubusercontent.com/octabyte-io/cloudgate/main/install.sh | sudo CLOUDGATE_PUBLIC_HOST=<public ip or hostname> sh"
    echo "Public host: $public_host (detected; set CLOUDGATE_PUBLIC_HOST to choose another)"
  fi

  CLOUDGATE_PUBLIC_HOST="$public_host"
  export CLOUDGATE_PUBLIC_HOST
  exec bash "$CHECKOUT/deploy/install.sh"
}

main "$@"
