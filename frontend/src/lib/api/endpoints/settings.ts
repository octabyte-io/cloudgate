import { api } from "../client";

/** Whether this is the Hosted instance or a Self-hosted one (ADR-0049). */
export type InstanceMode = "hosted" | "self-hosted";

/** `GET /settings/about` (`api-schemas`' `aboutSchema`). */
export interface InstanceAbout {
  product: "cloudgate";
  version: string;
  apiUrl: string | null;
  /** Absent only from an older backend, which was self-hosted. */
  mode?: InstanceMode;
}

/**
 * `settings.controller.ts` — how *this instance* is configured and how it is
 * doing.
 *
 * F14 opened this module with the one route its Monitoring screen read.
 * **F16 owns the settings screens and fills the rest of it in**, grouped the way
 * the phase's audit grouped the controller's 48 routes: the instance's own
 * identity and lifecycle here, Traefik's files and container in
 * `endpoints/traefik.ts`, and the cleanup surface at the bottom of this file.
 *
 * Three neighbours live elsewhere on purpose, because a reader looking for them
 * will look under the feature and not under "settings":
 * `endpoints/traefik.ts` has the file surface and the request-logging switch,
 * `endpoints/servers.ts` has `POST /settings/docker-cleanup` **with** a
 * `serverId` (it writes a `server` column and no other route can), and
 * `GET /settings/is-user-subscribed` is billing's and belongs to F18 — it is
 * deliberately absent here rather than declared twice.
 *
 * ## Four things this controller does that a screen has to know
 *
 * 1. **`POST /update-server` restarts Cloudgate.** The phase brief asked the
 *    question and the answer is yes, unambiguously: `UpdatesService.updateServer`
 *    runs `docker service update --force --image cloudgate/cloudgate:<latest>
 *    cloudgate`, which replaces the running task — the console you are looking at
 *    goes with it. `POST /reload-server` is the same command without the image
 *    change. Both are `DangerZone` actions and nothing else on these screens is.
 * 2. **`POST /update-server` can also do nothing at all.** It re-reads
 *    `getUpdateData` and only acts `if (data.updateAvailable)`, so on an
 *    up-to-date instance it answers `true` having run no command. A button that
 *    means "restart" on Tuesday and "nothing" on Wednesday is not one control, so
 *    the screen gates it on the update check rather than on the response.
 * 3. **Most of these are owner-or-admin.** `requireOwnerOrAdmin` throws a 403
 *    *before* the work, so a refusal must never be rendered as a reading: "your
 *    role cannot ask" and "Traefik is down" are opposite statements.
 * 4. **`GET /web-server` is the one read on this controller open to any
 *    authenticated member, and the singleton it answers with carries a
 *    secret.** `metricsConfig.server.token` is projected out server-side and
 *    replaced by `metricsConfig.server.hasToken`: that token is the whole of
 *    `POST /notifications/receive`'s authentication and the copy on this row
 *    fans a forged alert out to *every* organization, so a plain member could
 *    read it and write arbitrary alert text into every tenant's channels.
 *    `webServer()` below re-projects it in the client, as a second line of
 *    defence against an older backend. The row's other secret, the instance's
 *    own SSH private key, is gone altogether
 *    — it had no
 *    reader, and it had leaked through this route before.
 */

/** One leg of the health check. `message` is only present when unhealthy. */
export interface ServiceHealthStatus {
  status: "healthy" | "unhealthy";
  message?: string;
}

/**
 * What `GET /settings/infrastructure-health` reports.
 *
 * **Two legs: Postgres and Traefik.** Postgres is probed through the live
 * connection this backend already holds — there is no self-managed
 * `cloudgate-postgres` Swarm service to inspect — and there is no Redis leg,
 * because the deployment queue is in-process. So this is not a
 * "components: n of m healthy" readout with two of them missing; it is the two
 * things there are.
 */
export interface InfrastructureHealth {
  postgres: ServiceHealthStatus;
  traefik: ServiceHealthStatus;
}

/** The thresholds `ThresholdService` notifies on, off the web-server row. */
export interface MetricsThresholds {
  cpu: number;
  memory: number;
}

/**
 * The `web_server_settings` singleton, as the route answers with it and as this
 * module hands it on — the two agree now, and the history is why the projection
 * is still written twice.
 *
 * `getWebServerSettings` used to select the whole row, so the route really did
 * send the instance's SSH private key, decrypted, to any authenticated caller —
 * the same shape as `ssh-keys` and `notifications`. Unlike those two, a *type*
 * narrowing would not have been enough: TanStack holds the parsed response
 * whatever the declared type says, so the secret would still sit in the cache
 * and in every devtools panel over it. That argument is why `webServer()` keeps
 * deleting the metrics token at the client boundary even though the server no
 * longer sends it. The key itself, and its `hasSshPrivateKey` flag, are gone
 * from the row.
 */
export interface WebServerSettings {
  id: string;
  serverIp: string | null;
  certificateType: "letsencrypt" | "none" | "custom";
  https: boolean;
  host: string | null;
  letsEncryptEmail: string | null;
  enableDockerCleanup: boolean;
  logCleanupCron: string | null;
  buildsConcurrency: number;
  /** The Cloud run pool limit; more than one needs a licence. */
  cloudRunsConcurrency: number;
  /** The Cloud run time limit, in minutes. */
  cloudRunTimeLimitMinutes: number;
  /**
   * The longest a Requested preview may be asked to live, in minutes, 1..10080;
   * 1440 (24 hours) when never set. A request over it is refused, not
   * clamped. The 60-minute default a request gets when it names none is a
   * backend constant, not a setting.
   */
  requestedPreviewMaxTtlMinutes: number;
  enforceSSO: boolean;
  /**
   * Declared narrower than the route sends, which is the note in
   * `features/monitoring/use-monitoring.ts`: this is what the Platform screen
   * needed, and `asMetricsConfig` there widens it structurally for Monitoring.
   * `hasToken` is named here even though no screen on *this* side reads it,
   * because it is the field that stands where the credential was — a reader
   * looking for `token` needs to find out from the type that there isn't one.
   */
  metricsConfig: {
    server?: { thresholds?: MetricsThresholds; hasToken?: boolean };
  } | null;
  createdAt: string | null;
  updatedAt: string | null;
  /**
   * The console domain's origin and whether the backend lets a browser on it
   * sign in — `null` when no console domain is set. Derived by the
   * backend on every read from `BETTER_AUTH_URL`, `TRUSTED_ORIGINS` and the
   * owners' Trusted origins list, which is the list better-auth refuses
   * `INVALID_ORIGIN` against.
   */
  consoleOrigin: ConsoleOriginTrust | null;
  /**
   * Whether the platform host's `traefik.yml` carries request metrics
   * (ADR-0027) — read off the file on every request, so a fresh install reads
   * on and a host installed before it reads off until Enable request metrics.
   */
  requestMetricsEnabled: boolean;
}

/** The console domain as a browser signing in on it presents itself. */
export interface ConsoleOriginTrust {
  /** What a browser on the console domain sends in `Origin`. */
  origin: string;
  /** `false`: every sign-in there is refused `403 INVALID_ORIGIN`. */
  trusted: boolean;
}

/**
 * `POST /settings/update-data` — the running version against the latest
 * Cloudgate version on GitHub Releases (`cli-v*` releases never count).
 */
export interface UpdateData {
  /** The latest Cloudgate version's tag, `vX.Y.Z`. */
  latestVersion: string | null;
  updateAvailable: boolean;
  /**
   * The command that upgrades this instance to `latestVersion`, only when that
   * is newer, and never on the Hosted instance, which upgrades itself.
   */
  upgradeCommand: string | null;
  /**
   * Whether this instance runs as the `cloudgate` Docker service, the only
   * shape `updateServer` can move. False on every native install.
   */
  canUpdateInPlace: boolean;
  /**
   * `null` when the check ran to completion, including when it completed and
   * found nothing newer. A sentence naming the failure when it did not — an
   * unreachable api.github.com, or an HTTP status from it.
   *
   * This is the whole point: the Docker Hub check this replaced made the two
   * one answer, so an instance with nothing published was told it was up to date.
   */
  error: string | null;
}

/**
 * One reading off one host, with what configuration **declares** beside what the
 * host **reports**.
 *
 * **Both sides are independently nullable and a null is normal**: nothing pins
 * Postgres's version, a stopped Docker daemon answers nothing, and neither is a
 * failure of the request — the route still returns 200. A row that renders
 * either as an error tells somebody their platform is broken because a container
 * is off. `reason` and `raw` are **optional keys, absent rather than null**, so
 * `probe.reason === null` is never the test. And `drift` is never a guess: true
 * only when both sides are known and disagree.
 */
export interface Probe<T> {
  /** What Cloudgate's own configuration pins, or null where nothing pins it. */
  declared: T | null;
  /** What the host answered, or null — `reason` then says why. */
  observed: T | null;
  /** The host's unparsed answer, where `observed` is a reading of it. */
  raw?: string | null;
  /** Why `observed` is null. **Absent** when it is not. */
  reason?: string;
  /**
   * Which machine this reading is a fact about: `"host"` for the host the
   * request named, `"process"` for the Cloudgate process answering it. Present
   * and required on every probe, so a consumer never carries a list of which
   * keys are the exceptions and an absent `scope` can never mean `"host"`.
   */
  scope: "host" | "process";
  /** Both sides known and disagreeing. False whenever either side is unknown. */
  drift: boolean;
}

/**
 * `GET /settings/runtime-info` — everything one host is running, declared beside
 * observed.
 *
 * **Owner or admin only**, and a plain member gets a 403 before anything is
 * probed — a role answer, not a reading. `serverId` is `nullish` on the way in:
 * an omitted key and an explicit `null` both mean the platform host (ADR-0008).
 *
 * Two shapes here are not what they look like. `cloudgate` and `postgres`
 * describe **the process answering the request** whatever host is named — this
 * instance connects to one database and a Server has none of its own, and the
 * payload now says so itself: both carry `scope: "process"` while every other
 * probe carries `scope: "host"`, so this paragraph is a gloss on the
 * wire format rather than the only place the distinction exists. And
 * `directory` is **not** a `Probe`: free and total space come off the same `df`
 * line, so they share one `reason` and cannot be known separately — it carries
 * no `scope` and scopes itself by publishing its `path`.
 */
export interface RuntimeInfo {
  /** The Server described, or null for the platform host. */
  serverId: string | null;
  /** When the probe ran — not when it was served. The answer is cached 45s. */
  observedAt: string;
  cloudgate: {
    /** Always `"process"` — this block is never about the named host. */
    scope: "process";
    version: string;
    releaseTag: string;
    node: string;
    uptimeSeconds: number;
  };
  postgres: Probe<string>;
  /** `TRAEFIK_VERSION` against the running container's own image tag. */
  traefik: Probe<string>;
  /** `DOCKER_VERSION` — what setup installs — against the daemon's version. */
  docker: Probe<string>;
  swarm: Probe<string>;
  operatingSystem: Probe<string>;
  kernel: Probe<string>;
  uptimeSeconds: Probe<number>;
  cloudgateNetwork: Probe<boolean>;
  directory: {
    path: string;
    freeBytes: number | null;
    totalBytes: number | null;
    reason?: string;
  };
}

/** `GET /settings/gpu` — NVIDIA's answer on one host, as six readings. */
export interface GpuInfo {
  driverInstalled: boolean;
  driverVersion?: string;
  gpuModel?: string;
  runtimeInstalled: boolean;
  runtimeConfigured: boolean;
  cudaSupport: boolean;
  cudaVersion?: string;
  memoryInfo?: string;
  availableGPUs: number;
  swarmEnabled: boolean;
  gpuResources: number;
  /**
   * Not set up, set up the old way (`GPU=<n>`: run setup again), or set up by
   * card ID — only the last qualifies a GPU Server.
   */
  gpuSetup: GpuSetupState;
  /** The card IDs advertised, when set up by card ID. */
  gpuCardIds: string[];
}

/** `backend/src/settings/gpu-setup-state.ts`'s `GpuSetupState`. */
export type GpuSetupState = "none" | "count" | "card-id";

/**
 * `GET /settings/gpu/counts` — the counts-only read, live: cards a
 * reservation can use (advertised by card ID, else none) and how many no
 * running task holds. `gpuSetup` says why a machine has none.
 */
export interface GpuCounts {
  gpuSetup: GpuSetupState;
  cards: number;
  free: number;
}

/** One row of `docker system df`. */
export interface DockerDiskUsageItem {
  type: string;
  totalCount: number;
  active: number;
  size: string;
  reclaimable: string;
  sizeBytes: number;
}

/** `GET /settings/log-cleanup` — whether the nightly log prune is scheduled. */
export interface LogCleanupStatus {
  enabled: boolean;
  cronExpression: string | null;
}

export interface AssignDomainInput {
  host: string;
  certificateType: "letsencrypt" | "none" | "custom";
  letsEncryptEmail?: string | null;
  https?: boolean;
}

/**
 * `webServer()`'s metrics half: drop `server.token` and leave `server.hasToken`
 * standing where it was, deriving the flag from the value first if the response
 * only carried the value.
 *
 * Typed against `unknown` and rebuilt key by key rather than cast, because this
 * exists precisely for the case where the response is *not* the shape the type
 * claims. `null`, a missing `metricsConfig` and a missing `server` are all
 * "never set up", which is what `asMetricsConfig` in
 * `features/monitoring/use-monitoring.ts` independently concludes from the same
 * absence.
 */
function withoutMetricsToken(
  value: unknown,
): WebServerSettings["metricsConfig"] {
  if (value === null || typeof value !== "object") return null;
  const config = value as Record<string, unknown>;
  if (!config.server || typeof config.server !== "object") {
    return config as WebServerSettings["metricsConfig"];
  }
  const { token, hasToken, ...server } = config.server as Record<
    string,
    unknown
  >;
  return {
    ...config,
    server: {
      ...server,
      hasToken:
        typeof hasToken === "boolean"
          ? hasToken
          : typeof token === "string" && token.trim() !== "",
    },
  } as WebServerSettings["metricsConfig"];
}

export const settingsApi = {
  // ── The instance's own row ─────────────────────────────────────────────────

  /**
   * The singleton settings row. The server projects the row's secret out and
   * reports its presence instead — `metricsConfig.server.hasToken` for the
   * metrics agent token — so the flag is read from the response rather than
   * derived.
   *
   * The strip below stays as a second line of defence: this route is open to
   * any authenticated caller (no `requireOwnerOrAdmin`), so if it is ever
   * served by a backend that predates the fix, the token reaches neither a
   * screen nor the query cache. Deriving the flag is the fallback for that case
   * only — when the server sends it, the server wins. **The order matters**:
   * the flag is derived from the value *before* the value is dropped, or an
   * older backend would read as "never set up" and the Monitoring screen's
   * sampling switch would silently invert.
   *
   * An `sshPrivateKey` from an older backend, and the `hasSshPrivateKey`
   * flag a later one sends, are dropped here too: the console has nowhere to
   * show either.
   */
  webServer: async (): Promise<WebServerSettings> => {
    const row = await api.get<Record<string, unknown>>("/settings/web-server");
    const { metricsConfig, consoleOrigin, requestMetricsEnabled, ...rest } =
      row;
    delete rest.sshPrivateKey;
    delete rest.hasSshPrivateKey;
    return {
      ...(rest as Omit<
        WebServerSettings,
        "metricsConfig" | "consoleOrigin" | "requestMetricsEnabled"
      >),
      // An older backend sends none, which is "off": it has no way
      // to have written the block.
      requestMetricsEnabled: requestMetricsEnabled === true,
      // An older backend sends none, which is "not known" rather
      // than "trusted" — so nothing is claimed either way.
      consoleOrigin: (consoleOrigin as ConsoleOriginTrust | undefined) ?? null,
      metricsConfig: withoutMetricsToken(metricsConfig),
    };
  },

  /**
   * `GET /settings/about`, public: the product, the server version, the API's
   * own origin, and whether this is the Hosted instance (ADR-0049).
   */
  about: () => api.get<InstanceAbout>("/settings/about"),

  /** The version string this build carries. `Promise<string>` — hence `getText`. */
  version: () => api.getText("/settings/version"),

  /** The Docker tag it was built from: a version, or `canary` / `feature`. */
  releaseTag: () => api.getText("/settings/release-tag"),

  /** The address operators reach this instance on. Empty string when unset. */
  ip: () => api.getText("/settings/ip"),

  updateIp: (serverIp: string) =>
    api.post<WebServerSettings>("/settings/ip", { serverIp }),

  updateBuildsConcurrency: (buildsConcurrency: number) =>
    api.post<boolean>("/settings/builds-concurrency", { buildsConcurrency }),

  /** The Cloud run pool limit, behind the same instance authority. */
  updateCloudRunsConcurrency: (cloudRunsConcurrency: number) =>
    api.post<boolean>("/settings/cloud-runs-concurrency", {
      cloudRunsConcurrency,
    }),

  /** The Cloud run time limit in minutes. */
  updateCloudRunTimeLimit: (cloudRunTimeLimitMinutes: number) =>
    api.post<boolean>("/settings/cloud-run-time-limit", {
      cloudRunTimeLimitMinutes,
    }),

  /** Answers `true`, like builds-concurrency, behind the same instance authority. */
  updateRequestedPreviewMaxTtl: (requestedPreviewMaxTtlMinutes: number) =>
    api.post<boolean>("/settings/requested-preview-max-ttl", {
      requestedPreviewMaxTtlMinutes,
    }),

  /**
   * Point the console at a hostname and rewrite Cloudgate's own Traefik router.
   *
   * Writes `host`, `https`, `certificateType` and the ACME email, then
   * regenerates `dynamic/cloudgate.yml`. **Clearing the host removes that file**
   * (`updateServerTraefik` with a null host calls `removeConfig`), which is why
   * the form treats an empty host as its own deliberate action rather than as a
   * blank field.
   */
  assignDomain: (input: AssignDomainInput) =>
    api.post<WebServerSettings>("/settings/assign-domain", input),

  // ── Version and lifecycle ──────────────────────────────────────────────────

  /**
   * Ask GitHub Releases what the latest Cloudgate version is.
   *
   * A `POST` that writes nothing and reaches the network on every call — so it
   * is a query whose key is `keys.instanceUpdate()`, and it is never refetched
   * in the background.
   *
   * It answers 200 even when the check failed, and says so in `error`: an
   * unreachable or failing GitHub API is a sentence
   * on `error` rather than the `{latestVersion: null, updateAvailable: false}`
   * that also means "checked, nothing newer". Read `error` before you
   * read the other two.
   */
  updateData: () => api.post<UpdateData>("/settings/update-data"),

  /**
   * Move the `cloudgate` Docker service onto the newest Cloudgate version.
   *
   * **This restarts the instance.** See note 1 at the top of this file. It also
   * does nothing at all when no update is available, so nothing should call it
   * without having read `updateData()` first — and it answers **503** when the
   * check it re-runs did not complete, and **409** on an instance that is not
   * that Docker service (`canUpdateInPlace: false`), rather than silently doing
   * nothing.
   */
  updateServer: () => api.post<boolean>("/settings/update-server"),

  /**
   * Force the `cloudgate` service to restart on its current image.
   *
   * The same `docker service update --force`, minus the new image. Every open
   * connection to the console goes with it.
   */
  reloadServer: () => api.post<boolean>("/settings/reload-server"),

  /**
   * Are the platform's own two dependencies up?
   *
   * **Owner or admin only** — `requireOwnerOrAdmin` throws a 403 before the
   * probe runs. A screen must therefore never render a refusal as `unhealthy`:
   * "your role cannot ask" and "Traefik is down" are opposite statements, and the
   * second one sends somebody to a datacentre.
   *
   * `checkTraefikHealth` inspects the `cloudgate-traefik` **container** and falls
   * back to the Swarm **service** of the same name, so `unhealthy` also covers
   * "Traefik was never installed on this host" — which is why the message beside
   * it is worth rendering rather than summarising. `GET /settings/health` is the
   * public liveness probe and answers only for Postgres; it is not this.
   */
  infrastructureHealth: () =>
    api.get<InfrastructureHealth>("/settings/infrastructure-health"),

  /**
   * What one host is **actually** running, against what this Cloudgate pins.
   *
   * The fifth route over this ground and the only one that observes anything:
   * `version` and `release-tag` re-serve a constant, `infrastructure-health`
   * answers up or down, `health` is a public ping. Reach for this one when the
   * question is a version.
   *
   * **Owner or admin only.** A member's 403 is a role, not a reading — see
   * `RuntimeInfo`. `?? undefined` rather than passing `null` through, the same
   * shape `gpu` above uses: `null` and an omitted key mean the same host to the
   * DTO, and dropping the key keeps it out of the URL.
   */
  runtimeInfo: (serverId?: string | null) =>
    api.get<RuntimeInfo>("/settings/runtime-info", {
      query: { serverId: serverId ?? undefined },
    }),

  // ── GPU ────────────────────────────────────────────────────────────────────

  /**
   * What NVIDIA's tooling reports on a host. Owner or admin.
   *
   * **It never fails.** `checkGpuStatus` catches everything and answers with all
   * six readings false, so a host with no `nvidia-smi` and a host that refused
   * the SSH connection produce the same document — which is why the screen
   * presents these as findings about what is installed, and says nothing about
   * whether the machine was reachable.
   */
  gpu: (serverId?: string | null) =>
    api.get<GpuInfo>("/settings/gpu", {
      query: { serverId: serverId ?? undefined },
    }),

  /**
   * Cards and free cards on a host, for choosing a GPU reservation. Anyone who
   * may create a Service there — `service: ['create']` — unlike `gpu` above.
   */
  gpuCounts: (serverId?: string | null) =>
    api.get<GpuCounts>("/settings/gpu/counts", {
      query: { serverId: serverId ?? undefined },
    }),

  /** Point Docker at the NVIDIA runtime and list each card to Swarm by its ID. */
  setupGpu: (serverId?: string | null) =>
    api.post<{ success: boolean }>("/settings/gpu-setup", {
      serverId: serverId ?? undefined,
    }),

  // ── Maintenance ────────────────────────────────────────────────────────────

  /**
   * `docker system df`, parsed. **The platform host only** — `getDockerDiskUsage`
   * calls `execAsync` directly and takes no `serverId`, unlike every cleanup
   * route below it. Owner or admin.
   */
  dockerDiskUsage: () =>
    api.get<DockerDiskUsageItem[]>("/settings/docker-disk-usage"),

  /**
   * The nightly `docker` prune on the **platform host**.
   *
   * Called with no `serverId` it writes `webServerSettings.enableDockerCleanup`
   * and registers or unregisters the `50 23 * * *` job. The per-Server form of
   * the same route is `endpoints/servers.ts`'s, because that one writes a
   * `server` column.
   */
  updateDockerCleanup: (enableDockerCleanup: boolean) =>
    api.post<boolean>("/settings/docker-cleanup", { enableDockerCleanup }),

  logCleanup: () => api.get<LogCleanupStatus>("/settings/log-cleanup"),

  /**
   * Schedule or stop the deployment-log prune. `null` stops it.
   *
   * Note the gating: this one is **not** owner-or-admin — it takes instance
   * authority (`requireInstanceAuthority`), because the schedule it sets is the
   * whole instance's (H-64). It is listed with the other maintenance controls
   * anyway, because where a control sits should follow what it does and not who
   * may press it.
   */
  updateLogCleanup: (cronExpression: string | null) =>
    api.post<unknown>("/settings/log-cleanup", { cronExpression }),

  /** Drop every queued Deployment that has not started. Owner or admin. */
  cleanDeploymentQueue: () =>
    api.post<boolean>("/settings/clean-deployment-queue"),

  /**
   * The six Docker cleanups, each one `docker … prune --force` behind
   * `dockerSafeExec` (which waits up to 10 minutes for any docker command other than a logs/stats/events reader, then skips with a 409).
   *
   * `kind` is the path segment, so what a caller passes is the command that
   * runs. The two destructive ones — `docker-prune` (a full `system prune --all`
   * plus a builder prune) and `all` (every command in the table except volumes,
   * kicked off in the background) — are named here beside the harmless ones on
   * purpose: this module says what each route *is*, and `features/settings`
   * decides which of them get a `DangerZone`.
   */
  cleanup: (
    kind:
      | "images"
      | "volumes"
      | "stopped-containers"
      | "docker-builder"
      | "docker-prune"
      | "all"
      | "monitoring",
    serverId?: string | null,
  ) =>
    api.post<unknown>(`/settings/cleanup/${kind}`, {
      serverId: serverId ?? undefined,
    }),
};
