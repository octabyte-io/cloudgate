import type {
  CronEntry,
  ServiceEntry,
  StaticEntry,
  WebLikeEntry,
  WorkerEntry,
} from '../project-config.types';
import type { SavedVariableKeys } from './plan.types';

/** An entry the config describes, as opposed to a `managed: console` line. */
export type DescribedEntry = Exclude<ServiceEntry, { managed: 'console' }>;

/** An entry an Application row holds: built from a source, as a `web` is. */
export type ApplicationEntry =
  WebLikeEntry | WorkerEntry | StaticEntry | CronEntry;

export function isApplicationEntry(
  entry: DescribedEntry,
): entry is ApplicationEntry {
  return (
    entry.kind === 'web' ||
    entry.kind === 'web-private' ||
    entry.kind === 'worker' ||
    entry.kind === 'static' ||
    entry.kind === 'cron'
  );
}

/**
 * The config's variable-name lists, as the config writes them and a plan's
 * field names them. The one list the planner, the generator, the Applier and
 * the console Saves' rewrite all read.
 */
export const VARIABLE_LISTS = ['env', 'build_args', 'build_secrets'] as const;

export type VariableList = (typeof VARIABLE_LISTS)[number];

export function isVariableList(field: string): field is VariableList {
  return (VARIABLE_LISTS as readonly string[]).includes(field);
}

/** The keys a Service holds for each list; a kind with no such blob holds none. */
export const VARIABLE_KEYS: Readonly<
  Record<VariableList, (held: SavedVariableKeys) => readonly string[]>
> = {
  env: (held) => held.env,
  build_args: (held) => held.buildArgs ?? [],
  build_secrets: (held) => held.buildSecrets ?? [],
};

/**
 * Fields compared only when the config states them: leaving one
 * out leaves the Service's own value, because there is no create default to
 * compare it with — a `size` (the caps stay Cloudgate's) and a postgres's
 * or a mysql's `database` and `user`.
 */
export const ONLY_WHEN_STATED: ReadonlySet<string> = new Set([
  'size',
  'database',
  'user',
]);

/** Of the {@link ONLY_WHEN_STATED} fields, those `entry` states. */
export function statedFields(entry: DescribedEntry): ReadonlySet<string> {
  const stated = new Set<string>();
  if (entry.size !== undefined) stated.add('size');
  if (entry.kind === 'postgres' || entry.kind === 'mysql') {
    if (entry.databaseName !== undefined) stated.add('database');
    if (entry.databaseUser !== undefined) stated.add('user');
  }
  return stated;
}

/** The names an entry lists in each variable list. */
export const LISTED_NAMES: Readonly<
  Record<VariableList, (entry: DescribedEntry) => readonly string[]>
> = {
  env: (entry) => entry.env,
  build_args: (entry) => ('buildArgs' in entry ? entry.buildArgs : []),
  build_secrets: (entry) => ('buildSecrets' in entry ? entry.buildSecrets : []),
};
