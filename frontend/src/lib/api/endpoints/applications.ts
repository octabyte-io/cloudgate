import { api } from "../client";
import { cloudName } from "./cloud-accounts";

import type { Environment } from "./environments";
import type { Project } from "./projects";
import type { Server } from "./servers";
import type {
  EndpointSpecSwarm,
  HealthCheckSwarm,
  LabelsSwarm,
  NetworkSwarm,
  PlacementSwarm,
  RestartPolicySwarm,
  ServiceModeSwarm,
  UlimitsSwarm,
  UpdateConfigSwarm,
} from "./swarm";
import type { TeardownReport } from "./teardown";

/**
 * `applications.controller.ts` — `create`, `findOne`, `update`,
 * `saveEnvironment`, `uploadDrop`, `remove`, plus the lifecycle group:
 * `start`, `stop` and `reload`. The group's fourth route, `refresh-token`,
 * rotates a deploy-webhook secret no route checks, and has no caller here.
 *
 * There is deliberately no `list` here: the backend has no `GET /applications`.
 * Applications are reached through their Environment.
 *
 * **The two lifecycle calls that are not here are here on purpose.** Redeploying
 * and cancelling write a `deployment` row, so they live on the deployments
 * controller and in `deploymentsApi` — `redeployApplication` and
 * `cancelDeployment` — beside `deployApplication`, which has always been there.
 */

/**
 * Every state the `application_status` column holds, whichever table carries it
 * (`application.schema.ts`).
 *
 * `"stopped"` is the fifth member and the only one no row is created with:
 * `"idle"` is the column's default, so a workload scaled to zero on purpose
 * used to be indistinguishable from one that had never been deployed.
 * Written by every Stop — a managed database's, and an Application's
 * and a Compose stack's — and by a stack's Remove containers.
 */
export type ApplicationStatus =
  | "idle"
  | "running"
  | "done"
  | "error"
  | "stopped";

export type SourceType =
  | "docker"
  | "git"
  | "github"
  | "gitlab"
  | "bitbucket"
  | "gitea"
  | "drop";

export type BuildType =
  | "dockerfile"
  | "heroku_buildpacks"
  | "paketo_buildpacks"
  | "nixpacks"
  | "static"
  | "railpack";

/**
 * What an Application is in Project config terms: the kind its config
 * entry names it by, recorded rather than read off its build type.
 */
export type ApplicationConfigKind =
  | "web"
  | "static"
  | "worker"
  | "web-private"
  | "cron";

export type TriggerType = "push" | "tag";

/** The discriminator every service-owned row carries. */
export type ServiceType =
  | "application"
  | "postgres"
  | "mysql"
  | "mariadb"
  | "mongo"
  | "redis"
  | "compose"
  | "libsql"
  | "bucket";

/**
 * The `application` row. `appName` names the container, its volumes and its
 * Traefik router, which is why it is immutable once created.
 *
 * Secrets are not here: registry passwords and git-provider tokens never leave
 * the backend (`applications.service.ts`).
 */
export interface Application {
  applicationId: string;
  name: string;
  appName: string;
  /**
   * The fixed key a Project config uses for this Service: minted from the
   * display name at create and never changed by a rename.
   */
  configName: string;
  /** Its kind in Project config terms. */
  configKind: ApplicationConfigKind;
  description: string | null;
  env: string | null;
  buildArgs: string | null;
  buildSecrets: string | null;
  watchPaths: string[] | null;
  memoryReservation: string | null;
  memoryLimit: string | null;
  cpuReservation: string | null;
  cpuLimit: string | null;
  command: string | null;
  args: string[] | null;
  /** The container port a `web` listens on (the config's `port`). */
  port: number;
  /**
   * A deploy-webhook secret with no webhook: minted on create and
   * rotatable at `POST /applications/:id/refresh-token`, but no route checks
   * it, so the console neither shows nor rotates it. The row carries the
   * current value — a secret the backend does hand back, unlike a registry
   * password — so never log a row or a write body.
   */
  refreshToken: string | null;
  sourceType: SourceType;
  cleanCache: boolean | null;
  // GitHub
  repository: string | null;
  owner: string | null;
  branch: string | null;
  buildPath: string | null;
  triggerType: TriggerType | null;
  autoDeploy: boolean | null;
  // GitLab
  gitlabProjectId: number | null;
  gitlabRepository: string | null;
  gitlabOwner: string | null;
  gitlabBranch: string | null;
  gitlabBuildPath: string | null;
  gitlabPathNamespace: string | null;
  // Gitea
  giteaRepository: string | null;
  giteaOwner: string | null;
  giteaBranch: string | null;
  giteaBuildPath: string | null;
  // Bitbucket
  bitbucketRepository: string | null;
  bitbucketRepositorySlug: string | null;
  bitbucketOwner: string | null;
  bitbucketBranch: string | null;
  bitbucketBuildPath: string | null;
  // Docker image source
  username: string | null;
  dockerImage: string | null;
  registryUrl: string | null;
  // Custom git
  customGitUrl: string | null;
  customGitBranch: string | null;
  customGitBuildPath: string | null;
  customGitSSHKeyId: string | null;
  enableSubmodules: boolean;
  dockerfile: string | null;
  dockerContextPath: string | null;
  dockerBuildStage: string | null;
  dropBuildPath: string | null;
  // Swarm service-spec overrides
  healthCheckSwarm: HealthCheckSwarm | null;
  restartPolicySwarm: RestartPolicySwarm | null;
  placementSwarm: PlacementSwarm | null;
  updateConfigSwarm: UpdateConfigSwarm | null;
  rollbackConfigSwarm: UpdateConfigSwarm | null;
  modeSwarm: ServiceModeSwarm | null;
  labelsSwarm: LabelsSwarm | null;
  networkSwarm: NetworkSwarm[] | null;
  stopGracePeriodSwarm: number | null;
  endpointSpecSwarm: EndpointSpecSwarm | null;
  ulimitsSwarm: UlimitsSwarm | null;
  rollbackActive: boolean;
  isPreviewDeploymentsActive: boolean;
  previewWildcard: string | null;
  /**
   * Whether preview routers ask the machine's `letsencrypt-dns` resolver for a
   * certificate covering `previewWildcard`. The backend refuses it on
   * without a preview wildcard, or without a DNS-01 setup on the machine this
   * Application runs on.
   */
  previewDnsChallenge: boolean;
  /**
   * How many pull-request previews this Application may hold at once. Zero
   * refuses them. Requested previews are counted against their own limit.
   */
  previewLimit: number;
  /** The container port a preview's router points at. */
  previewPort: number;
  /**
   * Whether anybody holding `deployment: ['create']` may ask for a Requested
   * preview of a branch here. Off by default; written under
   * `service: ['update']`, which no Agent role holds.
   */
  requestedPreviewsAllowed: boolean;
  /** How many Requested previews this Application may hold at once, at least 1. */
  requestedPreviewLimit: number;
  /** Replaces `env` for preview builds; null means they inherit it. */
  previewEnv: string | null;
  /** Replaces `buildArgs` for preview builds; null means they inherit it. */
  previewBuildArgs: string | null;
  replicas: number;
  /** Whole GPUs reserved per running copy; 0 for none. */
  gpus: number;
  applicationStatus: ApplicationStatus;
  buildType: BuildType;
  railpackVersion: string | null;
  herokuVersion: string | null;
  publishDirectory: string | null;
  isStaticSpa: boolean | null;
  createEnvFile: boolean;
  createdAt: string;
  registryId: string | null;
  buildRegistryId: string | null;
  environmentId: string;
  githubId: string | null;
  gitlabId: string | null;
  giteaId: string | null;
  bitbucketId: string | null;
  serverId: string | null;
  buildServerId: string | null;
}

/**
 * `GET /applications/:id` — the row plus its relation tree.
 *
 * Only the relations already typed in this phase are declared. The git-provider
 * and registry relations come down too; F10 and F15 add them when they build the
 * screens that read them.
 *
 * **No relation on this read carries a secret**, and the two `Server`s are the
 * case that needs saying, because `Server` is the same type `GET /servers`
 * answers with: their `metricsConfig.server` carries `hasToken` and not
 * `token`, which is why both fields on `MetricsConfig` are optional and why
 * `isCollecting` asks for the flag first. Reading `token` off one of these is
 * reading `undefined` — see `endpoints/servers.ts` for the route split.
 */
export interface ApplicationDetail extends Application {
  environment: Environment & { project: Project };
  server: Server | null;
  buildServer: Server | null;
  /** The model facet on an AI model; `null` on a plain Application. */
  aiModel: AiModel | null;
  /**
   * Where the other Services on its Server reach a web-private:
   * `http://<appName>:<port>`, a base URL used whole. `null` on any other kind.
   */
  internalAddress: string | null;
  /** A Cron service's timetable; `null` on any other kind. */
  cronService: CronService | null;
  /**
   * Where a Service in a Cloud account runs: its Cloud account and
   * region, readable with the Service alone. `null` on a Server's Service.
   */
  cloudPlace: CloudPlace | null;
  /**
   * A cloud Service's Delete under way or incomplete (ADR-0038);
   * `null` on every other Service.
   */
  cloudDelete: CloudDelete | null;
  /**
   * A `static` site on AWS's own S3 bucket, which its Delete empties
   * and destroys; `null` on any other Service. Absent from an older
   * API.
   */
  cloudBucketName?: string | null;
  /**
   * A `static` site on AWS's CloudFront name, `<id>.cloudfront.net`:
   * its generated Domain, once its create's run has made the distribution;
   * `null` on any other Service. Absent from an older API.
   */
  cloudDistributionDomain?: string | null;
  /**
   * A `web` on Cloud Run's own `*.run.app` host (S11): its
   * generated Domain, once its first deploy has applied; `null` on any other
   * Service. Absent from an older API.
   */
  cloudRunAddress?: string | null;
  /**
   * A `web` on Cloud Run's copy range (S10): the fewest and most
   * copies it runs, Cloudgate's, 0 and 10 at create and set with
   * `setCopyRange`. `null` on any other Service; absent from an older API.
   */
  minCopies?: number | null;
  maxCopies?: number | null;
  /**
   * When an Output it links to changed outside a plan: the page reads
   * "deploy to pick up the new value" until it deploys. Absent from an older
   * API.
   */
  wiredChangedAt?: string | null;
}

/**
 * A Cron service's timetable as its Service page reads it (ADR-0034):
 * config-owned, written only by a plan. It fires nothing until a build has
 * succeeded, since each run starts from the last successful build's image.
 */
export interface CronService {
  /** Five-field unix cron, as the config writes it. */
  schedule: string;
  /** The IANA time zone the schedule is read in. */
  timezone: string;
  /** A run's time limit, as the config writes it: `1h`, `30m`. */
  timeout: string;
  timeoutSeconds: number;
  /** The next instants it fires at, ISO, soonest first. */
  nextFireTimes: string[];
  waitingForFirstBuild: boolean;
}

/** A cloud Service's Cloud account and region. */
/** Something a cloud Delete should have removed and did not. */
export interface CloudLeftover {
  /** `ecs:service`, `iam:role`, `ec2:network-interface`, … as AWS names it. */
  type: string;
  /** Its ARN, or EC2's own id for a network card. */
  awsId: string;
  /** Its region; `global` for an IAM role. */
  region: string;
  /** Cloudgate's tag on it, `key=value`; `null` on one AWS made. */
  tag: string | null;
  /**
   * Left on purpose by the Delete: an S3 bucket whose emptying stopped
   * partway, so it still holds files.
   */
  because?: "partly-emptied";
}

/**
 * A cloud Service's Delete: `deleting` while its destroy-only Cloud
 * run is queued or running, `incomplete` once it ended with something left
 * in AWS or without finishing. A clean Delete drops the row.
 */
/**
 * Something a Delete on Google Cloud should have removed and did not
 * its type as Google names it, its fixed name, region and
 * Cloudgate's state label.
 */
export interface GoogleCloudLeftover {
  /** `run.googleapis.com/Service`, `iam.googleapis.com/ServiceAccount`, … */
  type: string;
  /** The fixed name Cloudgate gave it; a host rule's is its URL map's and host. */
  googleName: string;
  /** Its region; `global` for a global kind. */
  region: string;
  /** Cloudgate's state label on it, `key=value`; `null` on a kind that takes none. */
  label: string | null;
  /** A static site's bucket whose emptying stopped partway, so it still holds files. */
  because?: "partly-emptied";
}

/** Whether a leftover is Google Cloud's rather than AWS's. */
export function isGoogleLeftover(
  one: CloudLeftover | GoogleCloudLeftover,
): one is GoogleCloudLeftover {
  return "googleName" in one;
}

export interface CloudDelete {
  status: "deleting" | "incomplete";
  /** The Deployment that records the latest run. */
  deploymentId: string;
  retrying: boolean;
  /** The report's *Kept* list; empty in this slice. */
  kept: { type: string; awsId: string; region: string; cost: string }[];
  /** The report's *Left* list: AWS's, or Google Cloud's. */
  left: (CloudLeftover | GoogleCloudLeftover)[];
  /** Why the latest run did not finish; `null` when it did. */
  unfinished: string | null;
}

export interface CloudPlace {
  cloudAccountId: string;
  cloudAccountName: string;
  /** Which cloud; absent from an older API, which meant AWS. */
  cloud?: "aws" | "gcp";
  region: string;
}

/** A Cloud Run Service's copy range, as `PUT /applications/:id/copy-range` takes it. */
export interface CopyRangeInput {
  minCopies: number;
  maxCopies: number;
}

/** The cloud a cloud Service runs in, as the console names it. */
export function cloudNameOf(place: CloudPlace): string {
  return cloudName(place.cloud);
}

/** Whether a Service runs on Google Cloud: `false` on AWS or off any cloud. */
export function onGoogleCloud(place: CloudPlace | null | undefined): boolean {
  return place?.cloud === "gcp";
}

/**
 * The inference runtimes an AI model can run on: Ollama, vLLM and
 * llama.cpp.
 */
export type InferenceRuntime = "ollama" | "vllm" | "llama.cpp";

/**
 * Whether a runtime reads a Hugging Face token: vLLM and
 * llama.cpp fetch gated weights with one, and Ollama fetches none. The
 * backend's `INFERENCE_RUNTIMES[runtime].takesHfToken`.
 */
export const TAKES_HF_TOKEN: Record<InferenceRuntime, boolean> = {
  ollama: false,
  vllm: true,
  "llama.cpp": true,
};

/**
 * An **AI model**'s facet as every read shows it. Never its upstream
 * secret. `imageTag` is the tag it runs — `pin` when none was chosen — and
 * `offPin` says when the two differ. Its Hugging Face token is write-only:
 * a read says only whether one is set.
 */
export interface AiModel {
  runtime: InferenceRuntime;
  /** In the runtime's own naming, e.g. `smollm2:135m`. */
  model: string;
  imageTag: string;
  /** The tag the platform was tested with. */
  pin: string;
  offPin: boolean;
  /** Whether a Hugging Face token is set (vLLM or llama.cpp); never the token. */
  hasHfToken: boolean;
  /**
   * Its OpenAI-compatible base URL on the gateway,
   * `<platform host URL>/ai/<AI model id>/v1`; `null` while the
   * platform host URL is not configured (no console domain nor server IP).
   */
  endpoint: string | null;
}

export interface CreateApplicationInput {
  name: string;
  /** Generated server-side when omitted. Immutable afterwards. */
  appName?: string;
  description?: string;
  environmentId: string;
  /**
   * `null` is the platform host. Left out, the Application lands on the
   * Environment's Deploy target's Server.
   */
  serverId?: string | null;
  /** Whole GPUs per copy, checked against `serverId`'s cards. */
  gpus?: number;
  /** Makes this Application an AI model, for life. */
  aiModel?: {
    runtime: InferenceRuntime;
    model: string;
    imageTag?: string;
    /** Write-only, vLLM and llama.cpp only: injected as `HF_TOKEN`. */
    hfToken?: string;
  };
}

/**
 * What an Application's port change did to its Domains (ADR-0068): those
 * on the old port moved to the new one and routed there, and the others,
 * left on the port each names. On `update`'s answer only when the port
 * changed on a Server or the platform host; each list is by host.
 */
export interface DomainPortMove {
  from: number;
  to: number;
  moved: { domainId: string; host: string }[];
  left: { domainId: string; host: string; port: number | null }[];
}

/**
 * Everything `update` accepts. No `appName` (immutable) and no `environmentId`
 * (an Application does not move Environments); `applicationStatus` changes only
 * from inside the backend.
 */
export type UpdateApplicationInput = Partial<
  Omit<
    Application,
    | "applicationId"
    | "appName"
    | "environmentId"
    | "applicationStatus"
    | "createdAt"
    | "refreshToken"
  > & {
    /** Write-only: the pull credential for a private image. */
    password: string | null;
    /**
     * An AI model's model and image tag; `imageTag: null` returns it
     * to the pin. Refused on a plain Application.
     */
    aiModel: {
      model?: string;
      imageTag?: string | null;
      /** Write-only: a new token replaces it, `null` removes it. */
      hfToken?: string | null;
    };
  }
>;

export interface SaveApplicationEnvironmentInput {
  env?: string;
  buildArgs?: string;
  buildSecrets?: string;
  createEnvFile?: boolean;
}

/**
 * `GET /applications/:id/gpu-wait`: whether an Application reserving
 * GPUs has a task Swarm left pending because no node can take it, and its run
 * Server's free and total cards. Read live; writes nothing.
 */
export type GpuWait =
  | { waiting: false }
  | { waiting: true; free: number; cards: number };

/**
 * What wrote a line of a Cloud Run Service's Runtime log: the
 * app on stdout or stderr, the app through a log of its own, or Cloud Run
 * itself about the Service.
 */
export type RuntimeLogSource = "stdout" | "stderr" | "app" | "cloud-run";

/** One line of a cloud Service's Runtime log, naming the copy that wrote it. */
export interface RuntimeLogLine {
  /** The cloud's id for the line: a line read twice has the same id. */
  id: string;
  /** Epoch milliseconds. */
  at: number;
  /** The ECS task id, or Cloud Run's instance id (`""` for a message about no one copy). */
  task: string;
  message: string;
  /** Google Cloud only: the revision it is about, `null` for none. */
  revision?: string | null;
  /** Google Cloud only: what wrote it. */
  source?: RuntimeLogSource;
}

/**
 * `GET /applications/:id/runtime-log`: one read of a cloud Service's
 * Runtime log, every task merged by time, and the `since` of the next read.
 * Each read starts a few seconds back for lines CloudWatch takes in late, so a
 * line can come twice; its `id` says so. `more`: lines were left for a read
 * that can come at once.
 */
export interface RuntimeLog {
  lines: RuntimeLogLine[];
  next: number;
  more: boolean;
  /**
   * Google Cloud only: the project's log reads are backing off
   * after Google refused one over its quota, so the lines are further behind.
   */
  delayed?: boolean;
}

export const applicationsApi = {
  /** "Waiting for a GPU" — anyone who can read the Application. */
  gpuWait: (applicationId: string) =>
    api.get<GpuWait>(`/applications/${applicationId}/gpu-wait`),

  /** A cloud Service's Runtime log — anyone who can read the Service. */
  runtimeLog: (applicationId: string, since?: number) =>
    api.get<RuntimeLog>(`/applications/${applicationId}/runtime-log`, {
      query: since === undefined ? undefined : { since },
    }),

  findOne: (applicationId: string) =>
    api.get<ApplicationDetail>(`/applications/${applicationId}`),

  create: (input: CreateApplicationInput) =>
    api.post<Application>("/applications", input),

  /** `domainPortMove` when the edit changed the port (ADR-0068). */
  update: (applicationId: string, input: UpdateApplicationInput) =>
    api.patch<Application & { domainPortMove?: DomainPortMove }>(
      `/applications/${applicationId}`,
      input,
    ),

  /** The three encrypted variable columns, saved together. */
  saveEnvironment: (
    applicationId: string,
    input: SaveApplicationEnvironmentInput,
  ) =>
    api.patch<Application>(`/applications/${applicationId}/environment`, input),

  /**
   * The response carries what the teardown could not reclaim. It is the
   * last record of those — the row is gone — so a caller must render them.
   *
   * `deleteVolumes` also removes the Docker volumes its `volume` mounts name,
   * on its Server; a volume it keeps comes back in
   * `unreclaimedArtifacts` as a `volume` entry with its `reason`. Sent as
   * `"true"`/`"false"`, the way `composeApi.remove` sends it.
   *
   * `force` drops the row on a Server even when the service could not be
   * confirmed gone, naming it in `orphaned`; sent only when asked.
   */
  remove: (applicationId: string, deleteVolumes = false, force = false) =>
    api.delete<
      Application & TeardownReport & { cloudDelete?: CloudDelete | null }
    >(`/applications/${applicationId}`, {
      query: {
        deleteVolumes: deleteVolumes ? "true" : "false",
        ...(force ? { force: "true" } : {}),
      },
    }),

  /**
   * **Retry** a cloud Service's incomplete Delete: another
   * destroy-only Cloud run from the kept state. `service: delete`.
   */
  retryCloudDelete: (applicationId: string) =>
    api.post<Application & { cloudDelete: CloudDelete | null }>(
      `/applications/${applicationId}/delete/retry`,
    ),

  /**
   * **Forget** a cloud Service's incomplete Delete: the row dropped,
   * what is left in AWS written into the audit entry. `service: delete`.
   */
  forgetCloudDelete: (applicationId: string) =>
    api.post<{
      applicationId: string;
      forgotten: (CloudLeftover | GoogleCloudLeftover)[];
    }>(`/applications/${applicationId}/delete/forget`),

  /**
   * Scale the Swarm service back to one replica. **It does not build**: the
   * image and the service spec are whatever the last Deployment left, which is
   * why an Application that has never been deployed has nothing to start.
   */
  start: (applicationId: string) =>
    api.post<Application>(`/applications/${applicationId}/start`),

  /**
   * Scale the Swarm service to zero. Downtime, not deletion — the row, the
   * domains, the volumes and the published ports all survive.
   */
  stop: (applicationId: string) =>
    api.post<Application>(`/applications/${applicationId}/stop`),

  /**
   * Down and straight back up, on the spec the service already has. This is the
   * one to reach for when the process is wedged rather than the code wrong: no
   * clone, no build, no push, so it takes seconds instead of minutes.
   */
  reload: (applicationId: string) =>
    api.post<Application>(`/applications/${applicationId}/reload`),

  /**
   * A Cloud Run Service's copy range (S10): set on the service by
   * a direct call, then saved, so a range Google refuses is never kept.
   * `service: ['update']`. Refused `409` on any other Service.
   */
  setCopyRange: (applicationId: string, input: CopyRangeInput) =>
    api.put<ApplicationDetail>(
      `/applications/${applicationId}/copy-range`,
      input,
    ),

  /**
   * Ask the registry a Docker-image source pulls from whether it accepts this
   * login, before a Deployment finds out at the pull
   * Answers an
   * empty `204` when it does and a `400` carrying the registry's own refusal
   * when it does not. Leave `password` out to test the Application's stored one
   * — accepted only with the `registryUrl` and `username` it was saved with, so
   * the secret is never sent to a host somebody typed. Runs on the build host,
   * where the pull logs in.
   */
  testRegistryLogin: (
    applicationId: string,
    body: { registryUrl: string | null; username: string; password?: string },
  ) =>
    api.post<unknown>(
      `/applications/${applicationId}/test-registry-login`,
      body,
    ),

  /**
   * Upload a zip of the code and make it this Application's source: the
   * archive is unpacked on the build host and the row becomes `drop`. It does
   * not deploy — that stays `POST /applications/:id/deployments`.
   * `dropBuildPath` is the directory inside the archive to build, `/` if unset.
   */
  uploadDrop: (applicationId: string, zip: File, dropBuildPath?: string) => {
    const form = new FormData();
    form.append("zip", zip);
    if (dropBuildPath) form.append("dropBuildPath", dropBuildPath);
    return api.postForm<Application>(
      `/applications/${applicationId}/drop`,
      form,
    );
  },
};
