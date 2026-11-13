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
# The tag must be vX.Y.Z and its commit must be on origin/main. A run takes a
# backup to B2 first and then re-runs the one-command install at the tag with
# HOSTED_MODE=true, which is the upgrade (docs/deploy.md §7); every other input
# is read back from /etc/default/cloudgate-hosted, so nothing secret travels
# over SSH or lives in GitHub.
#
# The upgrade runs in its own transient systemd unit, cloudgate-update.service,
# not under the SSH session: a dropped connection must never cut an install off
# half-way through its migrations and builds. The caller follows the unit's
# journal and gets its exit status. A second update while one is running is
# refused, because the unit already exists.
#
# backend/test/deploy/hosted-update.spec.ts runs this with sudo, systemd-run,
# journalctl, systemctl, git and the checkout stubbed; the UPDATE_* overrides
# below are for it.

set -euo pipefail

CHECKOUT="${UPDATE_CHECKOUT:-/opt/cloudgate}"
HOSTED_INPUTS_FILE="${UPDATE_HOSTED_INPUTS_FILE:-/etc/default/cloudgate-hosted}"
BACKEND_ENV_FILE="${UPDATE_BACKEND_ENV_FILE:-/etc/default/cloudgate-backend}"
# The root-owned copy sudo is allowed to run, never the checkout's: the
# checkout belongs to the cloudgate user.
SELF="${UPDATE_SELF:-/usr/local/sbin/cloudgate-update}"
UNIT=cloudgate-update

TAG_PATTERN='^v[0-9]+\.[0-9]+\.[0-9]+$'

fail() {
  printf '%s\n' "$@" >&2
  exit 1
}

checkout_git() {
  git -c safe.directory="$CHECKOUT" -C "$CHECKOUT" "$@"
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

# The work itself, as root inside cloudgate-update.service.
apply() {
  local tag="$1" main commit public_host
  valid_tag "$tag"
  [ -f "$HOSTED_INPUTS_FILE" ] ||
    fail "$HOSTED_INPUTS_FILE is missing: this is not a Hosted instance, so cloudgate-update does nothing here."

  echo "==> Checking $tag is a release on main"
  checkout_git fetch --quiet origin main || fail "Could not fetch main from $(checkout_git remote get-url origin)."
  main="$(checkout_git rev-parse FETCH_HEAD)"
  checkout_git fetch --quiet origin "refs/tags/$tag" || fail "The tag $tag does not exist on origin."
  commit="$(checkout_git rev-parse "FETCH_HEAD^{commit}")"
  checkout_git merge-base --is-ancestor "$commit" "$main" ||
    fail "$tag ($commit) is not on main; only a tag on main is deployed."

  echo "==> Backup to B2 before the upgrade"
  systemctl start cloudgate-backup.service ||
    fail "The backup before the upgrade failed, so nothing was upgraded." \
      "journalctl -u cloudgate-backup.service says why."

  echo "==> Upgrading to $tag"
  public_host="$(previous_public_host)"
  if [ -n "$public_host" ]; then
    export CLOUDGATE_PUBLIC_HOST="$public_host"
  fi
  HOSTED_MODE=true CLOUDGATE_REF="$tag" sh "$CHECKOUT/install.sh"

  [ "$(checkout_git rev-parse HEAD)" = "$commit" ] ||
    fail "The install finished but $CHECKOUT is not at $tag ($commit)." \
      "It was probably already ahead of $tag; git -C $CHECKOUT log -1 shows where it is."
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
