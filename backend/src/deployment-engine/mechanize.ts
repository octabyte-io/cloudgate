import type Docker from 'dockerode';
import { CLOUDGATE_AI_NETWORK } from '../ai-models/ai-network';
import {
  INFERENCE_RUNTIMES,
  SHARED_MEMORY_MOUNT,
} from '../ai-models/inference-runtime';
import { weightsVolumeMount } from '../ai-models/weights-volume';
import type { ContainerTaskSpec, CreateServiceOptions } from 'dockerode';
import { serviceLogDriver } from '../common/config/container-logs';
import {
  calculateResources,
  generateBindMounts,
  generateFileMounts,
  generateVolumeMounts,
  prepareEnvironmentVariables,
} from '../docker/docker.utils';
import { getAuthConfig, getImageName } from '../registries/registry.utils';
import type { RegistryAuthConfig } from '../registries/registry.utils';
import {
  AI_NETWORK_MESSAGE,
  namesAiNetwork,
  toEndpointProtocol,
  toPublishMode,
} from '../applications/swarm.types';
import type {
  HealthCheckSwarm,
  NetworkSwarm,
  PlacementSwarm,
  RestartPolicySwarm,
  ServiceModeSwarm,
  UpdateConfigSwarm,
} from '../applications/swarm.types';
import { refuseLockedDockerSettings } from '../native/docker-locks';
import type { DockerLockRole } from '../native/docker-locks';
import {
  blameNativeDocker,
  closedDockerColumnRefusals,
  DOCKER_DEFAULTS,
  over,
} from '../native/docker-native';
import { CLOUDGATE_NETWORK } from '../servers/server-audit';
import { withGpusHidden } from '../settings/gpu-visibility';
import { fileMountsDirectoryOnRunServer } from './deployment-engine.paths';
import type { DeployableApplication } from './deployment-engine.types';

/** The columns generateConfigContainer actually reads: the swarm JSON
 * overrides shared by applications and managed databases (Phase 26). */
export type SwarmConfigSource = Pick<
  DeployableApplication,
  | 'healthCheckSwarm'
  | 'restartPolicySwarm'
  | 'placementSwarm'
  | 'updateConfigSwarm'
  | 'rollbackConfigSwarm'
  | 'modeSwarm'
  | 'labelsSwarm'
  | 'replicas'
  | 'mounts'
  | 'networkSwarm'
  | 'stopGracePeriodSwarm'
  | 'endpointSpecSwarm'
  | 'ulimitsSwarm'
> &
  Pick<DeployableApplication, 'ports'> &
  // Optional: a managed database's spec comes through here and never
  // reserves a GPU.
  Partial<Pick<DeployableApplication, 'gpus'>>;

/**
 * A service that reserves GPUs updates and rolls back `stop-first`, over any
 * stored order. Start-first would ask for the new task's cards while
 * the old task still holds them, and on a Server whose cards are all taken
 * Swarm would leave the new task pending rather than refuse it — the waiting
 * a GPU reservation must never do (ADR-0039). Applied after the stored
 * override, so a `start-first` the operator saved loses.
 */
function gpuOrder(
  config: UpdateConfigSwarm,
  gpus: number | undefined,
): UpdateConfigSwarm {
  return gpus && gpus >= 1 ? { ...config, Order: 'stop-first' } : config;
}

/**
 * The networks a service joins: `cloudgate-network` first, then the operator's
 * own, each once.
 *
 * A stored list used to **replace** the default rather than add to it, while
 * the Networks card promised networks "beyond the default one". The task then
 * left `cloudgate-network` — the only network Traefik is on, and the one it
 * reaches `http://<appName>:<port>` through — so every domain answered 502
 * while the Deployment reported ✅. A managed database's spec comes through
 * here too, and losing the default cut it off from the Applications that
 * connect to it by name in the same way.
 *
 * An operator who lists the default network themselves keeps what they gave
 * it (aliases, driver options): their entry stands in for the bare one rather
 * than being dropped or doubled. Later duplicates of any target are dropped —
 * Docker refuses a spec that attaches one network twice. Leaving the default
 * out is not a way to detach from it; nothing on the screen offers that, and a
 * service off it is unreachable through its domains.
 */
function withDefaultNetwork(
  networkSwarm: NetworkSwarm[] | null | undefined,
): NetworkSwarm[] {
  // At the emitter as well as the DTO, for H-56's reason below: the
  // DTO guards new writes, this the rows already in the column. An AI model's
  // own `cloudgate-ai` is written by its deploy, never read from here.
  if (namesAiNetwork(networkSwarm)) {
    throw new Error(
      `${AI_NETWORK_MESSAGE}. Remove it from this service's networks; a deploy cannot be given it`,
    );
  }
  const listed = networkSwarm ?? [];
  const listedDefault = listed.find((n) => n.Target === CLOUDGATE_NETWORK);
  const seen = new Set<string>();
  const networks: NetworkSwarm[] = [];
  for (const network of [
    listedDefault ?? { Target: CLOUDGATE_NETWORK },
    ...listed,
  ]) {
    if (network.Target !== undefined) {
      if (seen.has(network.Target)) continue;
      seen.add(network.Target);
    }
    networks.push(network);
  }
  return networks;
}

/**
 * The swarm service-spec fragments derived from the application's JSON
 * overrides, falling back to defaults when an override is absent.
 *
 * `role` is whose spec this is, for the one Docker lock that differs: a
 * managed database's spec (`buildDatabaseServiceSpec`) passes `'database'`,
 * and its stored update and rollback orders must then be stop-first.
 */
export function generateConfigContainer(
  application: SwarmConfigSource,
  role: DockerLockRole = 'application',
) {
  const {
    healthCheckSwarm,
    restartPolicySwarm,
    placementSwarm,
    updateConfigSwarm,
    rollbackConfigSwarm,
    modeSwarm,
    labelsSwarm,
    replicas,
    mounts,
    networkSwarm,
    stopGracePeriodSwarm,
    endpointSpecSwarm,
    ulimitsSwarm,
    ports,
  } = application;

  const haveMounts = Boolean(mounts && mounts.length > 0);

  // The Docker lock list, at the emitter as well as the DTO.
  // `labelsSwarm` becomes the service's `ContainerSpec.Labels`, which is both
  // what Traefik's default-install `providers.docker` reads as router config —
  // a `traefik.http.routers…` label hijacks another tenant's domain (H-56) —
  // and what puts a `com.docker.*` key on the task containers Cloudgate's own
  // listings read to decide which organization owns a container (H-82); a
  // database's start-first puts two writers on one volume.
  //
  // The DTOs refuse every locked value, but `updateApplicationSchema` is
  // `.partial()`, so a row stored before a rule existed is re-emitted verbatim
  // by any PATCH that omits the field and is never revisited
  // otherwise. That is the whole reason this second reading exists: the DTO
  // protects new writes, this protects the rows already in the columns. It is
  // the choke point both an Application and a managed database's spec pass
  // through, so a stored value is caught here whichever wrote it.
  //
  // Refused, not stripped or forced (ADR-0044 rule 9): a half-applied spec is
  // worse than a failed deploy that names the value to correct.
  refuseLockedDockerSettings(
    {
      Labels: labelsSwarm,
      RestartPolicy: restartPolicySwarm,
      UpdateConfig: updateConfigSwarm,
      RollbackConfig: rollbackConfigSwarm,
    },
    role,
  );

  // Cloudgate's defaults for this kind of spec, which every stored value is
  // laid over field by field: the table the plan's "→ default"
  // reads too, so what a plan shows is what deploys.
  const defaults = DOCKER_DEFAULTS[role];
  const stopGracePeriod = stopGracePeriodSwarm ?? defaults.StopGracePeriod;

  return {
    // No default of either: the image's HEALTHCHECK and Docker's restart
    // policy stand where none is set. Merged all the same, so a field left
    // undefined in process never reaches the daemon as one.
    ...(healthCheckSwarm && {
      HealthCheck: over<HealthCheckSwarm>({}, healthCheckSwarm),
    }),
    ...(restartPolicySwarm && {
      RestartPolicy: over<RestartPolicySwarm>({}, restartPolicySwarm),
    }),
    // Services with mounts must stay on the manager node — and that stays true
    // of a service whose operator set a placement preference or a maximum and
    // never mentioned constraints, which is why this is merged rather than
    // replaced (the same shape as the two configs below). A placement
    // that names `Constraints` itself still wins, empty list included.
    Placement: over<PlacementSwarm>(
      { Constraints: haveMounts ? ['node.role==manager'] : [] },
      placementSwarm,
    ),
    ...(labelsSwarm && { Labels: labelsSwarm }),
    ...(modeSwarm
      ? { Mode: modeSwarm }
      : { Mode: { Replicated: { Replicas: replicas } } }),
    RollbackConfig: gpuOrder(
      over<UpdateConfigSwarm>(
        { ...defaults.RollbackConfig },
        rollbackConfigSwarm,
      ),
      application.gpus,
    ),
    UpdateConfig: gpuOrder(
      over<UpdateConfigSwarm>({ ...defaults.UpdateConfig }, updateConfigSwarm),
      application.gpus,
    ),
    ...(stopGracePeriod !== null && { StopGracePeriod: stopGracePeriod }),
    Networks: withDefaultNetwork(networkSwarm),
    ...(endpointSpecSwarm
      ? {
          EndpointSpec: {
            ...(endpointSpecSwarm.Mode && { Mode: endpointSpecSwarm.Mode }),
            Ports:
              // Membership-checked narrowing, not the unchecked `as` cast it
              // replaces: a stored Protocol/PublishMode Docker would reject can
              // no longer reach the API typed as one it accepts (H-56). The
              // `|| 'tcp'`/`|| 'host'` default is folded into the helpers.
              endpointSpecSwarm.Ports?.map((port) => ({
                Protocol: toEndpointProtocol(port.Protocol),
                TargetPort: port.TargetPort || 0,
                PublishedPort: port.PublishedPort || 0,
                PublishMode: toPublishMode(port.PublishMode),
              })) || [],
          },
        }
      : // With no override, the application's port rows are published.
        ports &&
        ports.length > 0 && {
          EndpointSpec: {
            Ports: ports.map((port) => ({
              Protocol: port.protocol,
              TargetPort: port.targetPort,
              PublishedPort: port.publishedPort,
              PublishMode: port.publishMode,
            })),
          },
        }),
    ...(ulimitsSwarm && ulimitsSwarm.length > 0 && { Ulimits: ulimitsSwarm }),
  };
}

/**
 * Pull credentials for the service's image — the app's own registry credentials
 * for a docker source, or the linked registry's for a built image.
 *
 * **The docker branch reads three columns and they are one value**. A
 * `Registry` row carries `url`/`username`/`password` together, so the built
 * branch cannot split them; the docker branch reads `registryUrl`, `username`
 * and `password` off `application` separately, and whatever assembles that
 * `DeployableApplication` decides whether the three agree. They did not:
 * `RollbacksService.EXCLUDED_FROM_CONTEXT` excluded `password` for being
 * `encryptedText` and kept the other two, so a rollback after a registry
 * rotation reached this function with the retired host and user and the live
 * secret, and the blob below went to the daemon as `X-Registry-Auth` — the
 * credential the Swarm service pulls with, on the create branch and the update
 * branch alike (dockerode lifts `opts.authconfig` off a service-update body).
 * Fixed in the exclusion list rather than here, because this function has no
 * way to tell a split triple from a legitimate one; what belongs here is the
 * reason a caller may not split it.
 *
 * It no longer runs on every converge: a converge pinned to `options.image`
 * takes {@link NO_PULL_CREDENTIAL} instead.
 */
function resolveAuthConfig(
  application: DeployableApplication,
): RegistryAuthConfig | undefined {
  if (application.sourceType === 'docker') {
    if (application.username && application.password) {
      return {
        username: application.username,
        password: application.password,
        serveraddress: application.registryUrl || '',
      };
    }
    return undefined;
  }
  const registry = application.registry ?? application.buildRegistry;
  return registry ? getAuthConfig(registry) : undefined;
}

/** Converge-time options. `image` pins the service to a specific tag — a
 * rollback snapshot — instead of the image the application's columns imply.
 *
 * **A pinned image is always a local tag, and {@link NO_PULL_CREDENTIAL}
 * depends on that**. The only value any caller passes is
 * `rollback.image`, minted by `RollbacksService.capture` as
 * `${appName}:v${version}` and preserved by a `docker tag` in
 * `DeploymentEngineService.captureRollback`; no registry serves it and nothing
 * pushes it. A caller that ever pins a *registry* reference here has to bring
 * the credential for that registry with it, and this field is where to say so.
 */
export interface MechanizeOptions {
  image?: string;
  /**
   * Where a line goes that has to be written *between* two Docker calls, so
   * the caller cannot write it before or after this function. Only the
   * mode-change recreation uses it: the log has to say the service is about to
   * be removed before it is, because a failure after that leaves nothing
   * running and the reader needs to know why. See {@link MechanizeOutcome}
   * for why everything else is returned rather than logged from here.
   */
  log?: (line: string) => Promise<void>;
  /**
   * Variables merged into the container's environment and never into the
   * Application's env rows: a traced Service's `OTEL_EXPORTER_OTLP_*`
   * (`traces/trace-store.ts`' `traceWiringEnv`). They win over an env row of
   * the same name — traces being on is the operator saying where spans go —
   * and the caller decides whether there are any: a preview's deploy passes
   * none, whatever its parent's setting (ADR-0028).
   */
  injectedEnv?: Record<string, string>;
  /**
   * The Application's wired variables, filled in for this release (ADR-0031;
   * `project-config/outputs`' `wiredEnv`) and never written to its
   * row. Unlike {@link injectedEnv} a typed value of the same name wins,
   * which only a preview's `previewEnv` can hold (ADR-0021).
   */
  wiredEnv?: Record<string, string>;
}

/**
 * The pull credential a converge onto a pinned image carries: one that names
 * nobody.
 *
 * What broke first: `resolveAuthConfig` ran unconditionally, so a rollback
 * shipped the Application's **live** private-registry credential beside an
 * `Image` of `${appName}:v${version}` — a *bare* tag, which the daemon
 * normalizes to `docker.io/library/<appName>`. That blob is not a value the
 * converge inspects and discards: the daemon stores it on the Swarm Service as
 * `TaskTemplate.ContainerSpec.PullOptions.RegistryAuth`, and a task's Prepare
 * attempts a pull on every start (moby only skips it under
 * `DOCKER_SERVICE_PREFER_OFFLINE_IMAGE=1`, and falls back to the local image
 * when the pull *fails*, which is the only reason a rollback onto a local tag
 * runs at all). So the operator's registry password was offered to Docker Hub,
 * on a pull that could never have succeeded.
 *
 * **Omitting the field was the rejected alternative, and it is the one first
 * recommended.** moby's `UpdateService` copies the Service's stored
 * `PullOptions` forward whenever the request carries no `X-Registry-Auth` —
 * *"if the encodedAuth isn't being updated then we shouldn't lose it"* — so an
 * omission leaves the **previous** Deployment's credential in place, aimed at
 * the same Docker Hub pull. An empty blob is a non-empty `X-Registry-Auth` at
 * the daemon and therefore replaces it; the next ordinary Deployment supplies
 * the real one again. Replacing it takes nothing away, because that pull is the
 * stored value's only consumer: moby's container adapter reads
 * `spec.PullOptions.RegistryAuth` in `pullImage` and nowhere else, so no later
 * restart of the Service wants it for anything a rollback is not already
 * refusing to do. Uniform across both branches for the same reason it is sent
 * rather than dropped: a create has nothing stored to displace, but two rules
 * for one intent is how one of them drifts.
 *
 * Refusing to converge a pinned image while the Application has a registry
 * credential was also rejected — it fails on the day the operator most wants a
 * rollback, which is the same trade turned down before.
 */
const NO_PULL_CREDENTIAL: RegistryAuthConfig = {
  username: '',
  password: '',
  serveraddress: '',
};

/**
 * The image this Application's Swarm service is released onto: the pulled
 * `dockerImage` for a docker source, the registry-qualified tag when the build
 * is pushed through a Registry, and the bare `${appName}:latest` otherwise.
 *
 * **Exported because the log has to name it, and named the other one**.
 * `DeploymentEngineService.deploy` announces the release in the Update line,
 * and it announced `builtImageName`'s answer — the tag the *build* leaves on
 * the build host, which is the right word for the `docker tag` and `docker
 * push` that method exists for and the wrong one here. With a Registry linked
 * the two differ by the whole registry prefix, so the operator was told
 * `app:latest` while the service ran `registry.example/prefix/app:latest`.
 * One dispatch read by the converge and by the announcement is what stops them
 * drifting apart again, which is the relation `applications/built-image.ts`
 * records having lost between the same pair of writing-side rules.
 *
 * It does not answer a converge pinned to {@link MechanizeOptions.image} — that
 * is a rollback tag no column implies, and the caller that pins it is the
 * caller that knows it.
 */
export function releasedImageName(application: DeployableApplication): string {
  return getImageName({
    appName: application.appName,
    dockerImage:
      application.sourceType === 'docker' ? application.dockerImage : null,
    registry: application.registry ?? application.buildRegistry,
  });
}

function buildServiceSettings(
  application: DeployableApplication,
  options: MechanizeOptions,
): CreateServiceOptions {
  const { appName, env, command, args, mounts } = application;

  const {
    HealthCheck,
    RestartPolicy,
    Placement,
    Labels,
    Mode,
    RollbackConfig,
    UpdateConfig,
    Networks,
    StopGracePeriod,
    EndpointSpec,
    Ulimits,
  } = generateConfigContainer(application);

  const serviceMounts = mounts ?? [];
  const runtime = application.aiModel
    ? INFERENCE_RUNTIMES[application.aiModel.runtime]
    : null;
  // An AI model's runtime env is the platform's, so it wins over the
  // operator's like any injected value.
  const injected = { ...runtime?.env, ...options.injectedEnv };
  const resolvedEnv = [
    ...prepareEnvironmentVariables(
      env,
      application.environment.project.env,
      application.environment.env,
      options.wiredEnv,
    ).filter((entry) => !(entry.split('=', 1)[0] in injected)),
    ...Object.entries(injected).map(([key, value]) => `${key}=${value}`),
  ];
  // A copy that reserves no GPU is kept off every card.
  const envVariables =
    application.gpus > 0 ? resolvedEnv : withGpusHidden(resolvedEnv);
  // The pinned image is a rollback tag no registry serves, so the
  // Application's own credential has nothing to authenticate here and a bare
  // tag would offer it to Docker Hub. See {@link NO_PULL_CREDENTIAL}.
  const authConfig = options.image
    ? NO_PULL_CREDENTIAL
    : resolveAuthConfig(application);
  const image = options.image ?? releasedImageName(application);

  return {
    ...(authConfig && { authconfig: authConfig }),
    Name: appName,
    TaskTemplate: {
      ContainerSpec: {
        ...(HealthCheck && { HealthCheck }),
        Image: image,
        Env: envVariables,
        Mounts: [
          ...generateVolumeMounts(serviceMounts),
          ...generateBindMounts(serviceMounts),
          // The **run** Server's root, off `application.serverId` — the same
          // column `DeploymentEngineService.deploy` opens this daemon
          // connection on, and never `buildHostServerId`'s answer. A
          // bind source is a path in the mounting host's filesystem, so it is
          // resolved by the daemon this spec is handed to; the file itself is
          // written by `MountsService` through the same one expression.
          //
          // **`appName` here is the Service that *owns* these mount rows, and
          // for everything that reaches this line it is `Name` above as well**.
          // The two are one column and forked exactly once:
          // `PreviewDeploymentsService.deployPreview` overrides `appName` with
          // the preview's, while the rows it inherits were written under the
          // parent's — so a preview bound an empty directory Docker minted at a
          // path no writer has. It is converted at that boundary rather than
          // parameterized here (`inheritedMounts`, ADR-0021): a preview's file
          // mounts arrive as `bind`s of the parent's own files, so nothing that
          // reaches this call is a `file` mount whose owner is not `appName`.
          ...generateFileMounts(
            serviceMounts,
            fileMountsDirectoryOnRunServer(application.serverId, appName),
          ),
          // An AI model's weights volume: the platform's, from the
          // facet rather than a `mount` row, so no operator write reaches it
          // and `generateConfigContainer` does not pin it to a manager.
          ...(application.aiModel
            ? [weightsVolumeMount(appName, application.aiModel.runtime)]
            : []),
          // vLLM's shared memory: Swarm takes no `--ipc` or
          // `--shm-size`, so a `tmpfs` over `/dev/shm` stands in for both.
          ...(runtime?.sharedMemoryTmpfs ? [SHARED_MEMORY_MOUNT] : []),
        ],
        ...(StopGracePeriod !== null &&
          StopGracePeriod !== undefined && { StopGracePeriod }),
        ...(command && { Command: command.split(' ') }),
        ...(args && args.length > 0 && { Args: args }),
        ...(Ulimits && { Ulimits }),
        ...(Labels && { Labels }),
      },
      // An AI model is on `cloudgate-ai` and nothing else: never on
      // `cloudgate-network`, where every other Service could reach it.
      Networks: runtime ? [{ Target: CLOUDGATE_AI_NETWORK }] : Networks,
      ...(RestartPolicy && { RestartPolicy }),
      Placement,
      Resources: calculateResources({
        memoryLimit: application.memoryLimit,
        memoryReservation: application.memoryReservation,
        cpuLimit: application.cpuLimit,
        cpuReservation: application.cpuReservation,
        gpus: application.gpus,
      }),
      // A deployed Application ran on the daemon's stock json-file driver
      // with no max-size and no max-file, so one application logging in a loop
      // filled the Server's disk and took every other workload on it down. The
      // driver stays json-file so `docker service logs` still reads it; only the
      // ceiling is new, and both halves of it are env-overridable.
      LogDriver: serviceLogDriver(),
    },
    Mode,
    RollbackConfig,
    ...(EndpointSpec && { EndpointSpec }),
    UpdateConfig,
  };
}

/**
 * The spec of one run of a Cron service: a one-off Swarm job
 * (ADR-0034).
 *
 * **The `web` path's spec, not a second one.** It is {@link
 * buildServiceSettings}' answer for the same Application — its variables, size
 * limits, network, registry login, placement, mounts and log ceiling — so a
 * run gets everything a released `web` does, and its container is a Managed
 * container. What differs is what a job is: it is named after the Service
 * plus a run id (`name`), so overlapping runs never collide; it runs once and
 * is never restarted (`ReplicatedJob` with one completion, `RestartPolicy:
 * none`); it publishes nothing and has no update or rollback to configure.
 *
 * `image` is resolved by the caller when the run starts — the last
 * successful build's — and pinned here, so a build that lands while the run
 * goes does not change what it runs. `wiredEnv` is its wired variables,
 * built by the caller at the run's start as a deploy builds them.
 */
export function buildRunJobSettings(
  application: DeployableApplication,
  {
    name,
    image,
    wiredEnv,
  }: { name: string; image: string; wiredEnv?: Record<string, string> },
): CreateServiceOptions {
  // Its labels, stop grace and ulimits are its own and reach the
  // job's container below. A health check, a restart policy, an update or a
  // rollback a stored row still holds fails the run naming it, stripping
  // nothing (ADR-0044 rule 9): the console's save refuses the same four.
  const closed = closedDockerColumnRefusals('cron', application);
  if (closed.length > 0) {
    throw new Error(
      `This Cron service's stored Swarm settings hold what a run never takes: ${closed.join('; ')}. Clear them in its Swarm settings; a run cannot be given them`,
    );
  }
  // Its Mode, UpdateConfig, RollbackConfig and EndpointSpec are left out: a
  // job has no replicas to update or roll back, and publishes nothing.
  const service = buildServiceSettings(application, { wiredEnv });
  // `buildServiceSettings` writes a container task, always.
  const template = service.TaskTemplate as ContainerTaskSpec;
  return {
    ...(service.authconfig && { authconfig: service.authconfig }),
    Name: name,
    TaskTemplate: {
      ...template,
      ContainerSpec: { ...template.ContainerSpec, Image: image },
      RestartPolicy: { Condition: 'none' },
    },
    Mode: { ReplicatedJob: { MaxConcurrent: 1, TotalCompletions: 1 } },
  };
}

/**
 * Which branch the converge took. Returned rather than logged from here: the
 * Update phase writes nothing at all today, so the deployment log ends on the
 * builder's last line and the operator cannot tell a still-converging service
 * from one that finished minutes ago. The caller owns the deployment
 * log — it holds the path and the build server it lives on — and giving this
 * function a log writer instead would make a pure converge call depend on the
 * engine's file layout, which was the rejected alternative. The one line that
 * cannot wait for the return — a mode change's, before the removal —
 * goes through {@link MechanizeOptions.log}, a callback the caller owns, so the
 * file layout stays the caller's all the same.
 */
export type MechanizeOutcome = 'created' | 'updated' | 'recreated';

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The four service modes Swarm knows, by the key that names each one. */
type ServiceModeKind = 'Replicated' | 'Global' | 'ReplicatedJob' | 'GlobalJob';

/**
 * Which of the four modes a service-spec `Mode` is. A spec with no mode at all
 * is replicated: that is what the Docker Engine creates when none is given.
 */
export function serviceModeKind(
  mode: ServiceModeSwarm | null | undefined,
): ServiceModeKind {
  if (mode?.Global) return 'Global';
  if (mode?.ReplicatedJob) return 'ReplicatedJob';
  if (mode?.GlobalJob) return 'GlobalJob';
  return 'Replicated';
}

/**
 * Converges the application's Swarm service — updating it in place when it
 * exists (bumping ForceUpdate so tasks restart even on an unchanged spec),
 * creating it otherwise, and **recreating it when its mode changed**.
 *
 * It returns which of the three happened and nothing more: the Docker
 * API call returning means the spec was *accepted*, not that the tasks
 * converged, so no caller may report convergence on the strength of this
 * resolving.
 *
 * ### Why a mode change recreates rather than refuses
 *
 * Swarm cannot change a service's mode in place: the update answers
 * `service mode change is not allowed`. That used to be the whole Deployment's
 * answer, after the build, on every Deployment until the mode was set back —
 * so a documented setting could never take effect. Refusing it before the
 * build with a better sentence was the alternative, and it was rejected
 * because it leaves the operator nowhere to go: the console has no Application
 * delete, and Stop scales the service to zero, which keeps it — and its
 * mode. Removing the service and creating it again is the only way Swarm
 * offers, and it is what an operator would do by hand.
 *
 * What it costs, and why it is still the right trade:
 *
 * - **Downtime.** Nothing serves between the removal and the new tasks
 *   running; `Order: 'start-first'` cannot apply across two services. The
 *   caller's convergence line reads "recreated", and the console's Service
 *   mode card says so before the change is saved.
 * - **Volumes survive.** Named volumes, bind mounts and file mounts belong to
 *   the host, not the service, and `docker service rm` removes none of them;
 *   the new service mounts the same ones.
 * - **Domains keep routing.** Traefik reaches the service as
 *   `http://<appName>:<port>` on `cloudgate-network`, by name; the recreated
 *   service has the same name on the same network, so the routers need no
 *   change and answer again once the tasks are up.
 * - **No Swarm rollback.** A new service has no previous spec to roll back to,
 *   so a release that does not start leaves nothing running — the same as a
 *   first deploy, which is how the convergence wait treats it.
 *
 * Only the kind of mode is compared. A replica count, or a job's concurrency,
 * is an ordinary update.
 */
export async function mechanizeDockerContainer(
  application: DeployableApplication,
  docker: Docker,
  options: MechanizeOptions = {},
): Promise<MechanizeOutcome> {
  const settings = buildServiceSettings(application, options);
  const service = docker.getService(application.appName);

  type ServiceInspect = {
    Version: { Index: string };
    Spec: {
      TaskTemplate: { ForceUpdate: number };
      Mode?: ServiceModeSwarm;
    };
  };
  let inspect: ServiceInspect | null;
  try {
    inspect = (await service.inspect()) as ServiceInspect;
  } catch {
    inspect = null;
  }

  // A value only Docker can judge fails the Deployment naming its native
  // path, when the Engine's refusal names one the Service sets.
  const blamed = async (call: () => Promise<unknown>) => {
    try {
      await call();
    } catch (error) {
      throw blameNativeDocker(error, application);
    }
  };
  const create = () =>
    blamed(async () => {
      if (settings.authconfig) {
        await docker.createService(settings.authconfig, settings);
      } else {
        await docker.createService(settings);
      }
    });

  const liveMode = inspect && serviceModeKind(inspect.Spec.Mode);
  const wantedMode = serviceModeKind(settings.Mode);
  if (liveMode && liveMode !== wantedMode) {
    const change = `its mode changed from ${liveMode} to ${wantedMode}`;
    await options.log?.(
      `🔁 [Update] Service mode changed from ${liveMode} to ${wantedMode}; Swarm cannot change it in place, so the service '${application.appName}' is removed and created again. Nothing serves until its new tasks are running.`,
    );
    // Each half is wrapped so the Deployment's error names which side of the
    // removal it stopped on: before it the previous release is still serving,
    // after it nothing is.
    try {
      await service.remove();
    } catch (error) {
      throw new Error(
        `Swarm service '${application.appName}' could not be removed to recreate it after ${change}, so it is still running as it was before this Deployment: ${errorText(error)}`,
        { cause: error },
      );
    }
    try {
      await create();
    } catch (error) {
      throw new Error(
        `Swarm service '${application.appName}' was removed because ${change}, and creating it again failed, so the Application is offline until a Deployment succeeds: ${errorText(error)}`,
        { cause: error },
      );
    }
    return 'recreated';
  }

  if (inspect) {
    const live = inspect;
    await blamed(() =>
      service.update({
        version: Number.parseInt(String(live.Version.Index), 10),
        ...settings,
        TaskTemplate: {
          ...settings.TaskTemplate,
          ForceUpdate: live.Spec.TaskTemplate.ForceUpdate + 1,
        },
      }),
    );
    return 'updated';
  }

  await create();
  return 'created';
}
