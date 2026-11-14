#!/usr/bin/env bash
#
# Cloudgate — uninstall from the platform host (docs/deploy.md §10).
#
# Run as root, from the version installed; bash keeps reading it after it
# removes /opt/cloudgate:
#
#     bash /opt/cloudgate/deploy/uninstall.sh            # keeps the instance
#     bash /opt/cloudgate/deploy/uninstall.sh --purge    # removes it too
#
# It stops, disables and removes cloudgate-backend and cloudgate-console (and
# on the Hosted instance its backup units and a running update), removes the
# cloudgate-traefik container, /opt/cloudgate with its .previous and .next,
# and /usr/local/share/cloudgate (Node, OpenTofu, the Session Manager plugin).
#
# It keeps the instance: the cloudgate database and its roles,
# /etc/default/cloudgate-*, /etc/cloudgate and the dumps in
# /var/backups/cloudgate. With them a reinstall, or a restore on another host
# (docs/deploy.md §8), is the same instance. --purge removes those as well,
# once the operator has typed the instance's public host; any other answer
# changes nothing.
#
# Docker, Postgres, the swarm, cloudgate-network, ufw and the cloudgate user
# stay: they may serve more than Cloudgate.
#
# backend/test/deploy/uninstall.spec.ts runs it with its boundaries shimmed.
#
set -euo pipefail

usage="Usage: bash $0 [--purge]"
purge=''
for arg in "$@"; do
  case "$arg" in
    --purge) purge=1 ;;
    *)
      echo "Unknown argument \"$arg\". $usage" >&2
      exit 1
      ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  echo "Run it as root: sudo bash $0${purge:+ --purge}. Nothing was changed." >&2
  exit 1
fi

# INSTALL_ROOT is for backend/test/deploy/uninstall.spec.ts only: a directory
# the run treats as /, so the test can drive it off a real box.
ROOT="${INSTALL_ROOT:-}"
UNIT_DIR="$ROOT/etc/systemd/system"
INSTALL_DIR="$ROOT/opt/cloudgate"
# Node, OpenTofu with its providers, and the Session Manager plugin.
SHARE_DIR="$ROOT/usr/local/share/cloudgate"
ENV_DIR="$ROOT/etc/default"
CLOUDGATE_DIR="$ROOT/etc/cloudgate"
BACKUP_DIR="$ROOT/var/backups/cloudgate"

BACKEND_ENV_FILE="$ENV_DIR/cloudgate-backend"
CONSOLE_ENV_FILE="$ENV_DIR/cloudgate-console"

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

# The host the install was given, read as root install.sh's
# previous_public_host reads it: the Hosted instance keeps it as
# CLOUDGATE_PUBLIC_HOST in the backend's env file, a Self-hosted box in the
# console's API address, which an older console file names
# NEXT_PUBLIC_API_URL. An IPv6 address comes back without its URL's brackets.
public_host() {
  local host=''
  if [ -r "$BACKEND_ENV_FILE" ]; then
    host="$(sed -n "s/^CLOUDGATE_PUBLIC_HOST='\(.*\)'\$/\1/p" "$BACKEND_ENV_FILE" | tail -n 1)"
  fi
  if [ -z "$host" ] && [ -r "$CONSOLE_ENV_FILE" ]; then
    host="$(sed -n \
      -e 's|^CLOUDGATE_API_URL=http://\(.*\):[0-9][0-9]*$|\1|p' \
      -e 's|^NEXT_PUBLIC_API_URL=http://\(.*\):[0-9][0-9]*$|\1|p' \
      "$CONSOLE_ENV_FILE" | tail -n 1 | tr -d '[]')"
  fi
  printf '%s' "$host"
}

# --purge cannot be undone, so it asks before anything changes: the operator
# types the instance's public host, and only that exact answer goes on.
if [ -n "$purge" ]; then
  host="$(public_host)"
  if [ -z "$host" ]; then
    echo "--purge asks you to type this instance's public host, and neither $BACKEND_ENV_FILE" >&2
    echo "nor $CONSOLE_ENV_FILE names one. Nothing was changed." >&2
    exit 1
  fi
  echo "--purge removes the instance as well, and that cannot be undone: the cloudgate database and"
  echo "its roles, $ENV_DIR/cloudgate-* with the secrets, $CLOUDGATE_DIR and the dumps in $BACKUP_DIR."
  printf "Type this instance's public host, %s, to go on: " "$host"
  answer=''
  IFS= read -r answer || true
  if [ "$answer" != "$host" ]; then
    echo
    echo "\"$answer\" is not $host. Nothing was changed." >&2
    exit 1
  fi
fi

# The Hosted updater runs in its own transient unit (deploy/hosted-update.sh),
# which has no file to remove; left running, it would install Cloudgate again.
if systemctl is-active --quiet cloudgate-update.service; then
  systemctl stop cloudgate-update.service
fi
# Timers before the services they start; the Hosted backup units exist only
# on the Hosted instance.
for unit in cloudgate-backup.timer cloudgate-backup-check.timer \
  cloudgate-backup.service cloudgate-backup-check.service \
  cloudgate-backend.service cloudgate-console.service; do
  if [ -e "$UNIT_DIR/$unit" ]; then
    systemctl disable --now "$unit"
    rm -f "$UNIT_DIR/$unit"
  fi
done
systemctl daemon-reload

if docker container inspect cloudgate-traefik >/dev/null 2>&1; then
  docker rm -f cloudgate-traefik
fi
rm -rf "$INSTALL_DIR" "$INSTALL_DIR.previous" "$INSTALL_DIR.next" "$SHARE_DIR"
log "Removed Cloudgate: its units, the cloudgate-traefik container, $INSTALL_DIR and $SHARE_DIR"

if [ -n "$purge" ]; then
  # The database before the secrets: a drop that fails keeps the files that
  # make it readable. The units that held connections to it are gone.
  log "Dropping the cloudgate database and its roles"
  if ! su - postgres -c "psql -q -v ON_ERROR_STOP=1" <<'SQL'
DROP DATABASE IF EXISTS cloudgate WITH (FORCE);
DROP ROLE IF EXISTS cloudgate_state;
DROP ROLE IF EXISTS cloudgate;
SQL
  then
    echo "The cloudgate database could not be dropped: psql says why above. Cloudgate is removed," >&2
    echo "and the instance's files are kept: $ENV_DIR/cloudgate-*, $CLOUDGATE_DIR and $BACKUP_DIR." >&2
    exit 1
  fi
  rm -rf "$ENV_DIR"/cloudgate-* "$CLOUDGATE_DIR" "$BACKUP_DIR"
  log "Removed the instance: the cloudgate database and its roles, $ENV_DIR/cloudgate-*, $CLOUDGATE_DIR and $BACKUP_DIR"
else
  # The instance: a reinstall, or a restore on another host (docs/deploy.md
  # §8), with these is the same instance, its sessions and encrypted values
  # intact.
  log "Kept the instance"
  echo "  the cloudgate database, and its roles cloudgate and cloudgate_state, in Postgres"
  for kept in "$ENV_DIR"/cloudgate-* "$CLOUDGATE_DIR" "$BACKUP_DIR"; do
    if [ -e "$kept" ]; then echo "  $kept"; fi
  done
  echo "To remove the instance as well, by hand: docs/deploy.md §10, \"Uninstalling\"."
fi

log "Left in place: Docker, Postgres, the swarm, cloudgate-network, ufw and the cloudgate user"
echo "Other things may use them; remove them by hand if nothing does."
