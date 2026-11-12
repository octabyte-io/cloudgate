#!/bin/sh
# cloudgate-start-dockerd: starts a docker daemon inside the Cloudgate builder
# image and waits until it answers.
#
# CodeBuild runs the build in the image itself, in privileged mode, with no
# daemon of its own, so a CodeBuild build runs this first. Cloud Build mounts
# its worker's socket instead; there the daemon already answers and this does
# nothing, so a build program may call it on either cloud.
#
# The daemon goes through the base image's `dind` wrapper, which readies the
# cgroups and mounts a nested daemon needs, and logs to /var/log/dockerd.log.
# A daemon that is not up after a minute fails the build with that log's tail.
set -eu

if docker info >/dev/null 2>&1; then
  echo "The docker daemon is already running."
  exit 0
fi

log=/var/log/dockerd.log
echo "Starting the docker daemon..."
nohup dind dockerd --host=unix:///var/run/docker.sock >"$log" 2>&1 &

waited=0
until docker info >/dev/null 2>&1; do
  if [ "$waited" -ge 60 ]; then
    echo "❌ The docker daemon did not start within 60 seconds. The end of its log:" >&2
    tail -n 40 "$log" >&2 || true
    exit 1
  fi
  sleep 1
  waited=$((waited + 1))
done
echo "The docker daemon is running."
