import { useMutation, useQuery } from "@tanstack/react-query";

import { useForgetVisited } from "@/components/shell/recents";
import {
  backupsApi,
  type BackupListItem,
  type BackupServiceType,
} from "@/lib/api/endpoints/backups";
import {
  databasesApi,
  type CreateDatabaseInput,
  type DatabaseKind,
  type ExternalPortsInput,
  type UpdateDatabaseInput,
} from "@/lib/api/endpoints/databases";
import { keys } from "@/lib/api/keys";
import { useInvalidate } from "@/lib/api/use-invalidate";
import { useActiveOrganizationId } from "@/lib/auth/client";
import { roleRefusal } from "@/lib/auth/use-permission";

/**
 * Everything the six database screens read and write — **one module for all six
 * engines**, because there is one controller shape behind them and the engine is
 * a parameter, not a branch.
 *
 * Two things worth knowing before reading a panel:
 *
 * 1. **A database's deploy writes no Deployment.** The shared base pulls the
 *    image, converges the swarm service and waits for Swarm to decide, all in
 *    `BaseDatabaseService.deployInternal` — inside the request up to a bound,
 *    and past it the request answers `running` and the verdict moves
 *    `applicationStatus` to done or error on its own. There is no `deployment` row, no log
 *    file and no `/listen-deployment` to open — which is why there is no
 *    Deployments tab in this scope (F07) and why `useDatabase` polls: the status
 *    is a column something else wrote.
 * 2. **No engine controller lists.** `GET /:kind/:id` and nothing else — so a
 *    database is found through its **Environment**, whose read carries every
 *    service deployed in it
 * or by address,
 *    from Recents, or straight after being created. There is still no key here
 *    for "the databases", because there is still no request that asks for them.
 */

/**
 * `service: ['update']`: what `PATCH /:kind/:id` runs first, through
 * `BaseDatabaseService.findOwnedForUpdate`, on all six engines. Identity,
 * Credentials, Resources and Run command are its four cards; the variables'
 * card beside them asks the same statement of `PATCH /:kind/:id/environment`.
 */
export const DATABASE_UPDATE_REFUSAL = roleRefusal(
  "change this database — its name, image, credentials, resources or run command",
);

/**
 * `service: ['create']` and `service: ['update']`: `POST
 * /:kind/:id/external-port` (LibSQL's `/external-ports`) is decorated with the
 * first and runs `findOwnedForUpdate`, which asks the second. The base member
 * holds `update` and not `create`, so it is the decorator that refuses them.
 */
export const DATABASE_PORTS_REFUSAL = roleRefusal(
  "publish this database's ports",
);

/**
 * `service: ['delete']`, which `DELETE /:kind/:id` requires on all six engines
 * and the base member does not hold.
 */
export const DATABASE_DELETE_REFUSAL = roleRefusal("delete a database");

/** Slow enough not to be a load, fast enough that a converge is seen landing. */
export const LIVE_POLL_MS = 3_000;

/**
 * One database.
 *
 * Keyed exactly the way `use-scope-queries.ts` keys the masthead's identity
 * query, so a panel opens with the row already in cache and the two can never
 * disagree about the database's name.
 *
 * **It polls while the row says `running`,** and the decision is re-made from
 * each answer so the poll turns itself off. `running` here means the converge is
 * in flight — a pull and a service update, which is seconds on a warm host and
 * minutes on a cold one — and nothing pushes the transition to `done`.
 */
export function useDatabase(
  kind: DatabaseKind | null,
  databaseId: string,
  options: { live?: boolean } = {},
) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.databases.detail(organizationId, kind ?? "", databaseId),
    queryFn: () => databasesApi.findOne(kind as DatabaseKind, databaseId),
    enabled: organizationId !== null && kind !== null && databaseId !== "",
    refetchInterval: (query) =>
      options.live || query.state.data?.applicationStatus === "running"
        ? LIVE_POLL_MS
        : false,
  });
}

/**
 * Whether the database's data volume is on its Server, for the Delete dialog.
 * Read only while the dialog is open, fresh each time it opens —
 * `staleTime: 0` and removed on close by `gcTime: 0` — because the answer is
 * the Server's now, and a deploy or rebuild since the last open changes it.
 * `retry: false`: a Server that does not answer is already `present: null`, and
 * a refusal is not going to change on a second ask.
 */
export function useDataVolume(
  kind: DatabaseKind,
  databaseId: string,
  enabled: boolean,
) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: [
      ...keys.databases.detail(organizationId, kind, databaseId),
      "volume",
    ] as const,
    queryFn: () => databasesApi.dataVolume(kind, databaseId),
    enabled: enabled && organizationId !== null && databaseId !== "",
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
}

/**
 * The row, patched. Name, description, image, resources, run command and the
 * connection columns all go through this one route.
 */
export function useUpdateDatabase(
  kind: DatabaseKind | null,
  databaseId: string,
  environmentId?: string,
) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: UpdateDatabaseInput) =>
      databasesApi.update(kind as DatabaseKind, databaseId, input),
    onSuccess: () =>
      invalidate.database({
        kind: kind ?? undefined,
        databaseId,
        environmentId,
      }),
  });
}

/** The dotenv blob, whole — its own route, so a save cannot carry anything else. */
export function useSaveDatabaseEnvironment(
  kind: DatabaseKind | null,
  databaseId: string,
  environmentId?: string,
) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (env: string | null) =>
      databasesApi.saveEnvironment(kind as DatabaseKind, databaseId, env),
    onSuccess: () =>
      invalidate.database({
        kind: kind ?? undefined,
        databaseId,
        environmentId,
      }),
  });
}

/**
 * The four lifecycle actions, and the one that publishes a port.
 *
 * All four have always been on the engines' shared base class. The Application
 * beside them caught up — see
 * `useApplicationLifecycle` — so the only one of these with no counterpart there
 * is `rebuild`, which throws the data volume away.
 *
 * Every one of them refreshes the row afterwards, because every one of them
 * writes `applicationStatus` — and the masthead badge reads it.
 *
 * **`onSettled`, not `onSuccess`, and that is a fix rather than a style.** A
 * database's deploy is synchronous: `deployInternal` pulls the image and waits
 * for the Swarm converge inside the request. A cold `docker pull mysql:8` takes
 * longer than the 30 seconds the dev proxy will hold a response open, so the
 * POST fails while the deploy carries on and succeeds. Driven, not guessed —
 * the request came back 500 at exactly 30005ms and the service reached 1/1
 * afterwards. Refreshing only on success would leave the screen showing `idle`
 * for a database that is running. The row is the truth; every outcome goes and
 * asks it.
 */
export function useDatabaseActions(
  kind: DatabaseKind | null,
  databaseId: string,
  environmentId?: string,
) {
  const invalidate = useInvalidate();
  const forgetVisited = useForgetVisited();
  const engine = kind as DatabaseKind;
  const done = () =>
    invalidate.database({
      kind: kind ?? undefined,
      databaseId,
      environmentId,
    });

  return {
    deploy: useMutation({
      mutationFn: () => databasesApi.deploy(engine, databaseId),
      onSettled: done,
    }),
    start: useMutation({
      mutationFn: () => databasesApi.start(engine, databaseId),
      onSettled: done,
    }),
    stop: useMutation({
      mutationFn: () => databasesApi.stop(engine, databaseId),
      onSettled: done,
    }),
    /** **Destroys the data volume.** See `databasesApi.rebuild`. */
    rebuild: useMutation({
      mutationFn: () => databasesApi.rebuild(engine, databaseId),
      onSettled: done,
    }),
    /** Publishing also converges the service, so the row moves with it. */
    saveExternalPorts: useMutation({
      mutationFn: (input: ExternalPortsInput) =>
        databasesApi.saveExternalPorts(engine, databaseId, input),
      onSettled: done,
    }),
    remove: useMutation({
      // `deleteData`: "also delete its data", in a Cloud account or on a Server.
      mutationFn: ({
        deleteData = false,
        force = false,
      }: {
        deleteData?: boolean;
        /** The forced Delete, for a Server that is gone for good. */
        force?: boolean;
      } = {}) => databasesApi.remove(engine, databaseId, deleteData, force),
      onSuccess: () => {
        forgetVisited([databaseId]);
        return done();
      },
    }),
  };
}

/**
 * Whether a failed lifecycle call means "it was refused" or "we stopped
 * listening".
 *
 * A 400 / 403 / 404 is the backend saying no, and the message is the answer. A
 * 5xx or a dropped connection on a call that converges a Swarm service is
 * ambiguous — most often it is the 30-second proxy timeout on a cold image
 * pull, and the operation is still running. Saying "nothing changed" there is
 * the wrong sentence, because something is changing right now.
 */
/**
 * Whether a deploy's answer says Swarm was still deciding when the request
 * gave up waiting. The backend answers within a bound under the
 * proxy's: decided, the row comes back `done` (a failure is a 4xx); not yet,
 * it comes back `running` and the status beside the name moves when Swarm
 * decides — which `useDatabase` polls for.
 */
export function stillConverging(answer: unknown): boolean {
  return (
    (answer as { applicationStatus?: unknown } | null)?.applicationStatus ===
    "running"
  );
}

export function wasRefused(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;
  return typeof status === "number" && status >= 400 && status < 500;
}

/**
 * Create one.
 *
 * The response carries the new row's engine-named id (`postgresId`, `redisId`,
 * …), which the caller needs in order to go straight to it. That used to be the
 * *only* way the thing just created was reachable; the Environment's Services
 * tab now lists it too, which is why `environmentId` is in the fan-out.
 */
export function useCreateDatabase(environmentId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (args: { kind: DatabaseKind; input: CreateDatabaseInput }) =>
      databasesApi.create(args.kind, args.input),
    onSuccess: () => invalidate.database({ environmentId }),
  });
}

/**
 * The dump files in a destination.
 *
 * Disabled until a destination is chosen, and **not refetched in the
 * background**: the route shells out to `rclone lsjson` against S3, over SSH
 * when the database is on a remote Server. That is a network round trip to a
 * third party, not a cache miss.
 *
 * `search` narrows server-side up to its last slash and filters the rest
 * (`endpoints/backups.ts`), so passing `<appName>/` lists just this database's
 * own dumps rather than the whole bucket.
 */
export function useBackupFiles(params: {
  destinationId: string;
  search: string;
  serverId: string | null;
  enabled?: boolean;
}) {
  const { organizationId } = useActiveOrganizationId();
  const { destinationId, search, serverId, enabled = true } = params;
  return useQuery({
    queryKey: [
      ...keys.destinations.all(organizationId),
      "files",
      destinationId,
      search,
      serverId,
    ] as const,
    queryFn: () => backupsApi.listFiles({ destinationId, search, serverId }),
    enabled: enabled && organizationId !== null && destinationId !== "",
    refetchOnWindowFocus: false,
  });
}

/**
 * This database's backup schedules, newest first.
 *
 * Keyed **under the database's own detail subtree** rather than in a group of its
 * own, which is the same composition `useBackupFiles` above uses: a backup hangs
 * off one engine row, so `invalidate.database({ kind, databaseId })` is already
 * the right fan-out and a schedule that has just been run or switched off
 * refreshes with the row it belongs to.
 *
 * `serviceType` is `null` for an engine with no dump command — Redis — and the
 * query does not run. That is the descriptor's answer, not an empty list.
 */
export function useBackups(
  kind: DatabaseKind | null,
  databaseId: string,
  serviceType: BackupServiceType | null,
) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: [
      ...keys.databases.detail(organizationId, kind ?? "", databaseId),
      "backups",
    ] as const,
    queryFn: () =>
      backupsApi.listByService({
        serviceId: databaseId,
        serviceType: serviceType as BackupServiceType,
      }),
    enabled:
      organizationId !== null &&
      kind !== null &&
      databaseId !== "" &&
      serviceType !== null,
  });
}

/**
 * The two things a row can be told to do without opening a form.
 *
 * Creating, editing and removing a schedule live in
 * `backups/use-backup-schedules.ts` — a cron expression, a destination, a
 * prefix, a database name and a retention count are a form with real decisions
 * in it, so they are kept with the form rather than with these two.
 */
export function useBackupActions(
  kind: DatabaseKind | null,
  databaseId: string,
) {
  const invalidate = useInvalidate();
  const done = () =>
    invalidate.database({ kind: kind ?? undefined, databaseId });

  return {
    /** Runs the dump now, outside its cron. Answers when the run is enqueued. */
    run: useMutation({
      mutationFn: (backupId: string) => backupsApi.run(backupId),
      onSuccess: done,
    }),
    /** Stops or resumes the cron. The row is the only record of which it is. */
    setEnabled: useMutation({
      mutationFn: (args: { row: BackupListItem; enabled: boolean }) =>
        backupsApi.update(args.row.backupId, { enabled: args.enabled }),
      onSuccess: done,
    }),
  };
}

/** **Destructive.** Feeds a dump into the running engine, replacing what is there. */
export function useRestoreBackup(
  kind: DatabaseKind | null,
  databaseId: string,
) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: Parameters<typeof backupsApi.restore>[0]) =>
      backupsApi.restore(input),
    onSuccess: () =>
      invalidate.database({ kind: kind ?? undefined, databaseId }),
  });
}
