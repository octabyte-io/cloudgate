import { useMutation, useQuery } from "@tanstack/react-query";

import { useForgetVisited } from "@/components/shell/recents";
import {
  composeApi,
  type CreateComposeInput,
  type UpdateComposeInput,
} from "@/lib/api/endpoints/compose";
import { deploymentsApi } from "@/lib/api/endpoints/deployments";
import { keys } from "@/lib/api/keys";
import { useInvalidate } from "@/lib/api/use-invalidate";
import { useRefetchWhenSettled } from "@/lib/api/use-refetch-when-settled";
import { useActiveOrganizationId } from "@/lib/auth/client";
import { roleRefusal } from "@/lib/auth/use-permission";
import { newestLive } from "@/lib/format/deployment-facts";

/**
 * Everything the Compose screens read and write.
 *
 * Three facts about this backend shape every panel, so they are stated once here
 * rather than discovered in each:
 *
 * 1. **Deploy is the only route that builds anything**, and it is the
 *    *deployments* controller's (`POST /compose/:id/deployments`). Start and stop
 *    exist on the compose controller and do not build — start is `docker compose
 *    up -d` over the code that is already on disk (re-applying the two platform
 *    defaults to it first, H-98), and for a Swarm stack it is **refused with a
 *    400 naming Deploy** (`ComposeService.start`, H-106): it used to do nothing
 *    at all and report `done`, which was a status no task on the host backed.
 *    There is no redeploy and no rebuild.
 * 2. **The compose controller does not list.** `GET /compose/:id` and nothing
 *    else, the same as Applications and databases — so a stack is found through
 *    its **Environment**, whose read carries every service deployed in it
 * or by address,
 *    from Recents, or straight after being created. The create flow still ends on
 *    the new stack's own screen, which is where somebody who just made one wants
 *    to be.
 * 3. **The status is a column something else wrote.** `composeStatus` moves
 *    idle → running → done as the engine works, and nothing pushes it, so the row
 *    is polled while a build is live exactly the way F09 polls an Application's.
 */

/** Slow enough not to be a load, fast enough that a 20-second build is seen. */
const LIVE_POLL_MS = 4_000;

/**
 * One Compose stack.
 *
 * Keyed exactly the way `use-scope-queries.ts` keys the masthead's identity
 * query, so a panel opens with the row already in cache and the two can never
 * disagree about the stack's name or its status.
 *
 * **It polls while the stack's newest Deployment is pending or running, and
 * reads the row once more when that ends**. It used to poll only while
 * the row itself said `running` — and Deploy's own refresh reads the row the
 * moment the job is queued, while it still says `idle`, so a first Deploy left
 * the Overview on `idle` over a stack that was up. The Deployment list is what
 * knows a build is live; it is read here, under the key the Deployments tab
 * shares, rather than asked of every panel that renders this row.
 */
export function useCompose(composeId: string, options: { live?: boolean } = {}) {
  const { organizationId } = useActiveOrganizationId();
  const deployments = useComposeDeployments(composeId);
  const building = newestLive(deployments.data ?? []) !== null;
  const query = useQuery({
    queryKey: keys.compose.detail(organizationId, composeId),
    queryFn: () => composeApi.findOne(composeId),
    enabled: organizationId !== null && composeId !== "",
    refetchInterval: (query) =>
      options.live || building || query.state.data?.composeStatus === "running"
        ? LIVE_POLL_MS
        : false,
  });
  useRefetchWhenSettled(building, query.refetch);
  return query;
}

/**
 * The service names the stack's **file** declares.
 *
 * Not the containers — see `endpoints/compose.ts`. For a git source this route
 * `cat`s the clone on the build Server, so it answers **nothing until the stack
 * has been deployed once** and there is a clone to read; for a `raw` source it
 * parses the stored file and is right immediately. Both are useful and they are
 * not the same thing, which is why the Containers tab labels where each row came
 * from.
 *
 * `refetchOnWindowFocus` off: this is a shell-out over SSH for a remote Server,
 * not a cache miss.
 *
 * **`retry: false`, against the client's own default, and it is the interesting
 * line.** F02 retries a 5xx twice because most 500s are transient. This one is
 * not: for a git source with no clone yet, `cat` on a file that is not there fails
 * the same way every time, and the *reason* is what the screen wants to say. Two
 * pointless retries cost nothing except that the query stays `pending` while they
 * are scheduled — so the screen shows a loading skeleton instead of the
 * explanation. **Found by driving it**, where it was worse than three seconds of
 * skeleton: TanStack's retryer *pauses* while the document is hidden, so in a
 * backgrounded tab the skeleton never resolved at all. Not retrying settles the
 * query on the first answer, which is the only answer.
 */
export function useComposeServices(composeId: string, enabled = true) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.compose.services(organizationId, composeId),
    queryFn: () => composeApi.loadServices(composeId),
    enabled: enabled && organizationId !== null && composeId !== "",
    refetchOnWindowFocus: false,
    retry: false,
  });
}

/** How often a Stack VM between running and stopped is read again. */
const STACK_VM_MOVING_POLL_MS = 5_000;

/**
 * Whether the stack's Stack VM runs, read from its cloud (ADR-0070). Read
 * again every few seconds while it is starting or stopping, and on Stop and
 * Start, whose invalidation covers the stack's detail key. `retry: false`: a
 * cloud that did not answer says so in the answer, and a failed request is
 * shown rather than retried behind a skeleton.
 */
export function useStackVmStatus(composeId: string) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.compose.stackVm(organizationId, composeId),
    queryFn: () => composeApi.stackVmStatus(composeId),
    enabled: organizationId !== null && composeId !== "",
    retry: false,
    refetchInterval: (query) =>
      query.state.data?.state === "starting" ||
      query.state.data?.state === "stopping"
        ? STACK_VM_MOVING_POLL_MS
        : false,
  });
}

/**
 * The compose file as the deploy will apply it.
 *
 * Keyed under the stack's own detail subtree beside `compose.services`, because
 * it is the same file read through a second lens: `invalidate.compose()` already
 * fires on every write that could change the answer — editing the file, flipping
 * isolation, adding a domain — and a converted view that survived one of those
 * would be a diff of the previous deploy.
 *
 * Shares `useComposeServices`' two settings and inherits its reasoning exactly:
 * this shells out over SSH for a git source, so no background refetch; and
 * **`retry: false`**, because the interesting answers are permanent. A 400 is the
 * stack's own configuration (an empty file, a domain naming a service that is not
 * declared) and a failed `cat` on a stack never deployed fails identically every
 * time — retrying keeps the query `pending` and shows a skeleton where the
 * explanation should be.
 */
export function useConvertedCompose(composeId: string, enabled = true) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: [
      ...keys.compose.detail(organizationId, composeId),
      "converted",
    ] as const,
    queryFn: () => composeApi.getConverted(composeId),
    enabled: enabled && organizationId !== null && composeId !== "",
    refetchOnWindowFocus: false,
    retry: false,
  });
}

/**
 * `service: ['update']`: what `PATCH /compose/:id` runs first, through
 * `ComposeService.findOwnedForUpdate` → `checkServiceAccess(…, 'update')`. The
 * Identity card, Change source, the file's Save, Isolation's Save and the two
 * cards on Advanced are that one route's doors on these screens.
 */
export const COMPOSE_UPDATE_REFUSAL = roleRefusal(
  "change this Compose stack — its name, its source, its file or how it is deployed",
);

/**
 * `service: ['delete']`, which `DELETE /compose/:id` requires and the base
 * member does not hold.
 */
export const COMPOSE_DELETE_REFUSAL = roleRefusal("delete a Compose stack");

/**
 * The row, patched. Name, description, source, the compose file, the isolation
 * flag and the deploy command all go through this one route.
 */
export function useUpdateCompose(composeId: string, environmentId?: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: UpdateComposeInput) =>
      composeApi.update(composeId, input),
    onSuccess: () => invalidate.compose({ composeId, environmentId }),
  });
}

/**
 * The dotenv blob, whole.
 *
 * **`""` clears it, not `null`** — `saveComposeEnvironmentSchema` types `env` as
 * `z.string().optional()`, which refuses a null. That is the opposite of the
 * database and Application routes, and it is the exact trap F10 and F11 each paid
 * a defect for.
 */
export function useSaveComposeEnvironment(
  composeId: string,
  environmentId?: string,
) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (env: string) => composeApi.saveEnvironment(composeId, env),
    onSuccess: () => invalidate.compose({ composeId, environmentId }),
  });
}

/**
 * This stack's Deployments, newest first once the table sorts them.
 *
 * Polls while a build is live and stops when none is, the same way F09's does and
 * for the same reason: the log arrives over a socket but the *status* is a column
 * the engine writes, so a build whose last line has arrived is not yet a build
 * anything has marked done.
 */
export function useComposeDeployments(composeId: string) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.deployments.byCompose(organizationId, composeId),
    queryFn: () => deploymentsApi.listByCompose(composeId),
    enabled: organizationId !== null && composeId !== "",
    refetchInterval: (query) =>
      (query.state.data ?? []).some(
        (row) => row.status === "pending" || row.status === "running",
      )
        ? LIVE_POLL_MS
        : false,
  });
}

/**
 * Deploy, start, stop, remove containers, delete.
 *
 * **`onSettled` on the ones that touch Docker, not `onSuccess`** — F11 found the
 * reason by driving it: `POST /compose/:id/start`, `/stop` and
 * `/remove-containers` each run a docker command *inside the request*, and
 * `docker compose up -d` on a stack that has to
 * pull three images outlasts the 30 seconds the dev proxy holds a response open.
 * The call fails; the containers come up anyway. Refreshing only on success would
 * leave the screen saying `idle` about a stack that is running, and
 * `toast.error`'s sentence for a 500 — once "nothing changed" — would be backwards.
 * The row is the truth, so every outcome goes and asks it.
 *
 * Deploy is the exception and genuinely is `onSuccess`: it enqueues a job and
 * returns a `pending` Deployment immediately, so there is nothing ambiguous about
 * a failure.
 */
export function useComposeActions(composeId: string, environmentId?: string) {
  const invalidate = useInvalidate();
  const forgetVisited = useForgetVisited();
  const refresh = () => invalidate.compose({ composeId, environmentId });

  return {
    deploy: useMutation({
      mutationFn: (title?: string) =>
        deploymentsApi.deployCompose(composeId, title ? { title } : undefined),
      onSuccess: async () => {
        await invalidate.composeDeployments(composeId);
        await refresh();
      },
    }),
    start: useMutation({
      mutationFn: () => composeApi.start(composeId),
      onSettled: refresh,
    }),
    /** `docker compose restart`, for a stack on a Stack VM. */
    restart: useMutation({
      mutationFn: () => composeApi.restart(composeId),
      onSettled: refresh,
    }),
    stop: useMutation({
      mutationFn: () => composeApi.stop(composeId),
      onSettled: refresh,
    }),
    /**
     * `docker compose rm --stop --force` — the rung between stop and delete
     * and it is in
     * the same boat as its two neighbours: the command runs inside the request,
     * so the row is the only honest account of what happened. `onSettled`.
     *
     * Offered only for a `docker-compose` stack — see `compose-actions.tsx`.
     */
    removeContainers: useMutation({
      mutationFn: () => composeApi.removeContainers(composeId),
      onSettled: refresh,
    }),
    /** `deleteVolumes` only reaches a `docker-compose` stack — see the dialog. */
    remove: useMutation({
      mutationFn: ({
        deleteVolumes,
        force = false,
      }: {
        deleteVolumes: boolean;
        /** The forced Delete, for a Server that is gone for good. */
        force?: boolean;
      }) => composeApi.remove(composeId, deleteVolumes, force),
      onSuccess: () => {
        forgetVisited([composeId]);
        return refresh();
      },
    }),
  };
}

/**
 * Create one.
 *
 * The response carries the new `composeId`, which the caller needs to go
 * straight to it. That used to be the *only* way the thing just created was
 * reachable; the Environment's Services tab now lists it too.
 */
export function useCreateCompose(environmentId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: CreateComposeInput) => composeApi.create(input),
    onSuccess: () => invalidate.compose({ environmentId }),
  });
}

/**
 * Whether a failed call means "it was refused" or "we stopped listening".
 *
 * F11's rule, and it applies here for the same reason: a 4xx is the backend
 * saying no and its message is the answer, while a 5xx or a dropped connection on
 * a call that runs `docker compose up` is most often the proxy timing out on an
 * image pull that is still going.
 */
export function wasRefused(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;
  return typeof status === "number" && status >= 400 && status < 500;
}
