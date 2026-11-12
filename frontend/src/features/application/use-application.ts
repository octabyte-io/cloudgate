import { useMutation, useQuery } from "@tanstack/react-query";

import { useForgetVisited } from "@/components/shell/recents";
import {
  applicationsApi,
  type CopyRangeInput,
  type SaveApplicationEnvironmentInput,
  type UpdateApplicationInput,
} from "@/lib/api/endpoints/applications";
import { deploymentsApi } from "@/lib/api/endpoints/deployments";
import { dockerApi } from "@/lib/api/endpoints/docker";
import { keys } from "@/lib/api/keys";
import { useInvalidate } from "@/lib/api/use-invalidate";
import { useRefetchWhenSettled } from "@/lib/api/use-refetch-when-settled";
import { useActiveOrganizationId } from "@/lib/auth/client";

/**
 * Everything the Application screens read and write.
 *
 * One thing is still *not* here and it is worth stating so nobody goes looking:
 * there is no `GET /applications`, so an Application is only ever reached by id.
 *
 * **The lifecycle is here now.** Start, stop, reload, redeploy and cancel all
 * landed together — until then Deploy was the only action an Application had,
 * while a Postgres in the same Environment had four. Three of the five live on
 * the applications controller and two on the deployments controller, split by
 * whether they write a `deployment` row; `useApplicationLifecycle` presents
 * them as the one set they are to whoever is pressing the buttons. The
 * deploy-webhook secret once had a rotation too, since taken back out: no route
 * accepts that webhook.
 *
 * `useApplication` is keyed the same way `use-scope-queries.ts` keys the
 * masthead's identity query, so a panel opens with the row already in cache and
 * the two can never disagree about the Application's name.
 */

export function useApplication(
  applicationId: string,
  options: {
    /**
     * A build is in flight, so keep the row fresh.
     *
     * `applicationStatus` is written by the deployment engine and nothing pushes
     * it, so the status in the page header and in the masthead badge would sit at
     * whatever it was when the tab opened. The caller decides because the caller
     * is the one holding the Deployment list that says whether anything is live —
     * and it turns itself off when that stops being true.
     *
     * **And reads the row once more when it does**: the engine writes
     * `applicationStatus` at the end of the build, so the read that follows the
     * poll switching off is the one that carries the build's outcome.
     */
    live?: boolean;
  } = {},
) {
  const { organizationId } = useActiveOrganizationId();
  const query = useQuery({
    queryKey: keys.applications.detail(organizationId, applicationId),
    queryFn: () => applicationsApi.findOne(applicationId),
    enabled: organizationId !== null && applicationId !== "",
    refetchInterval: options.live ? LIVE_POLL_MS : false,
  });
  useRefetchWhenSettled(options.live ?? false, query.refetch);
  return query;
}

/**
 * The row, patched.
 *
 * Every field on the Application — source, build, resources — goes through this
 * one route. `environmentId` is passed so a change also refreshes the
 * Environment the Application sits in, which is what the rail reads.
 */
export function useUpdateApplication(
  applicationId: string,
  environmentId?: string,
) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: UpdateApplicationInput) =>
      applicationsApi.update(applicationId, input),
    onSuccess: (saved) =>
      Promise.all([
        invalidate.application({ applicationId, environmentId }),
        // A port change moved its Domains on the old port (ADR-0068).
        saved.domainPortMove?.moved.length
          ? invalidate.domains({ applicationId })
          : undefined,
      ]),
  });
}

/**
 * A Cloud Run Service's copy range (S10), its own route: Google is
 * called before the row is saved, so a refusal keeps the range it had.
 */
export function useSetCopyRange(applicationId: string, environmentId?: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: CopyRangeInput) =>
      applicationsApi.setCopyRange(applicationId, input),
    onSuccess: () => invalidate.application({ applicationId, environmentId }),
  });
}

/**
 * The three encrypted variable columns, saved together.
 *
 * A separate route from `update` because it is a separate *decision*: the
 * backend takes `env`, `buildArgs`, `buildSecrets` and `createEnvFile` and
 * nothing else, so a screen that saves variables cannot accidentally also write
 * a branch it happened to be holding.
 */
export function useSaveApplicationEnvironment(
  applicationId: string,
  environmentId?: string,
) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: SaveApplicationEnvironmentInput) =>
      applicationsApi.saveEnvironment(applicationId, input),
    onSuccess: () => invalidate.application({ applicationId, environmentId }),
  });
}

/**
 * This Application's Deployments, newest first once the table sorts them.
 *
 * **It polls while a build is live and stops when none is.** The log arrives over
 * a socket, but the *status* is a column the engine writes — pending → running →
 * done — and nothing pushes that. A build whose last line has arrived is not yet
 * a build the engine has marked done, so a screen that only listened to the socket
 * would leave a finished Deployment reading "running" until someone reloaded.
 *
 * `refetchInterval` is a function so the decision is re-made from each answer:
 * the poll turns itself off, rather than a screen having to remember to.
 */
export function useApplicationDeployments(applicationId: string) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.deployments.byApplication(organizationId, applicationId),
    queryFn: () => deploymentsApi.listByApplication(applicationId),
    enabled: organizationId !== null && applicationId !== "",
    refetchInterval: (query) =>
      (query.state.data ?? []).some(
        (row) => row.status === "pending" || row.status === "running",
      )
        ? LIVE_POLL_MS
        : false,
  });
}

/**
 * How many of the Application's Swarm tasks are running, or `null` when that
 * cannot be read.
 *
 * `GET /docker/containers/service` — `docker service ps` on the deploy target,
 * which sees every node of its Swarm. Not `readSwarmServiceHealth`: that is a
 * backend helper for the platform's own services and no route serves it for
 * an Application. A task counts when Swarm both wants it running and reports
 * it running; a `Pending` task that no node can take is the case this exists
 * for.
 *
 * `enabled` is the caller's: this shells out to a host, so the Overview asks
 * only while its failure banner is up. A refusal — a base member holds no
 * `docker` action — an unreachable Server, or an empty listing (below) is
 * `null`, never `0`: "cannot say" must not read as "nothing is running".
 */
export function useRunningTasks(
  application: { appName: string; serverId: string | null } | undefined,
  enabled: boolean,
): number | null {
  const { organizationId } = useActiveOrganizationId();
  const serverId = application?.serverId ?? null;
  const appName = application?.appName ?? "";
  const tasks = useQuery({
    queryKey: keys.docker.serviceTasks(organizationId, serverId, appName),
    queryFn: () => dockerApi.serviceTasks({ appName, serverId }),
    enabled: organizationId !== null && appName !== "" && enabled,
    retry: false,
    // Read afresh each time the banner comes up: a redeploy that fails inside
    // the console's 30-second default would otherwise be judged by the tasks
    // read for the failure before it.
    staleTime: 0,
  });
  // An **empty** listing is "cannot say", not 0. `getTaskList` answers `[]`
  // for any stderr or failed exec other than an unreachable host — "This node
  // is not a swarm manager", "no such service" — so `[]` is as often a read
  // that failed as a service with no tasks. A service Swarm cannot place still
  // lists its `Pending` task, so "tasks listed, none running" is the real
  // nothing-is-serving case and loses nothing by this.
  if (!enabled || !tasks.data || tasks.data.length === 0) return null;
  return tasks.data.filter(
    (task) => task.state === "running" && /^running\b/i.test(task.currentState),
  ).length;
}

/**
 * Whether the Application is waiting for a GPU — a task Swarm left
 * pending for want of a card, after a reboot or a lost card, outside any
 * deploy. Its own route rather than `useRunningTasks`'s, because that one needs
 * `docker: ['read']` and a base member who can see the Application holds none.
 *
 * Asked only of an Application reserving a GPU; it shells out to the Server,
 * so it polls slowly. A failed read is "not waiting": the line explains, and
 * never stands in for a status.
 */
export function useGpuWait(
  application: { applicationId: string; gpus: number } | undefined,
): { free: number; cards: number } | null {
  const { organizationId } = useActiveOrganizationId();
  const applicationId = application?.applicationId ?? "";
  const wait = useQuery({
    queryKey: keys.applications.gpuWait(organizationId, applicationId),
    queryFn: () => applicationsApi.gpuWait(applicationId),
    enabled:
      organizationId !== null &&
      applicationId !== "" &&
      (application?.gpus ?? 0) > 0,
    retry: false,
    refetchInterval: GPU_WAIT_POLL_MS,
  });
  if ((application?.gpus ?? 0) < 1 || !wait.data?.waiting) return null;
  return { free: wait.data.free, cards: wait.data.cards };
}

/** A card coming back is minutes, not seconds; each read is an SSH round trip. */
const GPU_WAIT_POLL_MS = 30_000;

/** Slow enough not to be a load, fast enough that a 20-second build is seen. */
export const LIVE_POLL_MS = 4_000;

/**
 * Deploy. **This is the whole of "deploy"** — `POST /applications/:id/deployments`
 * writes a `pending` row with its log file and enqueues the build, so the
 * Deployment that comes back is something to start streaming immediately.
 */
export function useDeployApplication(
  applicationId: string,
  environmentId?: string,
) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (title?: string) =>
      deploymentsApi.deployApplication(
        applicationId,
        title ? { title } : undefined,
      ),
    onSuccess: async () => {
      await invalidate.deployments(applicationId);
      // The Application's own status moves with the build, and the masthead
      // badge reads it — so the Environment goes too when we know it.
      if (environmentId) await invalidate.application({ environmentId });
    },
  });
}

/**
 * The lifecycle, as one object.
 *
 * Six mutations, three routes on each controller, presented together because
 * that is how they are used: an operator deciding between Restart and Redeploy
 * is not thinking about which controller answers.
 *
 * **`onSettled`, not `onSuccess`, on the four that touch the Server.** Start,
 * stop and reload issue `docker service scale`, which *waits for the service to
 * converge* — a scale-up that has to pull a cold image outlasts the time a proxy
 * will hold the response open, and the row moved anyway. Refreshing only on
 * success would leave the screen describing the state the Application was in
 * before. The row is the truth; every outcome goes and asks it. F11 paid for
 * this once already on the database screens and the note there says the same.
 *
 * Redeploy and cancel invalidate the Deployment list instead, because what they
 * change is a `deployment` row — and `invalidate.deployments` takes the
 * Application's row with it, since `applicationStatus` moves with a build.
 */
export function useApplicationLifecycle(
  applicationId: string,
  environmentId?: string,
) {
  const invalidate = useInvalidate();
  const row = () => invalidate.application({ applicationId, environmentId });
  const builds = () => invalidate.deployments(applicationId);

  return {
    start: useMutation({
      mutationFn: () => applicationsApi.start(applicationId),
      onSettled: row,
    }),
    stop: useMutation({
      mutationFn: () => applicationsApi.stop(applicationId),
      onSettled: row,
    }),
    /** Restart, without building. */
    reload: useMutation({
      mutationFn: () => applicationsApi.reload(applicationId),
      onSettled: row,
    }),
    /** Build again from the source already configured; records an attempt. */
    redeploy: useMutation({
      mutationFn: () => deploymentsApi.redeployApplication(applicationId),
      onSuccess: builds,
    }),
    /**
     * Dequeues a queued build or kills a running one. A build past its
     * shell steps — releasing — answers 409; the caller shows that message
     * rather than treating it as a failed request.
     */
    cancel: useMutation({
      mutationFn: (deploymentId: string) =>
        deploymentsApi.cancelDeployment(deploymentId),
      onSettled: builds,
    }),
    /** Stop the run: ends a running Cloud run, its apply included. */
    stopRun: useMutation({
      mutationFn: (deploymentId: string) =>
        deploymentsApi.stopRun(deploymentId),
      onSettled: builds,
    }),
  };
}

/**
 * `service: ['update']`: what `PATCH /applications/:id` and its
 * `/environment` twin run first, through `findOwnedForUpdate`. Change source,
 * the build's Edit and the variables' Edit are that statement's three doors on
 * these screens — Rotate was a fourth until the deploy webhook it rotated
 * was taken out of the console.
 */
export const APPLICATION_UPDATE_REFUSAL =
  "Your role in this Organization cannot change this Application — its source, its build or its variables. Ask an owner or an admin to do it, or to change your role.";

/**
 * `service: ['update']` too — the same `PATCH /applications/:id` and
 * `findOwnedForUpdate` — for the five cards that are not the source, the build
 * or the variables: Build server, Resources and Run command on Advanced,
 * Preview settings, and Keep rollback points. Its own sentence because the one
 * above names three things none of these five is.
 *
 * Written out rather than built by `roleRefusal`, so a test that mocks
 * `use-permission` down to `usePermission` can still import this module.
 */
export const APPLICATION_SETTINGS_REFUSAL =
  "Your role in this Organization cannot change how this Application is built, run, previewed or rolled back. Ask an owner or an admin to do it, or to change your role.";

// `deployment: ['create']`; its sentence lives in `lib/auth`, since
// "Build now" on a plan's held build says it too.
export { APPLICATION_DEPLOY_REFUSAL } from "@/lib/auth/application-refusals";

/**
 * `service: ['delete']`, which `DELETE /applications/:id` requires and the base
 * member does not hold.
 */
export const APPLICATION_DELETE_REFUSAL =
  "Your role in this Organization cannot delete an Application. Ask an owner or an admin to do it, or to change your role.";

/**
 * Delete the Application: `DELETE /applications/:id`, which answers the
 * row plus whatever its teardown could not reclaim.
 *
 * **It refreshes the Environment and not the Application**, and that is the
 * one thing here that is not a copy of the Compose and database deletes. The
 * row is gone, so a refetch of it answers 404, and every Application panel
 * swaps itself for its "could not be read" state on an error — which would
 * unmount the teardown report the dialog has just opened, the only record of
 * what was left behind. The screen is about to navigate to the Environment
 * anyway, and the Environment's Services list is the read that changed.
 *
 * **`onSuccess`, not §3.5's `onSettled`**: a refused delete (the 409 when the
 * Swarm service cannot be confirmed gone) keeps the Application exactly as it
 * was, so there is nothing to re-read, and the Services list is only stale once
 * the row is actually gone.
 */
export function useDeleteApplication(
  applicationId: string,
  environmentId: string,
) {
  const invalidate = useInvalidate();
  const forgetVisited = useForgetVisited();
  return useMutation({
    mutationFn: ({
      deleteVolumes,
      force = false,
    }: {
      deleteVolumes: boolean;
      /** The forced Delete, for a Server that is gone for good. */
      force?: boolean;
    }) => applicationsApi.remove(applicationId, deleteVolumes, force),
    onSuccess: () => {
      forgetVisited([applicationId]);
      return invalidate.environment({ environmentId });
    },
  });
}

/**
 * Retry and Forget of a cloud Service's incomplete Delete. Retry
 * re-reads the row, which reads "Deleting" again; Forget drops it, so the
 * Environment's list is what changes.
 */
export function useCloudDeleteActions(
  applicationId: string,
  environmentId: string,
) {
  const invalidate = useInvalidate();
  const forgetVisited = useForgetVisited();
  return {
    retry: useMutation({
      mutationFn: () => applicationsApi.retryCloudDelete(applicationId),
      onSettled: () => {
        void invalidate.deployments(applicationId);
        return invalidate.application({ applicationId, environmentId });
      },
    }),
    forget: useMutation({
      mutationFn: () => applicationsApi.forgetCloudDelete(applicationId),
      onSuccess: () => {
        forgetVisited([applicationId]);
        return invalidate.environment({ environmentId });
      },
    }),
  };
}

/**
 * Whether a failed lifecycle call means "it was refused" or "we stopped
 * listening".
 *
 * A 4xx is the backend saying no and its message is the answer — a 409 from
 * cancel is the most important one in this feature, and it is a *fact about the
 * build*, not a broken request. A 5xx or a dropped connection on a call that
 * scales a Swarm service is ambiguous: most often it is the proxy timing out
 * while the service converges, and the operation is still running. Saying
 * "nothing changed" there is exactly backwards.
 *
 * It lives in `lib/api/` since "Build now with saved settings", a
 * component the Project config page shows too, needed it there.
 */
export { wasRefused } from "@/lib/api/api-error";

/**
 * Where a build pushes its image.
 *
 * **Moved to `lib/api/use-registries.ts` by F15**, which owns the screen that
 * manages these and is the second feature to read the list — the same move
 * `useSshKeys` made below. Re-exported here so this call site did not change.
 */
export { useRegistries } from "@/lib/api/use-registries";

/**
 * The keys a **custom git** source can clone with.
 *
 * **Moved to `lib/api/use-ssh-keys.ts` by F13**, which is the second and third
 * feature to want it — the add-a-Server dialog picks one and every Server's Access
 * tab names the one it uses — and which owns the screens that manage them.
 * Re-exported here so this call site did not change, the way F11 moved
 * `useServers` and `useDestinations`.
 */
export { useSshKeys } from "@/lib/api/use-ssh-keys";
