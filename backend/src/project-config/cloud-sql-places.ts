import { and, eq } from 'drizzle-orm';

import { STAND_IN_MARKER } from '../cloud-accounts/aws/definitions/stand-ins';
import type { GcpCloudAccount } from '../cloud-accounts/cloud-provider';
import { cloudSqlDefinition } from '../cloud-accounts/gcp/definitions/cloud-sql-definition';
import type { CloudSqlDefinition } from '../cloud-accounts/gcp/definitions/cloud-sql-definition';
import {
  CLOUD_SQL_ENGINES,
  cloudSqlDatabaseVersion,
} from '../cloud-accounts/gcp/definitions/cloud-sql-engines';
import { networkName } from '../cloud-accounts/gcp/definitions/names';
import { gcpNetworkStandIns } from '../cloud-accounts/gcp/definitions/stand-ins';
import type { GcpNetworkNames } from '../cloud-accounts/gcp/definitions/stand-ins';
import { rdsIdOf, rdsKindOf } from '../databases/common/rds-rows';
import type { RdsRow } from '../databases/common/rds-rows';
import type { DrizzleDB } from '../db/drizzle.module';
import { environmentNetwork } from '../db/schema';
import { cloudSqlNativeColumns } from '../native/gcp-console-owned';
import type { NativeGcpBlock } from '../native/gcp-native';
import type {
  CloudSqlAppliedSettings,
  CloudSqlChange,
} from './planner/plan.types';

/**
 * The names a Google definition writes for its Environment network (the Google Cloud
 * spec): the made network's, fixed by the Environment's id (S4), or
 * stand-ins while it is not made, which the plan shows as "made by this plan
 * (Environment network)". `standIns` is `null` on a made network. Nothing is
 * ever applied with a stand-in: the Apply makes the network first and reads
 * again.
 */
export async function googleNetworkNames(
  db: Pick<DrizzleDB, 'select'>,
  place: { environmentId: string; cloudAccountId: string; region: string },
): Promise<{ names: GcpNetworkNames; standIns: string[] | null }> {
  const [made] = await db
    .select({ id: environmentNetwork.environmentNetworkId })
    .from(environmentNetwork)
    .where(
      and(
        eq(environmentNetwork.environmentId, place.environmentId),
        eq(environmentNetwork.cloudAccountId, place.cloudAccountId),
        eq(environmentNetwork.region, place.region),
        eq(environmentNetwork.status, 'ready'),
      ),
    );
  if (made) {
    return {
      names: {
        networkName: networkName(place.environmentId, 'net'),
        subnetName: networkName(place.environmentId, 'subnet'),
      },
      standIns: null,
    };
  }
  const names = gcpNetworkStandIns();
  return {
    names,
    // Each whole stand-in first, then the marker any other carries.
    standIns: [names.networkName, names.subnetName, STAND_IN_MARKER],
  };
}

/**
 * The OpenTofu definition of a postgres already on Cloud SQL, from its
 * saved row: its machine and version as the row holds them unless
 * the caller names the ones a change moves to, and its real password as a
 * sensitive variable. A change's read writes it with the step's machine and
 * version before the Apply saves them; the Apply's Cloud run writes it
 * after, from the row alone, so both write the same definition. Its
 * backups are its Backups tab's retention with point-in-time
 * recovery as last applied, or none on one made before backups
 * (`cloudSqlApplied` unset) until its catch-up. Its `native.gcp`
 * is laid last: the step's on a change's read, else the row's.
 *
 * A mysql's is the same, with MySQL's engine and its `root`
 * password, its own encrypted column, as a second sensitive variable.
 */
export function savedCloudSqlDefinition(input: {
  readonly row: RdsRow;
  readonly account: GcpCloudAccount;
  readonly stateId: string;
  readonly network: Pick<GcpNetworkNames, 'networkName'>;
  readonly tier?: string;
  readonly databaseVersion?: string;
  /** A Delete's apply before its destroy: both deletion-protection flags off. */
  readonly deletionProtectionLifted?: boolean;
  /**
   * What a change's read takes the last Apply to have written, as
   * that change's Apply will save it (`cloudSqlAppliedAfter`). Absent, the
   * row's.
   */
  readonly applied?: CloudSqlAppliedSettings | null;
  /**
   * The `native.gcp` a change's read lays, its step's, before the
   * Apply saves it; absent, the one the row holds, which every Cloud run
   * lays. A backup count it sets is the one written, as its Apply saves it.
   */
  readonly native?: NativeGcpBlock | null;
}):
  | { readonly ok: true; readonly generated: CloudSqlDefinition }
  | { readonly ok: false; readonly message: string } {
  const { row } = input;
  const applied =
    input.applied === undefined ? row.cloudSqlApplied : input.applied;
  const name = row.configName ?? row.name;
  if (!row.cloudAccountId || !row.region) {
    return { ok: false, message: `${name} does not run in a Cloud account` };
  }
  const tier = input.tier ?? row.instanceClass;
  if (!tier) {
    return {
      ok: false,
      message: `${name} has no Cloud SQL machine saved. Check for changes, then apply the new plan`,
    };
  }
  const engine = CLOUD_SQL_ENGINES[rdsKindOf(row)];
  let databaseVersion = input.databaseVersion;
  if (!databaseVersion) {
    // The majors Cloudgate offers on Cloud SQL are those it offers on RDS.
    const read = engine.version(name, row.dockerImage);
    if (!read.ok) return { ok: false, message: read.refusal.message };
    databaseVersion = cloudSqlDatabaseVersion(engine, read.version);
  }
  const native = input.native !== undefined ? input.native : row.nativeGcp;
  // A backup count native sets wins over the Backups tab's.
  const backupRetentionDays =
    cloudSqlNativeColumns(native).backupRetentionDays ??
    row.backupRetentionDays;
  return {
    ok: true,
    generated: cloudSqlDefinition({
      engine: engine.engine,
      serviceId: rdsIdOf(row),
      cloudAccountId: input.account.cloudAccountId,
      projectId: input.account.cloudId,
      region: row.region,
      environmentId: row.environmentId,
      stateId: input.stateId,
      network: input.network,
      tier,
      databaseVersion,
      login: {
        user: row.databaseUser,
        database: row.databaseName,
        password: row.databasePassword,
        ...('databaseRootPassword' in row
          ? { rootPassword: row.databaseRootPassword }
          : {}),
      },
      backupRetentionDays: applied ? backupRetentionDays : null,
      pointInTimeRecovery: applied?.pointInTimeRecovery ?? true,
      ...(input.deletionProtectionLifted
        ? { deletionProtectionLifted: true }
        : {}),
      native,
    }),
  };
}

/**
 * What a change's Apply writes as a postgres on Cloud SQL's last applied
 * backups: its Backups tab's retention, and point-in-time
 * recovery as the change turns it, else as last applied (on, unless said
 * otherwise; off on one made before backups). `null` for one made before
 * backups that the change does not catch up, which still has none.
 */
export function cloudSqlAppliedAfter(
  row: Pick<RdsRow, 'backupRetentionDays' | 'cloudSqlApplied'>,
  change: Pick<CloudSqlChange, 'catchUp' | 'pointInTimeRecovery'>,
): CloudSqlAppliedSettings | null {
  const before = row.cloudSqlApplied;
  if (!before && !change.catchUp) return null;
  return {
    backupRetentionDays: row.backupRetentionDays,
    pointInTimeRecovery:
      change.pointInTimeRecovery?.to ??
      (before ? (before.pointInTimeRecovery ?? true) : false),
  };
}
