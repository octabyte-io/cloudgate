import { useCallback, useState } from "react";

import { useSocketStream } from "./use-socket-stream";
import type { PageLogStream, SocketStream } from "./use-socket-stream";

/**
 * One wrapper per gateway, each naming the parameters that gateway actually
 * reads off the URL.
 *
 * **`backend/src/realtime/gateways/` holds six**, and five of them are here: the
 * three below plus the two interactive ones, which live in `terminals.ts` and are
 * re-exported so this stays one import point for them.
 *
 * The sixth is `/listen-server-setup`
 * dialled by
 * `useServerSetupRun` in `features/server/use-server.ts` rather than wrapped here.
 * It is the one gateway that *starts* what it streams — the same socket both runs
 * the provisioning script and reports it — so it belongs with the hook that owns
 * the button, not in a list of read-only feeds. Only a dial carrying `start=true`
 * starts anything, and that hook sends it on the one dial a confirmed press makes;
 * every other dial only watches (ADR-0058). Outside those two files nothing
 * should reach for `useSocketStream` or assemble a socket URL.
 *
 * Every gateway validates its parameters on connect and closes with code 4000
 * and a reason when they are wrong; that surfaces as `status: "refused"` and
 * `closeReason`. Which is why each of these takes `enabled` — dial once you have
 * the id, not before.
 */

export {
  TERMINALS_ENDED_REASON,
  TERMINALS_LEFT_REASON,
  TerminalChannel,
  containerTerminalUrl,
  endAllTerminals,
  onTerminalsEnded,
  serverTerminalUrl,
  useContainerTerminal,
  useServerTerminal,
  useTerminalChannel,
} from "./terminals";
export type {
  ContainerShell,
  TerminalSnapshot,
  TerminalStream,
} from "./terminals";

/**
 * ADR-0012's mid-stream close, re-exported so a screen reading `closeCode` has
 * one import point for the whole realtime surface.
 */
export { LEASE_CLOSE_CODE } from "./socket-stream-store";

/** The first sentence of every card's `blocked` state. */
export { BLOCKED_SENTENCE } from "./socket-stream-store";

/**
 * The rest of the close-code contract, from the same one import point.
 *
 * A screen that reads `closeCode` needs the whole band and not just the lease's
 * code: `socket-stream-store.ts` turns *everything* from 4000 to 4999 into
 * `status: "refused"`, so one sentence used to cover a malformed parameter, a
 * denial, a failed SSH dial and a key the far end would not accept. Mirrored
 * from the gateways in `terminals.ts`, which says where each value comes from
 * and how the copy is pinned.
 */
export {
  DENIED_CLOSE_CODE,
  MALFORMED_CLOSE_CODE,
  NO_SHELL_CLOSE_CODE,
  TERMINAL_CLOSE,
  UNREACHABLE_CLOSE_CODE,
} from "./terminals";

// ---------------------------------------------------------------- deployment

/**
 * `/listen-deployment`'s *"the log was reaped, not never written"* close —
 * `socket-access.ts`'s `REAPED_LOG_CLOSE_CODE`
 * (ADR-0020).
 *
 * Mirrored here rather than in `terminals.ts` beside the rest of the band: the
 * three codes re-exported above are `socket-access.ts`'s, sent by every
 * authorized gateway, whereas this one belongs to the gateway declared
 * immediately below and to no other. Neither terminal gateway can send it, so
 * `refusalSentence` has no case for it and wants none.
 *
 * Duplicated rather than fetched, the way `LEASE_CLOSE_CODE` and
 * {@link UNREACHABLE_CLOSE_CODE} already are. Unlike those two it has no
 * mirror assertion yet: `reaped-log-close.spec.ts` pins the backend's value and
 * the sentence it carries, and the cross-package pin would belong beside
 * `server-terminal-close.spec.ts`'s — filed rather than written here, because
 * that change's scope was the copy the console shows and not `backend/test/`.
 *
 * Read by `DeploymentLog`, which needs it because the sentence it puts beside a
 * refusal is a claim about the build and this is the one close on which that
 * claim is false.
 */
export const REAPED_LOG_CLOSE_CODE = 4013;

/**
 * The Live log key of one Deployment's log, live or finished: the Dock holds
 * a Deployment's log at most once, whichever version was docked first.
 */
export function deploymentLogKey(deploymentId: string): string {
  return `deployment:${deploymentId}`;
}

/**
 * A build log as it is written. `tail -n +1 -f` replays everything already in
 * the file before following, so a Deployment opened late still shows the whole
 * build.
 *
 * **The socket is addressed by `deploymentId` alone.** It used to take the
 * Deployment's `logPath` and the build `serverId`, and the gateway streamed
 * whatever path it was handed — which made every file under the platform
 * directory readable by any signed-in user
 * The backend now
 * resolves both from the row, so neither is ours to send: passing a path would
 * be ignored, and the Server the build ran on is a fact about the Deployment
 * rather than something the screen has to know.
 *
 * A Deployment the caller may not read closes with 4003 and a reason that says
 * nothing about whether it exists, surfacing as `status: "refused"`. One whose
 * log retention has already reaped closes {@link REAPED_LOG_CLOSE_CODE} rather
 * than following a file that is not there — the same refusal surface,
 * and the reason carries ADR-0020's own sentence.
 */
export function useDeploymentLog(options: {
  deploymentId: string | null | undefined;
  enabled?: boolean;
}): PageLogStream {
  const { deploymentId, enabled = true } = options;
  return useSocketStream({
    path: "/listen-deployment",
    params: { deploymentId },
    logKey: deploymentLogKey(deploymentId ?? ""),
    // Docked, a redial keeps the lines held and skips the replay's first ones.
    resume: "replay",
    enabled: enabled && Boolean(deploymentId),
  });
}

// ------------------------------------------------------------ container logs

/** `all`, or a duration the gateway accepts: `30s`, `10m`, `1h`, `2d`. */
export type LogsSince =
  | "all"
  | `${number}s`
  | `${number}m`
  | `${number}h`
  | `${number}d`;

/** `swarm` reads a Swarm service's logs instead of one container's. */
export type LogsRunType = "swarm" | "native";

/**
 * `/docker-container-logs`'s *"the output ended"* close — `container-logs.gateway.ts`'s
 * `CONTAINER_LOGS_CLOSE.outputEnded`
 * pinned from
 * `container-logs-close.spec.ts`.
 *
 * The follower exited — a container that stopped, restarted or was removed, since
 * `docker logs --follow` ends with its container — or the Swarm service it
 * followed is no longer listed. It is in the refusal band so the store does not
 * redial on its own, and it is **not** a refusal: nothing was refused, the stream
 * ran and finished. So the log views word it as an ending, with the gateway's
 * sentence, rather than as "the gateway closed the connection".
 */
export const OUTPUT_ENDED_CLOSE_CODE = 4014;

/**
 * What a container-logs view says in place of "Following …" once the output has
 * ended, or `null` while it has not. The gateway's own sentence says which of the
 * causes it can know; the second half is the one action that brings the output
 * back.
 */
export function outputEndedSentence(
  stream: Pick<SocketStream, "status" | "closeCode" | "closeReason">,
): string | null {
  if (
    stream.status !== "refused" ||
    stream.closeCode !== OUTPUT_ENDED_CLOSE_CODE
  ) {
    return null;
  }
  const said = stream.closeReason ?? "The output ended";
  return `${said}. Reconnect to follow it again.`;
}

export function useContainerLogs(options: {
  containerId: string | null | undefined;
  serverId?: string | null;
  /**
   * A stack on its own Stack VM (ADR-0070): the gateway reaches it by the
   * stack, never by a Server, so `serverId` is left out beside it.
   */
  composeId?: string | null;
  /** Lines of history to open with. 0–10000. */
  tail?: number;
  /** Only alphanumerics, space, `.`, `_` and `-` — the gateway rejects the rest. */
  search?: string;
  since?: LogsSince;
  runType?: LogsRunType;
  /**
   * With `runType: "swarm"`, keep Docker's task prefix so each line names its
   * copy (`<stamp> web.1@node-1    | …`) — an Application's Logs tab (#1341). Left
   * out, the lines come stripped, as the database and Compose views read them.
   */
  taskPrefix?: boolean;
  enabled?: boolean;
}): PageLogStream {
  const {
    containerId,
    serverId,
    composeId,
    tail = 100,
    search,
    since = "all",
    runType,
    taskPrefix,
    enabled = true,
  } = options;

  return useSocketStream({
    path: "/docker-container-logs",
    params: {
      containerId,
      serverId: composeId ? undefined : serverId,
      composeId: composeId ?? undefined,
      tail,
      search,
      since,
      runType,
      // Sent only when asked: the gateway refuses it off a Swarm service.
      taskPrefix: taskPrefix ? true : undefined,
    },
    // The container, not how much of it was asked for: a new `tail` or
    // `search` dials the same log again rather than making another.
    logKey: `container:${composeId ? `stack-vm:${composeId}` : (serverId ?? "local")}:${containerId ?? ""}`,
    // Docked, a redial asks for output since the last line held, not the
    // page's `tail`, and skips the held lines it gets back.
    resume: "since",
    enabled: enabled && Boolean(containerId),
  });
}

// -------------------------------------------------------------- docker stats

/** One entry of a stat series: the value, and when it was sampled. */
export interface StatSample<T> {
  value: T;
  time: string;
}

/**
 * One tick's reading of each stat, as the gateway pushes it every 1300ms. The
 * backend keeps nothing between ticks, so every frame is the sample it
 * just took.
 *
 * `disk` is only ever populated when monitoring the platform host itself; a
 * container has no disk reading, and is the only `null` the gateway sends.
 */
export interface DockerStatsSample {
  /** A percentage as `docker stats` prints it, e.g. `"0.15%"`. */
  cpu: StatSample<string> | null;
  memory: StatSample<{ used: string; total: string }> | null;
  disk: StatSample<{
    diskTotal: number;
    diskUsedPercentage: number;
    diskUsage: number;
    diskFree: number;
  }> | null;
  network: StatSample<{ inputMb: string; outputMb: string }> | null;
  block: StatSample<{ readMb: string; writeMb: string }> | null;
}

/** `application` and `stack` are Swarm labels; `docker-compose` matches by name. */
export type StatsAppType = "application" | "stack" | "docker-compose";

export interface DockerStatsStream extends SocketStream {
  /** The last sample pushed, or `null` before the first one arrives. */
  sample: DockerStatsSample | null;
}

/**
 * Live CPU, memory and IO for one service. The gateway samples the service's
 * first running container; pass `appName: "cloudgate"` to sample the host.
 *
 * Local host only — the gateway takes no `serverId`, so a service on a remote
 * Server has no live stats. That is the backend's shape, not an omission here.
 */
export function useDockerStats(options: {
  appName: string | null | undefined;
  appType?: StatsAppType;
  enabled?: boolean;
}): DockerStatsStream {
  const { appName, appType = "application", enabled = true } = options;
  const [sample, setSample] = useState<DockerStatsSample | null>(null);

  // Frames are JSON, one sample each — not lines. Parse and keep the latest.
  const onFrame = useCallback((frame: string) => {
    try {
      const parsed = JSON.parse(frame) as { data?: DockerStatsSample };
      if (parsed.data) setSample(parsed.data);
    } catch {
      // A frame that is not the sample envelope tells us nothing to show.
    }
  }, []);

  const stream = useSocketStream({
    path: "/listen-docker-stats-monitoring",
    params: { appName, appType },
    enabled: enabled && Boolean(appName),
    onFrame,
  });

  return { ...stream, sample };
}
