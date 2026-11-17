import { useEffect, useId, useRef, useState } from "react";

import { useQueryClient } from "@tanstack/react-query";

import { ActionReason } from "@/components/console/action-reason";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { runsOnStackVm, type ComposeDetail } from "@/lib/api/endpoints/compose";
import type { Deployment } from "@/lib/api/endpoints/deployments";
import { useActiveOrganizationId } from "@/lib/auth/client";
import { roleRefusal, usePermission } from "@/lib/auth/use-permission";

import {
  composeDeclaresNoServices,
  composeFileIsEmpty,
} from "../editor/yaml-check";
import { stackMembersKey, useStackMembers } from "../containers/stack-members";
import {
  useComposeActions,
  useComposeLifecyclePending,
  wasRefused,
} from "../use-compose";
// The Application row's pending glyph, so every Service kind's lifecycle row
// says "working" the same way.
import { ActionIcon } from "../../application/lifecycle/action-icon";
import { RemoveContainersModal } from "./remove-containers-modal";
import { startOrRestart } from "./start-or-restart";

/** Why Restart is off for a role without `deployment: ['create']`. */
const RESTART_REFUSAL = roleRefusal("restart this stack's containers");

/**
 * What Deploy does to a stack that is already deployed, as its title. Said
 * because the row now offers Restart beside it, and the two read alike to
 * someone after "make it pick up my change". Not "new images": `up -d
 * --build` pulls only an image that is missing, so a moved tag stays as it
 * was unless the file's `pull_policy` says otherwise. A Swarm stack has no
 * build, so its sentence stops before that half.
 */
export const COMPOSE_DEPLOY_AGAIN =
  "Deploys the compose file as it is now, with every change since the last Deployment. Services with a build are built again; an image already on the deploy target is pulled again only if its pull_policy says so.";
export const COMPOSE_DEPLOY_AGAIN_SWARM =
  "Deploys the compose file as it is now, with every change since the last Deployment.";

/**
 * Reads the stack's membership again when its status moves — a Deploy that
 * finished, a stop made on another tab — so Start or Restart follows the
 * containers rather than a read from before the change. Not on mount: the
 * read's own cache decides that, and four rows mounting at once would each
 * cancel the others' fetch.
 */
function useRereadOnStatusChange(
  compose: Pick<
    ComposeDetail,
    "composeStatus" | "appName" | "serverId" | "composeType"
  >,
  enabled: boolean,
) {
  const queryClient = useQueryClient();
  const { organizationId } = useActiveOrganizationId();
  const last = useRef(compose.composeStatus);
  const { composeStatus, appName, serverId, composeType } = compose;
  useEffect(() => {
    if (last.current === composeStatus) return;
    last.current = composeStatus;
    if (!enabled) return;
    void queryClient.invalidateQueries({
      queryKey: stackMembersKey(organizationId, {
        appName,
        serverId,
        composeType,
      }),
      exact: true,
    });
  }, [
    composeStatus,
    enabled,
    queryClient,
    organizationId,
    appName,
    serverId,
    composeType,
  ]);
}

/** Why Start, Stop and Remove containers are off on a stack no Deploy has run. */
export const COMPOSE_NEVER_DEPLOYED =
  "Nothing of this stack is on its deploy target yet, so there is nothing to start, stop or remove. Deploy puts it there.";

/** Why Stop and Remove containers are off once its containers are removed. */
export const COMPOSE_CONTAINERS_REMOVED =
  "This stack's containers are removed, so there is nothing to stop or remove. Start recreates them.";

/**
 * Deploy, Start or Restart, Stop, Remove containers — four controls, the
 * second of which is Restart while the stack's containers are up and Start
 * otherwise (`startOrRestart`).
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
 * - **Restart** is `docker compose restart`: the containers restart and
 *   nothing else does, on a Stack VM never the VM (ADR-0070). It takes
 *   Start's place while the containers are up, where Start was `up -d` over
 *   running containers: a press that did nothing and looked as live as the
 *   rest. It was once offered on a Stack VM only, as a fifth button beside
 *   Start, on the argument that a Server's stack restarts a container from
 *   the Containers tab; that is one container at a time, and the route has
 *   always served a Server's stack too. Absent for a Swarm stack with Start:
 *   its route refuses that type the same way, naming Deploy. On a Stack VM,
 *   Stop also stops the VM and Start starts it first.
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
  // What is running for this stack, pressed in this row or in any other.
  const pending = useComposeLifecyclePending(compose.composeId);
  const working = (label: string) => busyLabel === label || pending === label;
  const [confirmRemove, setConfirmRemove] = useState(false);
  const reasonId = useId();

  // One at a time: all four run docker against the same project, and two at
  // once is a race whose loser leaves `composeStatus` describing the other one.
  // Across every row of the stack, not only this one: see
  // `useComposeLifecyclePending`.
  const busy = busyLabel !== null || pending !== null;
  const glyph = size === "sm" ? 14 : 15;

  const swarm = compose.composeType === "stack";
  /** A stack on its own Stack VM (ADR-0070), whose Restart leaves the VM up. */
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
   * under the row, the way Deploy is off over an empty file. `idle` is the
   * never-deployed default now that Stop writes `stopped`: Start would
   * run `up -d` in a directory that does not exist, and the backend's
   * `notDeployedRefusal` would say so after the press. A stack stopped by an
   * older version still wears `idle`, and Deploy brings that one back too.
   */
  const neverDeployed = compose.composeStatus === "idle";

  /**
   * Which containers of the stack Docker has, and in what state. Two
   * questions read it:
   *
   * - Stop and Remove containers are off once a stopped stack has no
   *   container left — after Remove containers, whose success writes `[]` to
   *   the membership this reads, or a later visit that asks Docker. Start
   *   stays on: it recreates them from the project directory, the round trip
   *   ADR-0011 names (Remove containers → restore → Start).
   * - Start or Restart: every container up is Restart (`startOrRestart`).
   *
   * Asked of a deployed `docker-compose` stack on a Server; a Stack VM's
   * membership is not read from its VM, and a Swarm stack has neither
   * control. It is the Containers tab's read, under one key, so the two agree.
   */
  const askDocker = !neverDeployed && !swarm && !runsOnStackVm(compose);
  const members = useStackMembers(compose, {
    enabled: askDocker,
    // A Deploy is converging, so what is up is changing under the row.
    refetchInterval: compose.composeStatus === "running" ? 4_000 : false,
  });
  useRereadOnStatusChange(compose, askDocker);
  const removed =
    askDocker &&
    compose.composeStatus === "stopped" &&
    members.data?.length === 0;
  const second = swarm
    ? null
    : startOrRestart({
        composeStatus: compose.composeStatus,
        stackVm: onStackVm,
        members: askDocker ? members.data : undefined,
      });
  const nothingThere = neverDeployed || removed;
  const reason = neverDeployed
    ? COMPOSE_NEVER_DEPLOYED
    : removed
      ? COMPOSE_CONTAINERS_REMOVED
      : undefined;

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
    description?: string,
  ) => {
    setBusyLabel(label);
    try {
      await mutation.mutateAsync();
      toast.done(done, description ? { description } : undefined);
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
      aria-busy={working("deploy") || undefined}
      title={
        emptyFile
          ? "There is nothing to deploy yet — the compose file is empty. Write it on the Overview tab first."
          : noServices
            ? "There is nothing to deploy — the compose file declares no services. Add one on the Overview tab first."
            : neverDeployed
              ? undefined
              : swarm
                ? COMPOSE_DEPLOY_AGAIN_SWARM
                : COMPOSE_DEPLOY_AGAIN
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
        pending={working("deploy")}
        size={glyph}
      />
      Deploy
    </Button>
  );

  const startButton = (
    <Button
      size={size}
      aria-disabled={busy || neverDeployed || undefined}
      title={
        neverDeployed
          ? COMPOSE_NEVER_DEPLOYED
          : "Runs docker compose up over the code already on the deploy target. It does not clone or build."
      }
      aria-describedby={neverDeployed ? reasonId : undefined}
      aria-busy={working("start") || undefined}
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
        pending={working("start")}
        size={glyph}
      />
      Start
    </Button>
  );

  /**
   * An empty tab offers the way back its sentence names (`whyNothingRuns`):
   * a stopped stack is told Start brings its containers back up, so Start is
   * the button, not Deploy, which would also rebuild. A Swarm stack has no
   * Start, and every other state is waiting for a Deploy.
   */
  if (deployOnly) {
    return compose.composeStatus === "stopped" && !swarm
      ? startButton
      : deploy;
  }

  return (
    <>
      {deploy}

      {second === "start" ? startButton : null}

      {second === "restart" ? (
        <Button
          size={size}
          aria-disabled={restartRefused || busy || undefined}
          title={
            restartRefused
              ? RESTART_REFUSAL
              : onStackVm
                ? "docker compose restart — the containers restart. The Stack VM keeps running."
                : "docker compose restart — the containers restart. Nothing is cloned or built."
          }
          aria-busy={working("restart") || undefined}
          onClick={
            restartRefused || busy
              ? undefined
              : () =>
                  void run(
                    "restart",
                    actions.restart,
                    onStackVm
                      ? `${compose.name}'s containers are restarting. Its Stack VM keeps running.`
                      : `${compose.name}'s containers are restarting.`,
                  )
          }
        >
          {/* The Application row's Restart glyph, in the slot Start's
              play glyph holds. */}
          <ActionIcon
            name="refresh"
            pending={working("restart")}
            size={glyph}
          />
          Restart
        </Button>
      ) : null}

      <Button
        size={size}
        aria-disabled={busy || nothingThere || undefined}
        title={
          reason
            ? reason
            : swarm
              ? "docker stack rm — the services are removed. Deploy recreates them."
              : "docker compose stop — the containers stop and stay."
        }
        aria-describedby={reason ? reasonId : undefined}
        aria-busy={working("stop") || undefined}
        onClick={
          busy || nothingThere
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
        <ActionIcon pending={working("stop")} size={glyph} />
        Stop
      </Button>

      {swarm ? null : (
        <Button
          size={size}
          aria-disabled={busy || nothingThere || undefined}
          title={
            reason ??
            "docker compose rm --stop --force — the containers are removed. Start recreates them."
          }
          aria-describedby={reason ? reasonId : undefined}
          aria-busy={working("remove-containers") || undefined}
          onClick={
            busy || nothingThere ? undefined : () => setConfirmRemove(true)
          }
        >
          <ActionIcon pending={working("remove-containers")} size={glyph} />
          Remove containers
        </Button>
      )}

      {/* Last, under every button: `ActionReason` says why it is not between
          Stop and Remove containers. */}
      {reason ? (
        <ActionReason id={reasonId}>{reason}</ActionReason>
      ) : null}

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
              // The action's own words, past tense, as Stop's toast is.
              `${compose.name}'s containers are removed.`,
              // "Named" is doing work: an unnamed mount's volume also
              // stays, but Start does not re-attach it, so "its volumes stay
              // and Start brings it back" read as a promise about the data.
              "Its named volumes and project directory stay. Start recreates the containers.",
            );
          }}
        />
      ) : null}
    </>
  );
}
