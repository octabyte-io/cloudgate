import { valueVariable } from '../../definitions/tofu-json';
import { literal, ref } from '../../definitions/tofu-json';
import { markDescription, stateLabels } from './mark';
import { serviceName } from './names';
import { placeSecrets, secretName } from './secret-variables';
import { frame, LOAD_BALANCING_SCHEME } from './tofu-json';
import { layNativeGcp } from '../../../native/gcp-lay';
import type { NativeGcpBlock } from '../../../native/gcp-native';
import type {
  ConfigKind,
  PlanRefusal,
  WebEntry,
} from '../../../project-config';
import type { TofuDefinition } from '../../definitions/tofu-json';
import type { GcpNetworkNames } from './stand-ins';

/**
 * A Cloud Run CPU and memory pair, already rounded up to one Cloud Run
 * allows (the Google Cloud spec, "Sizes", S3): the planner's to choose, this file's to
 * write.
 */
export interface CloudRunPair {
  readonly cpu: number;
  readonly memoryMb: number;
}

export interface GcpWebDefinitionInput {
  /** The entry's Config name: the Service's name in the Environment. */
  readonly configName: string;
  readonly entry: WebEntry;
  readonly service: {
    readonly serviceId: string;
    /**
     * The copy range a create writes, 0 and 10 by default (S10). After the
     * create it is set by a direct call, and the definition ignores it.
     */
    readonly copies: { readonly min: number; readonly max: number };
  };
  /** Cloudgate's id of the Cloud account, for the mark. */
  readonly cloudAccountId: string;
  /** The Google Cloud project the Cloud account connects. */
  readonly projectId: string;
  readonly region: string;
  readonly environmentId: string;
  /** The Service's Infrastructure state. */
  readonly stateId: string;
  /** The network's saved names, or `gcpNetworkStandIns()` before it is made. */
  readonly network: GcpNetworkNames;
  readonly pair: CloudRunPair;
  /** The Deployment's id, or `STAND_IN_IMAGE_TAG` before a build. */
  readonly imageTag: string;
  /**
   * The Service's variables' resolved values, which reach `tofu` only
   * through the result's `variables`.
   */
  readonly variables: Readonly<Record<string, string>>;
  /**
   * Its `native.gcp` (ADR-0044 rule 3), already checked: laid over
   * what this builder writes, field by field, before `main.tf.json` is
   * written; the container's object merged into its one container. A plan
   * read lays the entry's, a deploy and a read for Drift the applied one
   * its row holds. Absent or `null`: exactly Cloudgate's definition.
   */
  readonly native?: NativeGcpBlock | null;
}

export type CloudRunDefinitionResult =
  | {
      readonly ok: true;
      readonly definition: TofuDefinition;
      /**
       * Values for the definition's `sensitive` variables, which the run
       * passes as `TF_VAR_<name>`: one per variable with a value. Never
       * written to `main.tf.json`.
       */
      readonly variables: Record<string, string>;
    }
  | { readonly ok: false; readonly refusal: PlanRefusal };

/** The name of the one container in the revision, and of its image. */
export const CONTAINER_NAME = 'service';

/**
 * The resources a Service's first deploy makes before it pushes (the Google Cloud spec,
 * "A `web` deploy"): its Artifact Registry repository.
 */
export const GCP_REPOSITORY_ADDRESSES: readonly string[] = [
  'google_artifact_registry_repository.service',
];

/** The address of the secrets, one instance per variable name (S1). */
export const GCP_SECRET_ADDRESS = 'google_secret_manager_secret.variable';

const SECRET_VERSION_ADDRESS = 'google_secret_manager_secret_version.variable';

const SECRET_ACCESS_ADDRESS =
  'google_secret_manager_secret_iam_member.variable';

/** The outputs a Service's runs read. */
export const CLOUD_RUN_OUTPUTS = {
  /** The `run.app` address, saved as the generated Domain (S11). */
  serviceUri: 'service_uri',
  serviceName: 'service_name',
  /** Where the deploy pushes: `<region>-docker.pkg.dev/<project>/<repo>`. */
  repositoryUrl: 'repository_url',
  /** A Worker's worker pool, in place of a service and its address. */
  workerPoolName: 'worker_pool_name',
  /** A Cron service's job, which each run is one execution of. */
  jobName: 'job_name',
  /**
   * A Private web service's `run.app` URLs: Cloud Run v2's `urls`,
   * which hold `https://<service>-<project number>.<region>.run.app` beside
   * the older form `uri` holds. Read by {@link internalRunAppUrl}.
   */
  serviceUrls: 'service_urls',
} as const;

/**
 * The revision label Reload sets to the time of its call, so a new revision
 * of the same image rolls (S9).
 */
export const RELOAD_LABEL = 'cloudgate-reload';

/**
 * A Cron service's job's own task timeout (the Google Cloud kinds spec): a
 * backstop only. A run's `timeout` is Cloudgate's, which cancels the
 * execution at it; this stops a run Cloudgate lost track of within a day.
 */
export const JOB_TASK_TIMEOUT = '86400s';

/** Untagged versions older than this go, as a backstop. */
const UNTAGGED_MAX_AGE = '86400s';

/** The role a Service's own account holds on each of its secrets (S1, S8). */
const SECRET_ACCESSOR_ROLE = 'roles/secretmanager.secretAccessor';

/**
 * The OpenTofu definition of a `web` Service's own state on Google (the Google
 * Cloud spec). Pure: no Google call, no `tofu`, no
 * database.
 *
 * It holds the Service's Artifact Registry repository (Docker, tags left
 * mutable, untagged versions cleaned up after a day with the policy's dry-run
 * off), its own service account, which holds no role but reading its own
 * secrets (S8), the Cloud Run service, and the serverless NEG and backend
 * service the network's URL map routes its Domains to, by the same
 * `cloudgate-<service key>` name.
 *
 * **The Cloud Run service** runs the given pair with CPU only during
 * requests, takes traffic from anywhere with Cloud Run's invoker check off
 * (`allUsers` would be refused under domain-restricted sharing), and leaves
 * through Direct VPC egress on the network's subnet for private ranges only.
 * `deletion_protection` is off so a Delete can remove it (S15). It ignores
 * what Cloudgate sets by direct calls or Google sets by itself (S9): the
 * service-level scaling and launch stage (Stop), the revision's copy range
 * (S10), Reload's label and `client` / `client_version`.
 *
 * **Variables (S1)** are Secret Manager secrets, one per variable with a
 * value, each readable by the Service's account alone and referenced by
 * version number, so a changed value adds a version and rolls a revision.
 *
 * A variable Google cannot hold refuses, naming it, before anything is
 * written.
 *
 * It is {@link cloudRunServiceDefinition} with public load balancer routing.
 */
export function webDefinition(
  input: GcpWebDefinitionInput,
): CloudRunDefinitionResult {
  const { entry, ...rest } = input;
  return cloudRunServiceDefinition({
    ...rest,
    entry,
    routing: { kind: 'public-load-balancer', port: entry.port },
  });
}

/**
 * What of its Config entry a Cloud Run definition reads, whatever its kind:
 * the `command` and `args` its container runs. The port is the routing's,
 * since not every kind has one ({@link CloudRunRouting}).
 */
export type CloudRunEntry = Pick<WebEntry, 'command' | 'args'>;

/**
 * How traffic reaches a Cloud Run Service: the one thing in which a `web`, a
 * Worker and a Private web service differ on Google Cloud (the Google Cloud
 * kinds spec, "Worker on Google Cloud"), so one builder
 * ({@link cloudRunServiceDefinition}) makes all three and they cannot drift
 * apart (the Google twin of the AWS builder).
 *
 * - **public load balancer**: a `web`. Ingress from anywhere, and the
 *   serverless NEG and backend service the network's URL map routes the
 *   Service's Domains to.
 * - **none**: a Worker. A Cloud Run worker pool in place of the
 *   service: no ingress, no port, no URL, no NEG, no backend service and no
 *   Domain. Its instance count is the Service's `replicas` on create, and
 *   Stop's and Start's afterwards.
 *
 * - **internal-only**: a Private web service. The same Cloud Run
 *   service as a `web`'s, with ingress `INTERNAL_ONLY`, reached from its
 *   own Environment network alone through the network's private `run.app`
 *   zone (`run-app-zone.ts`, ADR-0045), and no NEG, no backend service and
 *   no Domain.
 * - **job**: a Cron service. A Cloud Run job in place of the
 *   service: no ingress, no port, no URL, and nothing kept running; each
 *   run is one execution Cloudgate's timetable starts.
 */
export type CloudRunRouting =
  | {
      readonly kind: 'public-load-balancer';
      /** The container's port, which Cloud Run sends requests to. */
      readonly port: number;
    }
  | {
      readonly kind: 'internal-only';
      /** The container's port, which Cloud Run sends requests to. */
      readonly port: number;
    }
  | {
      readonly kind: 'none';
      /**
       * The worker pool's manual instance count a create writes: the
       * Service's `replicas`. Set by Stop and Start afterwards, and ignored
       * by the definition, so a stopped Worker is never Drift.
       */
      readonly instances: number;
    }
  /**
   * A Cron service: routed by nothing either, and run to its end
   * rather than kept running, one execution of its Cloud Run job per run.
   */
  | { readonly kind: 'job' };

/**
 * The Cloud Run resource a Service runs as on Google Cloud (the Google Cloud kinds spec):
 *
 * - **service**: a `web` or a Private web service. It
 *   takes requests, has a copy range, and logs as `cloud_run_revision`.
 * - **worker-pool**: a Worker, routed by nothing. Its instance
 *   count is its `replicas`, and it logs as `cloud_run_worker_pool`.
 * - **job**: a Cron service, whose runs end on their own, so it has no
 *   container that runs until stopped.
 *
 * Every Cloud Run check of what a Service is reads it from here
 * ({@link cloudRunResourceOf}) rather than from a kind name.
 */
export type CloudRunResource = 'service' | 'worker-pool' | 'job';

/**
 * A Service's Cloud Run resource by its config kind: the one place a kind
 * picks it, and so its routing ({@link cloudRunRoutingOf}), the twin of
 * `ecsRoutingOf`. Which kinds reach Cloud Run at all is `kindsOn('gcp')`'s.
 */
export function cloudRunResourceOf(kind: ConfigKind): CloudRunResource {
  if (kind === 'worker') return 'worker-pool';
  if (kind === 'cron') return 'job';
  return 'service';
}

/**
 * A Cloud Run Service's routing by its config kind: a worker pool's
 * none, at its `replicas`, whatever port its row keeps; a Private web
 * service's internal-only on `port`; any other service's the
 * public load balancer on `port`; a Cron service's job none, and no port.
 * Picked by its resource
 * ({@link cloudRunResourceOf}), so every plan read and deploy of a Service
 * writes the same one.
 */
export function cloudRunRoutingOf(
  kind: ConfigKind,
  port: number | null,
  replicas: number,
): CloudRunRouting {
  const resource = cloudRunResourceOf(kind);
  if (resource === 'worker-pool') return { kind: 'none', instances: replicas };
  if (resource === 'job') return { kind: 'job' };
  if (port === null) throw new Error(`A ${kind} on Cloud Run needs a port`);
  if (kind === 'web-private') return { kind: 'internal-only', port };
  return { kind: 'public-load-balancer', port };
}

/**
 * The input of {@link cloudRunServiceDefinition}: everything a `web`'s
 * definition takes, with its entry's port moved into `routing`.
 */
export interface CloudRunServiceDefinitionInput extends Omit<
  GcpWebDefinitionInput,
  'entry'
> {
  readonly entry: CloudRunEntry;
  readonly routing: CloudRunRouting;
}

/**
 * The OpenTofu definition of a Cloud Run Service of any kind:
 * everything {@link webDefinition} describes, with what routes traffic to
 * it chosen by `routing` ({@link CloudRunRouting}) and nothing else
 * differing.
 */
export function cloudRunServiceDefinition(
  input: CloudRunServiceDefinitionInput,
): CloudRunDefinitionResult {
  const placed = cloudRunPieces({
    configName: input.configName,
    serviceId: input.service.serviceId,
    cloudAccountId: input.cloudAccountId,
    projectId: input.projectId,
    region: input.region,
    environmentId: input.environmentId,
    stateId: input.stateId,
    variables: input.variables,
    native: input.native,
  });
  if (!placed.ok) return placed;
  const { pieces } = placed;
  const { routing } = input;
  if (routing.kind === 'none') return workerPool(pieces, input, routing);
  if (routing.kind === 'job') return cronJob(pieces, input);

  const internal = routing.kind === 'internal-only';
  const run = pieces.add('google_cloud_run_v2_service', 'service', {
    name: pieces.name,
    location: input.region,
    description: pieces.description,
    labels: pieces.labels,
    // A `web`: from anywhere, the public load balancer's. A Private web
    // service: from its own Environment network alone, which
    // reaches it through the network's `run.app` zone. Either way with
    // Cloud Run's invoker check off (`allUsers` would be refused under
    // domain-restricted sharing), so its callers send no token.
    ingress: internal ? 'INGRESS_TRAFFIC_INTERNAL_ONLY' : 'INGRESS_TRAFFIC_ALL',
    invoker_iam_disabled: true,
    deletion_protection: false,
    template: {
      service_account: ref(pieces.account, 'email'),
      scaling: {
        min_instance_count: input.service.copies.min,
        max_instance_count: input.service.copies.max,
      },
      vpc_access: directVpcEgress(input.network),
      containers: [
        cloudRunContainer(pieces, {
          entry: input.entry,
          pair: input.pair,
          imageTag: input.imageTag,
          port: routing.port,
          // CPU only during requests: request-based billing.
          cpuIdle: true,
        }),
      ],
    },
    lifecycle: {
      ignore_changes: [
        'scaling',
        // Stop's call moves it to `BETA`, as Google's own example of manual
        // scaling does.
        'launch_stage',
        'template[0].scaling',
        `template[0].labels["${RELOAD_LABEL}"]`,
        'client',
        'client_version',
      ],
    },
    ...pieces.waitForSecrets,
  });

  if (internal) {
    // No NEG, backend service or Domain block: nothing outside the
    // Environment routes to it. Its address is one of its `urls`.
    return pieces.finish({
      [CLOUD_RUN_OUTPUTS.serviceUri]: ref(run, 'uri'),
      [CLOUD_RUN_OUTPUTS.serviceUrls]: ref(run, 'urls'),
      [CLOUD_RUN_OUTPUTS.serviceName]: ref(run, 'name'),
    });
  }

  publicLoadBalancer(pieces, run, input.region);

  return pieces.finish({
    [CLOUD_RUN_OUTPUTS.serviceUri]: ref(run, 'uri'),
    [CLOUD_RUN_OUTPUTS.serviceName]: ref(run, 'name'),
  });
}

/**
 * The address a Private web service is handed over at: of its
 * applied `service_urls` output (Cloud Run v2's `urls`), the
 * `https://<service>-<project number>.<region>.run.app` one, the form Cloud
 * Run documents now, in whatever order Google lists them; else the first
 * `https://` one (the older `-<hash>-<region code>.a.run.app` form, which
 * `uri` holds, and which reaches it through the zone the same way, as
 * measured live); `null` when there is none. A base URL, used whole.
 */
export function internalRunAppUrl(
  urls: unknown,
  region: string,
): string | null {
  if (!Array.isArray(urls)) return null;
  const https = urls.filter(
    (url): url is string =>
      typeof url === 'string' && url.startsWith('https://'),
  );
  return (
    https.find((url) => url.endsWith(`.${region}.run.app`)) ?? https[0] ?? null
  );
}

/**
 * A Worker's Cloud Run worker pool (the Google Cloud kinds spec "Worker on Google
 * Cloud"), a `google_cloud_run_v2_worker_pool` of the GA `google` provider,
 * beside the pieces every Cloud Run resource of a Service keeps. What it drops is what
 * routes traffic: there is no ingress, no port, no URL, and no NEG, backend
 * service or Domain.
 *
 * - **Instances:** scaling mode `MANUAL`, written rather than left to
 *   Google's default, and `manual_instance_count` the Service's `replicas`
 *   on create; Cloudgate never asks a worker pool to scale itself. Stop sets it
 *   to 0 and Start back by direct calls, so the definition ignores it and a
 *   stopped Worker is never Drift. No `launch_stage`: it is GA.
 * - **Health:** no probe. A Worker is healthy when its instances run, and a
 *   Cloud Run probe could not run an image's `HEALTHCHECK` anyway.
 * - **CPU** is always allocated, a worker pool's only billing, so there is
 *   no `cpu_idle`.
 * - **Egress:** Direct VPC egress on the Environment network's subnet for
 *   private ranges only, as a `web`'s.
 */
function workerPool(
  pieces: CloudRunPieces,
  input: CloudRunServiceDefinitionInput,
  routing: Extract<CloudRunRouting, { kind: 'none' }>,
): CloudRunDefinitionResult {
  const pool = pieces.add('google_cloud_run_v2_worker_pool', 'service', {
    name: pieces.name,
    location: input.region,
    description: pieces.description,
    labels: pieces.labels,
    deletion_protection: false,
    // Manual said outright rather than left to Google's default, so the
    // instance count is the whole of its scaling.
    scaling: {
      scaling_mode: 'MANUAL',
      manual_instance_count: routing.instances,
    },
    template: {
      service_account: ref(pieces.account, 'email'),
      vpc_access: directVpcEgress(input.network),
      containers: [
        cloudRunContainer(pieces, {
          entry: input.entry,
          pair: input.pair,
          imageTag: input.imageTag,
        }),
      ],
    },
    lifecycle: {
      ignore_changes: [
        // The instance count is Stop's and Start's.
        'scaling',
        `template[0].labels["${RELOAD_LABEL}"]`,
        'client',
        'client_version',
      ],
    },
    ...pieces.waitForSecrets,
  });
  return pieces.finish({
    [CLOUD_RUN_OUTPUTS.workerPoolName]: ref(pool, 'name'),
  });
}

/**
 * A Cron service's Cloud Run job (the Google Cloud kinds spec "Cron service on Google
 * Cloud"; ADR-0034), a `google_cloud_run_v2_job` of the GA `google`
 * provider, beside the pieces every Cloud Run resource of a Service keeps.
 * Nothing runs until Cloudgate's timetable starts an execution of it (no
 * Cloud Scheduler), and each run is one execution, never retried.
 *
 * - **One task, no parallelism, no retries:** `task_count` and
 *   `parallelism` 1, `max_retries` 0, so a run is one fresh container.
 * - **Timeout:** the task's own is fixed at {@link JOB_TASK_TIMEOUT}, a
 *   backstop. The Cron service's `timeout` is Cloudgate's alone, which
 *   cancels the execution at it, so it is no Google setting and a change of
 *   it never reaches Google.
 * - **Health:** no probe. A run is judged only by how it ends.
 * - **Egress:** Direct VPC egress on the Environment network's subnet for
 *   private ranges only, as a `web`'s, so a run reaches the Environment's
 *   databases and Private web services.
 */
function cronJob(
  pieces: CloudRunPieces,
  input: CloudRunServiceDefinitionInput,
): CloudRunDefinitionResult {
  const job = pieces.add('google_cloud_run_v2_job', 'service', {
    name: pieces.name,
    location: input.region,
    labels: pieces.labels,
    deletion_protection: false,
    template: {
      task_count: 1,
      parallelism: 1,
      template: {
        service_account: ref(pieces.account, 'email'),
        max_retries: 0,
        timeout: JOB_TASK_TIMEOUT,
        vpc_access: directVpcEgress(input.network),
        containers: [
          cloudRunContainer(pieces, {
            entry: input.entry,
            pair: input.pair,
            imageTag: input.imageTag,
          }),
        ],
      },
    },
    lifecycle: { ignore_changes: ['client', 'client_version'] },
    ...pieces.waitForSecrets,
  });
  return pieces.finish({
    [CLOUD_RUN_OUTPUTS.jobName]: ref(job, 'name'),
  });
}

/**
 * A public load balancer's own resources: the serverless NEG on the
 * Cloud Run service and the backend service the network's URL map routes
 * the Service's Domains to, by the same `cloudgate-<service key>` name.
 */
function publicLoadBalancer(
  pieces: CloudRunPieces,
  run: string,
  region: string,
): void {
  const endpoints = pieces.add(
    'google_compute_region_network_endpoint_group',
    'service',
    {
      name: pieces.name,
      description: pieces.description,
      region,
      network_endpoint_type: 'SERVERLESS',
      cloud_run: { service: ref(run, 'name') },
    },
  );
  pieces.add('google_compute_backend_service', 'service', {
    name: pieces.name,
    description: pieces.description,
    protocol: 'HTTPS',
    load_balancing_scheme: LOAD_BALANCING_SCHEME,
    backend: { group: ref(endpoints, 'id') },
  });
}

/** What {@link cloudRunPieces} reads: none of it is about routing. */
export interface CloudRunPiecesInput {
  readonly configName: string;
  readonly serviceId: string;
  readonly cloudAccountId: string;
  readonly projectId: string;
  readonly region: string;
  readonly environmentId: string;
  readonly stateId: string;
  readonly variables: Readonly<Record<string, string>>;
  /** Its `native.gcp`, laid by `finish` over everything written. */
  readonly native?: NativeGcpBlock | null;
}

/**
 * The pieces every Cloud Run resource of a Service keeps whatever it is (a
 * service, a worker pool, or later a Cron service's job), and the means to
 * add the rest of its definition beside them.
 */
export interface CloudRunPieces {
  /** `cloudgate-<service key>`, the name of every per-Service thing. */
  readonly name: string;
  readonly description: string;
  readonly labels: Record<string, string>;
  /** Adds a resource beside the pieces and returns its address. */
  readonly add: (type: string, local: string, body: object) => string;
  /** The Service's own service account's address. */
  readonly account: string;
  /** Where the deploy pushes: `<region>-docker.pkg.dev/<project>/<repo>`. */
  readonly repositoryUrl: string;
  /** The container's `env`: every variable, a secret's by version. */
  readonly env: readonly Record<string, unknown>[];
  /**
   * What the Cloud Run resource spreads into its own block so it waits for its
   * account to read the secrets: a revision is refused if its account
   * cannot read a secret yet.
   */
  readonly waitForSecrets: { readonly depends_on?: string[] };
  /** The values of the `sensitive` variables, passed as `TF_VAR_<name>`. */
  readonly variables: Record<string, string>;
  /**
   * The whole definition: the pieces, what was added beside them, and the
   * given outputs after the repository's URL.
   */
  readonly finish: (
    outputs: Record<string, string>,
  ) => Extract<CloudRunDefinitionResult, { ok: true }>;
}

/**
 * The pieces every Cloud Run resource of a Service keeps, written
 * once: its
 * Artifact Registry repository (Docker, tags left mutable, untagged versions
 * cleaned up after a day with the policy's dry-run off) and its own service
 * account, which holds no role but reading its own secrets (S8).
 *
 * **Variables (S1)** are Secret Manager secrets, one per variable with a
 * value, each readable by the Service's account alone and referenced by
 * version number, so a changed value adds a version and rolls a revision.
 *
 * A variable Google cannot hold refuses, naming it, before anything is
 * written.
 */
export function cloudRunPieces(
  input: CloudRunPiecesInput,
):
  | { readonly ok: true; readonly pieces: CloudRunPieces }
  | { readonly ok: false; readonly refusal: PlanRefusal } {
  const { serviceId } = input;
  const placed = placeSecrets(input.configName, serviceId, input.variables);
  if (!placed.ok) return { ok: false, refusal: placed.refusal };

  const mark = {
    cloudAccountId: input.cloudAccountId,
    environmentId: input.environmentId,
    stateId: input.stateId,
  };
  const description = markDescription(mark);
  const labels = stateLabels(mark);
  const name = serviceName(serviceId);
  const blocks: Record<string, Record<string, unknown>> = {};
  const add = (type: string, local: string, body: object): string => {
    (blocks[type] ??= {})[local] = body;
    return `${type}.${local}`;
  };

  const repository = add('google_artifact_registry_repository', 'service', {
    repository_id: name,
    location: input.region,
    format: 'DOCKER',
    description,
    labels,
    // Mutable: Artifact Registry refuses to delete a version carrying a
    // tag while tags are immutable (the live walk), and each deploy's
    // tag is its own Deployment's id, never moved, so the clean-up after a
    // deploy could otherwise remove nothing.
    docker_config: { immutable_tags: false },
    cleanup_policy_dry_run: false,
    cleanup_policies: [
      {
        id: 'delete-untagged',
        action: 'DELETE',
        condition: { tag_state: 'UNTAGGED', older_than: UNTAGGED_MAX_AGE },
      },
    ],
    // Google answers a repository made with mutable tags with no
    // `dockerConfig` at all, so the provider reads the block as gone and
    // every later plan would add it back: the first deploy's own re-read,
    // after the repository-only apply, stopped for review on it (the third live
    // walk).
    lifecycle: { ignore_changes: ['docker_config'] },
  });
  // Built from the repository's id rather than read from it, so the deploy
  // and the image both know it before the repository exists.
  const repositoryUrl = `${input.region}-docker.pkg.dev/${input.projectId}/${ref(repository, 'repository_id')}`;

  const account = add('google_service_account', 'service', {
    account_id: name,
    description,
  });

  const secrets = placed.placements.filter((one) => one.kind === 'secret');
  const variable: Record<string, unknown> = {};
  const variables: Record<string, string> = {};
  const locals: Record<string, unknown> = {};
  if (secrets.length > 0) {
    const values: Record<string, string> = {};
    for (const { name: variableName } of secrets) {
      const holder = valueVariable(variableName);
      variable[holder] = { type: 'string', sensitive: true, nullable: false };
      variables[holder] = input.variables[variableName];
      values[variableName] = `\${var.${holder}}`;
    }
    locals.variable_values = values;
    // `for_each` keys are names, never values, so the plan's addresses
    // (`google_secret_manager_secret.variable["API_KEY"]`) name the variable.
    const each = Object.fromEntries(
      secrets.map((one) => [one.name, secretName(serviceId, one.name)]),
    );
    add('google_secret_manager_secret', 'variable', {
      for_each: each,
      secret_id: '${each.value}',
      labels,
      replication: { auto: {} },
    });
    add('google_secret_manager_secret_version', 'variable', {
      for_each: each,
      secret: `\${${GCP_SECRET_ADDRESS}[each.key].id}`,
      secret_data: '${local.variable_values[each.key]}',
    });
    add('google_secret_manager_secret_iam_member', 'variable', {
      for_each: each,
      secret_id: `\${${GCP_SECRET_ADDRESS}[each.key].id}`,
      role: SECRET_ACCESSOR_ROLE,
      member: ref(account, 'member'),
    });
  }
  // By version number, so a changed value is a new revision.
  const fromSecret = (variableName: string) => ({
    value_source: {
      secret_key_ref: {
        secret: `\${${GCP_SECRET_ADDRESS}["${variableName}"].secret_id}`,
        version: `\${${SECRET_VERSION_ADDRESS}["${variableName}"].version}`,
      },
    },
  });
  const env = placed.placements.map((one) => ({
    name: one.name,
    ...(one.kind === 'secret' ? fromSecret(one.name) : { value: '' }),
  }));

  const finish = (outputs: Record<string, string>) => {
    const output = (value: string) => ({ value });
    return {
      ok: true as const,
      variables,
      definition: {
        ...frame(input.projectId, input.region),
        ...(Object.keys(variable).length > 0 ? { variable } : {}),
        ...(Object.keys(locals).length > 0 ? { locals } : {}),
        // Native last, over everything Cloudgate wrote.
        resource: layNativeGcp(blocks, input.native),
        output: {
          ...Object.fromEntries(
            Object.entries(outputs).map(([key, value]) => [key, output(value)]),
          ),
          [CLOUD_RUN_OUTPUTS.repositoryUrl]: output(repositoryUrl),
        },
      },
    };
  };

  return {
    ok: true,
    pieces: {
      name,
      description,
      labels,
      add,
      account,
      repositoryUrl,
      env,
      waitForSecrets:
        secrets.length > 0 ? { depends_on: [SECRET_ACCESS_ADDRESS] } : {},
      variables,
      finish,
    },
  };
}

/**
 * The one container of a Cloud Run resource: the pieces' image and
 * variables, the given pair, and the entry's `command` and `args`. Only a
 * routing that takes requests has a port, and only a service can idle its
 * CPU between them.
 */
export function cloudRunContainer(
  pieces: CloudRunPieces,
  shape: {
    readonly entry: CloudRunEntry;
    readonly pair: CloudRunPair;
    readonly imageTag: string;
    readonly port?: number;
    readonly cpuIdle?: boolean;
  },
): Record<string, unknown> {
  const container: Record<string, unknown> = {
    name: CONTAINER_NAME,
    image: `${pieces.repositoryUrl}/${CONTAINER_NAME}:${shape.imageTag}`,
    ...(shape.port === undefined
      ? {}
      : { ports: { container_port: shape.port } }),
    resources: {
      limits: {
        cpu: String(shape.pair.cpu),
        memory: cloudRunMemory(shape.pair.memoryMb),
      },
      ...(shape.cpuIdle ? { cpu_idle: true } : {}),
    },
  };
  // As on AWS and a Server, `command` replaces the image's entrypoint and
  // `args` its command.
  if (shape.entry.command) {
    container.command = shape.entry.command.split(' ').map(literal);
  }
  if (shape.entry.args && shape.entry.args.length > 0) {
    container.args = shape.entry.args.map(literal);
  }
  if (pieces.env.length > 0) container.env = pieces.env;
  return container;
}

/**
 * Direct VPC egress on the Environment network's subnet for private ranges
 * only: how every Cloud Run resource reaches the Environment's
 * databases, whatever its routing.
 */
export function directVpcEgress(network: GcpNetworkNames) {
  return {
    egress: 'PRIVATE_RANGES_ONLY',
    network_interfaces: [
      {
        network: network.networkName,
        subnetwork: network.subnetName,
      },
    ],
  };
}

/** Memory as Cloud Run writes it back: whole gibibytes as `Gi`, else `Mi`. */
function cloudRunMemory(memoryMb: number): string {
  return memoryMb % 1024 === 0 ? `${memoryMb / 1024}Gi` : `${memoryMb}Mi`;
}
