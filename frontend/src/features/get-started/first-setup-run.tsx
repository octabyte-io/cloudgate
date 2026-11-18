import { useEffect } from "react";

import { firstSetupRunKey, useServerSetupRun } from "../server/use-server";
import { SetupProgressView } from "./setup-progress-view";
import { WAIT_POLL_MS } from "./use-get-started";

/**
 * The Bought Server's first Setup run, which the backend started by itself
 * once the machine answered (the amendment to ADR-0058), followed here step
 * by step: watched, never started, exactly as the Server's own Setup card
 * watches it (`firstSetupRunKey`). A watch that lands before the run has
 * begun, or between its end and the stage moving on, ends without output;
 * it is asked again while the stage is still Setting up.
 */
export function FirstSetupRun({
  serverId,
  name,
}: {
  serverId: string;
  name: string;
}) {
  const run = useServerSetupRun(serverId, name);
  const { state, watch } = run;
  useEffect(() => {
    if (state === "idle") {
      watch(firstSetupRunKey(serverId));
      return;
    }
    // A run that said how it ended is left on screen until the stage moves
    // on; only a watch that found nothing (or lost the socket) asks again.
    if (state !== "ended" && state !== "interrupted") return;
    const again = window.setTimeout(
      () => watch(firstSetupRunKey(serverId)),
      WAIT_POLL_MS,
    );
    return () => window.clearTimeout(again);
  }, [state, watch, serverId]);

  return (
    <SetupProgressView
      lines={run.lines}
      dropped={run.dropped}
      // Until the stage moves on the run is as good as going: a gap between
      // watches is not a stop.
      live={
        state === "running" ||
        ((state === "idle" || state === "ended" || state === "interrupted") &&
          run.lines.length === 0)
      }
      finished={state === "finished"}
      label={`Setting up ${name}`}
    />
  );
}
