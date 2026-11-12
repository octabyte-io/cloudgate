import { useEffect, useState } from "react";

import { Card } from "@/components/console/card";
import { Dot } from "@/components/console/dot";
import { DockedLogNote } from "@/components/console/log-dock";
import { useDock } from "@/components/shell/dock-context";
import { Button } from "@/components/ui/button";
import {
  lastSetup,
  type Server,
  type StoredOutcome,
} from "@/lib/api/endpoints/servers";
import { timeAgo, timeExact } from "@/lib/format/time";
import { Icon } from "@/lib/design/icons";
import { useLiveLog } from "@/lib/realtime/use-socket-stream";

import {
  firstSetupRunKey,
  isSetupLogOf,
  useServerSetupRun,
  type SetupRunState,
} from "../use-server";
import { SetupConfirmModal } from "./setup-confirm-modal";
import { RunPanel } from "./setup-run-panel";
import { STEPS } from "./setup-steps";

/**
 * Run the provisioning script, having said what it will do — and then show it doing it.
 *
 * This is the one control in the console that **installs software on somebody else's
 * computer**: it pipes `get.docker.com` into `sh`, joins the host to a Swarm, and
 * starts a container that publishes ports 80 and 443. So the card has two halves,
 * and both are load-bearing.
 *
 * **Before.** The numbered list is `serverSetupCommand()` read in order rather than
 * a summary of it (`setup-steps.ts`), and it stays on the card during a run because
 * the script echoes the same six numbers as it goes.
 *
 * **During and after.** The run has a socket, `/listen-server-setup`, so
 * the output is on the screen while it happens (`setup-run-panel.tsx`). What that
 * replaces is worth naming, because it was the honest workaround and it is now the
 * wrong answer:
 *
 * - The card used to treat a failed request as *"Cloudgate stopped waiting — the run
 *   may still be going"*, because with a response held open for minutes that was
 *   the normal case and nothing could tell it from a real failure. **The run now
 *   says how it ended**, in its own last line, so `failed` and `finished` are
 *   different states with different copy. "We stopped watching" survives as
 *   `interrupted`, which is what it always meant and is now rare.
 * - The readiness audit used to be re-read on `onSettled` to *infer* where the run
 *   got to. It is still re-read, on an outcome — but as a second opinion from the
 *   machine, not as the answer.
 *
 * **No toast.** This is diagnostic output somebody reads twice while they change a
 * setting and press again, which is `reachability-card.tsx`'s rule for the control
 * beside it. A toast would take the outcome away after four seconds and leave the
 * log it belongs to on the screen without it.
 *
 * Two things about the route the copy still has to carry: **it is safe to run
 * twice** (every step checks before it acts — `command -v docker`, `docker info |
 * grep 'Swarm: active'`, `[ -d /etc/cloudgate ]`), and **a stored command replaces
 * the whole script**, because `setup` runs `current.command || serverSetupCommand()`.
 *
 * **A Bought Server Setting up has its first run started for it** (the amendment
 * to ADR-0058: Buy was the press). The card watches that run as it opens — a
 * watch-dial, which never starts one — and offers no press until it ends: the
 * stage then reads Ready, and a run that failed shows here like any other, with
 * *Run setup again*.
 */
export function SetupCard({ server }: { server: Server }) {
  const [confirming, setConfirming] = useState(false);
  const run = useServerSetupRun(server.serverId, server.name);
  const dock = useDock();
  // This Server's newest run in the Dock — docked from this card, or on an
  // earlier visit to it — and whether it is still going.
  const docked =
    dock?.logs.findLast((log) => isSetupLogOf(log, server.serverId)) ?? null;
  const dockedRun = useLiveLog(docked);
  const inDock = docked !== null && dockedRun.live;
  /** The stored command, or `""`. A string rather than a flag, because the dialog
   *  has to *show* it and not only know that there is one. */
  const custom = server.command.trim();
  // The first run of a Bought Server, which the backend started by itself.
  const settingUp = server.boughtServer?.stage === "setting_up";
  const { state, watch } = run;
  useEffect(() => {
    // Watched once, as the card opens: a watch that finds the run already
    // over ends, and the stage read after it says how it went.
    if (settingUp && state === "idle" && !inDock) {
      watch(firstSetupRunKey(server.serverId));
    }
  }, [settingUp, state, inDock, watch, server.serverId]);
  // A run going on in the Dock is running too: a press here would be a second
  // run of the same host, and the Dock never starts one (ADR-0058). So is a
  // Bought Server's first, until its stage moves on.
  const running = run.state === "running" || inDock || settingUp;
  // How the last run ended, stored on the row. Before it was, a failed
  // run's outcome lived in this mount alone, and a reload put "Run setup" back
  // on the button as though setup had never been tried.
  const stored = lastSetup(server);
  const label = settingUp
    ? "Setting up"
    : inDock
      ? "Running, in the Dock"
      : run.state === "idle" && stored
        ? "Run setup again"
        : ACTION[run.state];

  function startRun() {
    setConfirming(false);
    run.start();
  }

  return (
    <>
      <Card>
        <Card.Header
          title="Setup"
          sub="What Cloudgate puts on a Server before it can deploy to it."
          headingLevel={2}
          actions={
            <>
              {dock && docked && inDock ? (
                <Button
                  size="sm"
                  variant="qt"
                  onClick={() => dock.show(docked.id)}
                >
                  <Icon name="dock" size={14} />
                  Show it in the Dock
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="pri"
                onClick={() => setConfirming(true)}
                disabled={running}
                aria-busy={running || undefined}
              >
                <Icon
                  name={run.state === "idle" && !stored ? "play" : "refresh"}
                  size={14}
                />
                {label}
              </Button>
            </>
          }
        />
        <Card.Body>
          {settingUp ? (
            <p className="mb-3 text-body text-tx">
              Cloudgate is setting this Server up by itself, as it does every
              Server bought from it. Nothing can be deployed to it until setup
              finishes.
            </p>
          ) : null}
          {custom ? (
            <p className="mb-3 rounded-lg border border-warn-line bg-warn-tint p-2.5 text-meta text-tx">
              This Server has its own setup command, so none of the steps below
              will run — Cloudgate executes that command instead, exactly as
              written. It is on the Settings tab.
            </p>
          ) : null}

          {run.state === "idle" && docked && inDock ? (
            /* A run docked on an earlier visit: this card holds no box of it,
               so the note stands in, and Read it here too only watches. */
            <div className="mb-3">
              <DockedLogNote
                log={docked}
                stream={dockedRun}
                onReadHere={() => run.watch(docked.key)}
              />
            </div>
          ) : run.state === "idle" && stored ? (
            <StoredSetupOutcome outcome={stored} />
          ) : null}

          {run.state === "idle" ? null : (
            <>
              <RunPanel run={run} server={server} />
              {/* Only true of the default script: a stored command is not the six
                  steps and does not number anything. */}
              <h3 className="mt-4 mb-1 text-meta text-tx-3">
                {custom
                  ? "What the default script would have done, for reference."
                  : "The six steps, numbered the way the script numbers them in the output above."}
              </h3>
            </>
          )}

          <ol className="flex flex-col">
            {STEPS.map((step, index) => (
              <li
                key={step.title}
                className="flex gap-2.5 border-b border-line py-3 last:border-b-0"
              >
                <span className="num mt-0.25 flex-none font-mono text-chip text-tx-3">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-body text-tx">{step.title}</p>
                  <p className="mt-0.75 text-meta text-tx-2 wrap-anywhere">
                    {step.detail}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </Card.Body>
        <Card.Footer>
          Setup needs to be root or to have passwordless sudo — its first check
          stops the run otherwise. Running it again is safe: every step checks
          whether it is needed before it does anything.
        </Card.Footer>
      </Card>

      <SetupConfirmModal
        server={server}
        custom={custom}
        state={run.state}
        actionLabel={label}
        open={confirming}
        onOpenChange={setConfirming}
        onConfirm={startRun}
      />
    </>
  );
}

/** What the button says, per state. An action keeps its name; a repeat says so. */
const ACTION: Record<SetupRunState, string> = {
  idle: "Run setup",
  running: "Running",
  finished: "Run setup again",
  failed: "Run setup again",
  interrupted: "Watch again",
  // Over, so there is nothing to watch: the next press is a new run, behind the
  // same confirmation as any other (ADR-0058).
  ended: "Run setup again",
  refused: "Run setup",
  blocked: "Run setup",
};

/**
 * The last run's ending, read back from the row while no run is on screen.
 * The log itself is not stored — only how it ended, and the failure
 * in the run's own words.
 */
function StoredSetupOutcome({ outcome }: { outcome: StoredOutcome }) {
  const when = (
    <time dateTime={outcome.at} title={timeExact(outcome.at)}>
      {timeAgo(outcome.at)}
    </time>
  );
  return outcome.ok ? (
    <p className="mb-3 flex items-baseline gap-2 text-body text-tx">
      <Dot mark={{ tone: "ok", glyph: "●", label: "finished" }} />
      <span>The last setup run finished {when}.</span>
    </p>
  ) : (
    <div className="mb-3">
      <p className="flex items-baseline gap-2 text-body text-tx">
        <Dot mark={{ tone: "bad", glyph: "○", label: "failed" }} />
        <span>The last setup run failed {when}.</span>
      </p>
      {outcome.message ? (
        <p className="mt-1.5 font-mono text-meta text-tx-2 wrap-anywhere">
          {outcome.message}
        </p>
      ) : null}
    </div>
  );
}
