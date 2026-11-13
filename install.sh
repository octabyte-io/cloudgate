#!/bin/sh
#
# Cloudgate: the one-command Self-hosted install.
#
#     curl -fsSL https://raw.githubusercontent.com/octabyte-io/cloudgate/main/install.sh | sudo sh
#
# On a bare Ubuntu 24.04 host it downloads a Cloudgate version (ADR-0082): the
# tarball on the GitHub Release for its tag, checked against the sha256
# published beside it and unpacked into /opt/cloudgate.next. Then it hands over
# to that version's deploy/install.sh, which does the install itself and puts
# the version in place at /opt/cloudgate. Nothing is cloned or built. Running it
# again is the upgrade (docs/deploy.md §7); a run on the version already
# installed downloads nothing and re-runs that version's own install.
#
# Inputs, all optional, read from the environment (`| sudo VAR=value sh`):
#
#   CLOUDGATE_VERSION      the Cloudgate version to install, vX.Y.Z (or X.Y.Z).
#                          Default: the latest one published.
#   CLOUDGATE_PUBLIC_HOST  the public IP or hostname browsers will use. The
#                          console reads it when it starts, so changing it is a
#                          restart. Default: the value the last install on this
#                          host was given, and on a first install this host's
#                          public IPv4 address, as api.ipify.org sees it.
#
# Everything else in the environment (HOSTED_MODE and its inputs, CONSOLE_PORT,
# ...) reaches deploy/install.sh unchanged.
#
# INSTALL_ROOT is for backend/test/deploy/one-command-install.spec.ts only: a
# directory the run treats as /, so the test can drive it off a real box.
#
# POSIX sh, not bash: `curl | sh` runs it under dash on Ubuntu. The body is one
# function called on the last line, so a download cut short runs nothing.

set -eu

INSTALL_DIR="${INSTALL_ROOT:-}/opt/cloudgate"
# Beside the install, not in /tmp: on one filesystem, deploy/install.sh moves
# it into place with a rename, and a small VPS's /tmp may be memory.
STAGING_DIR="$INSTALL_DIR.next"
CONSOLE_ENV_FILE="${INSTALL_ROOT:-}/etc/default/cloudgate-console"
OS_RELEASE="${INSTALL_ROOT:-}/etc/os-release"

# A Cloudgate version's release is tagged vX.Y.Z. The same repository also
# publishes the CLI as cli-vX.Y.Z, which is never one.
RELEASES_API=https://api.github.com/repos/octabyte-io/cloudgate/releases?per_page=100
RELEASES_DOWNLOAD=https://github.com/octabyte-io/cloudgate/releases/download
RELEASES_PAGE=https://github.com/octabyte-io/cloudgate/releases

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
fail() {
  printf '%s\n' "$@" >&2
  exit 1
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

# X.Y.Z when $1 is vX.Y.Z or X.Y.Z, and nothing (status 1) otherwise.
plain_version() {
  version="${1#v}"
  case "$version" in
    '' | *[!0-9.]* | .* | *. | *..*) return 1 ;;
  esac
  [ "$(printf '%s' "$version" | tr -cd . | wc -c)" -eq 2 ] || return 1
  printf '%s\n' "$version"
}

# The highest vX.Y.Z among the repository's releases, as X.Y.Z, compared as
# numbers (0.10.0 is after 0.9.0). One page of 100, newest first, as the
# console's update notice reads it. Empty when there is none.
latest_version() {
  releases="$(curl -fsSL "$RELEASES_API")" || fail \
    "Could not ask GitHub for Cloudgate's releases ($RELEASES_API)." \
    "Name the version to install and run this again:" \
    "    curl -fsSL https://raw.githubusercontent.com/octabyte-io/cloudgate/main/install.sh | sudo CLOUDGATE_VERSION=v<X.Y.Z> sh"
  printf '%s\n' "$releases" |
    grep -o '"tag_name": *"v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*"' |
    sed 's/.*"v\(.*\)"$/\1/' |
    sort -t . -k 1,1n -k 2,2n -k 3,3n |
    tail -n 1
}

# download_version <X.Y.Z>: the version's tarball, checked against its
# published sha256 before anything is unpacked, unpacked into $STAGING_DIR.
# Nothing outside a download directory beside the install is written until the
# checksum matches, and that directory is removed whatever happens.
download_version() {
  version="$1"
  name="cloudgate-$version-linux-amd64.tar.gz"
  url="$RELEASES_DOWNLOAD/v$version/$name"

  download="$(mktemp -d "$INSTALL_DIR.download.XXXXXX")"
  trap 'rm -rf "$download"' EXIT

  say "Downloading Cloudgate $version"
  curl -fsSL -o "$download/$name.sha256" "$url.sha256" || fail \
    "Cloudgate v$version has no published release to install ($url.sha256)." \
    "The versions are listed at $RELEASES_PAGE. Nothing was changed."
  curl -fsSL -o "$download/$name" "$url" || fail \
    "Could not download $url. Nothing was changed."

  # Compared here rather than with `sha256sum -c`, which checks whichever file
  # the .sha256 names: this one checks the file that is about to be unpacked.
  expected="$(cut -d ' ' -f 1 < "$download/$name.sha256")"
  actual="$(sha256sum "$download/$name" | cut -d ' ' -f 1)"
  [ -n "$expected" ] && [ "$actual" = "$expected" ] || fail \
    "$name does not match its published sha256, so it was not unpacked." \
    "  published: ${expected:-(empty)}" \
    "  download:  $actual" \
    "Nothing was changed. Run this again; if it happens again, report it."

  # An interrupted run may have left one; it is never the installed version.
  rm -rf "$STAGING_DIR"
  mkdir -p "$STAGING_DIR"
  tar -xzf "$download/$name" -C "$STAGING_DIR" --no-same-owner
  rm -rf "$download"
  trap - EXIT
  [ "$(cat "$STAGING_DIR/VERSION" 2>/dev/null)" = "$version" ] || fail \
    "$name unpacked to a VERSION other than $version; it was left at $STAGING_DIR."
}

main() {
  [ "$(id -u)" -eq 0 ] || fail \
    "Run it as root:" \
    "    curl -fsSL https://raw.githubusercontent.com/octabyte-io/cloudgate/main/install.sh | sudo sh"

  # The two things deploy/install.sh needs and would only find out later.
  os_id=''
  os_version=''
  if [ -r "$OS_RELEASE" ]; then
    os_id="$(. "$OS_RELEASE" && printf '%s' "${ID:-}")"
    os_version="$(. "$OS_RELEASE" && printf '%s' "${VERSION_ID:-}")"
  fi
  [ "$os_id" = ubuntu ] && [ "$os_version" = 24.04 ] || fail \
    "Cloudgate installs on Ubuntu 24.04; this host is ${os_id:-unknown} ${os_version:-unknown}." \
    "docs/deploy.md §1 lists what the host needs."
  [ "$(uname -m)" = x86_64 ] || fail \
    "Cloudgate installs on amd64 (x86_64); this host is $(uname -m)."

  # A branch was what the install built before it installed versions. Refused
  # rather than ignored: a run asked for one thing must not install another.
  [ -z "${CLOUDGATE_REF:-}" ] || fail \
    "CLOUDGATE_REF is no longer read: the install installs a Cloudgate version, never a branch." \
    "Name one with CLOUDGATE_VERSION, or leave it unset for the latest:" \
    "    curl -fsSL https://raw.githubusercontent.com/octabyte-io/cloudgate/main/install.sh | sudo CLOUDGATE_VERSION=v0.3.0 sh" \
    "Building from source is by hand: docs/deploy.md §2."

  requested=''
  if [ -n "${CLOUDGATE_VERSION:-}" ]; then
    requested="$(plain_version "$CLOUDGATE_VERSION")" || fail \
      "CLOUDGATE_VERSION names a Cloudgate version such as v0.3.0, not \"$CLOUDGATE_VERSION\"." \
      "The versions are listed at $RELEASES_PAGE."
  fi

  # A box installed from a git checkout, before the install installed
  # versions, is switched over: the checkout holds no version, so the run
  # installs as on a new box, and the version's own deploy/install.sh moves
  # the checkout aside when it puts itself in place. /etc/default/cloudgate-*
  # and the database are the instance, and are kept.
  installed=''
  if [ -d "$INSTALL_DIR/.git" ]; then
    echo "$INSTALL_DIR is a git checkout; it will be moved aside and a Cloudgate version installed in its place."
  elif [ -e "$INSTALL_DIR" ]; then
    installed="$(cat "$INSTALL_DIR/VERSION" 2>/dev/null)" || fail \
      "$INSTALL_DIR exists but holds no Cloudgate version (it has no VERSION file)." \
      "Move it aside and run this again. Nothing was changed."
  fi

  if ! command -v curl >/dev/null 2>&1; then
    say "Installing curl"
    apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq curl ca-certificates
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

  version="$requested"
  if [ -z "$version" ]; then
    version="$(latest_version)"
    [ -n "$version" ] || fail \
      "No Cloudgate version has been published yet ($RELEASES_PAGE)." \
      "Nothing was changed."
  fi

  if [ "$version" = "$installed" ]; then
    echo "Cloudgate $version is already installed at $INSTALL_DIR; re-running its install."
    rm -rf "$STAGING_DIR"
    dir="$INSTALL_DIR"
  else
    download_version "$version"
    dir="$STAGING_DIR"
  fi

  CLOUDGATE_PUBLIC_HOST="$public_host"
  export CLOUDGATE_PUBLIC_HOST
  exec bash "$dir/deploy/install.sh"
}

main "$@"
