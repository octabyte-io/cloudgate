#!/usr/bin/env bash
#
# Cloudgate — native install on a bare Ubuntu 24.04 host.
#
# This is the record of the install that was actually performed and verified on
# a 2 vCPU / 3.7 GB / 38 GB VPS (run log: .project/vps-deploy/RUN-LOG.md, L01,
# in git history at c8e9bdfb). Every
# step below ran; nothing here is aspirational.
#
# It installs the Cloudgate version it is part of (ADR-0082). Run it, as root,
# from that version unpacked into an empty directory, and it puts the version
# in place at /opt/cloudgate; run from /opt/cloudgate it re-installs the
# version already there. The repository's root install.sh downloads, checks and
# unpacks the version and runs this, in one command (docs/deploy.md §2):
#
#     mkdir /opt/cloudgate.next
#     tar -xzf cloudgate-0.3.0-linux-amd64.tar.gz -C /opt/cloudgate.next --no-same-owner
#     CLOUDGATE_PUBLIC_HOST=203.0.113.10 bash /opt/cloudgate.next/deploy/install.sh
#
# Nothing is built here: the version holds the built backend and console and
# production node_modules with node-pty already compiled.
#
# The Hosted instance is the same script with HOSTED_MODE=true
# and its inputs, listed with what each is in deploy/hosted.sh:
#
#     HOSTED_MODE=true CLOUDGATE_PUBLIC_HOST=203.0.113.10 \
#       CLOUDGATE_HOSTNAME=cloudgate.octabyte.app SITE_URL=https://cloudgate.octabyte.app \
#       STRIPE_SECRET_KEY=… STRIPE_WEBHOOK_SECRET=… \
#       STARTER_PLAN_PRICE_ID=… BUSINESS_PLAN_PRICE_ID=… ADD_ON_PRICE_ID=… \
#       MAIL_FROM_ADDRESS='Cloudgate <hello@…>' RESEND_API_KEY=… \
#       TURNSTILE_SITE_KEY=… TURNSTILE_SECRET_KEY=… \
#       INSTANCE_OWNER_EMAIL=… INSTANCE_OWNER_FIRST_NAME=… INSTANCE_ORGANIZATION_NAME=Octabyte \
#       BACKUP_B2_KEY_ID=… BACKUP_B2_APPLICATION_KEY=… BACKUP_B2_BUCKET=… BACKUP_B2_FOLDER=live \
#       BACKUP_AGE_RECIPIENT=age1… BACKUP_ALERT_EMAIL=ops@… \
#       bash /opt/cloudgate.next/deploy/install.sh
#
# It refuses to start while any is missing, naming them all. It serves the one
# hostname on HTTPS through Traefik with a Let's Encrypt certificate, closes
# 3000/4000 to everything but Traefik, and makes the Instance organization with
# create-instance-organization instead of letting the first sign-up own the
# instance. It backs the box up hourly, age-encrypted, to B2, and mails ops
# when no backup has succeeded for 3 hours. A re-run reuses the inputs the
# first run was given. Without HOSTED_MODE everything below is the
# Self-hosted install, unchanged.
#
# Idempotent: every step is guarded and re-running is a no-op. Secrets are
# generated once and kept in $SECRETS_FILE; a re-run reuses them, and an older
# install has them migrated out of /root/cloudgate-live-test on first run.
#
set -euo pipefail

### ---------------------------------------------------------------- inputs ---

# The address operators and browsers will use. There is no sensible default.
# Both env files below carry it as CLOUDGATE_API_URL, which the console reads
# when it starts, so changing it later is a restart (docs/deploy.md §3).
: "${CLOUDGATE_PUBLIC_HOST:?set it to the public IP or hostname of this host}"

CONSOLE_PORT="${CONSOLE_PORT:-3000}"
API_PORT="${API_PORT:-4000}"
# The Node the version was built and its node-pty compiled with
# (.github/workflows/publish-version.yml). Another major cannot load pty.node.
NODE_VERSION="${NODE_VERSION:-v24.19.0}"
TRAEFIK_VERSION="${TRAEFIK_VERSION:-3.6.7}"

# The version's console was built to reach its API at 127.0.0.1:4000
# (deploy/version-tarball.sh), and Next keeps that in the rewrites it builds,
# so a console under any other API_PORT would send every /backend/ and
# /api/auth/ request to a port nothing listens on. Refused before anything is
# touched, rather than installed broken. Another port is a by-hand build
# (docs/deploy.md §2, building from source).
if [ "$API_PORT" != 4000 ]; then
  echo "API_PORT=$API_PORT: a Cloudgate version's console reaches its API on port 4000," >&2
  echo "which its build fixed. Leave API_PORT unset, or build from source (docs/deploy.md §2)." >&2
  exit 1
fi

# OpenTofu, which makes a Cloud account's resources (ADR-0030), and the
# providers Cloud runs use: hashicorp/aws for AWS, and hashicorp/google for
# Google Cloud. Each Cloudgate version pins exactly one version of each, with
# checksums, and only a Cloudgate change moves them — forward only, because a state
# written by a newer OpenTofu or provider is refused by an older one.
# OPENTOFU_SHA256 is the release's linux_amd64 tarball checksum, from its
# tofu_<version>_SHA256SUMS; move the two together. 1.10 is the floor.
#
# The *_PROVIDER_VERSION lines are not inputs: deploy/opentofu/.terraform.lock.hcl
# is, and the providers' checksums live there. These lines restate the lock
# file's versions so this script can say what it installs, and
# backend/test/cloud-accounts/opentofu-pins.spec.ts holds them together.
OPENTOFU_VERSION="${OPENTOFU_VERSION:-1.13.1}"
OPENTOFU_SHA256="${OPENTOFU_SHA256:-378ada19d4bc70c43732004e8159be771b23b9a5afdf059e5f8a2b3fa2c70a69}"
AWS_PROVIDER_VERSION=6.69.1
GOOGLE_PROVIDER_VERSION=8.8.0
# Cloudgate's own: never /usr/local/bin/tofu, which may be the operator's.
OPENTOFU_DIR=/usr/local/share/cloudgate/opentofu
OPENTOFU_BINARY="$OPENTOFU_DIR/bin/tofu"
OPENTOFU_PROVIDER_MIRROR="$OPENTOFU_DIR/providers"

# The Session Manager plugin, the tunnel a Stack VM is reached through on AWS
# (ADR-0070): Cloudgate starts a Session Manager session with the SSH document
# and runs SSH over the plugin's stdin and stdout. Pinned and checked like
# OpenTofu: SESSION_MANAGER_PLUGIN_SHA256 is the sha256 of the release's
# ubuntu_64bit session-manager-plugin.deb; move the two together. 1.2.536.0 is
# the floor: the session's token reaches the plugin in its environment, never
# on its command line. backend/test/stack-vm/session-manager-plugin-pin.spec.ts
# holds the pin, the floor and the path together.
SESSION_MANAGER_PLUGIN_VERSION="${SESSION_MANAGER_PLUGIN_VERSION:-1.2.707.0}"
SESSION_MANAGER_PLUGIN_SHA256="${SESSION_MANAGER_PLUGIN_SHA256:-91cc9a1a8df6f730622d5e11a8610be6e06d5858408e8029b56d0d63aedd0a68}"
# Cloudgate's own, as OpenTofu's is: never the operator's on PATH.
SESSION_MANAGER_PLUGIN=/usr/local/share/cloudgate/session-manager-plugin/bin/session-manager-plugin

# The json-file retention cap put on every container this script or the backend
# creates. Nothing set one, so every container ran unbounded on the stock
# driver — harmless while Traefik was silent, and its log at INFO made it
# chatty: an ACME retry loop against a misconfigured domain writes until the
# disk is full, which takes down every workload on the host rather than only
# Traefik. 10m x 3 is 30 MB per container. These two defaults are the same values as
# backend/src/common/config/container-logs.ts, and they are written into
# /etc/default/cloudgate-backend below so the backend agrees with them.
#
# Per container rather than /etc/docker/daemon.json: that file is the operator's,
# and a script that rewrites it cannot be undone without knowing what was there.
CONTAINER_LOG_MAX_SIZE="${CONTAINER_LOG_MAX_SIZE:-10m}"
CONTAINER_LOG_MAX_FILE="${CONTAINER_LOG_MAX_FILE:-3}"

# CLOUDGATE_DIRECTORY stays at its default on an install this script performs,
# and what holds it there is *this script's own Traefik* — not the backend.
#
# The reason this comment used to give is false. It said
# `deployment-engine.paths.ts` resolves the *local* root for application,
# compose and volume-backup paths even for commands dispatched to a Server over
# SSH; a run of later fixes converted every tree on that page to
# `cloudgateDirectoryOn`, so each now asks the Server the path is for. The
# backend's own root is relocatable and is meant to be:
# `localCloudgateDirectory` is read per call rather than frozen at import,
# `backend/test/coding-standards/platform-root-call-sites.spec.ts` enumerates
# every expression left in `src/` that answers without one and all four are
# `forks-in-place` or `platform-host-only`, and `setupSshKey` recreates
# `$CLOUDGATE_DIRECTORY/ssh` expressly for an operator who moved the root after
# installing.
#
# What survives is the `TRAEFIK_EOF` heredoc below. Three of its keys —
# `providers.file.directory`, `certificatesResolvers.letsencrypt.acme.storage`
# and `accessLog.filePath` — are read by Traefik *inside its container*, where
# the dynamic directory exists only at the bind **target**, which is the fixed
# literal `TRAEFIK_CONTAINER_DYNAMIC_DIR` whatever the tree outside is rooted at.
# This script writes all three through `${CLOUDGATE_DIR}`, so they are
# right only while it equals that literal. Point it elsewhere and the file
# provider watches a directory the container does not have — `middlewares.yml`
# is never read, `redirect-to-https` is undefined again and plain HTTP 404s
# — and `acme.json` lands in the container's throwaway layer, so every
# recreate re-issues into Let's Encrypt's rate limit, and `accessLog.filePath`
# names a file that `TraefikFilesService.rotateAccessLog` and
# `LogCleanupService`, which both look at the bind source, never open.
#
# Rejected: splitting the heredoc so its container-side keys take the literal
# and `${CLOUDGATE_DIR}` keeps only the host-side paths — which is exactly what
# was done inside the backend, and would make this variable genuinely
# configurable. That is a change, not a comment: the bind source below, the two
# `deploy/traefik/*.example` files pinned byte-identical to these heredocs, and
# the honesty of `server-setup.spec.ts` substituting `${CLOUDGATE_DIR}` back to
# `REMOTE_CLOUDGATE_DIRECTORY` before it compares them all move with it. Until
# then this is one value, and that spec pins the assignment below to it.
#
# **That rejection is settled, and describing the hazard here is not an
# invitation to file it.** It was filed anyway, and closed: a verification
# pass read the paragraph above, recognised the breakage it describes, and
# raised it as a finding. The hazard is unreachable without editing this
# script — CLOUDGATE_DIR is a literal here, not read from the environment, and
# `server-setup.spec.ts` pins it — so what is written above is a warning label,
# not a defect. If the variable is ever to become genuinely configurable, that
# is a scoped change moving the four things this paragraph names, and it starts
# by deleting this note.
CLOUDGATE_DIR=/etc/cloudgate

# The version this script is part of, which may still be staged beside the
# install (root install.sh unpacks into /opt/cloudgate.next); place_version
# moves it to INSTALL_DIR and points REPO_ROOT there.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The committed unit files hardcode /opt/cloudgate so they need no templating.
INSTALL_DIR=/opt/cloudgate
# The generated secrets. NOT under CLOUDGATE_DIRECTORY, for the reason
# docs/deploy.md §4 gives for /etc/default/cloudgate-backend: this file holds the
# database password and both signing secrets, and the platform directory is where
# every path-taking read is aimed. /etc/default/cloudgate-* is also the glob §8
# already backs up and restores as the instance's identity, so "this file
# survived, so it is the same instance" is a rule rather than an accident.
#
# It used to be /root/cloudgate-live-test/env — a verification run's scratch
# directory, which no teardown would think to remove, so a reinstall the operator
# believed was fresh inherited the previous instance's PGPW,
# APP_ENCRYPTION_SECRET and BETTER_AUTH_SECRET. Migrated once, below.
SECRETS_FILE=/etc/default/cloudgate-secrets
LEGACY_SECRETS_FILE=/root/cloudgate-live-test/env
SERVICE_USER=cloudgate

CONSOLE_ORIGIN="http://${CLOUDGATE_PUBLIC_HOST}:${CONSOLE_PORT}"
API_ORIGIN="http://${CLOUDGATE_PUBLIC_HOST}:${API_PORT}"

log() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

### ---------------------------------------------------------- hosted mode ---
# HOSTED_MODE=true is the Hosted instance (ADR-0049); unset or false is
# the Self-hosted install, and every hosted branch below is skipped. Checked
# before anything else runs, so a hosted install missing an input changes
# nothing on the box.
# shellcheck source=deploy/hosted.sh
. "$REPO_ROOT/deploy/hosted.sh"
case "${HOSTED_MODE:-}" in
  true) ;;
  '' | false) HOSTED_MODE= ;;
  *) echo "HOSTED_MODE must be \"true\" or \"false\" (or unset), not \"$HOSTED_MODE\"." >&2; exit 1 ;;
esac
# A re-run that forgets the setting must not rewrite the Hosted instance as a
# Self-hosted one: that would reopen 3000/4000, and the backend would refuse to
# boot against its recorded mode anyway. Changing the mode on purpose
# is set-instance-mode, then a re-run with the new setting.
if [ -z "$HOSTED_MODE" ] && [ -f "$HOSTED_INPUTS_FILE" ]; then
  echo "This box was installed with HOSTED_MODE=true ($HOSTED_INPUTS_FILE exists);" >&2
  echo "re-run with HOSTED_MODE=true." >&2
  exit 1
fi
if [ -n "$HOSTED_MODE" ]; then
  hosted_load_inputs
  hosted_require_inputs || exit 1
  # One origin for the console, the API's six sockets and the CLI: Traefik
  # answers the hostname on 443 and nothing else reaches 3000/4000.
  CONSOLE_ORIGIN="https://${CLOUDGATE_HOSTNAME}"
  API_ORIGIN="https://${CLOUDGATE_HOSTNAME}"
fi

# Guarded, for the reason the product-side setup script is guarded: `apt-get
# install` on an already-installed package *upgrades* it against a freshly
# refreshed index, and re-running this script is the documented upgrade path
# (docs/deploy.md §7). Unguarded, that path silently moved curl from
# 8.5.0-2ubuntu10.11 to .12 on a production host and printed nothing, while this
# file's own header promised a no-op. Only what is genuinely missing is
# ever handed to apt, so a present curl can never be upgraded here.
#
# dpkg-query, not the command_exists shape that script used: ca-certificates ships no
# binary, so a binary check cannot express this list. `${db:Status-Status}`
# matched with `grep -qx installed` is exact — it rejects the deinstall and config-files states a bare `dpkg -l | grep`
# accepts, and a package half-removed is a package apt still has to install.
#
# No CLOUDGATE_APT_UPGRADE escape hatch: §7 already documents a by-hand upgrade
# sequence for an operator who wants one, and a knob nobody sets is a branch
# nobody tests. `set -euo pipefail` is safe across the pipeline below because it
# is the condition of a `||`.
ensure_packages() {
  local missing=""
  for pkg in "$@"; do
    dpkg-query -W -f='${db:Status-Status}\n' "$pkg" 2>/dev/null | grep -qx installed \
      || missing="$missing $pkg"
  done
  if [ -z "$missing" ]; then
    echo "Required packages are installed ✅"
    return
  fi
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  # shellcheck disable=SC2086
  apt-get install -y -qq $missing
  echo "Installed:$missing ✅"
}

[ "$(id -u)" -eq 0 ] || { echo "must run as root" >&2; exit 1; }

# A Cloudgate version carries VERSION at its top level; a git checkout or a
# copy of the repository does not, and has nothing built to run.
if [ ! -f "$REPO_ROOT/VERSION" ]; then
  echo "$REPO_ROOT holds no Cloudgate version (it has no VERSION file). This script" >&2
  echo "installs the version it was unpacked with; root install.sh downloads one." >&2
  exit 1
fi
VERSION="$(cat "$REPO_ROOT/VERSION")"
# A box installed from a git checkout, before the install installed versions.
# Switching one over is not this script's yet, so it stops here, unchanged.
if [ -d "$INSTALL_DIR/.git" ]; then
  echo "$INSTALL_DIR is a git checkout, which this install no longer builds or updates." >&2
  echo "Switching a checkout over to a Cloudgate version is not supported yet. Nothing was changed." >&2
  exit 1
fi
if [ "$REPO_ROOT" != "$INSTALL_DIR" ] && [ -e "$INSTALL_DIR" ] && [ ! -f "$INSTALL_DIR/VERSION" ]; then
  echo "$INSTALL_DIR exists but holds no Cloudgate version (it has no VERSION file)." >&2
  echo "Move it aside and run this again. Nothing was changed." >&2
  exit 1
fi

# Kept only once every check above has passed and the run is root's.
if [ -n "$HOSTED_MODE" ]; then
  hosted_save_inputs
fi

### -------------------------------------------------------------- packages ---
# No build tools: the version's node-pty was compiled when it was built.
# A host installed before that keeps the build-essential, python3 and swap
# file the install used to need; nothing here removes them.

log "Packages"
ensure_packages \
  ca-certificates curl wget git jq openssl unzip rclone
# The Hosted instance's backups encrypt with age; rclone, above, uploads.
if [ -n "$HOSTED_MODE" ]; then
  ensure_packages age
fi

### ------------------------------------------------------------------ node ---
# Installed to /usr/local so /usr/local/bin/node is a stable path the committed
# unit files can hardcode. No pnpm: nothing is installed or built with it here,
# and the migrations run the version's own drizzle-kit.

log "Node ${NODE_VERSION}"
if [ "$(/usr/local/bin/node --version 2>/dev/null || true)" != "$NODE_VERSION" ]; then
  tarball="node-${NODE_VERSION}-linux-x64.tar.xz"
  tmp="$(mktemp -d)"
  (
    cd "$tmp"
    curl -fsSLO "https://nodejs.org/dist/${NODE_VERSION}/${tarball}"
    curl -fsSLO "https://nodejs.org/dist/${NODE_VERSION}/SHASUMS256.txt"
    grep " ${tarball}\$" SHASUMS256.txt | sha256sum -c -
    tar -xJf "$tarball" -C /usr/local --strip-components=1 --no-same-owner
  )
  rm -rf "$tmp"
fi

### ------------------------------------------------- docker, swarm, network ---
# Not optional, and not the product's job: nothing on the box provisions the
# *built-in* server, and every database and Compose stack created in the console
# gets serverId: null. Without swarm and the overlay network every built-in
# deploy dies at mechanizeDockerContainer and every domain 404s.

log "Docker"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh      # brings the compose + buildx plugins
fi
systemctl enable --now docker

log "Swarm and overlay network"
# `--advertise-addr` takes an IP address or an interface, never a hostname:
# Docker refuses `cloud.example.com` (and `localhost`, the SSH-tunnel setup in
# docs/deploy.md) with "advertise address must be a non-zero IP address or
# network interface", which stopped the install here. So the public host is
# advertised only when it is an IP literal; otherwise this host's own address
# on its default route is, which is what Docker would pick on a one-NIC box and
# still answers on a box with several.
swarm_advertise_addr() {
  if [[ "$CLOUDGATE_PUBLIC_HOST" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
    [[ "$CLOUDGATE_PUBLIC_HOST" == *:* ]]; then
    printf '%s\n' "$CLOUDGATE_PUBLIC_HOST"
    return
  fi
  ip -4 route get 1.1.1.1 2>/dev/null |
    awk '{ for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit } }' ||
    true
}
if [ "$(docker info --format '{{.Swarm.LocalNodeState}}')" != "active" ]; then
  advertise_addr="$(swarm_advertise_addr)"
  if [ -n "$advertise_addr" ]; then
    docker swarm init --advertise-addr "$advertise_addr"
  else
    docker swarm init
  fi
fi
# `docker network inspect`, not `docker network ls | grep -q`: the latter
# false-positives on any network whose name merely contains the string.
if ! docker network inspect cloudgate-network >/dev/null 2>&1; then
  docker network create --driver overlay --attachable cloudgate-network
fi

# Where Traefik's container reaches the console and the API on the Hosted
# instance: this host's address on docker_gwbridge, the bridge a container on
# cloudgate-network leaves the overlay by (deploy/hosted.sh makes it). Not the
# public address — 3000/4000 are closed there — and not 127.0.0.1, which inside
# the container is Traefik itself. The Firewall step opens 3000/4000 on that
# bridge alone.
if [ -n "$HOSTED_MODE" ]; then
  hosted_docker_gwbridge
  echo "Traefik reaches this host at ${DOCKER_HOST_GATEWAY} (docker_gwbridge)"
fi

### -------------------------------------------------------------- postgres ---

log "Postgres"
# `systemctl enable --now` below is idempotent; the apt-get was not.
ensure_packages postgresql
systemctl enable --now postgresql

# Migrate the legacy store once, and never regenerate over it: a new
# APP_ENCRYPTION_SECRET makes every encrypted column permanently unreadable
# (ADR-0006 has no fallback key chain), and a new PGPW without an ALTER ROLE
# leaves DATABASE_URL disagreeing with a role the CREATE ROLE guard below will
# not touch. The legacy file is renamed rather than deleted — it holds a run's
# evidence besides these three keys — and renaming is what closes the
# inheritance path, because nothing reads that name again.
if [ ! -f "$SECRETS_FILE" ] && [ -f "$LEGACY_SECRETS_FILE" ]; then
  install -m 0600 -o root -g root /dev/null "$SECRETS_FILE"
  grep -E '^(PGPW|APP_ENCRYPTION_SECRET|BETTER_AUTH_SECRET)=' \
    "$LEGACY_SECRETS_FILE" >> "$SECRETS_FILE" || true
  mv "$LEGACY_SECRETS_FILE" "$LEGACY_SECRETS_FILE.migrated"
  echo "migrated secrets to $SECRETS_FILE;"
  echo "  $LEGACY_SECRETS_FILE.migrated is no longer read and can be deleted"
fi
[ -f "$SECRETS_FILE" ] || install -m 0600 -o root -g root /dev/null "$SECRETS_FILE"

# One key, by name — NOT `. "$SECRETS_FILE"`, which is what this used to do
# twice. Sourcing executes the file as root at a point where every input from the
# inputs block above is already set, so a stray assignment in it silently
# redirects the install and a stray command simply runs; on the run that found
# this, the file carried 47 unrelated lines from a previous one.
read_secret() { sed -n "s/^$1=//p" "$SECRETS_FILE" | tail -n 1; }

PGPW="$(read_secret PGPW)"
if [ -z "$PGPW" ]; then
  PGPW="$(openssl rand -hex 24)"
  echo "PGPW=$PGPW" >> "$SECRETS_FILE"
fi
APP_ENCRYPTION_SECRET="$(read_secret APP_ENCRYPTION_SECRET)"
if [ -z "$APP_ENCRYPTION_SECRET" ]; then
  APP_ENCRYPTION_SECRET="$(openssl rand -hex 32)"
  echo "APP_ENCRYPTION_SECRET=$APP_ENCRYPTION_SECRET" >> "$SECRETS_FILE"
fi
# The Infrastructure state login's password: a login of its own, which
# reaches only the infrastructure_state schema, for `tofu` alone.
STATEPW="$(read_secret STATEPW)"
if [ -z "$STATEPW" ]; then
  STATEPW="$(openssl rand -hex 24)"
  echo "STATEPW=$STATEPW" >> "$SECRETS_FILE"
fi
BETTER_AUTH_SECRET="$(read_secret BETTER_AUTH_SECRET)"
if [ -z "$BETTER_AUTH_SECRET" ]; then
  BETTER_AUTH_SECRET="$(openssl rand -hex 32)"
  echo "BETTER_AUTH_SECRET=$BETTER_AUTH_SECRET" >> "$SECRETS_FILE"
fi

# Quote the literals inside psql. An unquoted `rolname=cloudgate` is read as a
# column reference and errors out, which makes the guard always "miss".
have_role="$(su - postgres -c "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='cloudgate'\"")"
if [ "$have_role" != "1" ]; then
  su - postgres -c "psql -q -c \"CREATE ROLE cloudgate LOGIN PASSWORD '${PGPW}'\""
fi
have_db="$(su - postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='cloudgate'\"")"
if [ "$have_db" != "1" ]; then
  su - postgres -c "createdb -O cloudgate cloudgate"
fi
# The Infrastructure state login (ADR-0036). What it may reach is granted
# after the migrations below, which make the schema it reaches.
have_state_role="$(su - postgres -c "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='cloudgate_state'\"")"
if [ "$have_state_role" != "1" ]; then
  su - postgres -c "psql -q -c \"CREATE ROLE cloudgate_state LOGIN PASSWORD '${STATEPW}'\""
fi

### ------------------------------------------------------------- build tooling ---
# nixpacks is the *default* buildType, and backend/src/servers/server-setup.ts
# explicitly declines to install it ("build tooling is a later phase"). Without
# it every default-builder deploy fails. rclone came from apt above;
# destinations.service.listObjects shells out to `rclone lsjson --no-mimetype`.
# Railpack and pack (the Heroku and Paketo builders) are not installed here:
# each build installs its own on whichever Server it runs on
# (backend/src/builders/pack-install.ts).

log "nixpacks"
command -v nixpacks >/dev/null || curl -sSL https://nixpacks.com/install.sh | bash

### -------------------------------------------------------------- opentofu ---
# OpenTofu and the providers, all pinned above, all checked, all into
# $OPENTOFU_DIR, so a Cloud run starts from what is on disk and never downloads
# anything (ADR-0030). About 255 MB of downloads; the providers unpack to
# about 980 MB (AWS 840 MB, Google 140 MB). Each is skipped when it is
# already at its pin, so a re-run — which is the upgrade (docs/deploy.md §7) —
# downloads only what moved.
#
# Never Terraform's binary, and no program is patched (ADR-0030): all are the
# release artefacts, checked byte for byte, and run as separate programs.
#
# A provider is checked against its block of the committed lock file, not only
# against the SHA256SUMS published beside it: its `zh:` entries are the zip
# checksums of every platform, and a zip whose sha256 is not one of them is
# refused. `tofu init` then checks the unpacked directory again against the
# lock file's `h1:`.
#
# Unpacked layout (`<host>/<namespace>/<type>/<version>/<os_arch>/`), which a
# `filesystem_mirror` reads in place: `tofu init` links it into each working
# directory rather than copying 840 MB. Older provider versions are removed —
# versions only move forward, so nothing will ask for one again.

log "OpenTofu ${OPENTOFU_VERSION}, the AWS provider ${AWS_PROVIDER_VERSION} and the Google provider ${GOOGLE_PROVIDER_VERSION}"
# Both downloads below are the linux_amd64 builds, and nothing else is pinned.
if [ "$(uname -m)" != x86_64 ]; then
  echo "OpenTofu is installed for amd64 (x86_64) only; this host is $(uname -m)." >&2
  exit 1
fi
if [ "$(printf '%s\n' 1.10.0 "$OPENTOFU_VERSION" | sort -V | head -n 1)" != 1.10.0 ]; then
  echo "OPENTOFU_VERSION=${OPENTOFU_VERSION}: Cloudgate needs OpenTofu 1.10 or later." >&2
  exit 1
fi

if [ "$("$OPENTOFU_BINARY" version -json 2>/dev/null | jq -r .terraform_version 2>/dev/null || true)" != "$OPENTOFU_VERSION" ]; then
  tarball="tofu_${OPENTOFU_VERSION}_linux_amd64.tar.gz"
  tmp="$(mktemp -d)"
  (
    cd "$tmp"
    curl -fsSLO "https://github.com/opentofu/opentofu/releases/download/v${OPENTOFU_VERSION}/${tarball}"
    echo "${OPENTOFU_SHA256}  ${tarball}" | sha256sum -c -
    mkdir unpacked
    tar -xzf "$tarball" -C unpacked --no-same-owner
    install -D -m 0755 unpacked/tofu "$OPENTOFU_BINARY"
  )
  rm -rf "$tmp"
fi

opentofu_lock="$REPO_ROOT/deploy/opentofu/.terraform.lock.hcl"
# One provider's block of the lock file: `provider "…/hashicorp/<type>" {` to `}`.
locked_provider() {
  awk -v open="provider \"registry.opentofu.org/hashicorp/$1\" {" \
    '$0 == open { on = 1 } on { print } on && $0 == "}" { exit }' "$opentofu_lock"
}
# install_provider <type> <version>: hashicorp/<type> from the OpenTofu
# registry's release, checked against its lock block, into the mirror.
install_provider() {
  local type="$1" version="$2"
  local dir="$OPENTOFU_PROVIDER_MIRROR/registry.opentofu.org/hashicorp/$type"
  local block
  block="$(locked_provider "$type")"
  if ! grep -qx "  version     = \"${version}\"" <<<"$block"; then
    echo "hashicorp/$type ${version} is not the version $opentofu_lock pins." >&2
    exit 1
  fi
  if [ -x "$dir/${version}/linux_amd64/terraform-provider-$type" ]; then
    return
  fi
  local zip="terraform-provider-${type}_${version}_linux_amd64.zip"
  # Beside the mirror, not in /tmp, so the move below is a rename on one
  # filesystem rather than a copy that an interrupted run could leave half done.
  install -d -m 0755 "$OPENTOFU_PROVIDER_MIRROR"
  local tmp
  tmp="$(mktemp -d "$OPENTOFU_DIR/.download.XXXXXX")"
  (
    cd "$tmp"
    curl -fsSLO "https://github.com/opentofu/terraform-provider-${type}/releases/download/v${version}/${zip}"
    sum="$(sha256sum "$zip" | cut -d' ' -f1)"
    if ! grep -qx "    \"zh:${sum}\"," <<<"$block"; then
      echo "$zip (sha256 $sum) is not a checksum $opentofu_lock pins." >&2
      exit 1
    fi
    echo "$zip: OK (deploy/opentofu/.terraform.lock.hcl)"
    mkdir linux_amd64
    unzip -q "$zip" -d linux_amd64
  )
  # Replaced whole, and only once the new one is complete and checked, so an
  # interrupted run leaves the old provider or none — never half of one.
  rm -rf "$dir"
  install -d -m 0755 "$dir/${version}"
  mv "$tmp/linux_amd64" "$dir/${version}/linux_amd64"
  rm -rf "$tmp"
}
install_provider aws "${AWS_PROVIDER_VERSION}"
install_provider google "${GOOGLE_PROVIDER_VERSION}"
"$OPENTOFU_BINARY" version

### ------------------------------------------------ session manager plugin ---
# The Session Manager plugin, pinned above and checked byte for byte, unpacked
# from AWS's own .deb into Cloudgate's directory rather than installed with
# dpkg, so it is never on PATH for anything else. Skipped when it is already at
# its pin, so a re-run downloads it only when the pin moved.

log "Session Manager plugin ${SESSION_MANAGER_PLUGIN_VERSION}"
if [ "$(printf '%s\n' 1.2.536.0 "$SESSION_MANAGER_PLUGIN_VERSION" | sort -V | head -n 1)" != 1.2.536.0 ]; then
  echo "SESSION_MANAGER_PLUGIN_VERSION=${SESSION_MANAGER_PLUGIN_VERSION}: Cloudgate needs the Session Manager plugin 1.2.536.0 or later." >&2
  exit 1
fi
if [ "$("$SESSION_MANAGER_PLUGIN" --version 2>/dev/null || true)" != "$SESSION_MANAGER_PLUGIN_VERSION" ]; then
  tmp="$(mktemp -d)"
  (
    cd "$tmp"
    curl -fsSLo session-manager-plugin.deb "https://s3.amazonaws.com/session-manager-downloads/plugin/${SESSION_MANAGER_PLUGIN_VERSION}/ubuntu_64bit/session-manager-plugin.deb"
    echo "${SESSION_MANAGER_PLUGIN_SHA256}  session-manager-plugin.deb" | sha256sum -c -
    dpkg-deb -x session-manager-plugin.deb unpacked
    install -D -m 0755 unpacked/usr/local/sessionmanagerplugin/bin/session-manager-plugin "$SESSION_MANAGER_PLUGIN"
  )
  rm -rf "$tmp"
fi
"$SESSION_MANAGER_PLUGIN" --version

### ------------------------------------------- service user and directories ---

log "Service user and directories"
id "$SERVICE_USER" >/dev/null 2>&1 || useradd \
  --system --home-dir /var/lib/cloudgate --create-home \
  --shell /usr/sbin/nologin "$SERVICE_USER"

mkdir -p "$CLOUDGATE_DIR/traefik/dynamic"
# The platform-host terminal's key directory. Nothing created it — not
# this script, and not `serverSetupCommand`, whose setupMainDirectory makes the
# same two directories on a *remote* Server — and `ssh-keygen` will not create a
# parent for an explicit -f path, so the first "Open a shell" on the local
# Server closed 4502 on a stock install. `install -d`, not mkdir: mode and owner
# in one call, and 0700 rather than the tree's default because the private key
# lives in it and F-04 (below) means anything readable here is readable by any
# authenticated caller. setupSshKey() makes it too, for an operator who moved
# CLOUDGATE_DIRECTORY after the install.
install -d -m 700 -o root -g root "$CLOUDGATE_DIR/ssh"
# Owned by root: the backend runs as root, and F-04 means anything readable
# under this tree is readable by any authenticated user via /listen-deployment.
chown -R root:root "$CLOUDGATE_DIR"

# Everything in the version is owned by the service user: the console runs as
# it and writes its runtime cache under frontend/.next. Before place_version,
# so the version arrives at /opt/cloudgate already owned.
chown -R "$SERVICE_USER:$SERVICE_USER" "$REPO_ROOT"

### ------------------------------------------------------------- env files ---
# NOT under $CLOUDGATE_DIR — see finding F-04.

log "Environment files"
umask 077
# `<<EOF` unquoted, deliberately: nine values below are interpolated, and
# `<<'EOF'` would write `PORT=${API_PORT}` and a DATABASE_URL containing the
# literal `${PGPW}`. The cost is that this body is a shell context running as
# root — a backtick or `$(...)` in it EXECUTES at install time and is replaced by
# its output. That is not hypothetical: an unescaped `true` in the
# TRUST_PROXY comment below ran and deleted the very value the comment forbids,
# so the installed file told operators to set it "never to .". Escape
# every backtick as \` and every `$` that is not an intended expansion as \$.
# Bash has no mode that expands ${VAR} and refuses `...`, so the constraint is
# pinned from backend/test/servers/server-setup.spec.ts instead.
cat > /etc/default/cloudgate-backend <<EOF
NODE_ENV=production
PORT=${API_PORT}
DATABASE_URL=postgresql://cloudgate:${PGPW}@127.0.0.1:5432/cloudgate
# The login a Cloud run's tofu uses: only the infrastructure_state schema.
INFRASTRUCTURE_STATE_DATABASE_URL=postgresql://cloudgate_state:${STATEPW}@127.0.0.1:5432/cloudgate
APP_ENCRYPTION_SECRET=${APP_ENCRYPTION_SECRET}
BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET}
# The CONSOLE's origin, not this service's.
BETTER_AUTH_URL=${CONSOLE_ORIGIN}
# This service's own public origin, the same CLOUDGATE_API_URL the console is
# given. Never dialled by the backend: GET /settings/about advertises it so the
# Cloudgate CLI can reach the WebSockets the console does not proxy.
CLOUDGATE_API_URL=${API_ORIGIN}
# Both origin lists stay empty on purpose. BETTER_AUTH_URL's own origin is
# trusted for free; adding a second one would let sign-in succeed at an address
# whose console CLOUDGATE_API_URL points elsewhere, producing a console that
# signs you in and then shows no logs.
TRUSTED_ORIGINS=
CORS_ALLOWED_ORIGINS=
CLOUDGATE_DIRECTORY=${CLOUDGATE_DIR}
TRAEFIK_VERSION=${TRAEFIK_VERSION}
# OpenTofu and the providers this script installed and checked (ADR-0030). A
# Cloud run uses these and only these; it never downloads a provider.
OPENTOFU_VERSION=${OPENTOFU_VERSION}
OPENTOFU_BINARY=${OPENTOFU_BINARY}
OPENTOFU_PROVIDER_MIRROR=${OPENTOFU_PROVIDER_MIRROR}
AWS_PROVIDER_VERSION=${AWS_PROVIDER_VERSION}
GOOGLE_PROVIDER_VERSION=${GOOGLE_PROVIDER_VERSION}
# The Session Manager plugin this script installed and checked: a Stack VM on
# AWS is reached through it (ADR-0070).
SESSION_MANAGER_PLUGIN=${SESSION_MANAGER_PLUGIN}
# So a container the backend creates carries the same log ceiling as the Traefik
# this script started.
CONTAINER_LOG_MAX_SIZE=${CONTAINER_LOG_MAX_SIZE}
CONTAINER_LOG_MAX_FILE=${CONTAINER_LOG_MAX_FILE}
# loopback, and it has to be. The console's /api/auth/* and /backend/*
# rewrites are a SERVER-SIDE proxy, so the socket peer the backend sees is the
# console process and never the browser — which recorded this host's own address
# on every session, and collapsed better-auth's sign-in throttle onto one bucket
# for the whole install. The console now reaches the backend over loopback and
# forwards the browser in x-forwarded-for (frontend/server.mjs), and loopback
# here is what lets the backend step past that hop and record the person.
# What it costs, plainly: anything else on this host that reaches the API over
# loopback is now a hop whose forwarded claim is believed — on a single-tenant
# box that is the operator. Other values (uniquelocal | an IP/CIDR list) belong
# here once Traefik or a load balancer is in front, and a hop count only ever on
# its own; never to \`true\`.
TRUST_PROXY=loopback
EOF
# The Hosted instance's settings, every one the hosted boot check requires,
# from deploy/hosted.sh rather than the heredoc above so that file can
# stay one shape for both modes, and each value single-quoted.
if [ -n "$HOSTED_MODE" ]; then
  hosted_backend_env "http://${DOCKER_HOST_GATEWAY}:${CONSOLE_PORT}" >> /etc/default/cloudgate-backend
fi
chmod 0600 /etc/default/cloudgate-backend
chown root:root /etc/default/cloudgate-backend

# Unquoted for ${CONSOLE_PORT} and ${API_ORIGIN}; same root shell-context rule as above.
cat > /etc/default/cloudgate-console <<EOF
NODE_ENV=production
PORT=${CONSOLE_PORT}
# The API's public origin, which every page is handed for the six gateways.
# Read when the console starts (ADR-0082): changing it is a restart, and a
# missing or non-http(s) value stops the console at boot.
CLOUDGATE_API_URL=${API_ORIGIN}
# Where the console's own rewrites reach the API. Server-side only, so it is
# loopback rather than the public origin: nothing a browser dials comes from
# this value, and it keeps console-to-API auth traffic off the public interface.
BACKEND_INTERNAL_ORIGIN=http://127.0.0.1:${API_PORT}
EOF
# Hosted only: Traefik is the one hop in front of the console, so its
# x-forwarded-for entry is believed from that bridge and from nowhere else.
if [ -n "$HOSTED_MODE" ]; then
  echo "CONSOLE_TRUSTED_PROXY=${DOCKER_GWBRIDGE_SUBNET}" >> /etc/default/cloudgate-console
fi
chmod 0640 /etc/default/cloudgate-console
chown "root:$SERVICE_USER" /etc/default/cloudgate-console
umask 022

### ------------------------------------------------------ cloudgate version ---

as_service_user() {
  runuser -u "$SERVICE_USER" -- env \
    PATH=/usr/local/bin:/usr/bin:/bin \
    HOME=/var/lib/cloudgate \
    "$@"
}

# Puts the version this script was run from at $INSTALL_DIR, in place of the
# one there, and points REPO_ROOT at it. Here, after every step that can stop
# the run and just before the migrations, rather than in root install.sh: the
# units keep running the old version until the restart below, and a run that
# stops earlier leaves the installed version whole beside an unused staging
# directory. Two renames on one filesystem, then the old one goes: rolling
# back is not offered, because its migrations only go forward. Run from
# $INSTALL_DIR itself, a re-run of the installed version, it moves nothing.
place_version() {
  if [ "$REPO_ROOT" = "$INSTALL_DIR" ]; then
    echo "Cloudgate $(cat "$INSTALL_DIR/VERSION") is in place at $INSTALL_DIR"
    return
  fi
  rm -rf "$INSTALL_DIR.previous"
  if [ -e "$INSTALL_DIR" ]; then
    mv "$INSTALL_DIR" "$INSTALL_DIR.previous"
  fi
  mv "$REPO_ROOT" "$INSTALL_DIR"
  REPO_ROOT="$INSTALL_DIR"
  rm -rf "$INSTALL_DIR.previous"
  echo "Cloudgate $(cat "$INSTALL_DIR/VERSION") is in place at $INSTALL_DIR"
}

log "Cloudgate ${VERSION}"
place_version

log "Database migrations"
set -a; . /etc/default/cloudgate-backend; set +a
# The version's own drizzle-kit, which it carries in production node_modules,
# as `db:migrate` runs it. NEVER `drizzle-kit push` — it writes columns with no
# journal row, and the next migrate then hits an already-applied ALTER TABLE
# and exits 1 with nothing on stdout or stderr. On the version already
# installed it applies nothing.
cd "$REPO_ROOT/backend"
as_service_user DATABASE_URL="$DATABASE_URL" node_modules/.bin/drizzle-kit migrate
cd "$REPO_ROOT"
# Every run, so an upgrade that adds to the state schema grants it too. Read by
# postgres from stdin: the version's files are not postgres's to open.
su - postgres -c "psql -q -v ON_ERROR_STOP=1 -d cloudgate" < "$REPO_ROOT/deploy/opentofu/state-login.sql"

### ---------------------------------------------------------------- traefik ---
# Write the config FIRST. Starting the container first makes Docker create a
# *directory* at the bind-mount source, after which Traefik fails on config and
# every retry fails identically until you rm -rf a directory you didn't know
# you made.
#
# Both files below are byte-identical to deploy/traefik/traefik.yml.example and
# deploy/traefik/dynamic/middlewares.yml.example, and to what
# `createTraefikConfig()` and `createTraefikMiddlewares()` in
# backend/src/servers/server-setup.ts write — except that a remote Server's
# traefik.yml stops before the access-log block at the end, because nothing on a
# remote Server reads that log (ADR-0027). That is not tidiness: this
# host can also be registered as a Server later, and that script skips each file
# it finds already present — so whichever path runs first wins, and the three
# must not disagree about what it wrote. All three are pinned against the
# generator by backend/test/servers/server-setup.spec.ts, which reads this file
# off disk — the two heredocs below, their `[ ! -f … ]` guards, CLOUDGATE_DIR
# and TRAEFIK_VERSION. Drift fails there rather than on a host. Only those are
# pinned: the rest of this script is not.
#
# There is one Traefik version now, not two. TRAEFIK_VERSION above is
# written into /etc/default/cloudgate-backend, which is where both
# server-setup.ts and TraefikSetupService read it from, so the container this
# script starts is the container they would each have started — and registering
# this host as a Server finds it present and skips it.

log "Traefik"
if [ ! -f "$CLOUDGATE_DIR/traefik/traefik.yml" ]; then
  # `certificatesResolvers.letsencrypt`: every generator that emits a
  # `letsencrypt` domain writes `tls: { certResolver: letsencrypt }`, and
  # without a resolver by that name Traefik serves the app under its built-in
  # self-signed certificate — a working HTTPS URL every browser rejects. The
  # email is a placeholder the console overwrites via updateLetsEncryptEmail,
  # which patches this key and fails outright when the block is absent; it is
  # not an @example.com address because Let's Encrypt refuses those.
  #
  # `log`: Traefik 3 defaults its own application log to ERROR, so a
  # healthy instance was silent and `docker logs cloudgate-traefik` was 0 bytes
  # since install — "no ACME attempt" and "attempt succeeded" read identically.
  # `accessLog` cannot stand in: the httpChallenge is answered before the router
  # chain, so it logs no acme-challenge line even for a challenge that worked.
  # Stdout, not a filePath, so `docker logs` is the interface and Docker's log
  # driver owns retention — capped by the --log-opt flags below.
  #
  # `metrics` and the `metrics` entryPoint (ADR-0027): Traefik's per-service
  # request counters, read by the backend as each Service's Error rate. Bound
  # to 127.0.0.1 inside the container, which is a tenant-isolation requirement:
  # on :8082 any container on cloudgate-network could read every Service's
  # counters.
  #
  # `accessLog`: without it /requests renders empty on a fresh install.
  # It is the platform host's alone — a remote Server is provisioned without one.
  # Turning it on later restarts Traefik — every connection on 80 and 443 —
  # which the product refuses to do on the operator's behalf. Here it costs
  # nothing. Same filePath, format and bufferingSize the toggle writes, so
  # haveActivateRequests reads it as already on.
  cat > "$CLOUDGATE_DIR/traefik/traefik.yml" <<EOF
providers:
  docker:
    exposedByDefault: false
    watch: true
  file:
    directory: ${CLOUDGATE_DIR}/traefik/dynamic
    watch: true
entryPoints:
  web:
    address: ':80'
  websecure:
    address: ':443'
  metrics:
    address: '127.0.0.1:8082'
certificatesResolvers:
  letsencrypt:
    acme:
      email: admin@localhost.com
      storage: ${CLOUDGATE_DIR}/traefik/dynamic/acme.json
      httpChallenge:
        entryPoint: web
# Traefik's *application* log — startup, provider reloads and, the reason it is
# here, every ACME attempt and what Let's Encrypt answered. At Traefik 3's
# default level (ERROR) a healthy instance says nothing, so "never tried" and
# "issued a certificate" are the same empty docker logs. No filePath:
# stdout is what "docker logs cloudgate-traefik" reads, and Docker's log driver
# owns retention. An access log, where a machine keeps one, is a separate file.
log:
  level: INFO
# Request metrics (ADR-0027): per-service request counters, read by the
# backend as each Service's Error rate. Loopback only — on any other address
# every container on the Traefik network could read every Service's counters.
# Never on the dashboard entryPoint.
metrics:
  prometheus:
    entryPoint: metrics
    addServicesLabels: true
    addRoutersLabels: false
# Cloudgate rotates this file; Traefik cannot. Traefik 3.x has no accessLog
# rotation settings, so the policy is ACCESS_LOG_MAX_BYTES in
# backend/src/settings/traefik-files.service.ts, which renames the file and
# sends Traefik SIGUSR1 to make it reopen filePath.
accessLog:
  filePath: ${CLOUDGATE_DIR}/traefik/dynamic/access.log
  format: json
  bufferingSize: 100
EOF
fi

# `redirect-to-https`, in its own file under dynamic/ and behind its own
# guard. Three generators — traefik/config/domain.ts, traefik/config/web-server.ts
# and compose/compose.utils.ts — attach this middleware to the `web` router of
# every HTTPS domain, and nothing defined it. Traefik drops a router that names
# a middleware it does not know, so plain HTTP did not redirect: it fell through
# to the catch-all and answered 404, which reads as a broken domain rather than
# as three missing lines of config.
#
# Separate guard, separate file: the file provider watches this directory, so it
# lands on a Traefik that is already running, and a re-run of this script repairs
# a host whose traefik.yml predates the block above and is therefore skipped.
if [ ! -f "$CLOUDGATE_DIR/traefik/dynamic/middlewares.yml" ]; then
  cat > "$CLOUDGATE_DIR/traefik/dynamic/middlewares.yml" <<'EOF'
http:
  middlewares:
    redirect-to-https:
      redirectScheme:
        scheme: https
        permanent: true
EOF
fi

# The Hosted instance's routing: CLOUDGATE_HOSTNAME on HTTPS with a
# Let's Encrypt certificate, the six WebSocket gateways (and the Gateway's
# /ai/) to the API, everything else to the console, plain HTTP redirected.
# Generated by the backend's hosted-traefik-config command, whose output
# backend/test/traefik/hosted.spec.ts tests, from the version's built backend. Its
# own file, not dynamic/cloudgate.yml, which Settings > Web server owns.
# Rewritten every run, unguarded, because it is this script's alone and the
# hostname may have changed; through a .tmp name the file provider ignores, so
# Traefik never reads half of it.
if [ -n "$HOSTED_MODE" ]; then
  as_service_user node "$REPO_ROOT/backend/dist/commands/hosted-traefik-config.js" \
    --host "$CLOUDGATE_HOSTNAME" \
    --console-url "http://${DOCKER_HOST_GATEWAY}:${CONSOLE_PORT}" \
    --api-url "http://${DOCKER_HOST_GATEWAY}:${API_PORT}" \
    > "$CLOUDGATE_DIR/traefik/dynamic/hosted.yml.tmp"
  mv "$CLOUDGATE_DIR/traefik/dynamic/hosted.yml.tmp" "$CLOUDGATE_DIR/traefik/dynamic/hosted.yml"
fi

if ! docker inspect cloudgate-traefik >/dev/null 2>&1; then
  docker pull -q "traefik:v${TRAEFIK_VERSION}"
  # Shape matches TraefikSetupService.initializeStandaloneTraefik — and, since
  # both paths share one set of constants, setupTraefikInstance in
  # server-setup.ts as well: same name, same network, same three binds,
  # 80 + 443/tcp + 443/udp, restart always.
  # The dynamic dir's bind *target* is /etc/cloudgate/traefik/dynamic because
  # that is the path inside the container the file provider watches.
  #
  # The --log-opt flags are what bounds Traefik's now-chatty application log.
  # Same driver as the stock default, so `docker logs cloudgate-traefik` still
  # reads it; the cap is 30 MB, and re-running this script does NOT apply a
  # changed cap, because the guard above skips an existing container. Changing it
  # on a running host is `docker rm -f cloudgate-traefik` and a re-run.
  docker run -d \
    --name cloudgate-traefik \
    --restart always \
    --network cloudgate-network \
    --log-driver json-file \
    --log-opt "max-size=${CONTAINER_LOG_MAX_SIZE}" \
    --log-opt "max-file=${CONTAINER_LOG_MAX_FILE}" \
    -v "${CLOUDGATE_DIR}/traefik/traefik.yml:/etc/traefik/traefik.yml" \
    -v "${CLOUDGATE_DIR}/traefik/dynamic:/etc/cloudgate/traefik/dynamic" \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -p 80:80 -p 443:443 -p 443:443/udp \
    "traefik:v${TRAEFIK_VERSION}"
fi

### ------------------------------------------------------------------ units ---

log "systemd units"
install -m 0644 "$REPO_ROOT/deploy/systemd/cloudgate-backend.service" /etc/systemd/system/
install -m 0644 "$REPO_ROOT/deploy/systemd/cloudgate-console.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable cloudgate-backend cloudgate-console
# restart, not `enable --now`: on a re-run the units are already active, and
# place_version has just put another version where they run from.
systemctl restart cloudgate-backend
systemctl restart cloudgate-console

# The Hosted instance's hourly backup to B2 and the hourly check that mails
# BACKUP_ALERT_EMAIL once none has succeeded for 3 hours
# (deploy/hosted-backup.sh). The first backup runs at the end of this script,
# once the database has its migrations and the Instance organization.
if [ -n "$HOSTED_MODE" ]; then
  for unit in cloudgate-backup.service cloudgate-backup.timer \
    cloudgate-backup-check.service cloudgate-backup-check.timer; do
    install -m 0644 "$REPO_ROOT/deploy/systemd/$unit" /etc/systemd/system/
  done
  systemctl daemon-reload
  systemctl enable --now cloudgate-backup.timer cloudgate-backup-check.timer
  # The updater deploy-hosted.yml runs over SSH (deploy/hosted-update.sh),
  # refreshed on every run so it is always this version's. A root-owned copy:
  # sudo lets cloudgate-deploy run this path, and /opt/cloudgate is the
  # cloudgate user's. Who may run it is deploy/hosted-update-access.sh's, once.
  install -m 0755 -o root -g root "$REPO_ROOT/deploy/hosted-update.sh" /usr/local/sbin/cloudgate-update
fi

### --------------------------------------------------------------- firewall ---
# Allow SSH *first*: `ufw enable` before `ufw allow OpenSSH` locks you out.
#
# These rules cover the host's own listeners and nothing Cloudgate publishes
# afterwards: ufw is not in the path of a Docker publish, because Docker's own
# iptables rules are evaluated first. A database given an external port in the
# console is therefore reachable from the internet while `ufw status` still
# shows the port is not allowed. Restricting one takes a DOCKER-USER
# rule or a firewall in front of the host — see docs/deploy.md, "Security
# posture". Do not add either here; this script decides nothing about what the
# operator later publishes.

#
# The Hosted instance is served on 443 alone, so 3000/4000 are closed:
# open only on docker_gwbridge, the bridge Traefik's container reaches them on
# (DOCKER_HOST_GATEWAY above), and nowhere else. Incoming is denied by default
# so closed means closed whatever was set before, and the Self-hosted allow
# rules are deleted in case this box ran the Self-hosted install first. Docker's
# own publishes are untouched by any of it, as above; the console and the API
# are host processes, so ufw is in their path. The Hetzner Cloud Firewall in
# front (22/80/443 only) is docs/deploy.md's, not this script's.

log "Firewall"
ufw allow OpenSSH
if [ -n "$HOSTED_MODE" ]; then
  ufw default deny incoming
  ufw delete allow "$CONSOLE_PORT" >/dev/null 2>&1 || true
  ufw delete allow "$API_PORT" >/dev/null 2>&1 || true
  ufw allow in on docker_gwbridge to any port "$CONSOLE_PORT" proto tcp
  ufw allow in on docker_gwbridge to any port "$API_PORT" proto tcp
else
  ufw allow "$CONSOLE_PORT"
  ufw allow "$API_PORT"
fi
ufw allow 80
ufw allow 443
# Swarm's cluster ports, opened on the public interface by `swarm init`.
ufw deny 2377
ufw deny 7946
ufw deny 4789
ufw --force enable
echo "note: ufw does not filter ports Docker publishes. A database given an"
echo "      external port in the console is reachable from anywhere, whatever"
echo "      \`ufw status\` says. See docs/deploy.md, \"Security posture\"."

### ----------------------------------------------------------------- verify ---

log "Verification"

# The backend maps its routes before it listens, which takes ~15s on two slow
# cores. Poll rather than sleeping a guessed interval.
for _ in $(seq 1 60); do
  curl -fsS -o /dev/null "http://127.0.0.1:${API_PORT}/settings/health" 2>/dev/null && break
  sleep 2
done

curl -fsS "http://127.0.0.1:${API_PORT}/settings/health"; echo
curl -fsS "http://127.0.0.1:${API_PORT}/auth/sign-up-open"; echo
echo "console /sign-up: $(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${CONSOLE_PORT}/sign-up")"
echo "traefik  :80    : $(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1/)  (404 = listening)"
docker info --format 'swarm: {{.Swarm.LocalNodeState}}'
docker network inspect cloudgate-network -f 'network: {{.Driver}} attachable={{.Attachable}}'
docker inspect -f 'traefik: {{.State.Running}} {{.Config.Image}}' cloudgate-traefik

if [ -z "$HOSTED_MODE" ]; then
  log "Done. Open ${CONSOLE_ORIGIN}/sign-up — the first account owns the instance."
else
  # -k: the certificate is issued on the first HTTPS request after DNS points
  # here, so it may not be in place yet. The answer still says Traefik routes.
  echo "https://${CLOUDGATE_HOSTNAME}/ via traefik: $(curl -sk -o /dev/null -w '%{http_code}' \
    --resolve "${CLOUDGATE_HOSTNAME}:443:127.0.0.1" "https://${CLOUDGATE_HOSTNAME}/sign-in")"

  # The Instance organization, instead of the first sign-up owning the
  # instance: web sign-up says "not open yet" until it exists. Asked of the
  # backend first rather than read off the command's exit code, because the
  # command's 1 means both "an owner already exists" — every re-run — and a
  # refusal that wrote nothing; only the first may be skipped.
  log "Instance organization"
  sign_up_state="$(curl -fsS "http://127.0.0.1:${API_PORT}/auth/sign-up-open" | jq -r .state)"
  case "$sign_up_state" in
    open)
      echo "The Instance organization already exists; web sign-up is open ✅"
      ;;
    not-open-yet)
      instance_owner_flags=(
        --email "$INSTANCE_OWNER_EMAIL"
        --first-name "$INSTANCE_OWNER_FIRST_NAME"
        --organization-name "$INSTANCE_ORGANIZATION_NAME"
      )
      if [ -n "${INSTANCE_OWNER_LAST_NAME:-}" ]; then
        instance_owner_flags+=(--last-name "$INSTANCE_OWNER_LAST_NAME")
      fi
      # Prints the generated password once. It is not kept anywhere: put it in
      # the vault now, or reset it from the sign-in page later.
      if ! as_service_user DATABASE_URL="$DATABASE_URL" \
        node "$REPO_ROOT/backend/dist/commands/create-instance-organization.js" \
        "${instance_owner_flags[@]}"; then
        echo "create-instance-organization refused; nothing was written. Fix the" >&2
        echo "INSTANCE_* input it names in $HOSTED_INPUTS_FILE and re-run." >&2
        exit 1
      fi
      ;;
    *)
      echo "GET /auth/sign-up-open answered \"$sign_up_state\"; the Hosted instance" >&2
      echo "answers not-open-yet or open. Is the backend running in hosted mode?" >&2
      exit 1
      ;;
  esac

  # A backup now, and the run fails if it does: it proves the B2 key, the
  # bucket and the age recipient before the first hourly run would. On a
  # re-run it backs up the upgraded instance; the backup from before an
  # upgrade is taken by hand first (docs/deploy.md, The Hosted instance).
  log "Backup to B2"
  if ! systemctl start cloudgate-backup.service; then
    echo "The first backup failed: journalctl -u cloudgate-backup.service says why." >&2
    echo "Fix the BACKUP_* input it names in $HOSTED_INPUTS_FILE and re-run." >&2
    exit 1
  fi
  journalctl -u cloudgate-backup.service -n 4 --no-pager -o cat || true
  systemctl list-timers cloudgate-backup.timer cloudgate-backup-check.timer --no-pager || true

  log "Done. Open https://${CLOUDGATE_HOSTNAME}/sign-in as ${INSTANCE_OWNER_EMAIL}."
  echo "Web sign-up is open to the public at https://${CLOUDGATE_HOSTNAME}/sign-up."
fi
echo "Secrets are in ${SECRETS_FILE} (mode 0600); the same three are also in"
echo "/etc/default/cloudgate-backend. Back up both — docs/deploy.md §8. Without"
echo "APP_ENCRYPTION_SECRET every encrypted column is permanently unreadable."
