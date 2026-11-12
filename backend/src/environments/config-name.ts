import { ConflictException } from '@nestjs/common';
import { inArray, sql } from 'drizzle-orm';
import type { ServiceType } from '../applications/application.schema';
import type { DrizzleDB } from '../db/drizzle.module';
import { SERVICE_SOURCES } from './environment-services';

// A Service's **Config name** (CONTEXT.md): the fixed key a Project
// config uses for it. It is minted once, at create or by the upgrade's
// backfill (`drizzle/0095_service-config-name.sql`), and never follows a
// rename of the display name, which stays Cloudgate's label.

// The format itself is the Project config's (`CONFIG_NAME_REGEX`), one regex
// for the parser, the JSON Schema and what this mints.

const MAX_LENGTH = 63;

/** `base` cut so that `suffix` still fits, with no hyphen left dangling. */
const fit = (base: string, suffix = ''): string =>
  base.slice(0, MAX_LENGTH - suffix.length).replace(/-+$/, '') + suffix;

/**
 * The Config name a Service with this display name gets, given the names
 * already taken in its Environment.
 *
 * The display name is slugged — lowercased, every run of anything but `a-z`
 * and `0-9` one hyphen, hyphens trimmed — and `-2`, `-3`, … is added on a
 * clash. **The kind stands in where the slug cannot start a name:** a display
 * name that slugs to nothing (`???`, `日本`) is named after its kind, and one
 * that would start with a digit gets the kind in front, rather than a random
 * token nobody can tell apart in a config.
 *
 * Diacritics are dropped rather than folded (`Café` → `caf`) on purpose: the
 * backfill spells this same slug in SQL, which has no `unaccent` without an
 * extension, and the two must agree.
 */
export function mintConfigName(
  displayName: string,
  kind: ServiceType,
  taken: ReadonlySet<string>,
): string {
  const slug = displayName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const base = fit(
    slug === '' ? kind : /^[0-9]/.test(slug) ? `${kind}-${slug}` : slug,
  );
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = fit(base, `-${n}`);
    if (!taken.has(candidate)) return candidate;
  }
}

/** A transaction handle, as `db.transaction`'s callback receives it. */
export type DrizzleTx = Parameters<Parameters<DrizzleDB['transaction']>[0]>[0];

/**
 * The one minting path for a new Service's Config name, to be called inside
 * the transaction that inserts the Service.
 *
 * Uniqueness is across all eight Service tables, and no single index can say
 * that, so this takes a per-Environment lock (a transaction-scoped advisory
 * lock keyed by the Environment id) and reads every table's names under it:
 * two creates racing in one Environment mint one after the other, and the
 * second sees the first's name. The per-table unique index on
 * `(environment_id, config_name)` is the backstop for a writer that skips
 * this path.
 */
export async function mintServiceConfigName(
  tx: DrizzleTx,
  environmentId: string,
  kind: ServiceType,
  displayName: string,
): Promise<string> {
  return mintConfigName(
    displayName,
    kind,
    await takenConfigNames(tx, environmentId),
  );
}

/**
 * A new Service's Config name when it is already decided: a plan creating
 * the Service a config entry names, whose key *is* the Config name.
 * Under the same per-Environment lock as {@link mintServiceConfigName}; a
 * name another Service has taken since the plan was made is refused rather
 * than suffixed, because a suffixed name would be a Service the config does
 * not describe.
 */
export async function claimServiceConfigName(
  tx: DrizzleTx,
  environmentId: string,
  configName: string,
): Promise<string> {
  if ((await takenConfigNames(tx, environmentId)).has(configName)) {
    throw new ConflictException(
      `A Service named ${configName} already exists in this Environment`,
    );
  }
  return configName;
}

/** Every Config name in the Environment, read under its minting lock. */
async function takenConfigNames(
  tx: DrizzleTx,
  environmentId: string,
): Promise<Set<string>> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`config-name:${environmentId}`}, 0))`,
  );
  return configNamesIn(tx, [environmentId]);
}

/**
 * Every Config name a Service holds in these Environments, read without the
 * minting lock: an answer to "is this taken", as a Template setup asks it
 * across a Project's Environments before a plan claims each name at Apply.
 */
export async function configNamesIn(
  db: DrizzleDB | DrizzleTx,
  environmentIds: readonly string[],
): Promise<Set<string>> {
  if (environmentIds.length === 0) return new Set();
  const [first, ...rest] = Object.values(SERVICE_SOURCES).map((source) =>
    db
      .select({
        configName: sql<string>`${source.configName}`.as('config_name'),
      })
      .from(source.table)
      .where(inArray(source.environmentId, [...environmentIds])),
  );
  const rows = await rest.reduce<
    typeof first | ReturnType<typeof first.unionAll>
  >((acc, arm) => acc.unionAll(arm), first);
  return new Set(rows.map((row) => row.configName));
}
