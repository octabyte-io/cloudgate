import { and, eq } from 'drizzle-orm';

import type { DrizzleDB } from '../../db/drizzle.module';
import { databaseSwitch } from './database-switch.schema';
import type {
  DatabaseSwitch,
  DatabaseSwitchKind,
  DatabaseSwitchTo,
} from './database-switch.schema';

/** Which Environment's entry a switch is of. */
export interface SwitchPlace {
  readonly environmentId: string;
  readonly configName: string;
}

/**
 * A switch as the API answers it: which way, the existing database
 * it goes to or leaves, and what the next plan's Apply does — never the
 * login's password.
 */
export interface SwitchView {
  readonly to: DatabaseSwitchTo;
  /** The RDS identifier it switches to; `null` on a switch to a Cloudgate-made one. */
  readonly identifier: string | null;
  readonly sentence: string;
}

/** What a switch of a redis to an existing cache holds. */
export interface ExistingCacheChoice {
  readonly identifier: string;
  readonly madeReachable: boolean;
  readonly tls: boolean;
  /** Empty: the cache has no AUTH token. */
  readonly authToken: string;
}

/** What a switch to an existing database holds. */
export interface ExistingChoice {
  readonly identifier: string;
  readonly madeReachable: boolean;
  readonly databaseUser: string;
  readonly databaseName: string;
  readonly databasePassword: string;
}

export function switchView(
  row: Pick<DatabaseSwitch, 'to' | 'identifier' | 'configName' | 'kind'>,
  leaving: string | null,
): SwitchView {
  const what = row.kind === 'redis' ? 'cache' : 'database';
  return {
    to: row.to,
    identifier: row.to === 'existing' ? row.identifier : null,
    sentence:
      row.to === 'existing'
        ? `The next plan switches ${row.configName} to the existing ${what} ${row.identifier}: its Apply deletes the ${what} Cloudgate made, as its Delete would, and no data is copied. Once that Delete is done, the next plan's Apply adds ${row.identifier}`
        : `The next plan switches ${row.configName} to a ${what} Cloudgate makes: its Apply removes only Cloudgate's records of ${leaving ?? `the existing ${what}`}, which is left as it was, and no data is copied`,
  };
}

/** The switch of an Environment's entry, when it was asked on a Service of `kind`. */
export async function switchOf(
  db: Pick<DrizzleDB, 'select'>,
  place: SwitchPlace,
  kind: DatabaseSwitchKind,
): Promise<DatabaseSwitch | null> {
  const [found] = await db
    .select()
    .from(databaseSwitch)
    .where(
      and(
        eq(databaseSwitch.environmentId, place.environmentId),
        eq(databaseSwitch.configName, place.configName),
        eq(databaseSwitch.kind, kind),
      ),
    );
  return found ?? null;
}

/** Every switch an Environment's next plan makes. */
export function switchesOf(
  db: Pick<DrizzleDB, 'select'>,
  environmentId: string,
): Promise<DatabaseSwitch[]> {
  return db
    .select()
    .from(databaseSwitch)
    .where(eq(databaseSwitch.environmentId, environmentId));
}

/** Records (or replaces) the switch of an Environment's entry. */
export async function askSwitch(
  db: Pick<DrizzleDB, 'insert'>,
  place: SwitchPlace,
  choice:
    | { readonly kind: DatabaseSwitchKind; readonly to: 'made' }
    | ({
        readonly kind: 'postgres' | 'mysql';
        readonly to: 'existing';
      } & ExistingChoice)
    | ({
        readonly kind: 'redis';
        readonly to: 'existing';
      } & ExistingCacheChoice),
): Promise<void> {
  const none = {
    identifier: null,
    madeReachable: false,
    databaseUser: null,
    databaseName: null,
    databasePassword: null,
    tls: true,
    authToken: null,
  };
  const values =
    choice.to === 'made'
      ? none
      : 'databaseUser' in choice
        ? {
            ...none,
            identifier: choice.identifier,
            madeReachable: choice.madeReachable,
            databaseUser: choice.databaseUser,
            databaseName: choice.databaseName,
            databasePassword: choice.databasePassword,
          }
        : {
            ...none,
            identifier: choice.identifier,
            madeReachable: choice.madeReachable,
            tls: choice.tls,
            authToken: choice.authToken || null,
          };
  const kind = choice.kind;
  await db
    .insert(databaseSwitch)
    .values({ ...place, kind, to: choice.to, ...values })
    .onConflictDoUpdate({
      target: [databaseSwitch.environmentId, databaseSwitch.configName],
      set: {
        kind,
        to: choice.to,
        ...values,
        createdAt: new Date().toISOString(),
      },
    });
}

export async function dropSwitch(
  db: Pick<DrizzleDB, 'delete'>,
  place: SwitchPlace,
): Promise<void> {
  await db
    .delete(databaseSwitch)
    .where(
      and(
        eq(databaseSwitch.environmentId, place.environmentId),
        eq(databaseSwitch.configName, place.configName),
      ),
    );
}

/**
 * The login a switch to an existing database holds, or `null` when it holds
 * none: a postgres's, or a mysql's.
 */
export function existingChoiceOf(row: DatabaseSwitch): ExistingChoice | null {
  if (
    (row.kind !== 'postgres' && row.kind !== 'mysql') ||
    row.to !== 'existing' ||
    row.identifier === null ||
    row.databaseUser === null ||
    row.databaseName === null ||
    row.databasePassword === null
  ) {
    return null;
  }
  return {
    identifier: row.identifier,
    madeReachable: row.madeReachable,
    databaseUser: row.databaseUser,
    databaseName: row.databaseName,
    databasePassword: row.databasePassword,
  };
}

/** What a redis's switch to an existing cache holds, or `null` when it is not one. */
export function existingCacheChoiceOf(
  row: DatabaseSwitch,
): ExistingCacheChoice | null {
  if (
    row.kind !== 'redis' ||
    row.to !== 'existing' ||
    row.identifier === null
  ) {
    return null;
  }
  return {
    identifier: row.identifier,
    madeReachable: row.madeReachable,
    tls: row.tls,
    authToken: row.authToken ?? '',
  };
}
