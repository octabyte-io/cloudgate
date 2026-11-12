import { useId, useState } from "react";

import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { runsOnStackVm, type ComposeDetail } from "@/lib/api/endpoints/compose";
import type { Deployment } from "@/lib/api/endpoints/deployments";
import { roleRefusal, usePermission } from "@/lib/auth/use-permission";

import {
  composeDeclaresNoServices,
  composeFileIsEmpty,
} from "../editor/yaml-check";
import { useComposeActions, wasRefused } from "../use-compose";
// The Application row's pending glyph, so every Service kind's lifecycle row
// says "working" the same way.
import { ActionIcon } from "../../application/lifecycle/action-icon";
import { RemoveContainersModal } from "./remove-containers-modal";

/** Why Restart is off for a role without `deployment: ['create']`. */
const RESTART_REFUSAL = roleRefusal("restart this stack's containers");

/** Why Start and Stop are off on a stack no Deploy has run. */
export const COMPOSE_NEVER_DEPLOYED =
  "Nothing of this stack is on its deploy target yet, so there is nothing to start or stop. Deploy puts it there.";

/**
 * Deploy, Start, Stop, Remove containers — four controls, and a fifth,
 * Restart, only for a stack on its own Stack VM (see below).
 *
 * This comment used to say there was no fourth, on the strength of the phase
 * brief's question about a compose redeploy or rebuild route. That half still
 * holds: there is no such route, and deploying is
 * `POST /compose/:composeId/deployments` on the deployments controller. What
 * changed is the lifecycle itself — it
 * gained a third rung, and it is not a redeploy. The four do genuinely
 * different things:
 *
 * - **Deploy** clones (or writes) the file, injects the domain labels, and runs
 *   `docker compose up -d --build` or `docker stack deploy`. It is the only one
 *   that reads the file, so it is the only one that applies an edit.
 * - **Start** is `docker compose up -d` over the code **already on disk** — no
 *   clone, no build, no label injection. For a Swarm stack there is nothing for
 *   it to run: `ComposeService.start` has no `docker stack deploy`, so it used
 *   to report `done` having exec'd nothing and the button would have claimed
 *   success and changed nothing. It is therefore absent for a stack rather than
 *   present and misleading — and since H-106 the route refuses that type with a
 *   400 naming Deploy, so the two agree instead of only this one knowing.
 * - **Stop** is `docker compose stop`, or `docker stack rm` — which for a Swarm
 *   stack is a *removal* of the services, not a pause, so the word is qualified
 *   in the button's title rather than left to mean two things.
 * - **Remove containers** is `docker compose rm --stop --force`: the containers
 *   go and nothing else does, so Start brings the stack back from the project
 *   directory. It exists because Stop leaves them `Exited` and Docker's volume
 *   refcount counts an exited container, which made a volume restore
 *   uncompletable from this console (ADR-0011). **Absent for a Swarm stack**,
 *   for Start's reason exactly: there `docker stack rm` is already what Stop
 *   runs, so this would be a second button doing the first one's job.
 *
 * - **Restart**, on a Stack VM only (ADR-0070), is `docker compose restart`
 *   through the cloud's tunnel: the containers restart and the VM does not.
 *   A stack on a Server restarts a container from the Containers tab, which
 *   reaches a Server's Docker but not a Stack VM's, so it gets no fifth button.
 *   On a Stack VM, Stop also stops the VM and Start starts it first.
 *
 * Which is why two of the four are behind `swarm ? null : …` and neither is
 * rendered off with a reason — a control that would do nothing for a type is
 * absent here, and one that cannot run *right now* is the case for
 * `aria-disabled` (Deploy, with a file that has nothing in it to deploy).
 *
 * **`deployOnly` is for an empty state**. The Logs, Deployments and
 * Containers tabs' "nothing here" repeated all four beside the page header's
 * own four, wrapped out of line, and offered Stop and Remove containers on a
 * stack never deployed. What an empty tab is waiting for is a Deploy; the rest
 * stay in the header.
 */
export function ComposeActions({
  compose,
  size = "default",
  onDeployed,
  deployOnly = false,
}: {
  compose: ComposeDetail;
  size?: "default" | "sm";
  /** So the Deployments tab can start streaming what was just started. */
  onDeployed?: (deployment: Deployment) => void;
  /** Deploy alone, for an empty state under the header's full row. */
  deployOnly?: boolean;
}) {
  const actions = useComposeActions(compose.composeId, compose.environmentId);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const reasonId = useId();

  // One at a time: all four run docker against the same project, and two at
  // once is a race whose loser leaves `composeStatus` describing the other one.
  const busy =
    busyLabel !== null ||
    actions.deploy.isPending ||
    actions.start.isPending ||
    actions.stop.isPending ||
    actions.restart.isPending ||
    actions.removeContainers.isPending;
  const glyph = size === "sm" ? 14 : 15;

  const swarm = compose.composeType === "stack";
  /**
   * A stack on its own Stack VM (ADR-0070) restarts its containers here: the
   * Containers tab's per-container Restart reaches a Server, not a Stack VM.
   */
  const onStackVm = runsOnStackVm(compose) && !swarm;
  // Restart asks what its route asks, `deployment: ['create']`.
  const canRestart = usePermission({ deployment: ["create"] });
  const restartRefused = !canRestart.allowed;

  /**
   * Deploy is off while a `raw` stack's file is still empty.
   *
   * Not a guess about what the deploy would do — it is what the deploy *does*:
   * `parseComposeFile("")` is `null`, so the engine refuses the file with
   * `Compose file is empty` and the only thing pressing this produces is a
   * Deployment recorded as `error`. That is the state every stack is in from
   * the moment it is created until someone writes the file, so the button
   * spent that whole window offering a failure.
   *
   * **Only for `raw`.** A git-sourced stack's `composeFile` column is empty by
   * definition; its file is in the repository and the deploy is what clones it.
   *
   * **And off for a file that parses but declares no services**
   * which is the
   * same rule one keystroke later. `volumes: {}` used to run: the clone replaced
   * the project file the running containers came from, Docker answered
   * `no service selected`, and the stack went `error` over two containers that
   * were still up. The refusal is `parseComposeFileOrThrow`'s now and lands in
   * front of that write, so the two states differ only in their sentence — which
   * is why they are two, rather than one message covering both.
   */
  const emptyFile =
    compose.sourceType === "raw" && composeFileIsEmpty(compose.composeFile);
  const noServices =
    compose.sourceType === "raw" &&
    composeDeclaresNoServices(compose.composeFile);
  const nothingToDeploy = emptyFile || noServices;

  /**
   * Start and Stop are off before the first Deploy, with the reason
   * beside them, the way Deploy is off over an empty file. `idle` is the
   * never-deployed default now that Stop writes `stopped`: Start would
   * run `up -d` in a directory that does not exist, and the backend's
   * `notDeployedRefusal` would say so after the press. A stack stopped by an
   * older version still wears `idle`, and Deploy brings that one back too.
   */
  const neverDeployed = compose.composeStatus === "idle";

  /**
   * Run one, and be honest about the ambiguous failure — F11's rule, and it bites
   * harder here. `start`, `stop` and `remove-containers` run docker **inside the
   * request**, and
   * `docker compose up -d` on a stack that pulls three images takes minutes; the
   * proxy holds a response for 30 seconds. A 5xx therefore does not mean nothing
   * happened, and `toast.error`'s sentence for one says exactly that.
   */
  const run = async (
    label: string,
    mutation: { mutateAsync: (input: void) => Promise<unknown> },
    done: string,
  ) => {
    setBusyLabel(label);
    try {
      await mutation.mutateAsync();
      toast.done(done);
    } catch (error) {
      if (wasRefused(error)) toast.error(error);
      else
        toast.warn("The request did not come back.", {
          description:
            "Docker was still working when the connection closed, so this may have carried on. The status beside the name is read from the Server — watch that rather than this.",
        });
    } finally {
      setBusyLabel(null);
    }
  };

  const deploy = (
    <Button
      size={size}
      variant="pri"
      aria-disabled={busy || nothingToDeploy || undefined}
      aria-busy={busyLabel === "deploy" || undefined}
      title={
        emptyFile
          ? "There is nothing to deploy yet — the compose file is empty. Write it on the Overview tab first."
          : noServices
            ? "There is nothing to deploy — the compose file declares no services. Add one on the Overview tab first."
            : undefined
      }
      onClick={
        busy || nothingToDeploy
          ? undefined
          : () => {
              setBusyLabel("deploy");
              actions.deploy
                .mutateAsync(undefined)
                .then((deployment) => {
                  onDeployed?.(deployment);
                  toast.done(`${compose.name} is deploying.`, {
                    description:
                      "The build log is on the Deployments tab as it is written.",
                  });
                })
                .catch((error: unknown) => toast.error(error))
                .finally(() => setBusyLabel(null));
            }
      }
    >
      <ActionIcon
        name="rocket"
        pending={busyLabel === "deploy"}
        size={glyph}
      />
      Deploy
    </Button>
  );

  if (deployOnly) return deploy;

  return (
    <>
      {deploy}

      {swarm ? null : (
        <Button
          size={size}
          aria-disabled={busy || neverDeployed || undefined}
          title={
            neverDeployed
              ? COMPOSE_NEVER_DEPLOYED
              : "Runs docker compose up over the code already on the deploy target. It does not clone or build."
          }
          aria-describedby={neverDeployed ? reasonId : undefined}
          aria-busy={busyLabel === "start" || undefined}
          onClick={
            busy || neverDeployed
              ? undefined
              : () =>
                  void run(
                    "start",
                    actions.start,
                    `${compose.name} is starting from the code already on the deploy target.`,
                  )
          }
        >
          <ActionIcon
            name="play"
            pending={busyLabel === "start"}
            size={glyph}
          />
          Start
        </Button>
      )}

      <Button
        size={size}
        aria-disabled={busy || neverDeployed || undefined}
        title={
          neverDeployed
            ? COMPOSE_NEVER_DEPLOYED
            : swarm
              ? "docker stack rm — the services are removed. Deploy recreates them."
              : "docker compose stop — the containers stop and stay."
        }
        aria-describedby={neverDeployed ? reasonId : undefined}
        aria-busy={busyLabel === "stop" || undefined}
        onClick={
          busy || neverDeployed
            ? undefined
            : () =>
                void run(
                  "stop",
                  actions.stop,
                  swarm
                    ? `${compose.name} is being removed from Swarm. Deploy recreates it.`
                    : `${compose.name} is stopping. Its containers and volumes stay.`,
                )
        }
      >
        <ActionIcon pending={busyLabel === "stop"} size={glyph} />
        Stop
      </Button>

      {onStackVm ? (
        <Button
          size={size}
          aria-disabled={restartRefused || busy || neverDeployed || undefined}
          title={
            restartRefused
              ? RESTART_REFUSAL
              : neverDeployed
                ? COMPOSE_NEVER_DEPLOYED
                : "docker compose restart — the containers restart. The Stack VM keeps running."
          }
          aria-describedby={neverDeployed ? reasonId : undefined}
          aria-busy={busyLabel === "restart" || undefined}
          onClick={
            restartRefused || busy || neverDeployed
              ? undefined
              : () =>
                  void run(
                    "restart",
                    actions.restart,
                    `${compose.name}'s containers are restarting. Its Stack VM keeps running.`,
                  )
          }
        >
          <ActionIcon pending={busyLabel === "restart"} size={glyph} />
          Restart
        </Button>
      ) : null}

      {neverDeployed ? (
        <span id={reasonId} className="text-meta text-tx-3">
          {COMPOSE_NEVER_DEPLOYED}
        </span>
      ) : null}

      {swarm ? null : (
        <Button
          size={size}
          aria-disabled={busy || undefined}
          title="docker compose rm --stop --force — the containers are removed. Start recreates them."
          aria-busy={actions.removeContainers.isPending || undefined}
          onClick={busy ? undefined : () => setConfirmRemove(true)}
        >
          <ActionIcon
            pending={actions.removeContainers.isPending}
            size={glyph}
          />
          Remove containers
        </Button>
      )}

      {/* Mounted here rather than beside the button, and only while open: this
          row is rendered in four panels' headers, and a dialog that stays
          mounted across a close keeps the state of the last decision. */}
      {confirmRemove ? (
        <RemoveContainersModal
          compose={compose}
          open
          onOpenChange={setConfirmRemove}
          onConfirm={() => {
            setConfirmRemove(false);
            void run(
              "remove-containers",
              actions.removeContainers,
              // "Named" is doing work: an unnamed mount's volume also
              // stays, but Start does not re-attach it, so "its volumes stay
              // and Start brings it back" read as a promise about the data.
              `${compose.name} has no containers now. Its named volumes and project directory stay, and Start brings it back.`,
            );
          }}
        />
      ) : null}
    </>
  );
}
