#!/bin/sh
#
# cloudgate-boot-recover: starts the containers Docker could not start when it
# started, because the swarm's overlay networks were not there yet (#105).
#
# Installed as /usr/local/sbin/cloudgate-boot-recover and run by
# cloudgate-boot-recover.service, which follows every start of docker.service
# (deploy/systemd/cloudgate-boot-recover.service). deploy/install.sh installs
# both on the platform host, and Server setup (backend/src/servers/
# boot-recover.ts) on each Server, from these same two files.
#
# Why it is needed. When dockerd starts, it starts every container whose
# restart policy asks for it. A container on a swarm-scoped network
# (cloudgate-network, cloudgate-ai, a trace store's network) waits for the
# swarm, and Docker tries it once; when the swarm has not finished bringing
# the network up, the start fails with "failed to set up container
# networking: … network cloudgate-network not found" (or "invalid cluster
# node while attaching to network"), Docker writes that into the container's
# State.Error, and nothing ever tries again. Traefik and every Compose
# container on cloudgate-network stayed down after each reboot.
#
# What it starts, and why exactly those. A container is started when all of
# these hold:
#   - it is exited or created, so it is not running;
#   - its restart policy is always, unless-stopped or on-failure, so Docker
#     itself would start it when it starts;
#   - its State.Error is not empty and names a network: Docker tried to start
#     it and the network was why it could not. A successful start clears
#     State.Error and a stop never sets it, so a container someone stopped
#     (Stop on a Compose stack is `docker compose stop`, whose containers are
#     unless-stopped) has none and stays stopped, and one Docker never tried
#     is not touched;
#   - one of its networks is swarm-scoped, now that the swarm answers.
# It waits for cloudgate-network to be inspectable first, which is the swarm
# answering for its networks, and gives up after
# CLOUDGATE_BOOT_RECOVER_TIMEOUT seconds (180) without starting anything.
#
# It says what it did on stdout, which the unit sends to the journal:
#     journalctl -u cloudgate-boot-recover -b
# Exit 1 when it gave up waiting or a start failed, so `systemctl status
# cloudgate-boot-recover` shows the run failed. Running it again is safe: a
# container it started is running and is not chosen again.
#
# POSIX sh, not bash: it runs on Servers as well as the platform host.
# backend/test/deploy/boot-recover.spec.ts runs it with a docker on PATH that
# answers from fixtures.
#
set -u

NETWORK=cloudgate-network
TIMEOUT="${CLOUDGATE_BOOT_RECOVER_TIMEOUT:-180}"
INTERVAL="${CLOUDGATE_BOOT_RECOVER_INTERVAL:-2}"

deadline=$(($(date +%s) + TIMEOUT))
until docker network inspect "$NETWORK" >/dev/null 2>&1; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "Gave up after ${TIMEOUT}s: Docker still does not find $NETWORK, so no container was started."
    echo "docker info shows whether the swarm is active; start the stopped containers with docker start once it is."
    exit 1
  fi
  sleep "$INTERVAL"
done

if ! ids="$(docker ps -aq --filter status=exited --filter status=created)"; then
  echo "docker ps failed, so no container was started."
  exit 1
fi

started=0
failed=0
for id in $ids; do
  # The error last: it is free text, and `read` gives the rest of the line to
  # the last name.
  info="$(docker inspect --format '{{.Name}}|{{.HostConfig.RestartPolicy.Name}}|{{range $name, $_ := .NetworkSettings.Networks}}{{$name}} {{end}}|{{.State.Error}}' "$id" 2>/dev/null)" || continue
  IFS='|' read -r name policy networks error <<EOF
$info
EOF
  name="${name#/}"
  case "$policy" in
    always | unless-stopped | on-failure) ;;
    *) continue ;;
  esac
  case "$error" in
    *network*) ;;
    *) continue ;;
  esac
  swarm=''
  for network in $networks; do
    if [ "$(docker network inspect --format '{{.Scope}}' "$network" 2>/dev/null)" = swarm ]; then
      swarm="$network"
      break
    fi
  done
  if [ -z "$swarm" ]; then
    echo "Left $name stopped: Docker could not start it ($error), and none of its networks ($networks) is a swarm network Docker finds now."
    continue
  fi
  if output="$(docker start "$id" 2>&1)"; then
    echo "Started $name, on $swarm: Docker could not start it when it started ($error)."
    started=$((started + 1))
  else
    echo "Could not start $name: $output"
    failed=$((failed + 1))
  fi
done

if [ "$started" -eq 0 ] && [ "$failed" -eq 0 ]; then
  echo "Nothing to start: no container is stopped for want of a swarm network."
fi
[ "$failed" -eq 0 ]
