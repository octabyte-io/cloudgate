import { toLogLines } from "@/components/console/log-well";
import { stripTerminalEscapes } from "@/components/console/terminal-escapes";
import { useDeploymentLog } from "@/lib/realtime/gateways";
import { cn } from "@/lib/utils";

import { FirstSetupRun } from "./first-setup-run";
import { OutputFold } from "./setup-progress-view";
import { useWizardServers } from "./use-get-started";
import type { LaunchPart, LaunchPartState, LaunchPhase } from "./wizard-model";

/**
 * What the launch's stage in progress is doing, under its name in the
 * launch's list: the Server's own setup while Cloudgate waits for it, then
 * each part of the app and the newest line of the deploy that runs now.
 *
 * Rejected: the stage's name and a turning mark alone. "Preparing Ghost"
 * for five minutes said neither what it waited for nor that anything moved.
 */
export function LaunchDetail({
  phase,
  parts,
  serverId,
}: {
  phase: LaunchPhase;
  parts: LaunchPart[];
  /** The Server the app goes on, from the wizard's address; null on an old link. */
  serverId: string | null;
}) {
  if (phase.phase === "preparing") {
    return <Preparing waitingFor={phase.waitingFor} serverId={serverId} />;
  }
  if (phase.phase === "starting" && parts.length > 0) {
    return <Starting parts={parts} />;
  }
  return null;
}

/**
 * Before the Apply: what Cloudgate waits for, in the backend's words, and
 * while that is a Bought Server's first setup, that setup step by step.
 */
function Preparing({
  waitingFor,
  serverId,
}: {
  waitingFor?: string;
  serverId: string | null;
}) {
  // Followed until it is Ready, as step two follows it.
  const servers = useWizardServers(serverId ?? undefined);
  const server = servers.data?.find((row) => row.serverId === serverId);
  const settingUp = server?.boughtServer?.stage === "setting_up";
  return (
    <div className="grid gap-2.5">
      <p role="status" className="text-ui text-tx-2">
        {waitingFor ??
          "Cloudgate is getting the setup ready. It starts in a moment."}
      </p>
      {settingUp && server ? (
        <div className="grid gap-2 rounded-md border border-line bg-panel-2 p-3">
          <FirstSetupRun serverId={server.serverId} name={server.name} />
        </div>
      ) : null}
    </div>
  );
}

const PART_WORD: Record<LaunchPartState, string> = {
  waiting: "Waiting its turn",
  starting: "Downloading and starting",
  started: "Started",
  failed: "Didn't start",
};

const PART_TONE: Record<LaunchPartState, string> = {
  waiting: "bg-tx-4",
  starting: "bg-warn motion-safe:animate-pulse",
  started: "bg-ok",
  failed: "bg-bad",
};

/** Each part of the app and how it is getting on, then the deploy running now. */
function Starting({ parts }: { parts: LaunchPart[] }) {
  const running = parts.find((part) => part.deploymentId !== null);
  return (
    <div className="grid gap-2.5">
      <ul aria-label="Parts of the app" className="grid gap-1.5">
        {parts.map((part) => (
          <li
            key={part.name}
            className="flex min-w-0 items-center gap-2 text-ui"
          >
            <span
              aria-hidden="true"
              className={cn(
                "size-2 flex-none rounded-pill",
                PART_TONE[part.state],
              )}
            />
            <span className="min-w-0 truncate font-mono text-tx">
              {part.name}
            </span>
            <span className="ml-auto flex-none text-meta text-tx-2">
              {PART_WORD[part.state]}
            </span>
          </li>
        ))}
      </ul>
      {running?.deploymentId ? (
        <DeployOutput deploymentId={running.deploymentId} />
      ) : null}
    </div>
  );
}

/**
 * The running deploy's newest line, so a download that takes a minute
 * visibly moves, and its whole log folded under it.
 */
function DeployOutput({ deploymentId }: { deploymentId: string }) {
  const stream = useDeploymentLog({ deploymentId });
  const latest = newestLine(stream.lines);
  return (
    <div className="grid gap-2">
      {latest ? (
        <p
          key={latest}
          title={latest}
          className="animate-fade truncate font-mono text-meta text-tx-3"
        >
          {latest}
        </p>
      ) : null}
      {stream.lines.length > 0 ? (
        <OutputFold
          label="Deploy output"
          lines={toLogLines(stream.lines)}
          live
          dropped={stream.dropped}
        />
      ) : null}
    </div>
  );
}

/** The last line with something on it, without its terminal codes. */
function newestLine(lines: readonly string[]): string | null {
  for (let at = lines.length - 1; at >= 0; at -= 1) {
    const text = stripTerminalEscapes(lines[at]).trim();
    if (text !== "") return text;
  }
  return null;
}
