import { api } from "../client";

/**
 * `deployments.controller.ts`. Deployments are triggered per service, and read
 * two ways: per service, and across the whole Organization.
 *
 * **`GET /deployments` is the organization-wide one** — `list` below. It is
 * cursor-paged, newest first, and resolves **all five owner kinds** on the way
 * out: the scheduled runs and the volume and database backup runs that no
 * fan-out over services could reach are rows in it like any build. That is why
 * the Deployments screen no longer states a coverage gap — there is none left to
 * state.
 *
 * The two per-owner reads stay, and are not the same question: a service's own
 * tab wants that service's history in full, unpaged and back to the beginning,
 * which is what `listByApplication` and `listByCompose` answer.
 *
 * `logPath` is the field that matters most on the client: it is what
 * `useDeploymentLog` opens the `/listen-deployment` socket with.
 */

/**
 * `pending` is there because a row exists from the moment a deploy is queued,
 * not only once the build starts
 * (`deployments/deployment.schema.ts`). `held` is a build a push recorded
 * and held for a plan: not queued until the plan is applied or
 * dismissed, or someone presses "Build now with saved settings".
 */
export type DeploymentStatus =
  | "pending"
  | "running"
  | "done"
  | "error"
  | "cancelled"
  | "held";

/**
 * The `deployment` row. Exactly one of the five owner ids is set — a Deployment
 * belongs to the thing whose run it tracks.
 */
export interface Deployment {
  deploymentId: string;
  title: string;
  description: string | null;
  status: DeploymentStatus;
  /** Absolute path on the build Server that the log is appended to. */
  logPath: string;
  applicationId: string | null;
  composeId: string | null;
  backupId: string | null;
  volumeBackupId: string | null;
  scheduleId: string | null;
  /**
   * The Environment network whose Cloud run this records; absent on a
   * feed older than the column.
   */
  environmentNetworkId?: string | null;
  /**
   * The plan a push held this build for, kept once it is released;
   * absent on a feed older than the column.
   */
  heldByPlanId?: string | null;
  /**
   * The plan a cloud Service's deploy stopped on: it met more than its
   * new image, ended `error`, and its whole plan became the Environment's
   * open plan. Absent on a feed older than the column.
   */
  reviewPlanId?: string | null;
  /**
   * Set on a row recording a Cloud run: its kind and the state it
   * locks. Absent on a feed older than the column; null on a build.
   */
  cloudRun?: {
    kind: "deploy" | "network" | "destroy" | "read";
    stateKey: string;
    environmentId: string;
    touchesNetwork: boolean;
  } | null;
  /**
   * Set on a **Run record** of a Cron service (ADR-0034): a run of it,
   * not one of its builds, though both hang off the Application. Its Swarm
   * job, the image it started from and who started it. Absent on a feed
   * older than the column; null on a build.
   */
  cronRun?: CronRunMark | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** What marks a Deployment as a Cron service's run. */
export interface CronRunMark {
  job: string;
  image: string;
  startedBy:
    | { kind: "member"; userId: string; name: string }
    | { kind: "timetable" };
  /** Set when its Cron service's Stop ended it; its status is `cancelled`. */
  stopped?: true;
}

/**
 * Which of the six owning rows a Deployment hangs off
 * (`deployments/service-scope.ts`). Two of them are the service's own build;
 * three are runs against a service — or, for a host-level schedule, against
 * no service at all; and the sixth is an Environment network's own Cloud run
 * which belongs to its Environment and to no Service.
 */
export type DeploymentOwnerType =
  | "application"
  | "compose"
  | "schedule"
  | "volumeBackup"
  | "backup"
  | "environmentNetwork"
  /** A postgres on RDS's own Cloud run, titled by the Service. */
  | "postgres"
  /** A mysql on RDS's own Cloud run, titled by the Service. */
  | "mysql"
  /** A bucket on AWS's own Cloud run, titled by the Service. */
  | "bucket"
  /** A redis on ElastiCache's own Cloud run, titled by the Service. */
  | "redis";

/**
 * One row of `GET /deployments`: the record, plus the names the ids on it do
 * not carry.
 *
 * **`project` and `environment` are null for a run that owns no service** — a
 * Server or Cloudgate-host schedule belongs to the Organization directly, and
 * there is no Environment it happened in. Nothing else in the feed is optional.
 *
 * The service *id* is deliberately not on the row: the feed resolves a run to
 * its service to scope and name it, and only the owner is addressable. So a
 * build links to its Application or stack, and a run links to where it ran.
 */
export interface DeploymentFeedRow extends Deployment {
  owner: { type: DeploymentOwnerType; id: string; name: string };
  project: { projectId: string; name: string } | null;
  environment: { environmentId: string; name: string } | null;
}

/** One page of the feed. `nextCursor` is null on the last page. */
export interface DeploymentFeedPage {
  rows: DeploymentFeedRow[];
  nextCursor: string | null;
}

/**
 * The feed's query (`listDeploymentsSchema`). `cursor` is the opaque token the
 * previous page answered with — keyset, not an offset, so a build landing while
 * a client walks the pages cannot make it repeat or skip a row.
 *
 * `limit` is capped at 100 server-side; anything higher is a 400.
 */
export interface ListDeploymentsQuery {
  limit?: number;
  cursor?: string;
  status?: DeploymentStatus;
  projectId?: string;
}

/** Both default to the manual-deployment banner when omitted. */
export interface TriggerDeploymentInput {
  title?: string;
  description?: string;
}

export const deploymentsApi = {
  /**
   * Every Deployment in the active Organization, newest first, one page at a
   * time. A restricted member's page holds only the services their member
   * row grants, which is the same row-level rule every per-service read applies.
   *
   * It takes a `signal` where the other reads do not, because its caller walks
   * several pages in one query function: TanStack cancels the query, and without
   * this the pages after the current one would still be asked for.
   */
  list: (query: ListDeploymentsQuery = {}, signal?: AbortSignal) =>
    api.get<DeploymentFeedPage>("/deployments", {
      query: { ...query },
      signal,
    }),

  listByApplication: (applicationId: string) =>
    api.get<Deployment[]>(`/applications/${applicationId}/deployments`),

  listByCompose: (composeId: string) =>
    api.get<Deployment[]>(`/compose/${composeId}/deployments`),

  deployApplication: (
    applicationId: string,
    input: TriggerDeploymentInput = {},
  ) =>
    api.post<Deployment>(`/applications/${applicationId}/deployments`, input),

  /**
   * **Run now** on a Cron service: one run, from the image of its last
   * successful build, as a one-off job. Answers the Run record once the job
   * is created; **409** while it is waiting for its first build.
   */
  runCronService: (applicationId: string) =>
    api.post<Deployment>(`/applications/${applicationId}/run`),

  deployCompose: (composeId: string, input: TriggerDeploymentInput = {}) =>
    api.post<Deployment>(`/compose/${composeId}/deployments`, input),

  /**
   * Build again from the source the Application already has — no new
   * commit needed. It records its own attempt, titled "Rebuild deployment", so
   * a retry is distinguishable from a first try in the history.
   */
  redeployApplication: (
    applicationId: string,
    input: TriggerDeploymentInput = {},
  ) => api.post<Deployment>(`/applications/${applicationId}/redeploy`, input),

  /**
   * Stop a build: dequeue a queued one, or kill a running one's
   * processes. Either way the Deployment comes back `cancelled`.
   *
   * A build past its shell steps answers **409**: releasing the image as a
   * Swarm service cannot be stopped part-way, so it finishes on its own. Treat
   * the 409 as the answer, not as a failed request to retry.
   */
  cancelDeployment: (deploymentId: string) =>
    api.post<Deployment>(`/deployments/${deploymentId}/cancel`),

  /**
   * **Stop the run**: ends a running Cloud run, its apply included —
   * one interrupt, a kill 5 minutes later. The row comes back still
   * `running` and ends `error` naming who stopped it, never `cancelled`.
   * 409 for a run still waiting (Cancel takes it out) or a row that is no
   * Cloud run.
   */
  stopRun: (deploymentId: string) =>
    api.post<Deployment>(`/deployments/${deploymentId}/stop-run`),

  /**
   * "Build now with saved settings": releases a build held for a plan
   * into the queue at once; the plan stays open. 409 when it is not held
   * (any more).
   */
  buildNow: (deploymentId: string) =>
    api.post<Deployment>(`/deployments/${deploymentId}/build-now`),

  /**
   * The last `tail` lines of a finished build, as one string — the route sends
   * `text/plain`, not JSON. Use this for a Deployment that has stopped; use
   * `useDeploymentLog` for one still running.
   */
  readLogs: (deploymentId: string, tail = 100) =>
    api.getText(`/deployments/${deploymentId}/logs`, { query: { tail } }),
};
