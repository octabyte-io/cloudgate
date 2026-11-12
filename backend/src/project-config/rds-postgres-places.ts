import { and, eq, isNotNull } from 'drizzle-orm';

import { rdsDatabaseDefinition } from '../cloud-accounts/aws/definitions/postgres-definition';
import type {
  DatabaseNetworkIds,
  DeletingDatabase,
  RdsDatabaseDefinition,
} from '../cloud-accounts/aws/definitions/postgres-definition';
import type { RdsPostgresVersion } from '../cloud-accounts/aws/definitions/postgres-version';
import { RDS_ENGINES } from '../cloud-accounts/aws/definitions/rds-engines';
import {
  STAND_IN_MARKER,
  networkStandIns,
} from '../cloud-accounts/aws/definitions/stand-ins';
import type { AwsCloudAccount } from '../cloud-accounts/cloud-provider';
import type { DrizzleDB } from '../db/drizzle.module';
import { environment, environmentNetwork, project } from '../db/schema';
import type { Postgres } from '../db/schema';
import { rdsIdOf, rdsKindOf } from '../databases/common/rds-rows';
import type { RdsRow } from '../databases/common/rds-rows';
import { rdsClassOf } from './planner/cloud-postgres';
import type { RdsConsoleSettings } from './planner/plan.types';
import type { NativeAwsBlock } from '../native/aws-native';

/**
 * Where a postgres on RDS sits in its Environment network: the
 * network's VPC and its two private subnets, as the network's Apply saved
 * them, or `null` while the network is not made.
 */
export async function savedDatabaseNetwork(
  db: Pick<DrizzleDB, 'select'>,
  place: { environmentId: string; cloudAccountId: string; region: string },
): Promise<DatabaseNetworkIds | null> {
  const [saved] = await db
    .select({
      vpcId: environmentNetwork.vpcId,
      privateSubnetIds: environmentNetwork.privateSubnetIds,
    })
    .from(environmentNetwork)
    .where(
      and(
        eq(environmentNetwork.environmentId, place.environmentId),
        eq(environmentNetwork.cloudAccountId, place.cloudAccountId),
        eq(environmentNetwork.region, place.region),
        eq(environmentNetwork.status, 'ready'),
        isNotNull(environmentNetwork.vpcId),
        isNotNull(environmentNetwork.privateSubnetIds),
      ),
    );
  if (!saved?.vpcId || !saved.privateSubnetIds) return null;
  return { vpcId: saved.vpcId, privateSubnetIds: saved.privateSubnetIds };
}

/**
 * Stand-ins for a network the same plan makes (the AWS spec, "Plan behaviour"), the
 * database's half: its VPC's and its private subnets', which the plan reader
 * shows as "made by this plan (Environment network)". Nothing is applied
 * with them: the Apply makes the network first and reads again.
 */
export function databaseNetworkStandIns(
  region: string,
  awsAccountId: string,
): { ids: DatabaseNetworkIds; standIns: string[] } {
  const ids: DatabaseNetworkIds = {
    vpcId: networkStandIns(region, awsAccountId).vpcId,
    privateSubnetIds: [
      `subnet-${STAND_IN_MARKER}-private-a`,
      `subnet-${STAND_IN_MARKER}-private-b`,
    ],
  };
  return {
    ids,
    standIns: [ids.vpcId, ...ids.privateSubnetIds, STAND_IN_MARKER],
  };
}

/** The Project's and Environment's names, which the final snapshot is named after. */
export async function snapshotNames(
  db: Pick<DrizzleDB, 'select'>,
  environmentId: string,
): Promise<{ projectName: string; environmentName: string }> {
  const [found] = await db
    .select({ projectName: project.name, environmentName: environment.name })
    .from(environment)
    .innerJoin(project, eq(project.projectId, environment.projectId))
    .where(eq(environment.environmentId, environmentId));
  return found ?? { projectName: 'project', environmentName: 'environment' };
}

/**
 * The OpenTofu definition of a postgres or a mysql already on RDS,
 * from its saved row
 * its class and version as the row holds them unless the
 * caller names the ones a change moves to, Cloudgate's settings as the
 * console holds them, and its real password as a sensitive variable. A
 * change's read writes it with the step's class and version before the
 * Apply saves them; the Apply's Cloud run writes it after, from the row
 * alone, so both write the same definition. `allowMajorUpgrade` is the
 * approved plan's, for that one run.
 */
export async function savedRdsDatabaseDefinition(
  db: Pick<DrizzleDB, 'select'>,
  input: {
    readonly row: RdsRow;
    readonly account: AwsCloudAccount;
    readonly stateId: string;
    readonly network: DatabaseNetworkIds;
    readonly instanceClass?: string;
    readonly version?: Pick<
      RdsPostgresVersion,
      'engineVersion' | 'autoMinorUpgrade'
    >;
    readonly allowMajorUpgrade?: boolean;
    /**
     * A Delete's run: protection off and its final snapshot named,
     * written over the settings the last Apply made — never the console's
     * edits still waiting for one — so nothing else moves.
     */
    readonly deleting?: DeletingDatabase;
    /**
     * The `native.aws` a change's read lays, its step's, before the
     * Apply saves it; absent, the one the row holds, which every Cloud run
     * lays.
     */
    readonly native?: NativeAwsBlock | null;
  },
): Promise<
  | { readonly ok: true; readonly generated: RdsDatabaseDefinition }
  | { readonly ok: false; readonly message: string }
> {
  const { account } = input;
  const row =
    input.deleting && input.row.rdsApplied
      ? { ...input.row, ...input.row.rdsApplied }
      : input.row;
  const name = row.configName ?? row.name;
  if (!row.cloudAccountId || !row.region) {
    return { ok: false, message: `${name} does not run in a Cloud account` };
  }
  const engine = rdsKindOf(input.row);
  let version = input.version;
  if (!version) {
    const read = RDS_ENGINES[engine].version(name, row.dockerImage);
    if (!read.ok) return { ok: false, message: read.refusal.message };
    version = read.version;
  }
  const instanceClass = input.instanceClass ?? rdsClassOf(name, row);
  if (!instanceClass) {
    return {
      ok: false,
      message: `${name}'s size is above every class Cloudgate chooses`,
    };
  }
  return {
    ok: true,
    generated: rdsDatabaseDefinition({
      engine,
      configName: name,
      serviceId: rdsIdOf(input.row),
      account: {
        awsAccountId: account.cloudId,
        deployRoleArn: account.deployRoleArn,
        externalId: account.externalId,
        cloudAccountId: account.cloudAccountId,
      },
      region: row.region,
      environmentId: row.environmentId,
      stateId: input.stateId,
      network: input.network,
      version,
      settings: {
        instanceClass,
        storageGb: row.storageGb,
        maxStorageGb: row.maxStorageGb,
        multiAz: row.multiAz,
        backupRetentionDays: row.backupRetentionDays,
      },
      allowMajorUpgrade: input.allowMajorUpgrade ?? false,
      login: {
        user: row.databaseUser,
        database: row.databaseName,
        password: row.databasePassword,
      },
      finalSnapshot: {
        ...(await snapshotNames(db, row.environmentId)),
        date: snapshotDate(new Date(row.createdAt)),
      },
      ...(input.deleting ? { deleting: input.deleting } : {}),
      native: input.native !== undefined ? input.native : input.row.nativeAws,
    }),
  };
}

/**
 * The console's settings of a postgres on RDS as a row holds them:
 * what an Apply records as written, and the next plan diffs against.
 */
export function rdsConsoleSettings(
  row: Pick<
    Postgres,
    | 'instanceClass'
    | 'storageGb'
    | 'maxStorageGb'
    | 'multiAz'
    | 'backupRetentionDays'
  >,
): RdsConsoleSettings {
  return {
    instanceClass: row.instanceClass,
    storageGb: row.storageGb,
    maxStorageGb: row.maxStorageGb,
    multiAz: row.multiAz,
    backupRetentionDays: row.backupRetentionDays,
  };
}

/** `YYYY-MM-DD`, the date part of a final snapshot's name. */
export function snapshotDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}
