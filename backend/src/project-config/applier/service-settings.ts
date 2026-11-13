import type { CronTimetable } from '../../applications/applications.service';
import type { UpdateApplicationDto } from '../../applications/dto/application.dto';
import type { UpdateComposeDto } from '../../compose/dto/compose.dto';
import {
  DEFAULT_TIMEOUT_SECONDS,
  DEFAULT_TIMEZONE,
} from '../../cron-services/cron-fields';
import {
  openDockerColumns,
  takesNativeDocker,
} from '../../native/docker-native';
import type { NativeDockerColumns } from '../../native/docker-native';
import { sizeLimits } from '../format/config-size';
import type { ResolvedConnection } from '../git-connections';
import type { DescribedEntry } from '../planner/fields';
import type { SavedService } from '../planner/plan.types';
import type {
  ComposeSource,
  CronEntry,
  MysqlEntry,
  PostgresEntry,
  RedisEntry,
  Source,
  StaticEntry,
  WebEntry,
  WebLikeEntry,
  WorkerEntry,
} from '../project-config.types';

/**
 * A config entry as the columns its per-kind create and update paths take.
 * Pure: the Applier hands these to `ApplicationsService` and the
 * database services and never writes a column itself.
 *
 * Every config-owned field is written, a field the entry leaves out at what
 * a console create leaves it — the planner's rule, so the next plan compares
 * equal. Three exceptions, as in the planner: a missing `size` leaves the
 * caps alone, and a postgres's missing `database` or `user` leaves
 * the one it has. Nothing Cloudgate owns is here except where a source needs
 * it to build: the connection and the branch, written when the repository
 * is new to the Service.
 */

const DEFAULTS = {
  buildType: 'nixpacks',
  railpackVersion: '0.15.4',
  herokuVersion: '24',
  dockerfile: 'Dockerfile',
} as const;

/** A source in a repository: an Application's, or a stack's compose file's. */
type RepositorySource = ComposeSource;

/** What a custom git URL builds from at first: no API names its default. */
export const CUSTOM_GIT_BRANCH = 'main';

/** The caps a stated `size` sets, and never the reservations. */
export function capsFor(entry: { readonly size?: WebEntry['size'] }) {
  return entry.size ? sizeLimits(entry.size) : {};
}

/** An Application entry's config-owned columns, its source aside. */
export function applicationSettings(
  entry: WebLikeEntry | WorkerEntry | StaticEntry | CronEntry,
): UpdateApplicationDto {
  const build = entry.build ?? {};
  const shared: UpdateApplicationDto = {
    description: entry.description ?? null,
    command: entry.command ?? null,
    args: entry.args ? [...entry.args] : null,
    publishDirectory: build.publishDirectory ?? null,
    createEnvFile: build.createEnvFile ?? true,
    enableSubmodules: build.enableSubmodules ?? false,
    watchPaths: build.watchPaths ? [...build.watchPaths] : null,
    ...capsFor(entry),
  };
  if (entry.kind === 'static') {
    return {
      ...shared,
      buildType: 'static',
      isStaticSpa: entry.build?.isStaticSpa ?? false,
    };
  }
  const web = entry.build ?? {};
  return {
    ...shared,
    // A `worker` and a Cron service have no port; the column
    // keeps what a create leaves.
    ...(entry.kind === 'worker' || entry.kind === 'cron'
      ? {}
      : { port: entry.port }),
    buildType: web.buildType ?? DEFAULTS.buildType,
    railpackVersion: web.railpackVersion ?? DEFAULTS.railpackVersion,
    herokuVersion: web.herokuVersion ?? DEFAULTS.herokuVersion,
    dockerfile: web.dockerfile ?? DEFAULTS.dockerfile,
    dockerContextPath: web.dockerContextPath ?? null,
    dockerBuildStage: web.dockerBuildStage ?? null,
  };
}

/**
 * The Swarm columns an entry's `native.docker` owns on a Server,
 * each at the block's value or `null`, Cloudgate's default for the kind,
 * where it writes none: all seven, or on a `cron` or a `bucket` the keys it
 * takes, the others' columns staying as they are. Written on every
 * create and change of a Service Swarm runs, so the next plan compares equal.
 */
export function swarmSettings(
  entry: DescribedEntry,
): Partial<NativeDockerColumns> {
  return takesNativeDocker(entry.kind)
    ? openDockerColumns(entry.kind, entry.native?.docker)
    : {};
}

/** A Cron service's timetable columns, a left-out field at its default. */
export function cronTimetable(entry: CronEntry): CronTimetable {
  return {
    cronSchedule: entry.schedule,
    cronTimezone: entry.timezone ?? DEFAULT_TIMEZONE,
    cronTimeoutSeconds: entry.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS,
  };
}

/**
 * A source's columns. `connection` is the resolved connection for a hosted
 * source, and `null` when the repository is the one the Service already
 * builds (only its path changed), in which case the connection and branch,
 * Cloudgate's, are left as they are.
 */
export function sourceSettings(
  source: Source | undefined,
  connection: ResolvedConnection | null,
  isNewRepository: boolean,
): UpdateApplicationDto {
  if (!source) {
    // No source: what a console create leaves, which the planner reads as none.
    return { sourceType: 'github', owner: null, repository: null };
  }
  if (source.sourceType === 'docker') {
    return { sourceType: 'docker', dockerImage: source.dockerImage };
  }
  if (source.sourceType === 'drop') {
    // A folder source (ADR-0080): uploaded files, built from the folder.
    return { sourceType: 'drop', dropBuildPath: source.buildPath };
  }
  return {
    ...repositorySettings(source, connection, isNewRepository),
    ...buildPathSettings(source),
  };
}

/** The column each repository source keeps its build path in. */
const BUILD_PATH_COLUMN = {
  git: 'customGitBuildPath',
  github: 'buildPath',
  gitlab: 'gitlabBuildPath',
  gitea: 'giteaBuildPath',
  bitbucket: 'bitbucketBuildPath',
} as const satisfies Record<
  RepositorySource['sourceType'],
  keyof UpdateApplicationDto
>;

/** An Application's build path, in its source's column; `/` by default. */
function buildPathSettings(
  source: Exclude<Source, { sourceType: 'docker' | 'drop' }>,
): UpdateApplicationDto {
  return { [BUILD_PATH_COLUMN[source.sourceType]]: source.buildPath ?? '/' };
}

/**
 * The columns a repository source writes, on an Application and a Compose
 * stack alike (ADR-0069), which name them the same: the source, and, when
 * the repository is new to the Service, the connection and branch it needs
 * to clone. A build path is an Application's alone ({@link sourceSettings}).
 */
export function repositorySettings(
  source: RepositorySource,
  connection: ResolvedConnection | null,
  isNewRepository: boolean,
): UpdateApplicationDto & UpdateComposeDto {
  switch (source.sourceType) {
    case 'git':
      return {
        sourceType: 'git',
        customGitUrl: source.customGitUrl,
        ...(isNewRepository ? { customGitBranch: CUSTOM_GIT_BRANCH } : {}),
      };
    case 'github':
      return {
        sourceType: 'github',
        ...(connection?.sourceType === 'github'
          ? {
              githubId: connection.githubId,
              owner: connection.owner,
              repository: connection.repository,
              branch: connection.defaultBranch,
            }
          : {}),
      };
    case 'gitlab':
      return {
        sourceType: 'gitlab',
        ...(connection?.sourceType === 'gitlab'
          ? {
              gitlabId: connection.gitlabId,
              gitlabProjectId: connection.projectId,
              gitlabOwner: connection.owner,
              gitlabRepository: connection.repository,
              gitlabPathNamespace: connection.pathNamespace,
              gitlabBranch: connection.defaultBranch,
            }
          : {}),
      };
    case 'gitea':
      return {
        sourceType: 'gitea',
        ...(connection?.sourceType === 'gitea'
          ? {
              giteaId: connection.giteaId,
              giteaOwner: connection.owner,
              giteaRepository: connection.repository,
              giteaBranch: connection.defaultBranch,
            }
          : {}),
      };
    case 'bitbucket':
      return {
        sourceType: 'bitbucket',
        ...(connection?.sourceType === 'bitbucket'
          ? {
              bitbucketId: connection.bitbucketId,
              bitbucketOwner: connection.owner,
              bitbucketRepository: connection.repository,
              bitbucketRepositorySlug: connection.slug,
              bitbucketBranch: connection.defaultBranch,
            }
          : {}),
      };
  }
}

/**
 * Whether a changed source names a repository (or image or URL) the Service
 * — an Application, or a Compose stack (ADR-0069) — does not already build
 * from. Only then is a connection resolved and the branch reset to the
 * repository's default; a path-only change keeps the Service's connection
 * and branch, which are Cloudgate's.
 */
export function isNewRepository(
  found: SavedService | undefined,
  source: Source | undefined,
): boolean {
  if (
    !source ||
    (found?.serviceType !== 'application' && found?.serviceType !== 'compose')
  ) {
    return true;
  }
  const settings = found.settings;
  if (settings.sourceType !== source.sourceType) return true;
  const repo = (owner: string | null, name: string | null) =>
    owner && name ? `${owner}/${name}`.toLowerCase() : null;
  switch (source.sourceType) {
    case 'github':
      return (
        repo(settings.owner, settings.repository) !==
        source.repository.toLowerCase()
      );
    case 'gitlab':
      return (
        (
          settings.gitlabPathNamespace ??
          repo(settings.gitlabOwner, settings.gitlabRepository) ??
          ''
        ).toLowerCase() !== source.repository.toLowerCase()
      );
    case 'gitea':
      return (
        repo(settings.giteaOwner, settings.giteaRepository) !==
        source.repository.toLowerCase()
      );
    case 'bitbucket':
      return (
        repo(settings.bitbucketOwner, settings.bitbucketRepository) !==
        source.repository.toLowerCase()
      );
    case 'git':
      return settings.customGitUrl !== source.customGitUrl;
    case 'docker':
      return true;
    case 'drop':
      // Uploaded files name no repository: only the folder changed.
      return false;
  }
}

export function mysqlSettings(entry: MysqlEntry): {
  description: string | null;
  dockerImage: string;
  databaseName?: string;
  databaseUser?: string;
  cpuLimit?: string;
  memoryLimit?: string;
} {
  return {
    description: entry.description ?? null,
    dockerImage: entry.dockerImage ?? 'mysql:8.4',
    ...(entry.databaseName !== undefined
      ? { databaseName: entry.databaseName }
      : {}),
    ...(entry.databaseUser !== undefined
      ? { databaseUser: entry.databaseUser }
      : {}),
    ...capsFor(entry),
  };
}

export function postgresSettings(entry: PostgresEntry): {
  description: string | null;
  dockerImage: string;
  databaseName?: string;
  databaseUser?: string;
  cpuLimit?: string;
  memoryLimit?: string;
} {
  return {
    description: entry.description ?? null,
    dockerImage: entry.dockerImage ?? 'postgres:18',
    ...(entry.databaseName !== undefined
      ? { databaseName: entry.databaseName }
      : {}),
    ...(entry.databaseUser !== undefined
      ? { databaseUser: entry.databaseUser }
      : {}),
    ...capsFor(entry),
  };
}

export function redisSettings(entry: RedisEntry): {
  description: string | null;
  dockerImage: string;
  cpuLimit?: string;
  memoryLimit?: string;
} {
  return {
    description: entry.description ?? null,
    dockerImage: entry.dockerImage ?? 'redis:8',
    ...capsFor(entry),
  };
}
