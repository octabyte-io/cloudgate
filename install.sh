#!/bin/sh
#
# Cloudgate: the one-command Self-hosted install.
#
#     curl -fsSL https://raw.githubusercontent.com/octabyte-io/cloudgate/main/install.sh | sudo sh
#
# On a bare Ubuntu 24.04 or 26.04 amd64 platform host (ADR-0085), or an arm64
# one with HOSTED_MODE=true for the Hosted instance only (ADR-0088), it
# downloads a Cloudgate version (ADR-0082): the tarball for the host's CPU on
# the GitHub Release for its tag, checked against the sha256 published beside
# it once that checksum's signature verifies against the key below (ADR-0087),
# and unpacked into /opt/cloudgate.next. Then it hands over
# to that version's deploy/install.sh, which does the install itself and puts
# the version in place at /opt/cloudgate. Nothing is cloned or built. Running it
# again is the upgrade (docs/deploy.md §7); a run on the version already
# installed downloads nothing and re-runs that version's own install. A host
# whose /opt/cloudgate is a git checkout, from an install made before versions,
# is switched over: the version's install moves the checkout aside and keeps it.
#
# Inputs, all optional, read from the environment (`| sudo VAR=value sh`):
#
#   CLOUDGATE_VERSION      the Cloudgate version to install, vX.Y.Z (or X.Y.Z).
#                          Default: the latest one published.
#   CLOUDGATE_PUBLIC_HOST  the public IP or hostname browsers will use: the
#                          host alone, an IPv4 or IPv6 address or a hostname,
#                          with no scheme, port or path. The console reads it
#                          when it starts, so changing it is a restart.
#                          Default: the value the last install on this host
#                          was given, and on a first install this host's
#                          public IPv4 address, as api.ipify.org sees it.
#   CLOUDGATE_SKIP_PREFLIGHT  1 skips the checks before the download, which
#                          warn about busy ports, low disk and memory and
#                          hosts that do not answer, and never stop the run.
#
# Everything else in the environment (HOSTED_MODE and its inputs, CONSOLE_PORT,
# ...) reaches deploy/install.sh unchanged. HOSTED_MODE is read here only to
# accept an arm64 host.
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
BACKEND_ENV_FILE="${INSTALL_ROOT:-}/etc/default/cloudgate-backend"
# Held for the whole run, deploy/install.sh included: two runs at once would
# both empty and unpack into $STAGING_DIR, and one could put the other's
# half-unpacked version in place.
LOCK_FILE="${INSTALL_ROOT:-}/run/lock/cloudgate-install.lock"
OS_RELEASE="${INSTALL_ROOT:-}/etc/os-release"

# A Cloudgate version's release is tagged vX.Y.Z. The same repository also
# publishes the CLI as cli-vX.Y.Z, which is never one.
RELEASES_API=https://api.github.com/repos/octabyte-io/cloudgate/releases?per_page=100
RELEASES_DOWNLOAD=https://github.com/octabyte-io/cloudgate/releases/download
RELEASES_PAGE=https://github.com/octabyte-io/cloudgate/releases

# The keys Cloudgate versions' checksums are signed with (ADR-0087), as
# ssh-keygen's allowed-signers file, one line per key: publish-version.yml
# signs each .sha256 with the private half, the VERSION_SIGNING_KEY secret, in
# the cloudgate-version namespace, and a signature by any key here verifies.
# A rotation adds the new public key as a second line before the first version
# signed with it. deploy/version-sign.sh reads every line to check what it
# signed.
VERSION_SIGNERS='cloudgate-version namespaces="cloudgate-version" ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOErAhkCuVbN93mcEL4k0I0v+5KL528MRSBJPyfvsE7B cloudgate-version-signing'

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
fail() {
  printf '%s\n' "$@" >&2
  exit 1
}

# The host the previous install was given, so a re-run with no input is an
# upgrade of the same instance rather than an install for a newly guessed
# address. The Hosted instance keeps it as CLOUDGATE_PUBLIC_HOST in the
# backend's environment file, because its console is reached at
# https://<hostname>, which names no address; a Self-hosted box has it in the
# console's API address. A console file written before the console read its
# address at start (ADR-0082) names that NEXT_PUBLIC_API_URL; that line is
# read only here, so such a box keeps its address when this run rewrites the
# file with CLOUDGATE_API_URL. An IPv6 address comes back without the
# brackets its URL needs.
previous_public_host() {
  if [ -r "$BACKEND_ENV_FILE" ]; then
    host="$(sed -n "s/^CLOUDGATE_PUBLIC_HOST='\(.*\)'\$/\1/p" "$BACKEND_ENV_FILE" | tail -n 1)"
    if [ -n "$host" ]; then
      printf '%s\n' "$host"
      return 0
    fi
  fi
  [ -r "$CONSOLE_ENV_FILE" ] || return 0
  sed -n \
    -e 's|^CLOUDGATE_API_URL=http://\(.*\):[0-9][0-9]*$|\1|p' \
    -e 's|^NEXT_PUBLIC_API_URL=http://\(.*\):[0-9][0-9]*$|\1|p' \
    "$CONSOLE_ENV_FILE" | tail -n 1 | tr -d '[]'
}

# 0 when $1 is a host alone: an IPv4 address, a hostname, or an IPv6 address
# (two colons at least, and only hex digits, colons and dots). A scheme, port
# or path would end up inside every origin the install writes, as
# http://https://host:3000.
public_host_ok() {
  case "$1" in
    '' | *[!0-9A-Za-z.:-]*) return 1 ;;
    *:*:*)
      case "$1" in *[!0-9A-Fa-f:.]*) return 1 ;; esac
      ;;
    *:*) return 1 ;;
  esac
}

# apt-get, waiting out the lock another apt holds. On a VPS's first boot
# cloud-init and unattended-upgrades hold it for minutes, and apt-get fails at
# once with "Could not get lock". DPkg::Lock::Timeout has apt wait for dpkg's
# lock itself; a refusal that still names a lock (update's lists lock among
# them) is tried again, every 10 seconds for 10 minutes. Any other failure is
# apt's answer, and is returned at once.
apt_get() {
  tries=0
  apt_errors="$(mktemp)"
  while :; do
    if DEBIAN_FRONTEND=noninteractive apt-get -o DPkg::Lock::Timeout=600 "$@" 2>"$apt_errors"; then
      cat "$apt_errors" >&2
      rm -f "$apt_errors"
      return 0
    fi
    cat "$apt_errors" >&2
    tries=$((tries + 1))
    if ! grep -q 'Could not get lock' "$apt_errors" || [ "$tries" -ge 60 ]; then
      rm -f "$apt_errors"
      return 1
    fi
    echo "Another apt is running; waiting for it to finish (try $tries of 60)." >&2
    sleep 10
  done
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

# Prints whichever of two X.Y.Z versions is lower, compared as numbers
# (0.9.0 is before 0.10.0).
lower_version() {
  printf '%s\n%s\n' "$1" "$2" | sort -t . -k 1,1n -k 2,2n -k 3,3n | head -n 1
}

# Refuses <version> when it is older than the one installed: going back is not
# supported, because a version's migrations only go forward.
refuse_older() {
  [ -n "$installed" ] && [ "$1" != "$installed" ] || return 0
  [ "$(lower_version "$1" "$installed")" = "$1" ] || return 0
  fail \
    "Cloudgate $installed is installed, and $1 is older. Going back to an older version is not" \
    "supported: its migrations only go forward, and $installed's have already run." \
    "Nothing was changed. The versions are listed at $RELEASES_PAGE."
}

# The highest vX.Y.Z among the repository's releases that carries the
# tarball for this host's CPU with its .sha256 and .sha256.sig, as X.Y.Z,
# compared as numbers (0.10.0 is after 0.9.0). A release missing any of the
# three, made by hand or still being published, is not a version yet: its
# download would fail or be refused. One page of 100, newest first; the
# console's update notice reads the same page and counts a release by the
# same three files. Empty when there is none.
#
# No jq on a bare box, so the answer is read as the sequence of its
# "tag_name" and "name" strings: GitHub writes a release's tag_name before
# its assets, and each asset's name inside them, so each file's name is
# matched against the tag last seen.
latest_version() {
  releases="$(curl -fsSL --retry 3 --retry-connrefused --connect-timeout 15 "$RELEASES_API")" || fail \
    "Could not ask GitHub for Cloudgate's releases ($RELEASES_API)." \
    "Name the version to install and run this again:" \
    "    curl -fsSL https://raw.githubusercontent.com/octabyte-io/cloudgate/main/install.sh | sudo CLOUDGATE_VERSION=v<X.Y.Z> sh"
  printf '%s\n' "$releases" |
    grep -oE '"(tag_name|name)": *"[^"]*"' |
    awk -F '"' -v cpu="$cpu" '
      $2 == "tag_name" {
        tag = ($4 ~ /^v[0-9]+\.[0-9]+\.[0-9]+$/) ? substr($4, 2) : ""
        held = 0
      }
      $2 == "name" && tag != "" {
        tarball = "cloudgate-" tag "-linux-" cpu ".tar.gz"
        if ($4 == tarball || $4 == tarball ".sha256" || $4 == tarball ".sha256.sig")
          if (++held == 3) print tag
      }' |
    sort -t . -k 1,1n -k 2,2n -k 3,3n |
    tail -n 1
}

# download_version <X.Y.Z>: the version's tarball for this host's CPU, checked
# against its published sha256 before anything is unpacked, unpacked into
# $STAGING_DIR. The sha256 is trusted only once its signature verifies against
# VERSION_SIGNERS (ADR-0087), which is checked before the tarball is
# downloaded. Nothing outside a download directory beside the install is
# written until both checks pass, and that directory is removed whatever
# happens.
download_version() {
  version="$1"
  name="cloudgate-$version-linux-$cpu.tar.gz"
  url="$RELEASES_DOWNLOAD/v$version/$name"

  # A run killed outright (SIGKILL, a power cut) can leave one; under the
  # lock, none belongs to another run.
  rm -rf "$INSTALL_DIR".download.*
  download="$(mktemp -d "$INSTALL_DIR.download.XXXXXX")"
  trap 'rm -rf "$download"' EXIT
  # dash, which runs `curl | sh`, runs no EXIT trap for a signal that kills
  # it, so Ctrl-C (INT), a kill (TERM) and a dropped SSH session (HUP) exit
  # instead, which runs it.
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP

  say "Downloading Cloudgate $version"
  curl -fsSL --retry 3 --retry-connrefused --connect-timeout 15 -o "$download/$name.sha256" "$url.sha256" || fail \
    "Cloudgate v$version has no published release to install ($url.sha256)." \
    "The versions are listed at $RELEASES_PAGE. Nothing was changed."
  curl -fsSL --retry 3 --retry-connrefused --connect-timeout 15 -o "$download/$name.sha256.sig" "$url.sha256.sig" || fail \
    "Cloudgate v$version has no signature on its checksum ($url.sha256.sig), so it was not installed." \
    "Every Cloudgate version is signed when it is published; one without a signature is not one we published." \
    "Nothing was changed."
  printf '%s\n' "$VERSION_SIGNERS" > "$download/allowed_signers"
  ssh-keygen -Y verify -f "$download/allowed_signers" -I cloudgate-version -n cloudgate-version \
    -s "$download/$name.sha256.sig" < "$download/$name.sha256" > "$download/verified" 2>&1 || fail \
    "The signature on Cloudgate v$version's checksum does not verify, so it was not installed:" \
    "$(sed 's/^/  /' "$download/verified")" \
    "It was not signed with Cloudgate's key (docs/deploy.md §2). Nothing was changed. If it happens again, report it."
  # The signature proves we signed this checksum, not that it is this
  # tarball's: another CPU's or version's, signed as well, would verify too.
  # sha256sum writes "<hash>  <file>" ("<hash> *<file>" in binary mode).
  named="$(sed -n '1s/^[^ ]* [ *]//p' "$download/$name.sha256")"
  [ "$named" = "$name" ] || fail \
    "Cloudgate v$version's signed checksum is for ${named:-no file}, not $name, so it was not installed." \
    "Nothing was changed. If it happens again, report it."
  # A progress bar for an operator watching a terminal; nothing when the
  # output goes to a file or a pipe, which would only collect its redraws.
  progress=-sS
  if [ -t 2 ]; then progress=--progress-bar; fi
  curl -fL "$progress" --retry 3 --retry-connrefused --connect-timeout 15 -o "$download/$name" "$url" || fail \
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
  trap - EXIT INT TERM HUP
  [ "$(cat "$STAGING_DIR/VERSION" 2>/dev/null)" = "$version" ] || fail \
    "$name unpacked to a VERSION other than $version; it was left at $STAGING_DIR."
}

### Preflight: warnings only. What it finds is likely to fail the install
### minutes into its downloads, and is said before them; nothing here stops
### the run. CLOUDGATE_SKIP_PREFLIGHT=1 skips it. Each check prints one line
### per finding; a GB is 1,000,000,000 bytes.

# The ports the install's own services take: Traefik 80 and 443, the console
# 3000 and the API 4000.
PREFLIGHT_PORTS='80 443 3000 4000'
# docs/deploy.md §1's Outbound row, held equal to it by
# backend/test/deploy/one-command-install.spec.ts.
PREFLIGHT_HOSTS='get.docker.com nodejs.org registry.npmjs.org registry-1.docker.io api.github.com github.com release-assets.githubusercontent.com s3.amazonaws.com'
# 15 GB and 4 GB, in the KiB df and /proc/meminfo count in.
PREFLIGHT_MIN_DISK_KIB=14648438
PREFLIGHT_MIN_MEMORY_KIB=3906250

# 0 when the listener <name> <pid> on <port> is Cloudgate's own, as on a
# re-run: a process of one of its units, or docker-proxy holding 80 or 443 for
# its Traefik. docker-proxy holds a port for any container that publishes it,
# and Traefik publishes only those two, so one on 3000 or 4000 is someone
# else's container.
cloudgate_listener() {
  grep -qE 'cloudgate-(backend|console)\.service' "${INSTALL_ROOT:-}/proc/$2/cgroup" 2>/dev/null &&
    return 0
  [ "$1" = docker-proxy ] || return 1
  case "$3" in 80 | 443) ;; *) return 1 ;; esac
  command -v docker >/dev/null 2>&1 &&
    [ -n "$(docker ps -q --filter 'name=^cloudgate-traefik$' 2>/dev/null)" ]
}

# Each of PREFLIGHT_PORTS another process listens on, from `ss -Hltnp`: one
# line per port and process, an address family's second socket left out.
preflight_ports() {
  ss -Hltnp 2>/dev/null |
    awk -v ports=" $PREFLIGHT_PORTS " '{
      n = split($4, address, ":")
      port = address[n]
      if (index(ports, " " port " ") == 0) next
      name = "an unnamed process"; pid = "?"
      if (match($0, /users:\(\("[^"]*",pid=[0-9]+/)) {
        found = substr($0, RSTART, RLENGTH)
        split(found, quoted, "\"")
        name = quoted[2]
        pid = found
        sub(/.*pid=/, "", pid)
      }
      if (seen[port " " pid]++) next
      print port "\t" pid "\t" name
    }' |
    while IFS="$(printf '\t')" read -r port pid name; do
      cloudgate_listener "$name" "$pid" "$port" && continue
      echo "port $port is held by $name (pid $pid), which is not Cloudgate's; what Cloudgate runs on it will not start until it is free."
    done
}

# Each filesystem /opt or /usr/local is on with less than 15 GB free, once.
preflight_disk() {
  for dir in /opt /usr/local; do
    df -Pk "${INSTALL_ROOT:-}$dir" 2>/dev/null | awk -v dir="$dir" 'NR == 2 { print $6, $4, dir }'
  done |
    awk -v min="$PREFLIGHT_MIN_DISK_KIB" '{
      if (!($1 in free)) { order[++n] = $1; free[$1] = $2; dirs[$1] = $3 }
      else dirs[$1] = dirs[$1] " and " $3
    }
    END {
      for (i = 1; i <= n; i++) {
        mount = order[i]
        if (free[mount] < min)
          printf "only %.1f GB is free on %s (which holds %s); the install needs 15 GB.\n", free[mount] * 1024 / 1e9, mount, dirs[mount]
      }
    }'
}

preflight_memory() {
  kib="$(awk '$1 == "MemTotal:" { print $2 }' "${INSTALL_ROOT:-}/proc/meminfo" 2>/dev/null)"
  [ -n "$kib" ] && [ "$kib" -lt "$PREFLIGHT_MIN_MEMORY_KIB" ] || return 0
  awk -v kib="$kib" 'BEGIN {
    printf "this platform host has %.1f GB of memory (MemTotal); Cloudgate needs 4 GB.\n", kib * 1024 / 1e9
  }'
}

# Each host that gives no answer at all within 5 seconds; any HTTP status is
# one. Asked all at once, so an offline host costs 5 seconds, not 35.
preflight_hosts() {
  answered="$(mktemp -d)"
  for host in $PREFLIGHT_HOSTS; do
    (if curl -s -o /dev/null --max-time 5 "https://$host/"; then : >"$answered/$host"; fi) &
  done
  wait
  for host in $PREFLIGHT_HOSTS; do
    [ -e "$answered/$host" ] ||
      echo "$host did not answer within 5 seconds; the install downloads from it (docs/deploy.md §1)."
  done
  rm -rf "$answered"
}

preflight() {
  [ "${CLOUDGATE_SKIP_PREFLIGHT:-}" != 1 ] || return 0
  say "Checking the platform host"
  # In an || list, so no failing command in a check can end the run.
  warnings="$(
    {
      preflight_ports
      preflight_disk
      preflight_memory
      preflight_hosts
    } || true
  )"
  [ -n "$warnings" ] || return 0
  printf '%s\n' "$warnings" | sed 's/^/Warning: /' >&2
  echo "The install carries on. Set CLOUDGATE_SKIP_PREFLIGHT=1 to skip these checks." >&2
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
  # Each CPU's tarball, built on 24.04, runs on both (ADR-0085).
  case "$os_id $os_version" in
    'ubuntu 24.04' | 'ubuntu 26.04') ;;
    *) fail \
      "Cloudgate installs on Ubuntu 24.04 or 26.04; this platform host is ${os_id:-unknown} ${os_version:-unknown}." \
      "docs/deploy.md §1 lists what the platform host needs." ;;
  esac
  # amd64 everywhere; arm64 on the Hosted instance only (ADR-0088), which
  # builds nothing on its platform host. Each CPU has its own tarball.
  machine="$(uname -m)"
  case "$machine" in
    x86_64) cpu=amd64 ;;
    aarch64)
      [ "${HOSTED_MODE:-}" = true ] || fail \
        "This platform host is arm64 ($machine). Cloudgate supports Arm for the Hosted instance only" \
        "(HOSTED_MODE=true); a Self-hosted install needs an amd64 (x86_64) host. Nothing was changed."
      cpu=arm64
      ;;
    *) fail \
      "Cloudgate installs on amd64 (x86_64), and on arm64 (aarch64) for the Hosted instance only;" \
      "this platform host is $machine. Nothing was changed." ;;
  esac

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

  public_host="${CLOUDGATE_PUBLIC_HOST:-}"
  # An IPv6 address may come in the brackets a URL gives it.
  public_host="${public_host#\[}"
  public_host="${public_host%\]}"
  if [ -n "${CLOUDGATE_PUBLIC_HOST:-}" ] && ! public_host_ok "$public_host"; then
    fail \
      "CLOUDGATE_PUBLIC_HOST is the public IP address or hostname alone, such as 203.0.113.10," \
      "2001:db8::10 or cloud.example.com, not \"$CLOUDGATE_PUBLIC_HOST\": no scheme, port or path." \
      "Nothing was changed."
  fi

  mkdir -p "$(dirname "$LOCK_FILE")"
  exec 9>"$LOCK_FILE"
  flock -n 9 || fail \
    "Another Cloudgate install is running on this platform host; this one stopped before changing anything." \
    "Let it finish, then run this again if you still need to."

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
  if [ -n "$requested" ]; then refuse_older "$requested"; fi

  # curl downloads the version and ssh-keygen checks its signature; a stock
  # Ubuntu server image has both, a minimal one may have neither.
  missing=''
  command -v curl >/dev/null 2>&1 || missing='curl ca-certificates'
  command -v ssh-keygen >/dev/null 2>&1 || missing="${missing:+$missing }openssh-client"
  if [ -n "$missing" ]; then
    say "Installing $missing"
    apt_get update -qq
    # One word per package.
    # shellcheck disable=SC2086
    apt_get install -y -qq $missing
  fi

  # Before anything is downloaded; it needs curl for the hosts.
  preflight

  if [ -z "$public_host" ]; then
    public_host="$(previous_public_host)"
    # Read back from files someone may have edited, so held to the same rule
    # as one given, and refused before anything is downloaded.
    if [ -n "$public_host" ] && ! public_host_ok "$public_host"; then
      fail \
        "The public host the last install used, read back from $BACKEND_ENV_FILE or $CONSOLE_ENV_FILE," \
        "is \"$public_host\", which is not an IP address or hostname alone. Name it and run this again:" \
        "    curl -fsSL https://raw.githubusercontent.com/octabyte-io/cloudgate/main/install.sh | sudo CLOUDGATE_PUBLIC_HOST=<public ip or hostname> sh" \
        "Nothing was changed."
    fi
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
      "No Cloudgate version has been published yet: no release at $RELEASES_PAGE carries a signed $cpu tarball" \
      "(the tarball, its .sha256 and the signature on it, .sha256.sig). Nothing was changed."
    refuse_older "$version"
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
  # The lock on descriptor 9 goes with it, so it is held until the install ends.
  exec bash "$dir/deploy/install.sh"
}

main "$@"
