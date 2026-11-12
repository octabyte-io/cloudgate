import { api } from "../client";

import type { ApplicationStatus, TriggerType } from "./applications";
import type { Environment } from "./environments";
import type { Project } from "./projects";
import type { Server } from "./servers";
import type { TeardownReport } from "./teardown";

/**
 * `compose.controller.ts` — a Compose stack: several containers deployed
 * together from one file.
 *
 * The whole surface is ten routes, and **F12's audit of them changed two
 * screens**, so it is worth stating here rather than in a panel:
 *
 * - `POST /compose` · `GET /compose/:id` · `PATCH /compose/:id` ·
 *   `PATCH /compose/:id/environment` · `DELETE /compose/:id?deleteVolumes=`
 * - `POST /compose/:id/start` · `POST /compose/:id/stop` ·
 *   `POST /compose/:id/remove-containers`
 * - `GET /compose/:id/services` — **the service names the *file* declares**, not
 *   the containers that are running. For a `raw` source it parses the stored
 *   `composeFile`; for a git source it `cat`s the clone on the build Server and
 *   parses that (`ComposeService.loadServices`). So the Containers tab joins it to
 *   `dockerApi` for anything live, and a service the file declares but nothing is
 *   running still gets a row.
 * - `GET /compose/:id/converted` — **the file as the deploy actually applies it**
 * Answers YAML as
 *   `text/plain`, like the platform's other file reads, so it needs `getText`.
 * - Deploying is `deploymentsApi.deployCompose` — there is **no** compose
 *   redeploy or rebuild route, so Deploy / Start / Stop / Remove containers is
 *   the whole lifecycle.
 *
 * **No randomized names.** There are no `randomize` / `suffix` columns at all — `compose.schema.ts`'s header comment
 * says that feature is deliberately out of scope, which is why nothing in the app
 * offers it.
 */

/** `docker compose up` against a file, or a Swarm stack. */
export type ComposeType = "docker-compose" | "stack";

/**
 * What a `ComposeType` is called on screen — the masthead chip, the Overview
 * badge, the facts card and the editor alike. The masthead used to print
 * the column's own `docker-compose` beside an Overview badge saying "Docker
 * Compose", so one stack read as two kinds.
 */
export const COMPOSE_TYPE_LABEL: Record<ComposeType, string> = {
  "docker-compose": "Docker Compose",
  stack: "Swarm stack",
};

/**
 * The six sources a stack can come from — the shared `source_type` enum minus
 * `docker` and `drop`, which `updateComposeSchema`'s own `sourceType` enum
 * refuses. `raw` is the file written in Cloudgate itself.
 */
export type ComposeSourceType =
  | "git"
  | "github"
  | "gitlab"
  | "bitbucket"
  | "gitea"
  | "raw";

/**
 * The `compose` row.
 *
 * `appName` names the Docker stack (or the compose project), its networks and
 * its Traefik routers, which is why it is immutable and unique across the
 * instance. The git-provider columns are the **same names** an `application` row
 * uses — that is what lets one source form serve both — with one exception:
 * there is no per-provider build path, because a stack has a single
 * `composePath`.
 */
export interface Compose {
  composeId: string;
  name: string;
  /** The Docker stack name. Immutable, and unique across the instance. */
  appName: string;
  /**
   * The fixed key a Project config uses for this Service: minted from the
   * display name at create and never changed by a rename.
   */
  configName: string;
  description: string | null;
  /** The dotenv blob, decrypted on the way out. */
  env: string | null;
  /** The file itself, for a `raw` source. Empty for a git source. */
  composeFile: string;
  /** A deploy-webhook secret with no webhook: no route checks it or rotates
   *  it, and the console does not show it. */
  refreshToken: string | null;
  sourceType: ComposeSourceType;
  /** The `compose_status` column, on the same enum an Application uses. */
  composeStatus: ApplicationStatus;
  composeType: ComposeType;
  /** Where the file sits in the repository. Ignored for a `raw` source. */
  composePath: string;
  /** Replaces the generated `docker compose up` / `stack deploy` entirely. */
  command: string;
  enableSubmodules: boolean;
  /**
   * Deploy onto an app-named attachable network instead of the shared
   * `cloudgate-network`. The one rewrite toggle this backend has.
   */
  isolatedDeployment: boolean;
  watchPaths: string[] | null;
  // GitHub
  repository: string | null;
  owner: string | null;
  branch: string | null;
  triggerType: TriggerType | null;
  autoDeploy: boolean | null;
  // GitLab
  gitlabProjectId: number | null;
  gitlabRepository: string | null;
  gitlabOwner: string | null;
  gitlabBranch: string | null;
  gitlabPathNamespace: string | null;
  // Gitea
  giteaRepository: string | null;
  giteaOwner: string | null;
  giteaBranch: string | null;
  // Bitbucket
  bitbucketRepository: string | null;
  bitbucketRepositorySlug: string | null;
  bitbucketOwner: string | null;
  bitbucketBranch: string | null;
  // Custom git
  customGitUrl: string | null;
  customGitBranch: string | null;
  customGitSSHKeyId: string | null;
  createdAt: string;
  environmentId: string;
  /**
   * The Cloud account a stack on its own Stack VM is in (ADR-0070), with
   * its region; both `null` for a stack on a Server or this Cloudgate host.
   */
  cloudAccountId: string | null;
  region: string | null;
  githubId: string | null;
  gitlabId: string | null;
  giteaId: string | null;
  bitbucketId: string | null;
  /** `null` deploys onto the platform's own host. */
  serverId: string | null;
}

/**
 * Whether a stack runs on its own **Stack VM** (ADR-0070): the console's one
 * test for it. A stack's place is a Server, this Cloudgate host or a Cloud
 * account, fixed at create (ADR-0035), and only the last runs on a Stack
 * VM, so its Cloud account is the answer. Not `stackVmFacts`: a list row
 * carries no facts, and a stack whose Cloud account row is gone has none
 * while still running on its Stack VM.
 */
export function runsOnStackVm(
  compose: Pick<Compose, "cloudAccountId">,
): boolean {
  return compose.cloudAccountId != null;
}

/**
 * `GET /compose/:id/stack-vm` — whether the stack's Stack VM runs, read from
 * its cloud when asked (`StackVmPower.state`). `not-made`: no Apply has made
 * it yet. `gone`: the cloud no longer has it. `unknown`: the cloud did not
 * answer, `reason` in its own words.
 */
export interface StackVmStatus {
  state:
    | "running"
    | "starting"
    | "stopping"
    | "stopped"
    | "gone"
    | "not-made"
    | "unknown";
  reason?: string;
}

/**
 * `GET /compose/:id` — the row plus its relation tree, with every secret on
 * every relation stripped by the service (`ComposeService.findOne`, and
 * `common/service-read-relations.ts` for the rule). `server` is the case worth
 * naming: it is the same `Server` type `GET /servers` answers with, but its
 * `metricsConfig.server` carries `hasToken` rather than `token` — see
 * `endpoints/servers.ts`.
 */
export interface ComposeDetail extends Compose {
  environment: Environment & { project: Project };
  server: Server | null;
  /**
   * Its Stack VM, on a stack whose place is a Cloud account (ADR-0070);
   * `null` on a Server and on this Cloudgate host.
   */
  stackVmFacts: StackVmFacts | null;
}

/** The sizes a Stack VM is set to, as the Project config names them. */
export const STACK_VM_SIZES = [
  "xsmall",
  "small",
  "medium",
  "large",
  "xlarge",
  "2xlarge",
] as const;
export type StackVmSize = (typeof STACK_VM_SIZES)[number];

/** What each size asks of a Stack VM's machine, at least. */
export const STACK_VM_SIZE_WORDS: Record<StackVmSize, string> = {
  xsmall: "0.25 CPU, 512 MB",
  small: "0.5 CPU, 1 GB",
  medium: "1 CPU, 2 GB",
  large: "2 CPU, 4 GB",
  xlarge: "4 CPU, 8 GB",
  "2xlarge": "8 CPU, 16 GB",
};

/** The size a new Stack VM starts at. */
export const STACK_VM_STARTING_SIZE: StackVmSize = "medium";

/**
 * A stack's **Stack VM** as its page shows it (`stackVmFacts` in
 * `planner/stack-vm.ts`): the VM Cloudgate makes in the stack's Cloud
 * account and region to run it, never a Server.
 */
export interface StackVmFacts {
  cloud: "aws" | "gcp";
  region: string;
  /** Whether its plan has been applied; until then nothing runs. */
  made: boolean;
  /** `t3.small`, `e2-small`. */
  machineType: string;
  /** `2 vCPU, 2 GB`; `null` for a machine type Cloudgate does not list. */
  machine: string | null;
  sizeName: StackVmSize | null;
  /** The data disk its volumes live on, which only grows. */
  dataDiskGb: number;
  snapshotDays: number;
  /** What the stack page set, which the Environment's next plan applies. */
  console: { sizeName: StackVmSize | null; dataDiskGb: number | null };
  /** About this much a month, from Cloudgate's rate table; `null` when it has none. */
  monthlyUsd: number | null;
}

/** `PATCH /compose/:id/stack-vm`: the size, the data disk grown to, or both. */
export interface SaveStackVmInput {
  size?: StackVmSize;
  dataDiskGb?: number;
}

/**
 * What `POST /compose` accepts. Everything else is set through `update`, which
 * is why creating a stack from a git provider is two calls and the create modal
 * says so.
 */
export interface CreateComposeInput {
  name: string;
  /** Generated server-side when omitted. Immutable afterwards. */
  appName?: string;
  description?: string;
  environmentId: string;
  composeType?: ComposeType;
  serverId?: string | null;
  composeFile?: string;
  /**
   * Left out, the API stores `raw` for a non-empty `composeFile` and the
   * column's `github` otherwise (#1338).
   */
  sourceType?: ComposeSourceType;
}

/**
 * `updateComposeSchema` is `.partial()` over the editable columns. No `appName`
 * (it names the stack, its networks and its routers), no `environmentId` (a
 * stack does not move Environment), and no `composeStatus` — the deployment
 * engine writes that one.
 */
export type UpdateComposeInput = Partial<
  Omit<
    Compose,
    | "composeId"
    | "appName"
    | "environmentId"
    | "composeStatus"
    | "createdAt"
    | "refreshToken"
  >
>;

export const composeApi = {
  findOne: (composeId: string) =>
    api.get<ComposeDetail>(`/compose/${composeId}`),

  create: (input: CreateComposeInput) => api.post<Compose>("/compose", input),

  update: (composeId: string, input: UpdateComposeInput) =>
    api.patch<Compose>(`/compose/${composeId}`, input),

  /**
   * The dotenv blob, whole. Its own route, so saving variables cannot carry a
   * source column the screen happened to be holding.
   *
   * `saveComposeEnvironmentSchema` types `env` as `.optional()` and **not**
   * nullable, so clearing it is `""` rather than `null` — the opposite of the
   * database and Application routes, and the reason this takes a string.
   */
  saveEnvironment: (composeId: string, env: string) =>
    api.patch<Compose>(`/compose/${composeId}/environment`, { env }),

  /**
   * A stack's Stack VM setting (#1372): stored only. The Environment's next
   * plan shows the change with its price, and its Apply makes it.
   */
  saveStackVm: (composeId: string, input: SaveStackVmInput) =>
    api.patch<StackVmFacts>(`/compose/${composeId}/stack-vm`, input),

  /**
   * Remove the row, then tear the stack down best-effort.
   *
   * `deleteVolumes` is a query parameter and only reaches
   * `docker compose down --volumes` — a Swarm stack's volumes are **never**
   * removed either way (`composeTeardownCommand`, which has no volume flag on
   * its `docker stack rm` half), which is what the delete dialog has to say out
   * loud.
   */
  /** Carries the artifacts, images and workloads it could not reclaim. */
  remove: (composeId: string, deleteVolumes = false, force = false) =>
    api.delete<Compose & TeardownReport>(`/compose/${composeId}`, {
      // `force`: drop the row though the stack could not be confirmed gone
      // sent only when asked.
      query: {
        deleteVolumes: deleteVolumes ? "true" : "false",
        ...(force ? { force: "true" } : {}),
      },
    }),

  /**
   * Bring an already-built project up. **Only does anything for a
   * `docker-compose` stack** — the service's own comment says a Swarm stack is
   * (re)started by deploying it, and the route succeeds silently for one.
   */
  start: (composeId: string) =>
    api.post<Compose>(`/compose/${composeId}/start`),

  /** `docker compose stop`, or `docker stack rm` for a Swarm stack. */
  stop: (composeId: string) => api.post<Compose>(`/compose/${composeId}/stop`),

  /**
   * `docker compose restart`: the containers only. Offered for a stack on a
   * Stack VM, whose VM keeps running (ADR-0070).
   */
  restart: (composeId: string) =>
    api.post<Compose>(`/compose/${composeId}/restart`),

  /** Whether the stack's Stack VM runs, read from its cloud now. */
  stackVmStatus: (composeId: string) =>
    api.get<StackVmStatus>(`/compose/${composeId}/stack-vm`),

  /**
   * `docker compose rm --stop --force` — the third lifecycle rung, between
   * `stop` and `remove`.
   *
   * It removes the project's containers and **nothing else**: the project
   * network, the project directory, the volumes and this row all survive, so
   * `start` brings the stack back. That is the whole reason it exists —
   * `docker compose stop` leaves its containers `Exited`, Docker's volume
   * refcount counts an exited container, and a volume restore therefore refused
   * until somebody removed them from a shell on the host. ADR-0011 records why
   * this is a new rung rather than a change to what `stop` means, and why the
   * command is not `down` (that removes the network Traefik is attached to) and
   * carries no `-v` (that would destroy anonymous volumes).
   *
   * Answers the updated row, exactly the way `stop` does. **Only offered for a
   * `docker-compose` stack**: for a Swarm one `stop` is already `docker stack
   * rm`, so this would duplicate it.
   */
  removeContainers: (composeId: string) =>
    api.post<Compose>(`/compose/${composeId}/remove-containers`),

  /** The service names the **file** declares. See the note at the top. */
  loadServices: (composeId: string) =>
    api.get<string[]>(`/compose/${composeId}/services`),

  /**
   * The compose file as the deploy applies it. **`text/plain`**, so
   * `getText` — `api.get<string>` on a Nest route typed `Promise<string>` hands
   * back `undefined` with a type that says otherwise.
   *
   * The same rewrite `getBuildComposeCommand` pipes onto the build server
   * (`writeDomainsToCompose`), fed the same domains the deployment engine loads,
   * serialized back to YAML. Read-scoped like `loadServices`; the stored file is
   * never touched. So this is the artifact, not a second implementation of it —
   * which is the whole reason the Converted tab may now draw a diff.
   *
   * **Two 400s are the stack's own configuration and are the answer, not a
   * failure**: an empty file, and a domain naming a service the file does not
   * declare. Both are refusals `writeDomainsToCompose` makes *before the deploy
   * writes anything*, so this route is the cheapest place to find out.
   *
   * For a git source it reads the clone on the build Server, so it answers
   * nothing until the stack has been deployed once — the same condition
   * `loadServices` has.
   */
  getConverted: (composeId: string) =>
    api.getText(`/compose/${composeId}/converted`),
};
