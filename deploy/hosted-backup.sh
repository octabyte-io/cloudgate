#!/usr/bin/env bash
#
# The Hosted instance's backup off the box. Installed by install.sh's
# HOSTED_MODE=true path and run by systemd, never by hand except as
#
#     systemctl start cloudgate-backup.service          # a backup now
#     systemctl start cloudgate-backup-check.service    # the staleness check now
#
# `run` (cloudgate-backup.timer, hourly) takes the two things docs/deploy.md §8
# says a rebuild needs: `pg_dump -Fc` of the cloudgate database, and a tarball
# of /etc/cloudgate with the /etc/default/cloudgate-* files (the secrets, the
# backend's and the console's environments, the hosted inputs). Each is
# encrypted with `age` to BACKUP_AGE_RECIPIENT — the identity that decrypts
# them is in the vault, never here — and uploaded with `rclone` to
#
#     <BACKUP_B2_BUCKET>/<BACKUP_B2_FOLDER>/hourly/<UTC time>/cloudgate.dump.age
#                                                            /cloudgate-config.tar.gz.age
#
# The first run of each UTC day is copied to daily/<UTC time>/ as well. Then
# hourly/ is cut to its newest 48 runs and daily/ to its newest 30; B2 deletes
# are hard, so what is cut is gone rather than kept as a hidden version.
#
# `check` (cloudgate-backup-check.timer, hourly) mails BACKUP_ALERT_EMAIL
# through Resend, and fails, while the last successful run is more than 3 hours
# old or there has never been one. A box that is down sends nothing: the
# outside uptime check on /backend/settings/health is what hears about that.
#
# Every setting is read by name from /etc/default/cloudgate-hosted, the file
# install.sh keeps its hosted inputs in (deploy/hosted.sh), never sourced.
# backend/test/deploy/hosted-backup.spec.ts runs this with pg_dump, age, rclone
# and curl stubbed; the BACKUP_* overrides below are for it.

set -euo pipefail
umask 077

# shellcheck source=deploy/hosted.sh
. "$(dirname "${BASH_SOURCE[0]}")/hosted.sh"

HOSTED_INPUTS_FILE="${BACKUP_INPUTS_FILE:-$HOSTED_INPUTS_FILE}"
# systemd's StateDirectory=cloudgate-backup. `last-success` holds the epoch
# second and the name of the last run that uploaded both files.
BACKUP_STATE_DIR="${BACKUP_STATE_DIR:-/var/lib/cloudgate-backup}"
# What the config tarball is taken relative to.
BACKUP_FS_ROOT="${BACKUP_FS_ROOT:-/}"

BACKUP_HOURLY_KEEP=48
BACKUP_DAILY_KEEP=30
BACKUP_STALE_AFTER_SECONDS=$((3 * 60 * 60))

# Relative to $BACKUP_FS_ROOT. Each must exist: a Hosted box missing one is
# not one a restore can rebuild, and tar failing says so.
BACKUP_CONFIG_PATHS=(
  etc/cloudgate
  etc/default/cloudgate-backend
  etc/default/cloudgate-console
  etc/default/cloudgate-secrets
  etc/default/cloudgate-hosted
)

# A run's folder name: the UTC time it started, sortable, no colons.
RUN_NAME_PATTERN='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}Z$'

# One kept input by name, or a refusal naming it.
setting() {
  local value
  value="$(hosted_stored_input "$1")"
  if [ -z "$value" ]; then
    echo "$1 is not set in $HOSTED_INPUTS_FILE; re-run install.sh with HOSTED_MODE=true and $1." >&2
    exit 1
  fi
  printf '%s' "$value"
}

# rclone's remote, from the environment rather than a config file or argv, so
# the key is in no file but the inputs one and in no process listing.
use_b2() {
  export RCLONE_CONFIG_CLOUDGATEB2_TYPE=b2
  RCLONE_CONFIG_CLOUDGATEB2_ACCOUNT="$(setting BACKUP_B2_KEY_ID)"
  RCLONE_CONFIG_CLOUDGATEB2_KEY="$(setting BACKUP_B2_APPLICATION_KEY)"
  export RCLONE_CONFIG_CLOUDGATEB2_ACCOUNT RCLONE_CONFIG_CLOUDGATEB2_KEY
  export RCLONE_CONFIG_CLOUDGATEB2_HARD_DELETE=true
  local bucket folder
  bucket="$(setting BACKUP_B2_BUCKET)"
  folder="$(setting BACKUP_B2_FOLDER)"
  REMOTE="cloudgateb2:$bucket/$folder"
}

# The run folders directly under $1 (hourly or daily), newest first. Anything
# not named like a run is never listed, so never pruned.
runs_in() {
  local listing
  listing="$(rclone lsf --dirs-only "$REMOTE/$1")"
  printf '%s\n' "$listing" | sed 's:/$::' | { grep -E "$RUN_NAME_PATTERN" || true; } | sort -r
}

# Removes all but the newest $2 runs in $1.
prune() {
  local run kept=0
  while IFS= read -r run; do
    [ -n "$run" ] || continue
    kept=$((kept + 1))
    if [ "$kept" -gt "$2" ]; then
      rclone purge "$REMOTE/$1/$run"
      echo "removed $1/$run"
    fi
  done <<< "$(runs_in "$1")"
}

backup_run() {
  local recipient started name day work daily
  recipient="$(setting BACKUP_AGE_RECIPIENT)"
  use_b2

  started="$(date -u +%s)"
  name="$(date -u -d "@$started" +%Y-%m-%dT%H-%M-%SZ)"
  day="${name%%T*}"
  work="$(mktemp -d "${TMPDIR:-/var/tmp}/cloudgate-backup.XXXXXX")"
  # shellcheck disable=SC2064
  trap "rm -rf '$work'" EXIT

  # As postgres, over the socket: peer authentication, so no password is
  # needed here and none appears in a process listing.
  runuser -u postgres -- pg_dump -Fc cloudgate |
    age --encrypt --recipient "$recipient" --output "$work/cloudgate.dump.age"
  tar -czf - -C "$BACKUP_FS_ROOT" "${BACKUP_CONFIG_PATHS[@]}" |
    age --encrypt --recipient "$recipient" --output "$work/cloudgate-config.tar.gz.age"

  rclone copy "$work" "$REMOTE/hourly/$name"
  echo "uploaded hourly/$name"

  # A daily folder that does not exist yet lists as an error on B2; the copy
  # below then makes it, and the prune's own listing is not forgiving.
  daily="$(rclone lsf --dirs-only "$REMOTE/daily" 2>/dev/null || true)"
  if ! printf '%s\n' "$daily" | grep -q "^${day}T"; then
    rclone copy "$REMOTE/hourly/$name" "$REMOTE/daily/$name"
    echo "kept as daily/$name"
  fi

  mkdir -p "$BACKUP_STATE_DIR"
  printf '%s %s\n' "$started" "$name" > "$BACKUP_STATE_DIR/last-success.tmp"
  mv "$BACKUP_STATE_DIR/last-success.tmp" "$BACKUP_STATE_DIR/last-success"

  # After the success is recorded: a prune that fails fails the unit, but the
  # backup it follows was taken and is not stale.
  prune hourly "$BACKUP_HOURLY_KEEP"
  prune daily "$BACKUP_DAILY_KEEP"
}

backup_check() {
  local now last="" name="" age_seconds subject text hostname from to key
  # Read first, each on its own, so a missing one stops the check here.
  hostname="$(setting CLOUDGATE_HOSTNAME)"
  from="$(setting MAIL_FROM_ADDRESS)"
  to="$(setting BACKUP_ALERT_EMAIL)"
  key="$(setting RESEND_API_KEY)"
  now="$(date -u +%s)"
  if [ -r "$BACKUP_STATE_DIR/last-success" ]; then
    read -r last name < "$BACKUP_STATE_DIR/last-success" || true
  fi
  if [[ "$last" =~ ^[0-9]+$ ]]; then
    age_seconds=$((now - last))
    if [ "$age_seconds" -le "$BACKUP_STALE_AFTER_SECONDS" ]; then
      echo "last backup $name succeeded $((age_seconds / 60)) minutes ago ✅"
      return 0
    fi
    text="No Cloudgate backup has succeeded for $((age_seconds / 3600)) hours. The last one that did is $name."
  else
    text="No Cloudgate backup has ever succeeded on this box."
  fi
  text="$text

On the box: journalctl -u cloudgate-backup.service, and systemctl start cloudgate-backup.service to retry.
This alert repeats every hour until a backup succeeds."
  subject="Cloudgate backups are stale on $hostname"
  echo "$text" >&2

  # The Resend key goes to curl in a config it reads from a pipe, not argv.
  jq -n --arg from "$from" --arg to "$to" \
    --arg subject "$subject" --arg text "$text" \
    '{from: $from, to: [$to], subject: $subject, text: $text}' |
    curl -fsS -o /dev/null -X POST https://api.resend.com/emails \
      --config <(printf 'header = "Authorization: Bearer %s"\n' "$key") \
      -H 'Content-Type: application/json' --data-binary @- ||
    echo "the staleness alert could not be sent through Resend" >&2
  return 1
}

case "${1:-}" in
  run) backup_run ;;
  check) backup_check ;;
  *)
    echo "usage: $0 run|check" >&2
    exit 2
    ;;
esac
