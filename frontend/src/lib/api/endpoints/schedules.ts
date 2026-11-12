import { api } from "../client";

import type { Deployment } from "./deployments";
import type { TeardownReport } from "./teardown";

/**
 * `scheduling/schedules/schedules.controller.ts` — a cron entry against a
 * service, a Server, or the Cloudgate host itself.
 *
 * `scheduleType` picks what the run *is*: an `application` or `compose`
 * schedule is a command `docker exec`'d in the running container, while a
 * `server` or `cloudgate-server` schedule is a script materialised as
 * `script.sh` and run on the host. The two use different columns —`command`
 * against a container, `script` against a host — and the form follows the type.
 *
 * **A run's outcome reads back through its Deployment rows, and it took two
 * fixes to get there.** `POST /:id/run` records a `deployment` row carrying
 * `scheduleId`, the schedule row carries no `lastRunAt` to fall back on, and for
 * a long time the only Deployment list routes were keyed by `applicationId` and
 * `composeId` — so a run was recorded and unreadable.
 *
 * 1. `GET /schedules/:scheduleId/deployments` — `runHistory` below, newest first.
 *    Access is resolved through `SchedulesService.findOne`, so it is exactly
 *    "whoever can read the schedule can read its runs", including that service's
 *    owner/admin gate on `server` and `cloudgate-server` schedules and its
 *    cross-organization rows reading as absent.
 * 2. Those runs' **logs** are readable, and it is the correction that decides
 *    how a screen links to one. `GET /deployments/:deploymentId/logs` was once
 *    claimed to "work on any deployment id"; it did not — it resolved ownership
 *    as `applicationId ?? composeId`, which is null on *every* schedule run, so
 *    the history could say last night's 03:00 job failed and never why. The fix
 *    extended that resolution to `scheduleId`, `volumeBackupId` and `backupId`.
 *
 * So a run's log is **`deploymentsApi.readLogs(row.deploymentId)`** — the ordinary
 * Deployment log route, by deployment id. Never `logPath`: that is an absolute
 * path on a Server's filesystem, and nothing in the browser can read it.
 */

export type ScheduleType =
  | "application"
  | "compose"
  | "server"
  | "cloudgate-server";

export type ShellType = "bash" | "sh";

export interface Schedule {
  scheduleId: string;
  name: string;
  description: string | null;
  cronExpression: string;
  /** Names the script directory and the run-log directory. Server-side. */
  appName: string;
  /** Compose only: which service in the stack runs the command. */
  serviceName: string | null;
  shellType: ShellType;
  scheduleType: ScheduleType;
  /** What `application` / `compose` schedules exec in the container. */
  command: string;
  /** What `server` / `cloudgate-server` schedules write as `script.sh`. */
  script: string | null;
  enabled: boolean;
  timezone: string | null;
  createdAt: string;
  applicationId: string | null;
  composeId: string | null;
  serverId: string | null;
  organizationId: string | null;
}

export interface CreateScheduleInput {
  name: string;
  description?: string;
  cronExpression: string;
  scheduleType?: ScheduleType;
  /** The target. Absent only for `cloudgate-server`, which has no service row. */
  serviceId?: string;
  serviceName?: string;
  shellType?: ShellType;
  command?: string;
  script?: string;
  enabled?: boolean;
  timezone?: string;
}

/** A schedule cannot be re-pointed, so `serviceId` and `scheduleType` stay out. */
export type UpdateScheduleInput = Partial<{
  name: string;
  description: string | null;
  cronExpression: string;
  serviceName: string | null;
  shellType: ShellType;
  command: string;
  script: string | null;
  enabled: boolean;
  timezone: string | null;
}>;

export const schedulesApi = {
  listByService: (
    serviceId: string,
    scheduleType: ScheduleType = "application",
  ) => api.get<Schedule[]>("/schedules", { query: { scheduleType, serviceId } }),

  findOne: (scheduleId: string) =>
    api.get<Schedule>(`/schedules/${scheduleId}`),

  create: (input: CreateScheduleInput) =>
    api.post<Schedule>("/schedules", input),

  update: (scheduleId: string, input: UpdateScheduleInput) =>
    api.patch<Schedule>(`/schedules/${scheduleId}`, input),

  /** Runs it now, outside its cron. Answers when the run is enqueued. */
  run: (scheduleId: string) => api.post<unknown>(`/schedules/${scheduleId}/run`),

  /**
   * This schedule's runs, newest first.
   *
   * **On the deployments controller, not this one** — `GET /schedules/:id/
   * deployments` — because a run *is* a Deployment row and the route is the cron
   * sibling of `listByApplication` and `listByCompose`. It is declared here
   * anyway: a schedule's run history is a fact about the schedule, and the panel
   * reading it has a `scheduleId` and no reason to know which controller answers.
   *
   * Each row's log is `deploymentsApi.readLogs(row.deploymentId)` (see the
   * note at the top of this file for why that is not obvious).
   */
  runHistory: (scheduleId: string) =>
    api.get<Deployment[]>(`/schedules/${scheduleId}/deployments`),

  remove: (scheduleId: string) =>
    api.delete<Schedule & Pick<TeardownReport, "unreclaimedArtifacts">>(
      `/schedules/${scheduleId}`,
    ),
};
