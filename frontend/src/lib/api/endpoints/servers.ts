import { api } from "../client";
import type { BoughtServerStage } from "./bought-servers";

/**
 * `servers.controller.ts`. Note `serverStatus` is only ever `active` or
 * `inactive` (`servers/server.schema.ts`) — there is no provisioning or
 * unreachable state to render.
 *
 * **F13 fills the rest in**, and three route shapes decided three screens:
 *
 * 1. **`validate` and `audit` both open an SSH session.** `validate` runs
 *    `echo ok`; `audit` uploads a readiness script and parses its JSON. Neither
 *    is something to refetch in the background — `keys.ts` says so and
 *    `use-invalidate.ts` deliberately leaves both out of `server()`.
 * 2. **`setup` has a socket, and the console uses that instead of this route.**
 *    It shells `curl … | sh` to install Docker on a cold host, so it runs for
 *    minutes, and holding a response open for that never worked: the proxy closed
 *    it while the script went on succeeding, which made "the request failed"
 *    and "the run failed" the same event. Now
 *    the gateway `/listen-server-setup` calls the same service with an `onData` that writes
 *    to the socket, and **the run ends by saying how it ended** — so the
 *    Infrastructure tab shows the output as it arrives and no longer has to infer
 *    the outcome from a second SSH round trip. `serversApi.setup` below stays for
 *    API callers that only want the outcome.
 */

export type ServerStatus = "active" | "inactive";

/** `deploy` runs services; `build` only builds images for other Servers. */
export type ServerType = "deploy" | "build";

/**
 * The `metricsConfig` column, as the API sends it — which is **not** quite the
 * column, on one field.
 *
 * `server.token` is the metrics agent's credential: possession of it is the
 * whole of `POST /notifications/receive`'s authentication. Every route a caller
 * who is not an operator of the Server can reach projects it out and sends
 * `server.hasToken` in its place. So the two fields are one field on the wire —
 * exactly one of them arrives — and which one depends on the route:
 *
 * - `GET /servers` and `GET /servers/:id` carry `token`. That is `server:read`,
 *   which the backend bypasses for owner/admin only, and the operator who may
 *   rotate a Server's token through the setup modal may read it back;
 * - `web_server_settings` (`GET /settings/web-server`) carries `hasToken` — the
 *   route is open to any authenticated member and the copy on that singleton
 *   fans a forged alert out to *every* organization;
 * - the nested `server` on a service read — `GET /applications/:id`,
 *   `GET /compose/:id`, every database read — carries `hasToken` too. Those are
 *   `checkServiceAccess(…, 'read')`, which a base member satisfies with one id
 *   in `accessedServices`, and that token authenticates alerts into the whole
 *   organization's channels while `memberRole` holds `notification: []`;
 * - and `POST /monitoring/servers/:serverId/setup` answers `hasToken`, like the
 *   `POST /admin/setup-monitoring` twin it shares a body with. It is
 *   `server:create`, so no base member reaches it — what made the echo a
 *   disclosure rather than a mirror is that `token` is now optional on that
 *   body: an omitted one keeps what is stored, so the row it answers can carry
 *   a value the caller never sent, and a custom role may hold `server:create`
 *   without the `server:read` that entitles it. Nothing reads the response
 *   anyway; `useSetupMonitoring` re-reads the row.
 *
 * **Never read either directly.** `configCollects` in `lib/format/sampling.ts`
 * is the one predicate that takes both, and `isCollecting` in
 * `lib/api/use-server-metrics.ts` asks it of a `Server` row. Reading `token` for anything other than "is a token
 * set" is what this shape exists to stop.
 */
export interface MetricsConfig {
  server: {
    type: "Cloudgate" | "Remote";
    refreshRate: number;
    port: number;
    /** Absent on any route that projects the credential out — see above. */
    token?: string;
    /** Sent in `token`'s place by the routes that project it out. */
    hasToken?: boolean;
    urlCallback: string;
    retentionDays: number;
    cronJob: string;
    thresholds: { cpu: number; memory: number };
  };
  containers: {
    refreshRate: number;
    services: { include: string[]; exclude: string[] };
  };
}

/** The `server` row. */
export interface Server {
  serverId: string;
  name: string;
  description: string | null;
  ipAddress: string;
  port: number;
  username: string;
  serverStatus: ServerStatus;
  serverType: ServerType;
  /** Custom setup script; empty means the default setup command runs. */
  command: string;
  enableDockerCleanup: boolean;
  /**
   * Whether this Server's Traefik keeps request metrics — the loopback counters
   * its Services' Error rate is read from (ADR-0027). Set by Enable request
   * metrics, and by setup on a Server whose traefik.yml it wrote.
   */
  requestMetricsEnabled: boolean;
  /**
   * The last attempt to reach this Server over SSH — Check now, the readiness
   * read every tab shows, or a setup run — and how it went. All three
   * are null until the first attempt. Read them through {@link lastReach}.
   */
  reachCheckedAt: string | null;
  reachOk: boolean | null;
  /** The refusal the console was shown; null when it was reached. */
  reachMessage: string | null;
  /** How the last setup run ended. Read through {@link lastSetup}. */
  setupRanAt: string | null;
  setupOk: boolean | null;
  setupMessage: string | null;
  sshKeyId: string | null;
  /**
   * The SSH host key this Server presented on Cloudgate's first connect, as
   * `ssh-keygen -lf` prints it (`SHA256:…`), or null until then and after
   * Forget host key. A connect that presents another is refused with a 409
   * whose code is `SERVER_HOST_KEY_CHANGED` (ADR-0074).
   */
  hostKeyFingerprint: string | null;
  /**
   * When this Server's **Maintenance** began (ISO), or null while it is not in
   * maintenance. While it is set nothing new starts containers on it: a deploy,
   * redeploy, rebuild, rollback or Start is refused with a 409 whose code is
   * {@link SERVER_IN_MAINTENANCE_CODE} (spec #1420).
   */
  maintenanceSince: string | null;
  /** Who started it: a user id, null while not in maintenance or once they are gone. */
  maintenanceStartedBy: string | null;
  metricsConfig: MetricsConfig;
  createdAt: string;
  organizationId: string;
  /**
   * The **Bought Server** behind this row and its stage (ADR-0071), or null
   * for a Server of the Organization's own. Read through {@link notReadyYet};
   * Delete also reads it, since it deletes a Bought Server's machine with its
   * data and backups and only forgets any other.
   *
   * `poweredOff` is an Operator's power-off for abuse (#1401) and the
   * reason, which every tab shows as "Powered off by Cloudgate: <reason>";
   * only an Operator powers it back on. `deletesOn` is the day it is due for
   * deletion, while a payment for it is failing (the red bar,
   * `BoughtServerNotice`); `deletedAt` is when its machine was deleted, for
   * the Deleted record kept with its Services.
   */
  boughtServer: {
    stage: BoughtServerStage;
    poweredOff?: { at: string; reason: string } | null;
    deletesOn: string | null;
    deletedAt: string | null;
  } | null;
}

/**
 * The `code` of every refusal of new work on a Server in **Maintenance**
 * (`backend/src/servers/server-maintenance.ts`): a 409 whose message names the
 * Server, "<name> is in maintenance".
 */
export const SERVER_IN_MAINTENANCE_CODE = "SERVER_IN_MAINTENANCE";

/** What a Server picker says beside a Bought Server that is not Ready, per stage. */
const NOT_READY: Record<Exclude<BoughtServerStage, "ready">, string> = {
  waiting_for_payment: "Waiting for payment",
  creating: "Creating",
  setting_up: "Setting up",
  changing: "Changing",
  deleting: "Deleting",
  deleted: "Deleted",
  failed: "Failed",
};

/**
 * Why nothing can be deployed to this Server yet, in a word for a picker
 * ("Setting up"), or `null` when it can be. Only a Bought Server is ever held
 * back, until it is Ready (spec #1387); the API refuses a deploy to one
 * before then, so a picker greys it out rather than offer a choice that fails.
 */
export function notReadyYet(server: {
  boughtServer?: Server["boughtServer"];
}): string | null {
  const stage = server.boughtServer?.stage;
  return stage && stage !== "ready" ? NOT_READY[stage] : null;
}

/**
 * A stored outcome: when it happened, whether it worked, and the refusal in
 * the words the console was shown when it did not.
 */
export interface StoredOutcome {
  ok: boolean;
  at: string;
  message: string | null;
}

/**
 * The last reach attempt, or `null` when Cloudgate has never tried.
 *
 * **This is what a Server tab says about reaching it**, rather than whatever
 * request that tab happened to make: each card used to hold its own result
 * until the operator navigated away, so Infrastructure said "Nothing has been
 * checked yet" one card above "could not reach that Server".
 */
export function lastReach(
  server: Pick<Server, "reachCheckedAt" | "reachOk" | "reachMessage">,
): StoredOutcome | null {
  if (!server.reachCheckedAt) return null;
  return {
    ok: server.reachOk === true,
    at: server.reachCheckedAt,
    message: server.reachMessage,
  };
}

/** How the last setup run ended, or `null` when setup never ran. */
export function lastSetup(
  server: Pick<Server, "setupRanAt" | "setupOk" | "setupMessage">,
): StoredOutcome | null {
  if (!server.setupRanAt) return null;
  return {
    ok: server.setupOk === true,
    at: server.setupRanAt,
    message: server.setupMessage,
  };
}

export interface CreateServerInput {
  name: string;
  description?: string;
  ipAddress: string;
  /** Defaults to 22 server-side. */
  port?: number;
  /** Defaults to `root` server-side. */
  username?: string;
  sshKeyId: string;
  serverType?: ServerType;
}

export interface UpdateServerInput {
  name?: string;
  description?: string | null;
  ipAddress?: string;
  port?: number;
  username?: string;
  sshKeyId?: string;
  serverType?: ServerType;
  command?: string;
}

/**
 * What the readiness script reports (`servers/server-audit.ts`). Every field is
 * a fact about the host, which is why the screen can render it as a checklist.
 */
export interface ServerAudit {
  docker: { version: string; enabled: boolean };
  isSwarmActive: boolean;
  isNetworkInstalled: boolean;
  isMainDirectoryInstalled: boolean;
  privilegeMode: string;
  isDockerGroupMember: boolean;
}

export const serversApi = {
  list: () => api.get<Server[]>("/servers"),

  findOne: (serverId: string) => api.get<Server>(`/servers/${serverId}`),

  /**
   * Runs `echo ok` over SSH. Resolves when the Server answers; throws a 400
   * carrying the SSH failure when it does not, which is the interesting case.
   */
  validate: (serverId: string) =>
    api.get<{ status: "ok" }>(`/servers/${serverId}/validate`),

  audit: (serverId: string) =>
    api.get<ServerAudit>(`/servers/${serverId}/audit`),

  /**
   * Provisions the host: packages, Docker, `docker swarm init`, the
   * `cloudgate-network` overlay, `/etc/cloudgate/traefik/dynamic`, and Traefik.
   *
   * Runs the Server's own `command` instead when one is stored.
   *
   * **The console does not call this** — it opens `/listen-server-setup`, which
   * runs the same script and streams it (`features/server/use-server.ts`,
   * `useServerSetupRun`). This is the fire-and-forget shape: no output, and a
   * response held open for as long as the script takes. Note 2 above.
   */
  setup: (serverId: string) => api.post<unknown>(`/servers/${serverId}/setup`),

  /**
   * The nightly `docker system prune` cron, on or off for this Server.
   *
   * **It lives on the settings controller, not this one** —
   * `POST /settings/docker-cleanup` with a `serverId`, owner/admin only — and it
   * is declared here because it writes a `server` column and there is nowhere
   * else a person would look for it. `PATCH /servers/:id` cannot reach
   * `enableDockerCleanup`: `updateServerSchema` does not have the field, so this
   * route is the only writer there is. **F16 owns the settings screens and must
   * not add a second one.**
   */
  setDockerCleanup: (serverId: string, enableDockerCleanup: boolean) =>
    api.post<boolean>("/settings/docker-cleanup", {
      serverId,
      enableDockerCleanup,
    }),

  create: (input: CreateServerInput) => api.post<Server>("/servers", input),

  update: (serverId: string, input: UpdateServerInput) =>
    api.patch<Server>(`/servers/${serverId}`, input),

  remove: (serverId: string) => api.delete<Server>(`/servers/${serverId}`),

  /**
   * Forgets the recorded host key, so the next connect records the one the
   * Server presents then: the answer to a reinstall (ADR-0074).
   * `server: ['create']`, as `PATCH` is.
   */
  forgetHostKey: (serverId: string) =>
    api.post<Server>(`/servers/${serverId}/forget-host-key`),

  /**
   * Start Maintenance: nothing new starts containers on the Server until End
   * maintenance. `server: ['create']`, as every Server change is; a 409 when
   * it is already in maintenance.
   */
  startMaintenance: (serverId: string) =>
    api.post<Server>(`/servers/${serverId}/start-maintenance`),

  /** End Maintenance; a 409 when it is not in maintenance. */
  endMaintenance: (serverId: string) =>
    api.post<Server>(`/servers/${serverId}/end-maintenance`),
};
