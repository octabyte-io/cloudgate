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
# on the Hosted instance its backup units, a running update, and the remote
# updater deploy/hosted-update-access.sh made), removes the cloudgate-traefik
# container, /opt/cloudgate with its .previous and .next, and
# /usr/local/share/cloudgate (Node, OpenTofu, the Session Manager plugin).
#
# It keeps the instance: the cloudgate database and its roles,
# /etc/default/cloudgate-*, /etc/cloudgate and the dumps in
# /var/backups/cloudgate. With them a reinstall, or a restore on another
# platform host (docs/deploy.md §8), is the same instance. It keeps the
# install logs in /var/log/cloudgate too. --purge removes those as well, and
# the old secrets an earlier install moved to
# /root/cloudgate-live-test/env.migrated, once the operator has typed the
# instance's public host; any other answer changes nothing.
#
# The Swarm services and containers of the Applications and other Services the
# instance deployed on this host keep running either way: a reinstall on the
# kept instance manages them again. --purge leaves nothing to manage them, so
# before the database goes it lists them and offers to remove them once it is
# dropped; only y or yes removes them, and their volumes stay.
#
# Docker, Postgres, the swarm, cloudgate-network, ufw and the cloudgate user
# stay: they may serve more than Cloudgate. So does a git checkout an install
# moved to /opt/cloudgate.checkout-<date>, which may hold the operator's own
# changes; it is named.
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
LOG_DIR="$ROOT/var/log/cloudgate"
# The secrets an install from before /etc/default/cloudgate-secrets kept,
# renamed by deploy/install.sh when it moved them and never read again.
OLD_SECRETS_FILE="$ROOT/root/cloudgate-live-test/env.migrated"
# What deploy/hosted-update-access.sh made on the Hosted instance.
UPDATER="$ROOT/usr/local/sbin/cloudgate-update"
SUDOERS_FILE="$ROOT/etc/sudoers.d/cloudgate-deploy"
DEPLOY_USER=cloudgate-deploy
DEPLOY_HOME="$ROOT/var/lib/cloudgate-deploy"

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
  echo "its roles, $ENV_DIR/cloudgate-* with the secrets, $CLOUDGATE_DIR, the dumps in $BACKUP_DIR,"
  echo "the install logs in $LOG_DIR and the old secrets in $OLD_SECRETS_FILE."
  printf "Type this instance's public host, %s, to go on: " "$host"
  answer=''
  IFS= read -r answer || true
  if [ "$answer" != "$host" ]; then
    echo
    echo "\"$answer\" is not $host. Nothing was changed." >&2
    exit 1
  fi
fi

# The Swarm services and standalone containers this instance deployed on the
# platform host. Its database is the only record of them: Cloudgate labels
# nothing as its own, so a Docker object is the instance's when its name is
# one the database holds. An Application, a Database, a Bucket or a preview
# runs as the Swarm service named its app_name; a Swarm Compose stack's
# services carry its app_name as their stack namespace; a Docker Compose
# stack's containers carry it as their Compose project. A plain uninstall
# reads none of this: the kept database still names them, so a reinstall
# manages them again.
#
# Every table with an app_name column but github (the GitHub App's own name)
# is read; uninstall.spec.ts fails when a table is added without it.
deployed_names() {
  su - postgres -c "psql -d cloudgate -X -q -tA -v ON_ERROR_STOP=1" <<'SQL'
SELECT app_name FROM application
UNION SELECT app_name FROM preview_deployment
UNION SELECT app_name FROM compose
UNION SELECT app_name FROM postgres
UNION SELECT app_name FROM mysql
UNION SELECT app_name FROM mariadb
UNION SELECT app_name FROM mongo
UNION SELECT app_name FROM redis
UNION SELECT app_name FROM libsql
UNION SELECT app_name FROM bucket
UNION SELECT app_name FROM backup
UNION SELECT app_name FROM schedule
UNION SELECT app_name FROM volume_backup;
SQL
}

deployed_services=()
deployed_containers=()
remove_deployed=''
if [ -n "$purge" ]; then
  declare -A deployed=()
  if names="$(deployed_names)"; then
    while IFS= read -r name; do
      if [ -n "$name" ]; then deployed[$name]=1; fi
    done <<<"$names"
  else
    echo "The cloudgate database could not be read, so what this instance deployed is not listed:" >&2
    echo "its Applications and other Services keep running. docker service ls and docker ps name them." >&2
  fi
  if [ "${#deployed[@]}" -gt 0 ]; then
    # Neither listing is an error to stop on: a host that is no swarm manager,
    # or whose Docker is down, runs nothing of the instance's.
    service_ids="$(docker service ls -q 2>/dev/null </dev/null)" || service_ids=''
    if [ -n "$service_ids" ]; then
      # shellcheck disable=SC2086 # one argument per service id
      while IFS='|' read -r name stack; do
        if [ -n "${deployed[$name]+x}" ] || { [ -n "$stack" ] && [ -n "${deployed[$stack]+x}" ]; }; then
          deployed_services+=("$name")
        fi
      done < <(docker service inspect \
        --format '{{.Spec.Name}}|{{index .Spec.Labels "com.docker.stack.namespace"}}' \
        $service_ids 2>/dev/null </dev/null || true)
    fi
    while IFS='|' read -r name project; do
      if [ -n "$project" ] && [ -n "${deployed[$project]+x}" ]; then
        deployed_containers+=("$name")
      fi
    done < <(docker ps -a --filter label=com.docker.compose.project \
      --format '{{.Names}}|{{.Label "com.docker.compose.project"}}' 2>/dev/null </dev/null || true)
  fi

  if [ "${#deployed_services[@]}" -gt 0 ] || [ "${#deployed_containers[@]}" -gt 0 ]; then
    echo
    echo "These run the Applications and other Services this instance deployed on this platform host."
    echo "They keep running unmanaged once its database is gone: nothing is left to stop, update or"
    echo "remove them."
    for name in "${deployed_services[@]}"; do echo "  Swarm service $name"; done
    for name in "${deployed_containers[@]}"; do echo "  container $name"; done
    printf 'Remove them as well, once the database is dropped? Their volumes are kept. [y/N]: '
    answer=''
    IFS= read -r answer || true
    case "$answer" in
      [yY] | [yY][eE][sS]) remove_deployed=1 ;;
    esac
    echo
  fi
fi

# The Hosted updater runs in its own transient unit (deploy/hosted-update.sh),
# which has no file to remove; left running, it would install Cloudgate again.
if systemctl is-active --quiet cloudgate-update.service; then
  systemctl stop cloudgate-update.service
fi
# The Hosted instance's remote updater, before anything else goes: left in
# place, the next green tag's deploy would log in with its key and run the
# updater, which installs Cloudgate again. userdel --remove takes the home and
# the key in it; the rm is for a home userdel did not know as the user's.
remote_updater=''
for file in "$UPDATER" "$SUDOERS_FILE"; do
  if [ -e "$file" ]; then
    rm -f "$file"
    remote_updater=1
  fi
done
if id "$DEPLOY_USER" >/dev/null 2>&1; then
  userdel --remove "$DEPLOY_USER"
  remote_updater=1
fi
rm -rf "$DEPLOY_HOME"
if [ -n "$remote_updater" ]; then
  log "Removed the remote updater: $UPDATER, $SUDOERS_FILE and the $DEPLOY_USER user"
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
    echo "and the instance's files are kept: $ENV_DIR/cloudgate-*, $CLOUDGATE_DIR, $BACKUP_DIR and $LOG_DIR." >&2
    exit 1
  fi
  rm -rf "$ENV_DIR"/cloudgate-* "$CLOUDGATE_DIR" "$BACKUP_DIR" "$LOG_DIR"
  log "Removed the instance: the cloudgate database and its roles, $ENV_DIR/cloudgate-*, $CLOUDGATE_DIR, $BACKUP_DIR and $LOG_DIR"
  if [ -e "$OLD_SECRETS_FILE" ]; then
    rm -f "$OLD_SECRETS_FILE"
    echo "  and the old secrets in $OLD_SECRETS_FILE"
  fi
  # Only once the drop has gone through: a failed one keeps the instance, and
  # what it deployed is still its own.
  if [ "${#deployed_services[@]}" -gt 0 ] || [ "${#deployed_containers[@]}" -gt 0 ]; then
    if [ -n "$remove_deployed" ]; then
      log "Removing the Swarm services and containers of this instance's Applications and other Services; their volumes are kept"
      if [ "${#deployed_services[@]}" -gt 0 ]; then
        docker service rm "${deployed_services[@]}"
      fi
      if [ "${#deployed_containers[@]}" -gt 0 ]; then
        docker rm -f "${deployed_containers[@]}"
      fi
    else
      log "Left running unmanaged: the Swarm services and containers of this instance's Applications and other Services"
      for name in "${deployed_services[@]}"; do
        echo "  Swarm service $name: remove it with docker service rm $name"
      done
      for name in "${deployed_containers[@]}"; do
        echo "  container $name: remove it with docker rm -f $name"
      done
    fi
  fi
else
  # The instance: a reinstall, or a restore on another platform host (docs/deploy.md
  # §8), with these is the same instance, its sessions and encrypted values
  # intact.
  log "Kept the instance"
  echo "  the cloudgate database, and its roles cloudgate and cloudgate_state, in Postgres"
  for kept in "$ENV_DIR"/cloudgate-* "$CLOUDGATE_DIR" "$BACKUP_DIR" "$LOG_DIR" "$OLD_SECRETS_FILE"; do
    if [ -e "$kept" ]; then echo "  $kept"; fi
  done
  echo "To remove the instance as well, by hand: docs/deploy.md §10, \"Uninstalling\"."
fi

log "Left in place: Docker, Postgres, the swarm, cloudgate-network, ufw and the cloudgate user"
echo "Other things may use them; remove them by hand if nothing does."
# A git checkout an install from before versions moved aside (ADR-0082): the
# operator's, and it may hold changes nobody pushed.
for checkout in "$INSTALL_DIR".checkout-*; do
  if [ -e "$checkout" ]; then
    echo "Also left: $checkout, the git checkout an earlier install moved aside. Delete it once"
    echo "you have kept anything of yours from it."
  fi
done
