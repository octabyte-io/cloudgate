#!/usr/bin/env bash
#
# The Hosted instance's updater: upgrades the box to one release tag. Installed
# by install.sh's HOSTED_MODE=true path as /usr/local/sbin/cloudgate-update and
# run by .github/workflows/deploy-hosted.yml over SSH, as the cloudgate-deploy
# user whose key can run nothing else (deploy/hosted-update-access.sh):
#
#     ssh cloudgate-deploy@<box> v0.3.0
#
# sshd runs this as that key's forced command, with the tag in
# $SSH_ORIGINAL_COMMAND. Root can run it by hand the same way:
#
#     cloudgate-update v0.3.0
#
# The tag must be vX.Y.Z and a published Cloudgate version: its tarball's
# .sha256 is on the tag's GitHub Release, which publish-version.yml puts there
# only after the tag's E2E (release) run is green (ADR-0082). A run takes a
# backup to B2 first and then runs the tag's own one-command install with
# CLOUDGATE_VERSION=<tag> and HOSTED_MODE=true, which is the upgrade
# (docs/deploy.md §7), and checks /opt/cloudgate/VERSION is the tag after it;
# every other input is read back from /etc/default/cloudgate-hosted, so
# nothing secret travels over SSH or lives in GitHub.
#
# The upgrade runs in its own transient systemd unit, cloudgate-update.service,
# not under the SSH session: a dropped connection must never cut an install off
# half-way through its migrations. The caller follows the unit's
# journal and gets its exit status. A second update while one is running is
# refused, because the unit already exists.
#
# backend/test/deploy/hosted-update.spec.ts runs this with sudo, systemd-run,
# journalctl, systemctl and curl (GitHub) stubbed; the UPDATE_* overrides below
# are for it.

set -euo pipefail

INSTALL_DIR="${UPDATE_INSTALL_DIR:-/opt/cloudgate}"
HOSTED_INPUTS_FILE="${UPDATE_HOSTED_INPUTS_FILE:-/etc/default/cloudgate-hosted}"
BACKEND_ENV_FILE="${UPDATE_BACKEND_ENV_FILE:-/etc/default/cloudgate-backend}"
# The root-owned copy sudo is allowed to run, never the one in $INSTALL_DIR:
# that belongs to the cloudgate user.
SELF="${UPDATE_SELF:-/usr/local/sbin/cloudgate-update}"
UNIT=cloudgate-update

TAG_PATTERN='^v[0-9]+\.[0-9]+\.[0-9]+$'

RELEASES_DOWNLOAD=https://github.com/octabyte-io/cloudgate/releases/download
RAW_FILES=https://raw.githubusercontent.com/octabyte-io/cloudgate

fail() {
  printf '%s\n' "$@" >&2
  exit 1
}

valid_tag() {
  [[ "$1" =~ $TAG_PATTERN ]] ||
    fail "cloudgate-update takes one version tag such as v0.3.0, not \"$1\"."
}

# The public host the first install was given, which the backend's file keeps
# on the Hosted instance (deploy/hosted.sh). Empty when it was never written;
# the one-command install then finds it itself.
previous_public_host() {
  [ -r "$BACKEND_ENV_FILE" ] || return 0
  sed -n "s/^CLOUDGATE_PUBLIC_HOST='\(.*\)'\$/\1/p" "$BACKEND_ENV_FILE" | tail -n 1
}

# A tag is a Cloudgate version once publish-version.yml has put its tarball's
# .sha256 on the tag's GitHub Release, which it does only after the tag's
# E2E (release) run is green (ADR-0082). Asked before the backup, so a tag
# that was never published costs nothing.
published_version() {
  local tag="$1" url status=0
  url="$RELEASES_DOWNLOAD/$tag/cloudgate-${tag#v}-linux-amd64.tar.gz.sha256"
  curl -fsSL --max-time 30 -o /dev/null "$url" || status=$?
  case "$status" in
    0) ;;
    22) fail "$tag has no published release ($url), so nothing was backed up or upgraded." \
      "A version is published by the Publish Cloudgate version workflow once its E2E (release) run is green." ;;
    *) fail "Could not ask GitHub whether $tag is published (curl exit $status), so nothing was backed up or upgraded." ;;
  esac
}

# The tag's own install.sh: the one-command install that installs the version
# it was published with. Never $INSTALL_DIR/install.sh, which is the version
# being replaced's, or on a box still holding a git checkout the checkout's,
# which builds a branch rather than installing a version. Fetched before the
# backup, so a GitHub that cannot serve it costs nothing.
fetch_install() {
  local tag="$1" into="$2" url
  url="$RAW_FILES/$tag/install.sh"
  curl -fsSL --max-time 60 -o "$into" "$url" ||
    fail "Could not download $url, so nothing was backed up or upgraded."
}

# The work itself, as root inside cloudgate-update.service.
apply() {
  local tag="$1" public_host work installed
  valid_tag "$tag"
  [ -f "$HOSTED_INPUTS_FILE" ] ||
    fail "$HOSTED_INPUTS_FILE is missing: this is not a Hosted instance, so cloudgate-update does nothing here."

  echo "==> Checking $tag is a published Cloudgate version"
  published_version "$tag"
  work="$(mktemp -d)"
  # shellcheck disable=SC2064 # $work is fixed from here on.
  trap "rm -rf '$work'" EXIT
  fetch_install "$tag" "$work/install.sh"

  echo "==> Backup to B2 before the upgrade"
  systemctl start cloudgate-backup.service ||
    fail "The backup before the upgrade failed, so nothing was upgraded." \
      "journalctl -u cloudgate-backup.service says why."

  echo "==> Upgrading to $tag"
  public_host="$(previous_public_host)"
  if [ -n "$public_host" ]; then
    export CLOUDGATE_PUBLIC_HOST="$public_host"
  fi
  HOSTED_MODE=true CLOUDGATE_VERSION="$tag" sh "$work/install.sh"

  installed="$(cat "$INSTALL_DIR/VERSION" 2>/dev/null || true)"
  [ "$installed" = "${tag#v}" ] ||
    fail "The install finished but $INSTALL_DIR/VERSION says ${installed:-nothing}, not ${tag#v}." \
      "journalctl -u $UNIT.service shows what the install did."
  echo "==> Upgraded to $tag ✅"
}

# Root, from SSH or by hand: run apply in its own unit and follow it.
start() {
  local tag="$1" follower status=0
  [ -f "$HOSTED_INPUTS_FILE" ] ||
    fail "$HOSTED_INPUTS_FILE is missing: this is not a Hosted instance, so cloudgate-update does nothing here."

  journalctl --follow --lines=0 --output=cat --unit="$UNIT.service" &
  follower=$!
  systemd-run --unit="$UNIT" --description="Cloudgate upgrade to $tag" \
    --collect --wait --quiet \
    --setenv=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    --setenv=HOME=/root \
    "$SELF" --apply "$tag" || status=$?
  # Let the journal catch up with the unit's last lines.
  sleep 2
  kill "$follower" 2>/dev/null || true
  wait "$follower" 2>/dev/null || true

  if [ "$status" -ne 0 ]; then
    echo "The upgrade to $tag failed (exit $status)." >&2
    echo "On the box: journalctl -u $UNIT.service. If $UNIT.service is still running, another update was in progress." >&2
  fi
  return "$status"
}

main() {
  if [ "${1:-}" = --apply ]; then
    [ "$(id -u)" -eq 0 ] || fail "--apply runs as root, inside $UNIT.service."
    apply "${2:-}"
    return
  fi

  # Over SSH the forced command has no arguments; the tag is what the caller
  # asked to run. Anything but one tag is refused before sudo is reached.
  local tag="${1:-${SSH_ORIGINAL_COMMAND:-}}"
  valid_tag "$tag"

  if [ "$(id -u)" -ne 0 ]; then
    exec sudo -n "$SELF" "$tag"
  fi
  start "$tag"
}

main "$@"
