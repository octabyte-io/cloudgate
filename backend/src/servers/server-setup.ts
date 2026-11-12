import { REMOTE_CLOUDGATE_DIRECTORY } from '../common/config/cloudgate-directory';
import { containerLogRunFlags } from '../common/config/container-logs';
import {
  REQUEST_METRICS_BLOCK_YAML,
  REQUEST_METRICS_ENTRYPOINT_YAML,
} from '../common/config/request-metrics';
import { CLOUDGATE_NETWORK } from './server-audit';
import { joinAiNetworkProgram } from '../ai-models/ai-network';

/**
 * Initial server provisioning: required packages, Docker, Swarm init, the
 * overlay network, the platform directory, and Traefik.
 * (No rclone/nixpacks — build tooling is a later phase. Railpack and `pack`,
 * which the Heroku and Paketo builders run, need nothing here: each build
 * installs its own when the Server has none — `builders/pack-install.ts`.)
 *
 * Every path below is REMOTE_CLOUDGATE_DIRECTORY, never this instance's own
 * CLOUDGATE_DIRECTORY: this script runs over SSH on the Server, and what
 * it creates there is what later commands sent to that Server expect to find.
 */

export const DOCKER_VERSION = '28.5.0';

/**
 * The one definition of the Traefik container, for both paths that create it.
 *
 * Registering a Server runs the script below; adding a port or toggling the
 * dashboard later goes through `TraefikSetupService.writeTraefikSetup`, which
 * *recreates the same container*. Those used to be two independent definitions
 * — 3.5.0 here, 3.6.7 there, and only the second published 443/udp — so an
 * unrelated settings change silently moved Traefik a minor version and gave it
 * an HTTP/3 entry point it did not have before. These constants are now the
 * single source: `traefik-setup.service.ts` imports and re-exports them, and
 * the same env knobs steer both.
 *
 * Read at import, which is fine for a process env; a .env file only reaches
 * these through ConfigModule, so pin the version in the environment
 * (deploy/env/cloudgate-backend.example) rather than in a .env if the two must
 * agree on a host.
 */
export const TRAEFIK_VERSION = process.env.TRAEFIK_VERSION || '3.6.7';
export const TRAEFIK_PORT =
  Number.parseInt(process.env.TRAEFIK_PORT!, 10) || 80;
export const TRAEFIK_SSL_PORT =
  Number.parseInt(process.env.TRAEFIK_SSL_PORT!, 10) || 443;
export const TRAEFIK_HTTP3_PORT =
  Number.parseInt(process.env.TRAEFIK_HTTP3_PORT!, 10) || 443;

/**
 * The binaries the rest of the platform shells out to on a Server. Named as
 * *binaries* rather than as package names because that is what the guard can
 * check for; on Debian-family hosts each is also its package's name.
 *
 * `rclone` is here because every database backup, volume backup, prune and
 * restore of a Service on this Server runs `rclone` *on the Server*
 * (`destinations/rclone-exec.ts` passes the `serverId`), and nothing else
 * installed it: the platform host gets it from `deploy/install.sh`, a Server
 * never did, so every backup of a Service on an added VPS failed with
 * `rclone: command not found`.
 */
export const REQUIRED_UTILITIES = [
  'unzip',
  'curl',
  'wget',
  'git',
  'jq',
  'openssl',
  'rclone',
];

/**
 * Step 1 was the only step with no check, which made the console's "running it
 * again is safe: every step checks whether it is needed" false: every
 * re-run refreshed the apt index and ran `apt-get install` on six packages that
 * were already there, and `apt-get install` on an installed package *upgrades*
 * it when the freshly-refreshed index offers a newer one. So pressing a button
 * the UI describes as idempotent could silently upgrade curl, git and openssl
 * on a production Server, and print nothing while doing it — both apt calls are
 * `>/dev/null`.
 */
const installUtilities = () => `
  case "$OS_TYPE" in
  ubuntu | debian | raspbian)
    MISSING_PACKAGES=""
    for binary in ${REQUIRED_UTILITIES.join(' ')}; do
      command_exists "$binary" || MISSING_PACKAGES="$MISSING_PACKAGES $binary"
    done
    if [ -z "$MISSING_PACKAGES" ]; then
      echo "Required packages are installed ✅"
    else
      # Only what is missing: \`apt-get install\` on an installed package
      # upgrades it, which is what the guard above exists to prevent.
      export DEBIAN_FRONTEND=noninteractive
      $SUDO_CMD apt-get update -y >/dev/null
      $SUDO_CMD apt-get install -y $MISSING_PACKAGES >/dev/null
      echo "Required packages installed:$MISSING_PACKAGES ✅"
    fi
    ;;
  *)
    echo "Skipping package installation for $OS_TYPE (only Debian-family is automated)."
    ;;
  esac
`;

const installDocker = () => `
  if ! [ -x "$(command -v docker)" ]; then
    echo " - Docker is not installed. Installing Docker. It may take a while."
    curl -s https://get.docker.com | $SUDO_CMD sh -s -- --version $DOCKER_VERSION 2>&1
    if ! [ -x "$(command -v docker)" ]; then
      echo " - Docker installation failed. Please install Docker manually: https://docs.docker.com/engine/install/"
      exit 1
    fi
    echo " - Docker installed successfully."
  else
    echo " - Docker is installed."
  fi
  # A non-root sudo user runs this script with $SUDO_CMD, but every command
  # Cloudgate sends afterwards (deploys, database containers, backups, the
  # readiness probe) runs plain \`docker\` as that user. Without the group
  # each of them is refused at /var/run/docker.sock. Group membership applies
  # from the next login, and every later command is a new SSH session.
  if [ -n "$SUDO_CMD" ]; then
    if id -nG "$CURRENT_USER" | tr ' ' '\\n' | grep -qx docker; then
      echo " - $CURRENT_USER is in the docker group."
    else
      $SUDO_CMD groupadd -f docker
      $SUDO_CMD usermod -aG docker "$CURRENT_USER"
      echo " - Added $CURRENT_USER to the docker group."
    fi
  fi
`;

const setupSwarm = () => `
  if $SUDO_CMD docker info | grep -q 'Swarm: active'; then
    echo "Already part of a Docker Swarm ✅"
  else
    $SUDO_CMD docker swarm init --advertise-addr $ADVERTISE_ADDR
    echo "Swarm initialized ✅"
  fi
`;

/**
 * `docker network inspect`, not `docker network ls | grep`.
 *
 * The substring match said yes to `${CLOUDGATE_NETWORK}-old`, to
 * `my-${CLOUDGATE_NETWORK}`, and to a *container* name in another column of the
 * listing. When it did, provisioning printed "already exists ✅" and moved on,
 * `cloudgate-traefik` came up unattached, and every routed app 502'd with
 * nothing in the setup log pointing at the cause. `inspect` takes an exact name
 * — which is what the `setupTraefikInstance` guard below and `deploy/install.sh`
 * already do.
 */
const setupNetwork = () => `
  if $SUDO_CMD docker network inspect ${CLOUDGATE_NETWORK} >/dev/null 2>&1; then
    echo "Network ${CLOUDGATE_NETWORK} already exists ✅"
  else
    if $SUDO_CMD docker network create --driver overlay --attachable ${CLOUDGATE_NETWORK}; then
      echo "Network created ✅"
    else
      echo "Failed to create ${CLOUDGATE_NETWORK} ❌" >&2
      exit 1
    fi
  fi
`;

const setupMainDirectory = () => `
  if [ -d ${REMOTE_CLOUDGATE_DIRECTORY} ]; then
    echo "${REMOTE_CLOUDGATE_DIRECTORY} already exists ✅"
  else
    $SUDO_CMD mkdir -p ${REMOTE_CLOUDGATE_DIRECTORY}/traefik/dynamic
    echo "Directory ${REMOTE_CLOUDGATE_DIRECTORY} created ✅"
  fi
  if [ -n "$SUDO_CMD" ]; then
    $SUDO_CMD chown -R $CURRENT_USER:$CURRENT_USER ${REMOTE_CLOUDGATE_DIRECTORY}
  fi
`;

/**
 * Traefik's own container, and the one place a Server's Traefik gets its log
 * ceiling.
 *
 * The `--log-opt` flags are not decoration: Traefik's application
 * log is on at INFO, and on the stock `json-file` driver — no `max-size`, no
 * `max-file` — an ACME retry loop against a misconfigured domain writes until
 * the Server's disk is full, which takes down every workload on that machine
 * rather than only Traefik. Set here rather than in the operator's
 * `/etc/docker/daemon.json`, because the daemon file is theirs and a setup
 * script that rewrites it cannot be undone; see `common/config/container-logs`.
 */
const setupTraefikInstance = () => `
  if $SUDO_CMD docker inspect cloudgate-traefik > /dev/null 2>&1; then
    echo "Traefik already exists ✅"
  else
    $SUDO_CMD docker run -d \\
      --name cloudgate-traefik \\
      --restart always \\
      ${containerLogRunFlags().join(' \\\n      ')} \\
      -v ${REMOTE_CLOUDGATE_DIRECTORY}/traefik/traefik.yml:/etc/traefik/traefik.yml \\
      -v ${REMOTE_CLOUDGATE_DIRECTORY}/traefik/dynamic:${REMOTE_CLOUDGATE_DIRECTORY}/traefik/dynamic \\
      -v /var/run/docker.sock:/var/run/docker.sock \\
      -p ${TRAEFIK_SSL_PORT}:${TRAEFIK_SSL_PORT} \\
      -p ${TRAEFIK_HTTP3_PORT}:${TRAEFIK_HTTP3_PORT}/udp \\
      -p ${TRAEFIK_PORT}:${TRAEFIK_PORT} \\
      traefik:v${TRAEFIK_VERSION}

    $SUDO_CMD docker network connect ${CLOUDGATE_NETWORK} cloudgate-traefik
    echo "Traefik version ${TRAEFIK_VERSION} installed ✅"
  fi
`;

/**
 * Where the ACME account and its certificates are kept.
 *
 * Inside `dynamic/`, because that is the only directory of the three this
 * script creates that `setupTraefikInstance` bind-mounts into the container —
 * anywhere else and the file lives in the container's writable layer, which
 * `TraefikSetupService` throws away every time it recreates Traefik, and every
 * recreation would re-issue certificates straight into Let's Encrypt's rate
 * limit. `deploy/traefik/traefik.yml.example` names the same path.
 */
const ACME_STORAGE = `${REMOTE_CLOUDGATE_DIRECTORY}/traefik/dynamic/acme.json`;

/**
 * A placeholder the console overwrites: `assignDomain` calls
 * `TraefikFilesService.updateLetsEncryptEmail`, which *patches* this key and
 * throws "Invalid Let's Encrypt configuration structure" when the block is
 * absent — so writing the block here is also what makes that path work at all.
 * Not an `@example.com` address: Let's Encrypt refuses those outright, which
 * would turn a placeholder into a registration failure.
 */
const ACME_EMAIL = 'admin@localhost.com';

/**
 * Traefik's static configuration — the file the container reads once at start.
 *
 * Written before `setupTraefikInstance` runs, and only when it is not already
 * there, which is what makes it the one safe place to put anything static:
 * nothing is running yet, so nothing has to be restarted to pick it up. Four
 * things beyond providers and entryPoints:
 *
 * - **`certificatesResolvers.letsencrypt`.** Every generator that emits a
 *   `letsencrypt` domain writes `tls: { certResolver: 'letsencrypt' }`, and no
 *   resolver by that name existed. Traefik does not refuse such a router — it
 *   serves the app under its built-in self-signed certificate, so the operator
 *   gets a working HTTPS URL that every browser rejects and one line in a
 *   container log they have no reason to read.
 * - **`log`.** Traefik 3 defaults its own application log to `ERROR` on
 *   stdout, so a healthy instance was silent and `docker logs
 *   cloudgate-traefik` was 0 bytes since install — which made "no ACME attempt"
 *   and "attempt succeeded" the same observation. An access log cannot stand
 *   in: the httpChallenge is answered before the router chain, so a challenge
 *   that demonstrably succeeded leaves no `acme-challenge` line in one.
 *   `INFO` rather than `DEBUG` because that is where lego's
 *   `acme: Obtaining bundled SAN certificate` lines are, at startup-and-events
 *   volume rather than per-request volume. Deliberately **no `filePath`**: a
 *   file under `dynamic/` would land in the directory the file provider
 *   watches, and stdout is the interface the access log already assumes, with
 *   Docker's log driver owning retention (capped).
 * - **Request metrics (ADR-0027).** The loopback `metrics` entryPoint and
 *   `metrics.prometheus` on it, so a new Server's Services have an Error rate
 *   from the start. The block is `common/config/request-metrics.ts`'s, which
 *   Enable request metrics writes on a Server provisioned before this.
 * - **`middlewares.yml`**, below.
 *
 * **No `accessLog`, and that is ADR-0027 rather than an omission.** It used to
 * be here so `/requests` had something to read, but that reader is the
 * platform host's alone — it takes no `serverId` — so on a Server it wrote
 * about 800 B per request to a file nothing read and nothing rotated.
 * The platform host keeps its access log and its rotation: `deploy/install.sh`
 * and `deploy/traefik/traefik.yml.example` are this file plus the access-log
 * block, appended last, and `server-setup.spec.ts` pins exactly that. An
 * operator can still turn a Server's on with `POST /settings/traefik/requests`.
 */
const createTraefikConfig = () => `
  if [ -f "${REMOTE_CLOUDGATE_DIRECTORY}/traefik/traefik.yml" ]; then
    echo "Traefik config already exists ✅"
  else
    cat > ${REMOTE_CLOUDGATE_DIRECTORY}/traefik/traefik.yml <<'TRAEFIK_EOF'
providers:
  docker:
    exposedByDefault: false
    watch: true
  file:
    directory: ${REMOTE_CLOUDGATE_DIRECTORY}/traefik/dynamic
    watch: true
entryPoints:
  web:
    address: ':${TRAEFIK_PORT}'
  websecure:
    address: ':${TRAEFIK_SSL_PORT}'
${REQUEST_METRICS_ENTRYPOINT_YAML}
certificatesResolvers:
  letsencrypt:
    acme:
      email: ${ACME_EMAIL}
      storage: ${ACME_STORAGE}
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
${REQUEST_METRICS_BLOCK_YAML}
TRAEFIK_EOF
    echo "Traefik config created ✅"
  fi
`;

/**
 * The `redirect-to-https` middleware, defined at last.
 *
 * Three generators — `traefik/config/domain.ts`, `traefik/config/web-server.ts`
 * and `compose/compose.utils.ts` — attach this middleware to the `web` router
 * of every HTTPS domain, and nothing anywhere defined it. Traefik drops a router
 * that names a middleware it does not know, so `http://` did not redirect: it
 * hit the catch-all and answered **404**, which looks like a broken domain
 * rather than a missing three lines of config.
 *
 * Its own file in `dynamic/`, not a block in `traefik.yml`: the file provider
 * watches that directory, so this lands on a Traefik that is already running,
 * and — because the guard is its own — a re-run repairs a host whose
 * `traefik.yml` predates this change and is therefore skipped.
 */
const createTraefikMiddlewares = () => `
  if [ -f "${REMOTE_CLOUDGATE_DIRECTORY}/traefik/dynamic/middlewares.yml" ]; then
    echo "Traefik middlewares already exist ✅"
  else
    mkdir -p ${REMOTE_CLOUDGATE_DIRECTORY}/traefik/dynamic
    cat > ${REMOTE_CLOUDGATE_DIRECTORY}/traefik/dynamic/middlewares.yml <<'MIDDLEWARES_EOF'
http:
  middlewares:
    redirect-to-https:
      redirectScheme:
        scheme: https
        permanent: true
MIDDLEWARES_EOF
    echo "Traefik middlewares created ✅"
  fi
`;

/** The whole provisioning script, in order. */
export const serverSetupCommand = () => `
set -e;
DOCKER_VERSION=${DOCKER_VERSION}
OS_TYPE=$(grep -w "ID" /etc/os-release | cut -d "=" -f 2 | tr -d '"')
command_exists() {
  command -v "$@" > /dev/null 2>&1
}
CURRENT_USER=$(id -un)
ADVERTISE_ADDR=$(hostname -I 2>/dev/null | awk '{print $1}')

# Auto-detect sudo requirement
if [ "$(id -u)" -eq 0 ]; then
  SUDO_CMD=""
  echo "Running as root"
elif sudo -n true 2>/dev/null; then
  SUDO_CMD="sudo"
  echo "Running as $CURRENT_USER with sudo privileges"
else
  echo "Error: Non-root user requires passwordless sudo access. ❌"
  exit 1
fi

echo -e "1. Installing required packages"
${installUtilities()}

echo -e "2. Installing Docker"
${installDocker()}

echo -e "3. Setting up Docker Swarm"
${setupSwarm()}

echo -e "4. Setting up Network"
${setupNetwork()}

echo -e "5. Setting up Directories"
${setupMainDirectory()}

echo -e "6. Setting up Traefik"
${createTraefikConfig()}
${createTraefikMiddlewares()}
${setupTraefikInstance()}

echo -e "7. Setting up the AI model network"
${joinAiNetworkProgram('$SUDO_CMD docker')}
`;
