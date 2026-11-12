import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import { isNull } from 'drizzle-orm';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { execByServer } from '../docker-ops/server-access';
import { containerMetric, serverMetric } from '../monitoring/monitoring.schema';
import { ExecError } from '../remote/exec-error';
import { RemoteExecService } from '../remote/remote-exec.service';

/** How long a prune waits for the Docker CLI to go quiet before it gives up. */
export const DOCKER_IDLE_DEADLINE_SECONDS = 600;

/**
 * The exit status of a prune that gave up waiting: `EX_TEMPFAIL`, "try again
 * later", which is exactly what the next night does.
 */
export const DOCKER_BUSY_EXIT_CODE = 75;

/** The stderr line a prune that gave up writes, naming what held it. */
const DOCKER_BUSY_MARKER = 'CLOUDGATE_DOCKER_BUSY:';

/**
 * The docker CLI processes a prune waits behind, one label per kind, joined
 * with ", " — empty when there are none.
 *
 * **Only the `docker` CLI itself counts**, by its program name, not by
 * "`docker ` appears somewhere on the line". The old `grep -E "^.*docker
 * [A-Za-z]"` also matched this script's own `sh -c` (which carries the prune
 * it is about to run) and was only saved from waiting on itself by the
 * `grep -v grep` that happened to drop the same line.
 *
 * **A read-only follower does not count**: `logs`, `stats`, `events`
 * and their `container`/`service`/`system`/`compose` forms, followed or not.
 * They take nothing a prune removes, and a follower lives as long as whoever
 * opened it — a log view, or one leaked from a log view, which held the
 * nightly prune for thirteen hours and would have held it for ever. What is
 * left — a build, a pull, a push, an `exec`, another prune — is what the wait
 * exists for.
 *
 * **The label is the subcommand, never the arguments**: `docker login`,
 * `docker image push`. It goes into the backend's log and a 409, and a docker
 * command line can carry a password (`login -p`, `run -e`). A management
 * command (`image`, `container`, …) gets its verb as well, so it reads as what
 * it does.
 *
 * Global flags before the subcommand are skipped, with the value of the ones
 * that take one (`-H unix:///…`, `--context prod`); `docker compose`'s own
 * value flags likewise before its verb. POSIX awk only: the script runs under
 * `/bin/sh`, which is dash on Ubuntu, and mawk is what Ubuntu ships.
 */
const BUSY_DOCKER_PROCESSES = `ps -eo args= | awk '
function skip(from, valued,    k) {
    k = from
    while (k <= NF && substr($k, 1, 1) == "-") {
        if ($k ~ valued) k++
        k++
    }
    return k
}
{
    n = split($1, path, "/")
    if (path[n] != "docker") next
    i = skip(2, "^(-H|--host|-c|--context|--config|-l|--log-level|--tlscacert|--tlscert|--tlskey)$")
    cmd = $i
    verb = $(i + 1)
    if (cmd == "compose") verb = $(skip(i + 1, "^(-f|--file|-p|--project-name|--project-directory|--env-file|--profile|--ansi|--progress|--parallel)$"))
    if (cmd == "logs" || cmd == "stats" || cmd == "events") next
    if ((cmd == "container" || cmd == "compose") && (verb == "logs" || verb == "stats" || verb == "events")) next
    if (cmd == "service" && verb == "logs") next
    if (cmd == "system" && verb == "events") next
    label = "docker " cmd
    if (cmd ~ /^(builder|buildx|compose|config|container|context|image|manifest|network|node|plugin|secret|service|stack|swarm|system|trust|volume)$/ && verb !~ /^-/ && verb != "") label = label " " verb
    seen[label] = 1
}
END {
    for (label in seen) { out = out sep label; sep = ", " }
    if (out != "") print out
}'`;

/**
 * Wrap a command so it runs once no other docker CLI command that could be
 * changing what it prunes is running — or, after
 * {@link DOCKER_IDLE_DEADLINE_SECONDS}, does not run at all.
 *
 * **Skip rather than run at the deadline.** The wait is there so a prune does
 * not pull an image or build cache out from under a build or pull still using
 * it; running anyway would trade a disk that is fuller for a day for a deploy
 * that fails, and the nightly job simply tries again tomorrow. The script
 * exits {@link DOCKER_BUSY_EXIT_CODE} and names what held it on stderr, which
 * `CleanupService` turns into a log line (and a 409 for a manual prune).
 *
 * `$((…))` and `[ … -ge … ]` are POSIX; nothing here needs bash.
 */
export const dockerSafeExec = (exec: string) => `
CHECK_INTERVAL=10
DEADLINE=${DOCKER_IDLE_DEADLINE_SECONDS}
WAITED=0

echo "Preparing for execution..."

while true; do
    PROCESSES=$(${BUSY_DOCKER_PROCESSES})

    if [ -z "$PROCESSES" ]; then
        echo "Docker is idle. Starting execution..."
        break
    fi
    if [ "$WAITED" -ge "$DEADLINE" ]; then
        echo "Docker is still busy after $DEADLINE seconds. Skipping execution."
        echo "${DOCKER_BUSY_MARKER} $PROCESSES" >&2
        exit ${DOCKER_BUSY_EXIT_CODE}
    fi
    echo "Docker is busy. Will check again in $CHECK_INTERVAL seconds..."
    sleep $CHECK_INTERVAL
    WAITED=$((WAITED + CHECK_INTERVAL))
done

${exec}

echo "Execution completed."
`;

/**
 * The sentence for a prune that gave up waiting, or null when `error` is any
 * other failure.
 */
const dockerBusyReason = (error: unknown): string | null => {
  if (!(error instanceof ExecError)) return null;
  if (error.exitCode !== DOCKER_BUSY_EXIT_CODE) return null;
  const line = (error.stderr ?? '')
    .split('\n')
    .find((l) => l.startsWith(DOCKER_BUSY_MARKER));
  if (line === undefined) return null;
  const held = line.slice(DOCKER_BUSY_MARKER.length).trim();
  return `Docker stayed busy for ${DOCKER_IDLE_DEADLINE_SECONDS / 60} minutes, so the prune did not run: ${held}`;
};

const describeTarget = (serverId?: string | null) =>
  serverId ? `Server ${serverId}` : 'the platform host';

/** What a {@link CleanupService.cleanupAll} run did. */
export interface DockerCleanupOutcome {
  /**
   * Why the run stopped without pruning, when Docker stayed busy past the
   * deadline; null when every prune was attempted.
   */
  skipped: string | null;
}

const cleanupCommands = {
  containers: 'docker container prune --force',
  images: 'docker image prune --all --force',
  volumes: 'docker volume prune --all --force',
  builders: 'docker builder prune --all --force',
  system: 'docker system prune --all --force',
};

/**
 * Volume cleanup is only ever run manually: an automatic prune could drop a
 * volume whose container merely happens to be stopped.
 */
const excludedCleanupAllCommands: (keyof typeof cleanupCommands)[] = [
  'volumes',
];

export interface DockerDiskUsageItem {
  type: string;
  totalCount: number;
  active: number;
  size: string;
  reclaimable: string;
  sizeBytes: number;
}

const parseSizeToBytes = (size: string): number => {
  const match = size.match(/^([\d.]+)\s*([KMGT]?B)$/i);
  if (!match) return 0;
  const value = Number.parseFloat(match[1]);
  const unit = match[2].toUpperCase();
  const multipliers: Record<string, number> = {
    B: 1,
    KB: 1024,
    MB: 1024 ** 2,
    GB: 1024 ** 3,
    TB: 1024 ** 4,
  };
  return value * (multipliers[unit] || 0);
};

/** Docker prunes on the platform host or a Server, through the docker CLI. */
@Injectable()
export class CleanupService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly remoteExec: RemoteExecService,
  ) {}

  private readonly logger = new Logger(CleanupService.name);

  /**
   * One manual prune. A prune that gave up waiting for Docker is a 409 naming
   * what held it — Docker was busy, the request itself was fine — and a warn
   * line in the backend's log, since the pty it wrote to is nobody's.
   */
  private async run(command: string, serverId?: string | null): Promise<void> {
    try {
      await execByServer(this.remoteExec, serverId, dockerSafeExec(command));
    } catch (error) {
      const busy = dockerBusyReason(error);
      if (busy) {
        this.logger.warn(
          `\`${command}\` on ${describeTarget(serverId)} skipped: ${busy}`,
        );
        throw new ConflictException(busy);
      }
      this.logger.error(
        `\`${command}\` on ${describeTarget(serverId)} failed: ${String(error)}`,
      );
      throw error;
    }
  }

  cleanupContainers(serverId?: string | null): Promise<void> {
    return this.run(cleanupCommands.containers, serverId);
  }

  cleanupImages(serverId?: string | null): Promise<void> {
    return this.run(cleanupCommands.images, serverId);
  }

  cleanupVolumes(serverId?: string | null): Promise<void> {
    return this.run(cleanupCommands.volumes, serverId);
  }

  cleanupBuilders(serverId?: string | null): Promise<void> {
    return this.run(cleanupCommands.builders, serverId);
  }

  cleanupSystem(serverId?: string | null): Promise<void> {
    return this.run(cleanupCommands.system, serverId);
  }

  /**
   * Every prune but volumes, in turn — the nightly job's body. A failed one is
   * logged and does not stop the rest.
   *
   * **One that gave up waiting for Docker stops the run**, recorded as skipped
   * in the log and in the outcome: the next prune would wait the same ten
   * minutes behind the same build, so four of them would hold the job for
   * forty to learn nothing more.
   */
  async cleanupAll(serverId?: string | null): Promise<DockerCleanupOutcome> {
    for (const [key, command] of Object.entries(cleanupCommands) as [
      keyof typeof cleanupCommands,
      string,
    ][]) {
      if (excludedCleanupAllCommands.includes(key)) continue;
      try {
        await execByServer(this.remoteExec, serverId, dockerSafeExec(command));
      } catch (error) {
        const busy = dockerBusyReason(error);
        if (busy) {
          this.logger.warn(
            `Docker cleanup on ${describeTarget(serverId)} skipped at \`${command}\`: ${busy}`,
          );
          return { skipped: busy };
        }
        this.logger.error(
          `Docker cleanup on ${describeTarget(serverId)}: \`${command}\` failed: ${String(error)}`,
        );
      }
    }
    return { skipped: null };
  }

  /** Every prune but volumes, started at once; returns before they finish. */
  cleanupAllBackground(serverId?: string | null): {
    status: string;
    message: string;
  } {
    const commands = (
      Object.entries(cleanupCommands) as [
        keyof typeof cleanupCommands,
        string,
      ][]
    )
      .filter(([key]) => !excludedCleanupAllCommands.includes(key))
      .map(([, command]) => command);
    const target = describeTarget(serverId);

    Promise.allSettled(
      commands.map((command) =>
        execByServer(this.remoteExec, serverId, dockerSafeExec(command)),
      ),
    )
      .then((results) => {
        results.forEach((result, i) => {
          if (result.status === 'fulfilled') return;
          const busy = dockerBusyReason(result.reason);
          if (busy) {
            this.logger.warn(
              `Docker cleanup on ${target}: \`${commands[i]}\` skipped: ${busy}`,
            );
          } else {
            this.logger.error(
              `Docker cleanup on ${target}: \`${commands[i]}\` failed: ${String(result.reason)}`,
            );
          }
        });
        if (results.every((r) => r.status === 'fulfilled')) {
          this.logger.log(`Docker cleanup on ${target} completed`);
        }
      })
      .catch((error) =>
        this.logger.error(`Docker cleanup on ${target}: ${String(error)}`),
      );

    return {
      status: 'scheduled',
      message: 'Docker cleanup has been initiated in the background',
    };
  }

  /** `docker system df` on the platform host only. */
  async getDockerDiskUsage(): Promise<DockerDiskUsageItem[]> {
    const command = "docker system df --format '{{json .}}'";
    const { stdout } = await this.remoteExec.execAsync(command);

    const lines = stdout.trim().split('\n').filter(Boolean);
    return lines.map((line) => {
      const data = JSON.parse(line) as {
        Type: string;
        TotalCount: string;
        Active: string;
        Size: string;
        Reclaimable: string;
      };
      return {
        type: data.Type,
        totalCount: Number.parseInt(data.TotalCount, 10) || 0,
        active: Number.parseInt(data.Active, 10) || 0,
        size: data.Size,
        reclaimable: data.Reclaimable,
        sizeBytes: parseSizeToBytes(data.Size),
      };
    });
  }

  /**
   * Delete what this host has collected: its stored samples.
   *
   * **The rows are the history**: the platform host's `server_metric`
   * and `container_metric` rows, stored under `serverId` null. This used
   * to empty the monitoring directory too, which was the live stream's scratch
   * series; the stream now writes nothing, and the boot purge in
   * `realtime/legacy-stats-series.ts` removes what earlier versions left.
   *
   * **A Server's rows are not this control's.** They belong to the Server's
   * Organization and to a machine this route does not name, and they already
   * have an eraser: the Server's retention cleanup, which keeps running after
   * its collection is stopped.
   */
  async cleanMonitoring(): Promise<void> {
    await this.db
      .delete(containerMetric)
      .where(isNull(containerMetric.serverId));
    await this.db.delete(serverMetric).where(isNull(serverMetric.serverId));
  }
}
