import { CLOUDGATE_NETWORK } from '../servers/server-audit';

/**
 * The one shell round trip behind `GET /settings/runtime-info`: what a host is
 * running *right now*, as one JSON document on stdout.
 *
 * **Deliberately not a widening of `serverAuditCommand`.** That script answers
 * "can this host be set up", runs once at setup time, and its
 * `ServerAuditResult` has consumers — the setup gateway and the console's
 * readiness panel — that do not want a Traefik image tag or a disk figure.
 * This is the other question, "what is this host running", asked repeatedly
 * against a host that is already provisioned, so it gets its own script rather
 * than extra keys on a shape somebody else owns. The two overlap on Docker's
 * version and on `cloudgate-network`, and that overlap is cheaper than coupling
 * a setup-time contract to an incident-time one.
 *
 * Three properties the shape depends on, all of them load-bearing:
 *
 * - **Nothing here may fail the round trip.** There is no `set -e` and no
 *   `exit`: a missing binary, a stopped daemon or an unreadable `/proc` leaves
 *   that one variable empty and every other probe still answers. `execAsync`
 *   and `execAsyncRemote` both raise on a non-zero exit, so a script that
 *   propagated a failure would turn one absent binary into a 500 for the whole
 *   inventory — which is the failure mode this endpoint exists to avoid.
 * - **Every value is a string, and empty means unavailable.** Numbers and
 *   booleans are read on the TypeScript side rather than emitted as JSON
 *   literals, because an unset shell variable interpolated where a literal is
 *   expected (`"network": ,`) is a parse error that takes the whole document
 *   down. Empty-string-means-null keeps the document valid whatever the host
 *   does, and puts the interpretation somewhere a unit test can reach it.
 * - **Values are stripped, not escaped.** `sanitize` deletes newlines, double
 *   quotes and backslashes rather than escaping them. Every field here is a
 *   version, an image reference, a kernel release, an OS pretty name or a
 *   number; a quote or a backslash in one of those means the host answered
 *   something this script has no reading for, and dropping the character is
 *   better than hand-rolling JSON string escaping in POSIX sh.
 */

/** The raw document `runtimeProbeCommand` prints. Empty string = unavailable. */
export interface RuntimeProbeRaw {
  /** `docker version --format '{{.Server.Version}}'` — the daemon's version. */
  docker: string;
  /** `docker info --format '{{.Swarm.LocalNodeState}}'`. */
  swarm: string;
  /** `docker inspect cloudgate-traefik --format '{{.Config.Image}}'`. */
  traefik: string;
  /** `PRETTY_NAME` out of `/etc/os-release`. */
  os: string;
  /** `uname -sr`. */
  kernel: string;
  /** The host's uptime in whole seconds, from `/proc/uptime`. */
  uptimeSeconds: string;
  /** `"true"` / `"false"`: whether `cloudgate-network` exists. */
  network: string;
  /** Free space on the platform directory, in 1 KiB blocks (`df -Pk`). */
  diskFreeKib: string;
  /** Total space on the platform directory, in 1 KiB blocks (`df -Pk`). */
  diskTotalKib: string;
}

/** The keys of {@link RuntimeProbeRaw}, in the order the script prints them. */
export const RUNTIME_PROBE_KEYS: ReadonlyArray<keyof RuntimeProbeRaw> = [
  'docker',
  'swarm',
  'traefik',
  'os',
  'kernel',
  'uptimeSeconds',
  'network',
  'diskFreeKib',
  'diskTotalKib',
];

/**
 * POSIX single-quoting for the one interpolated value, the directory path.
 *
 * `RemoteExecService` has the same helper and does not export it; this is four
 * lines rather than a widened export because the two protect different things —
 * that one wraps caller-supplied secrets, this one wraps a path out of
 * `CLOUDGATE_DIRECTORY`. `isValidCloudgateDirectory` already rejects a relative
 * path and a `..` segment but says nothing about a quote or a space, and a
 * directory named with either would otherwise re-split into two `df` arguments.
 */
const quote = (value: string): string => `'${value.split("'").join(`'\\''`)}'`;

/**
 * The probe script for one host. `directory` is the platform directory to
 * measure — this instance's own `localCloudgateDirectory()` for the platform
 * host, `REMOTE_CLOUDGATE_DIRECTORY` for a Server, because the probe runs over
 * SSH on that host and the two roots deliberately differ.
 */
export const runtimeProbeCommand = (directory: string): string => `
have() { command -v "$1" >/dev/null 2>&1; }
sanitize() { printf '%s' "$1" | tr -d '\\n"\\\\'; }

DOCKER_SERVER_VERSION=""
SWARM_STATE=""
TRAEFIK_IMAGE=""
NETWORK_PRESENT=""
if have docker; then
  DOCKER_SERVER_VERSION=$(docker version --format '{{.Server.Version}}' 2>/dev/null)
  SWARM_STATE=$(docker info --format '{{.Swarm.LocalNodeState}}' 2>/dev/null)
  TRAEFIK_IMAGE=$(docker inspect cloudgate-traefik --format '{{.Config.Image}}' 2>/dev/null)
  # Gated on the daemon having answered at all: with Docker stopped,
  # "network inspect" also fails, and reporting that as "the network is absent"
  # would send an operator hunting a network that is there.
  if [ -n "$SWARM_STATE" ]; then
    if docker network inspect ${CLOUDGATE_NETWORK} >/dev/null 2>&1; then
      NETWORK_PRESENT=true
    else
      NETWORK_PRESENT=false
    fi
  fi
fi

KERNEL=$(uname -sr 2>/dev/null)

# grep-and-cut rather than sourcing /etc/os-release: the file is designed to be
# sourced, but the setup script already reads ID out of it this way and a probe
# has no reason to execute anything the host wrote there.
OS_NAME=""
if [ -r /etc/os-release ]; then
  OS_NAME=$(grep -m1 '^PRETTY_NAME=' /etc/os-release 2>/dev/null | cut -d= -f2- | tr -d '"')
fi

UPTIME_SECONDS=""
if [ -r /proc/uptime ]; then
  UPTIME_SECONDS=$(cut -d' ' -f1 /proc/uptime | cut -d. -f1)
fi

DISK_TOTAL_KIB=""
DISK_FREE_KIB=""
if [ -d ${quote(directory)} ]; then
  # -P for POSIX output (one line per filesystem, never wrapped) and -k for
  # 1 KiB blocks, so the two figures do not depend on the host's BLOCKSIZE.
  DF_LINE=$(df -Pk ${quote(directory)} 2>/dev/null | awk 'NR==2 {print $2" "$4}')
  DISK_TOTAL_KIB=$(printf '%s' "$DF_LINE" | awk '{print $1}')
  DISK_FREE_KIB=$(printf '%s' "$DF_LINE" | awk '{print $2}')
fi

printf '{"docker":"%s","swarm":"%s","traefik":"%s","os":"%s","kernel":"%s","uptimeSeconds":"%s","network":"%s","diskFreeKib":"%s","diskTotalKib":"%s"}\\n' \\
  "$(sanitize "$DOCKER_SERVER_VERSION")" \\
  "$(sanitize "$SWARM_STATE")" \\
  "$(sanitize "$TRAEFIK_IMAGE")" \\
  "$(sanitize "$OS_NAME")" \\
  "$(sanitize "$KERNEL")" \\
  "$(sanitize "$UPTIME_SECONDS")" \\
  "$(sanitize "$NETWORK_PRESENT")" \\
  "$(sanitize "$DISK_FREE_KIB")" \\
  "$(sanitize "$DISK_TOTAL_KIB")"
`;
