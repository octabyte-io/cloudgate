#!/usr/bin/env bash
#
# Cloudgate — uninstall from the platform host.
#
# Run as root, from the version installed:
#
#     bash /opt/cloudgate/deploy/uninstall.sh
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

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

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

# The instance: a reinstall, or a restore on another host (docs/deploy.md §8),
# with these is the same instance, its sessions and encrypted values intact.
log "Kept the instance"
echo "  the cloudgate database, and its roles cloudgate and cloudgate_state, in Postgres"
for kept in "$ENV_DIR"/cloudgate-* "$CLOUDGATE_DIR" "$BACKUP_DIR"; do
  if [ -e "$kept" ]; then echo "  $kept"; fi
done

log "Left in place: Docker, Postgres, the swarm, cloudgate-network, ufw and the cloudgate user"
echo "Other things may use them; remove them by hand if nothing does."
