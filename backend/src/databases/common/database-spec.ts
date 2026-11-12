import type Docker from 'dockerode';
import type { CreateServiceOptions, PortConfig } from 'dockerode';
import { serviceLogDriver } from '../../common/config/container-logs';
import { fileMountsDirectoryOnRunServer } from '../../deployment-engine/deployment-engine.paths';
import type { SwarmConfigSource } from '../../deployment-engine/mechanize';
import { generateConfigContainer } from '../../deployment-engine/mechanize';
import {
  calculateResources,
  generateBindMounts,
  generateFileMounts,
  generateVolumeMounts,
} from '../../docker/docker.utils';
import type { ServiceResources } from '../../docker/docker.types';
import { withGpusHidden } from '../../settings/gpu-visibility';
import type { ConvergeResult } from './database-convergence';

/** The columns a database service spec is built from: the swarm overrides
 * plus the engine-agnostic runtime columns every database table shares. */
export type DatabaseSpecSource = SwarmConfigSource &
  ServiceResources & {
    appName: string;
    dockerImage: string;
    command: string | null;
    args: string[] | null;
    externalPort: number | null;
    /**
     * The **run** Server, and the only machine a managed database has — it
     * builds nothing, so there is no `buildServerId` here to confuse it with.
     * On the type because a file mount's bind source is resolved by the daemon
     * this spec is handed to, which `DatabaseServiceBase.deployInternal` opens
     * on this same column.
     */
    serverId: string | null;
  };

/**
 * The swarm service spec for a managed database, common to every engine. Engine
 * specifics arrive as inputs — resolved env pairs and the engine's in-container
 * port. Mounts (the data volume) come from the `mounts` field on the source,
 * which also drives the manager-node placement constraint.
 */
export function buildDatabaseServiceSpec(
  database: DatabaseSpecSource,
  options: {
    env: string[];
    targetPort: number;
    /** Engine-supplied entrypoint (e.g. Redis's requirepass wrapper); when
     * set it wins over the row's own command/args columns. */
    containerCommand?: { Command: string[]; Args: string[] };
    /** Engine-supplied published ports (LibSQL publishes three); when set
     * they win over the single externalPort → targetPort mapping. */
    ports?: PortConfig[];
  },
): CreateServiceOptions {
  const { appName, dockerImage, command, args, externalPort } = database;
  const mounts = database.mounts ?? [];

  // **A database updates and rolls back stop-first**: two copies of
  // it on one volume are two writers to one data directory, and that
  // corrupts it. Both blocks, and its thirty seconds to stop, are the
  // database role's defaults (`DOCKER_DEFAULTS`), which the stored override
  // is laid over field by field, so a stored block that leaves "On failure"
  // or the order out still rolls back and stays stop-first. A stored
  // `start-first` is refused by the Docker lock list, which
  // `generateConfigContainer` reads with the `'database'` role, and fails the
  // Deployment naming it: it is never forced to stop-first here,
  // which would run something other than what the console showed.
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
  } = generateConfigContainer(database, 'database');

  return {
    Name: appName,
    TaskTemplate: {
      ContainerSpec: {
        ...(HealthCheck && { HealthCheck }),
        Image: dockerImage,
        // No database reserves a GPU, so every one is kept off the cards.
        Env: withGpusHidden(options.env),
        Mounts: [
          ...generateVolumeMounts(mounts),
          ...generateBindMounts(mounts),
          // The database's own Server, for the reason `serverId` is on the
          // source type above.
          ...generateFileMounts(
            mounts,
            fileMountsDirectoryOnRunServer(database.serverId, appName),
          ),
        ],
        // A database's default is long, so it can flush to disk.
        ...(StopGracePeriod !== undefined && { StopGracePeriod }),
        ...(options.containerCommand ?? {
          ...(command && { Command: command.split(' ') }),
          ...(args && args.length > 0 && { Args: args }),
        }),
        ...(Ulimits && { Ulimits }),
        ...(Labels && { Labels }),
      },
      Networks,
      ...(RestartPolicy && { RestartPolicy }),
      Placement,
      Resources: calculateResources({
        memoryLimit: database.memoryLimit,
        memoryReservation: database.memoryReservation,
        cpuLimit: database.cpuLimit,
        cpuReservation: database.cpuReservation,
      }),
      // Same ceiling as an Application's, for the same reason — a managed
      // database is as much a container Cloudgate creates, and it fills the same
      // disk on the same host. A database is the likeliest of the three to log
      // in a loop, too: a bad connection string retried by an app is one refused
      // authentication per attempt, written by *this* service.
      LogDriver: serviceLogDriver(),
    },
    Mode,
    RollbackConfig,
    EndpointSpec: EndpointSpec ?? {
      Mode: 'dnsrr' as const,
      Ports:
        options.ports ??
        (externalPort
          ? [
              {
                Protocol: 'tcp' as const,
                TargetPort: options.targetPort,
                PublishedPort: externalPort,
                PublishMode: 'host' as const,
              },
            ]
          : []),
    },
    UpdateConfig,
  };
}

/**
 * The mechanizeDockerContainer converge dance for databases: update the
 * service in place when it exists (bumping ForceUpdate so tasks restart even
 * on an unchanged spec), create it otherwise.
 *
 * Resolving means Docker *accepted* the spec, not that it runs: the answer is
 * what `awaitDatabaseDeploy` waits on, keyed by the `ForceUpdate` this
 * returns.
 */
export async function convergeDatabaseService(
  docker: Docker,
  appName: string,
  settings: CreateServiceOptions,
): Promise<ConvergeResult> {
  const service = docker.getService(appName);

  type ServiceInspect = {
    Version: { Index: string };
    // Absent until something sets it: Docker omits a zero `ForceUpdate`, which
    // made the bump below `undefined + 1`, NaN, on a never-forced service.
    Spec: { TaskTemplate: { ForceUpdate?: number } };
  };
  let inspect: ServiceInspect | null;
  try {
    inspect = (await service.inspect()) as ServiceInspect;
  } catch {
    inspect = null;
  }

  if (inspect) {
    const forceUpdate = (inspect.Spec.TaskTemplate.ForceUpdate ?? 0) + 1;
    await service.update({
      version: Number.parseInt(String(inspect.Version.Index), 10),
      ...settings,
      TaskTemplate: { ...settings.TaskTemplate, ForceUpdate: forceUpdate },
    });
    return { outcome: 'updated', forceUpdate };
  }

  await docker.createService(settings);
  return { outcome: 'created', forceUpdate: null };
}
