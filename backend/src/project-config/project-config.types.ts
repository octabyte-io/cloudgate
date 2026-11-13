import type { BuildType } from '../applications/application.schema';
import type { NativeRename } from '../native/address-snapshot';
import type { NativeBlock } from '../native/native-wire';
import type { Size } from './format/config-size';

/**
 * A parsed `version: 1` Project config, in **backend field names**.
 * The wire's snake_case (`build_args`, `create_env_file`, `spa`, …) never
 * reaches past `format/config-wire.ts`, which is the one place it is
 * translated, so the planner and generator speak the columns' language.
 *
 * Absence is kept where it means something: a missing `size` leaves the caps
 * Cloudgate's, a missing `source` or build field is not the same as an
 * empty one. Variable-name lists are the exception — the config owns the names,
 * so an absent list is the empty list.
 */
export interface ProjectConfig {
  readonly version: 1;
  /** Keyed by Config name, in the order the text lists them. */
  readonly services: Readonly<Record<string, ServiceEntry>>;
}

export type ServiceEntry =
  | WebEntry
  | WebPrivateEntry
  | StaticEntry
  | WorkerEntry
  | PostgresEntry
  | MysqlEntry
  | RedisEntry
  | CronEntry
  | BucketEntry
  | ComposeEntry
  | ConsoleManagedEntry;

/** Listed by name and kind only, and never touched by a plan. */
export interface ConsoleManagedEntry {
  /** Any kind, an expressible one included. */
  readonly kind: string;
  readonly managed: 'console';
}

/** Where an Application's code or image comes from. */
export type Source =
  | {
      readonly sourceType: 'github' | 'gitlab' | 'gitea' | 'bitbucket';
      /** `owner/repo` (a GitLab group path may nest). */
      readonly repository: string;
      readonly buildPath?: string;
    }
  | {
      readonly sourceType: 'git';
      readonly customGitUrl: string;
      readonly buildPath?: string;
    }
  | { readonly sourceType: 'docker'; readonly dockerImage: string }
  | {
      /**
       * Uploaded files: a config's `folder` source (ADR-0080), the whole
       * **Project folder** uploaded and built from this subfolder of it,
       * written relative to it with no trailing `/`.
       */
      readonly sourceType: 'drop';
      readonly buildPath: string;
    };

interface SharedBuild {
  readonly publishDirectory?: string;
  readonly createEnvFile?: boolean;
  readonly enableSubmodules?: boolean;
  readonly watchPaths?: readonly string[];
}

export interface WebBuild extends SharedBuild {
  readonly buildType?: Exclude<BuildType, 'static'>;
  readonly railpackVersion?: string;
  readonly herokuVersion?: string;
  readonly dockerfile?: string;
  readonly dockerContextPath?: string;
  readonly dockerBuildStage?: string;
}

export interface StaticBuild extends SharedBuild {
  readonly isStaticSpa?: boolean;
}

/**
 * A wired variable's source (ADR-0031): the Service the config names it by,
 * and which of its Outputs fills the variable in at deploy.
 */
export interface ConfigLink {
  readonly source: string;
  readonly output: string;
}

/** Wired variables by name; the names are never in `env`. */
export type ConfigLinks = Readonly<Record<string, ConfigLink>>;

interface Described {
  readonly managed: false;
  readonly description?: string;
  readonly size?: Size;
  /**
   * The `env` names whose value is typed in Cloudgate. A wired variable is
   * not one: it is in {@link links}, so a name has one source.
   */
  readonly env: readonly string[];
  /**
   * The `env` entries that link to another Service's Output (ADR-0031),
   * absent when there are none.
   */
  readonly links?: ConfigLinks;
  /**
   * Native settings (ADR-0044), as written: `native.docker`'s keys
   * are Docker's own spelling, so nothing is renamed. Absent when the entry
   * writes none, which is Cloudgate's default for the kind, not "leave it".
   * A cloud block's addresses are the ones generated now: one the file
   * names by an old name is read under its new one.
   */
  readonly native?: NativeBlock;
  /** The old addresses its native blocks named, read as their new ones; absent when none. */
  readonly nativeRenamed?: readonly NativeRename[];
}

interface Buildable extends Described {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly buildArgs: readonly string[];
  readonly buildSecrets: readonly string[];
}

export interface WebEntry extends Buildable {
  readonly kind: 'web';
  readonly source?: Source;
  readonly build?: WebBuild;
  /** 3000 when the config names none. */
  readonly port: number;
}

/**
 * A `web` reached only at its internal address `http://<appName>:<port>`,
 * by the other Services on its Server: no Domain, no published port,
 * no previews.
 */
export interface WebPrivateEntry extends Buildable {
  readonly kind: 'web-private';
  readonly source?: Source;
  readonly build?: WebBuild;
  /** Required: the port its callers are given. */
  readonly port: number;
}

/** An Application built the way a `web` is: a `web` or a `web-private`. */
export type WebLikeEntry = WebEntry | WebPrivateEntry;

/**
 * A Worker: an Application with `web`'s build and no `port`, given no
 * Domain and no preview.
 */
export interface WorkerEntry extends Buildable {
  readonly kind: 'worker';
  readonly source?: Source;
  readonly build?: WebBuild;
}

/** An Application built by the `static` build type. */
export interface StaticEntry extends Buildable {
  readonly kind: 'static';
  readonly source?: Exclude<Source, { sourceType: 'docker' }>;
  readonly build?: StaticBuild;
}

/**
 * A Cron service (ADR-0034): built as a `web` is, with no port, and
 * run as `command` on `schedule`. `timezone` and `timeout` are kept absent
 * when the config leaves them out; the planner reads `UTC` and `1h` then.
 */
export interface CronEntry extends Buildable {
  readonly kind: 'cron';
  readonly command: string;
  readonly source?: Source;
  readonly build?: WebBuild;
  /** Five-field unix cron, as written. */
  readonly schedule: string;
  /** An IANA time zone name. */
  readonly timezone?: string;
  /** A run's time limit, in seconds. */
  readonly timeoutSeconds?: number;
}

export interface PostgresEntry extends Described {
  readonly kind: 'postgres';
  /** `postgres:<version>`. */
  readonly dockerImage?: string;
  readonly databaseName?: string;
  readonly databaseUser?: string;
}

/** A MySQL takes exactly a postgres's fields. */
export interface MysqlEntry extends Described {
  readonly kind: 'mysql';
  /** `mysql:<version>`. */
  readonly dockerImage?: string;
  readonly databaseName?: string;
  /** At most 32 characters, MySQL's limit; `root` is allowed. */
  readonly databaseUser?: string;
}

export interface RedisEntry extends Described {
  readonly kind: 'redis';
  /** `redis:<version>`. */
  readonly dockerImage?: string;
}

/**
 * A Bucket: a kind and a description, nothing more. It reads no
 * variables and has no size, so `env` is always empty and `size` never set;
 * both are here only so every described entry answers the same two
 * questions.
 */
export interface BucketEntry {
  readonly kind: 'bucket';
  readonly managed: false;
  readonly description?: string;
  readonly env: readonly [];
  readonly size?: undefined;
  /** It links no Output: it has no variables to wire (ADR-0031). */
  readonly links?: undefined;
  /** Read so a plan refuses its `native.docker` by name. */
  readonly native?: NativeBlock;
  /** As on every described entry. */
  readonly nativeRenamed?: readonly NativeRename[];
}

/** The repository a `compose` entry names: a provider's, or a git URL. */
export type ComposeSource =
  | {
      readonly sourceType: 'github' | 'gitlab' | 'gitea' | 'bitbucket';
      /** `owner/repo` (a GitLab group path may nest). */
      readonly repository: string;
    }
  | { readonly sourceType: 'git'; readonly customGitUrl: string };

/**
 * A Compose stack (ADR-0069): the compose file it is deployed from,
 * named by its repository, its path there and how it is deployed, never
 * held. Like a bucket's, its `env` is always empty: the stack's variables,
 * branch, Domains and mounts are Cloudgate's. Its `size` is its Stack VM's
 * in a Cloud Environment (ADR-0070).
 */
export interface ComposeEntry {
  readonly kind: 'compose';
  readonly managed: false;
  readonly source: ComposeSource;
  /** From the repository's root; `docker-compose.yml` when left out. */
  readonly composePath?: string;
  /** `docker-compose` when left out. */
  readonly composeType?: 'docker-compose' | 'stack';
  readonly description?: undefined;
  readonly env: readonly [];
  /** Its Stack VM's size in a Cloud Environment (ADR-0070); unread on a Server. */
  readonly size?: Size;
  /** It links no Output: it has no variables the config names. */
  readonly links?: undefined;
  /**
   * Its cloud block sets its Stack VM (ADR-0070); a `native.docker` is
   * refused by name.
   */
  readonly native?: NativeBlock;
  /** As on every described entry. */
  readonly nativeRenamed?: readonly NativeRename[];
}

/**
 * Why a config text was refused, naming where (US17).
 *
 * - `syntax`: the text is not YAML (or JSON). `at` is `null`; the message
 *   carries the line.
 * - `version`: `version` is missing or not one this Cloudgate reads; the
 *   message names it.
 * - `invalid`: an entry is malformed. `at` is `<service>.<field>` (`web.port`,
 *   `web.source.git`), or `<service>` for the entry as a whole, or a top-level
 *   field.
 */
export interface ConfigRefusal {
  readonly reason: 'syntax' | 'version' | 'invalid';
  readonly at: string | null;
  /** The sentence an operator reads, naming `at` when there is one. */
  readonly message: string;
}

export type ParseResult =
  | { readonly ok: true; readonly config: ProjectConfig }
  | { readonly ok: false; readonly refusal: ConfigRefusal };
