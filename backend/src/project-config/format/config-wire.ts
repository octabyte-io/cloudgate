import { timeoutSeconds } from '../../cron-services/cron-fields';
import { SOURCE_PROVIDERS } from './config-schema';
import type { ProjectConfigWire, ServiceEntryWire } from './config-schema';
import { toSize } from './config-size';
import type {
  ComposeSource,
  ConfigLink,
  ConfigLinks,
  ProjectConfig,
  ServiceEntry,
  Source,
  StaticBuild,
  WebBuild,
} from '../project-config.types';

/**
 * The one place a wire name becomes a backend field name. Every
 * snake_case key the format admits is spelled here and nowhere else beside
 * `config-schema.ts`; the generator, when it lands, inverts this table rather
 * than keeping its own.
 *
 * A key the config left out stays out (see `ProjectConfig`): `defined` drops
 * `undefined` so a parsed entry compares equal to one built by hand.
 */
export function fromWire(wire: ProjectConfigWire): ProjectConfig {
  const services: Record<string, ServiceEntry> = {};
  for (const [name, entry] of Object.entries(wire.services ?? {})) {
    services[name] = entryFromWire(entry);
  }
  return { version: 1, services };
}

function entryFromWire(entry: ServiceEntryWire): ServiceEntry {
  if ('managed' in entry) return { kind: entry.kind, managed: 'console' };
  if (entry.kind === 'compose') {
    return defined({
      kind: 'compose',
      managed: false,
      source: composeSourceFromWire(entry.source),
      composePath: entry.file,
      composeType: entry.type,
      size: entry.size === undefined ? undefined : toSize(entry.size),
      env: [],
      native: entry.native,
    });
  }
  if (entry.kind === 'bucket') {
    return defined({
      kind: 'bucket',
      managed: false,
      description: entry.description,
      env: [],
      native: entry.native,
    });
  }

  const described = {
    managed: false as const,
    description: entry.description,
    size: entry.size === undefined ? undefined : toSize(entry.size),
    env: (entry.env ?? []).filter((e) => typeof e === 'string'),
    links: linksFromWire(entry.env ?? []),
    // In Docker's own spelling already: nothing here is renamed.
    native: entry.native,
  };

  switch (entry.kind) {
    case 'web':
    case 'web-private':
    case 'worker':
    case 'static':
    case 'cron': {
      const buildable = {
        ...described,
        command: entry.command,
        args: entry.args,
        buildArgs: entry.build_args ?? [],
        buildSecrets: entry.build_secrets ?? [],
      };
      if (entry.kind === 'worker') {
        return defined({
          kind: 'worker',
          ...buildable,
          source: entry.source && sourceFromWire(entry.source),
          build: entry.build && webBuildFromWire(entry.build),
        });
      }
      if (entry.kind === 'cron') {
        return defined({
          kind: 'cron',
          ...buildable,
          command: entry.command,
          source: entry.source && sourceFromWire(entry.source),
          build: entry.build && webBuildFromWire(entry.build),
          schedule: entry.schedule.trim(),
          timezone: entry.timezone,
          timeoutSeconds:
            entry.timeout === undefined
              ? undefined
              : (timeoutSeconds(entry.timeout) ?? undefined),
        });
      }
      if (entry.kind === 'web') {
        return defined({
          kind: 'web',
          ...buildable,
          source: entry.source && sourceFromWire(entry.source),
          build: entry.build && webBuildFromWire(entry.build),
          port: entry.port ?? 3000,
        });
      }
      if (entry.kind === 'web-private') {
        return defined({
          kind: 'web-private',
          ...buildable,
          source: entry.source && sourceFromWire(entry.source),
          build: entry.build && webBuildFromWire(entry.build),
          port: entry.port,
        });
      }
      return defined({
        kind: 'static',
        ...buildable,
        source:
          entry.source &&
          (sourceFromWire(entry.source) as Exclude<
            Source,
            { sourceType: 'docker' }
          >),
        build: entry.build && staticBuildFromWire(entry.build),
      });
    }
    case 'postgres':
      return defined({
        kind: 'postgres',
        ...described,
        dockerImage: entry.version && `postgres:${entry.version}`,
        databaseName: entry.database,
        databaseUser: entry.user,
      });
    case 'mysql':
      return defined({
        kind: 'mysql',
        ...described,
        dockerImage: entry.version && `mysql:${entry.version}`,
        databaseName: entry.database,
        databaseUser: entry.user,
      });
    case 'redis':
      return defined({
        kind: 'redis',
        ...described,
        dockerImage: entry.version && `redis:${entry.version}`,
      });
  }
}

/**
 * The `env` entries that are links, `{ NAME: <service>.<output> }`, split at
 * the last dot (a Config name has none). `undefined` when there are none, so
 * an entry with no link compares equal to one built without the field.
 */
function linksFromWire(
  env: readonly (string | Record<string, string>)[],
): ConfigLinks | undefined {
  const links: Record<string, ConfigLink> = {};
  for (const entry of env) {
    if (typeof entry === 'string') continue;
    const [[name, target]] = Object.entries(entry);
    const dot = target.lastIndexOf('.');
    links[name] = {
      source: target.slice(0, dot),
      output: target.slice(dot + 1),
    };
  }
  return Object.keys(links).length > 0 ? links : undefined;
}

/**
 * What a database's `database` and `user` are when the entry leaves them
 * out and the plan creates it: its Config name with `-` turned into `_`. A
 * `postgres`'s user is {@link defaultPostgresUser}, which may differ.
 */
export function defaultDatabaseIdentifier(configName: string): string {
  return configName.replaceAll('-', '_');
}

/**
 * Whether PostgreSQL refuses `name` as a role: it reserves every role
 * name starting with `pg_`. Any case, as RDS and Cloud SQL fold one. A
 * database may be named so; only a role may not.
 */
export function postgresReservesRole(name: string): boolean {
  return name.toLowerCase().startsWith('pg_');
}

/** Why a `postgres`'s `user` is refused when {@link postgresReservesRole}. */
export const POSTGRES_RESERVED_ROLE =
  'PostgreSQL reserves role names starting with pg_; choose another user:';

/**
 * What a `postgres`'s `user` is when the entry leaves it out: its
 * {@link defaultDatabaseIdentifier}, or `app_` before it when that is a role
 * PostgreSQL reserves, so `pg-1` gets `app_pg_1`. Its `database` stays
 * `pg_1`. A MySQL keeps the plain identifier, which MySQL takes.
 */
export function defaultPostgresUser(configName: string): string {
  const identifier = defaultDatabaseIdentifier(configName);
  return postgresReservesRole(identifier) ? `app_${identifier}` : identifier;
}

type SourceWire = Record<string, string | undefined>;

function sourceFromWire(source: SourceWire): Source {
  if (source.image !== undefined) {
    return { sourceType: 'docker', dockerImage: source.image };
  }
  if (source.git !== undefined) {
    return defined({
      sourceType: 'git',
      customGitUrl: source.git,
      buildPath: source.path,
    });
  }
  const provider = SOURCE_PROVIDERS.find((p) => source[p] !== undefined);
  // The schema admits exactly one source key, so this is unreachable.
  if (!provider) throw new Error('a source names no provider');
  return defined({
    sourceType: provider,
    repository: source[provider] as string,
    buildPath: source.path,
  });
}

/** A `compose` entry's source: a provider key or a git URL, never a path. */
function composeSourceFromWire(source: SourceWire): ComposeSource {
  const found = sourceFromWire(source);
  if (found.sourceType === 'docker') {
    // The schema admits no `image` on a compose source.
    throw new Error('a compose source names an image');
  }
  return found.sourceType === 'git'
    ? { sourceType: 'git', customGitUrl: found.customGitUrl }
    : { sourceType: found.sourceType, repository: found.repository };
}

interface SharedBuildWire {
  publish?: string;
  create_env_file?: boolean;
  submodules?: boolean;
  watch_paths?: string[];
}

function sharedBuildFromWire(build: SharedBuildWire) {
  return {
    publishDirectory: build.publish,
    createEnvFile: build.create_env_file,
    enableSubmodules: build.submodules,
    watchPaths: build.watch_paths,
  };
}

function webBuildFromWire(
  build: SharedBuildWire & {
    type?: string;
    railpack_version?: string;
    heroku_version?: string;
    dockerfile?: string;
    context?: string;
    stage?: string;
  },
): WebBuild {
  return defined({
    buildType: build.type as WebBuild['buildType'],
    railpackVersion: build.railpack_version,
    herokuVersion: build.heroku_version,
    dockerfile: build.dockerfile,
    dockerContextPath: build.context,
    dockerBuildStage: build.stage,
    ...sharedBuildFromWire(build),
  });
}

function staticBuildFromWire(
  build: SharedBuildWire & { spa?: boolean },
): StaticBuild {
  return defined({ isStaticSpa: build.spa, ...sharedBuildFromWire(build) });
}

function defined<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, v]) => v !== undefined),
  ) as T;
}
