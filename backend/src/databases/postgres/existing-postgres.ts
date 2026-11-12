import { ConflictException } from '@nestjs/common';
import { and, eq, or } from 'drizzle-orm';

import { application } from '../../applications/application.schema';
import { NETWORK_ADDRESS_RANGE } from '../../cloud-accounts/aws/definitions/network-definition';
import { serviceSecurityGroupName } from '../../cloud-accounts/aws/definitions/web-definition';
import { cloudAccount } from '../../cloud-accounts/cloud-account.schema';
import type { CloudKind } from '../../cloud-accounts/cloud-account.schema';
import {
  byCloud,
  CLOUD_NAMES,
  cloudOrLegacy,
} from '../../cloud-accounts/cloud-provider';
import { cloudSqlViewerGrant } from '../../cloud-accounts/gcp/plan-reader/existing-cloud-sql';
import { memorystoreViewerGrant } from '../../cloud-accounts/gcp/plan-reader/existing-valkey';
import { endpointSentence } from '../../project-config/existing-endpoint-status';
import type { DrizzleDB } from '../../db/drizzle.module';
import { environmentNetwork } from '../../environments/environment-network.schema';
import { existingDatabase } from './existing-database.schema';
import type { ExistingDatabase } from './existing-database.schema';

/**
 * The sentence an Existing database's Start, Stop, Rebuild and Deploy are
 * refused with (spec "Database lifecycle module"): Cloudgate only reads
 * it (ADR-0033).
 */
export const EXISTING_NOT_MANAGED =
  "Cloudgate uses this database but doesn't manage it.";

export const EXISTING_NOT_MANAGED_CODE = 'EXISTING_DATABASE_NOT_MANAGED';

/**
 * What an Existing database's Service reads with: where it is, and
 * that its login is set, never the login's password (ADR-0019).
 */
export interface ExistingView {
  readonly identifier: string;
  readonly cloudAccountId: string;
  readonly region: string;
  readonly madeReachable: boolean;
  /** Where the last plan's lookup found it, `null` until one has. */
  readonly address: { readonly host: string; readonly port: number } | null;
  readonly hasDatabasePassword: boolean;
  /**
   * The last plan's lookup found nothing under its identifier: the
   * Service page's status, "AWS cannot find `acme-prod`", and since when.
   * `null` while the last lookup found it, or none has run.
   */
  readonly notFound: {
    readonly sentence: string;
    readonly since: string;
  } | null;
  /**
   * Cloudgate's own endpoint to it, where it has one (a Cloud SQL instance
   * on Google Cloud): its acceptance as last read, and the page's
   * sentence while it is not accepted. `null` until one is made.
   */
  readonly endpoint: {
    readonly status: string;
    readonly checkedAt: string | null;
    /** `null` once accepted. */
    readonly sentence: string | null;
  } | null;
}

/**
 * An Existing database as its page reads it. `cloud` is its Cloud account's,
 * which names who cannot find it: "AWS cannot find `acme-prod`", "Google
 * Cloud cannot find `shop-prod:europe-west1:acme-prod`".
 */
export function existingView(
  existing: ExistingDatabase,
  databasePassword: string,
  cloud: CloudKind | null = null,
): ExistingView {
  return {
    identifier: existing.identifier,
    cloudAccountId: existing.cloudAccountId,
    region: existing.region,
    madeReachable: existing.madeReachable,
    address: existing.address ?? null,
    hasDatabasePassword: databasePassword !== '',
    notFound: existing.notFoundAt
      ? {
          sentence: notFoundSentence(existing.identifier, cloud),
          since: existing.notFoundAt,
        }
      : null,
    endpoint: existing.endpointStatus
      ? {
          status: existing.endpointStatus,
          checkedAt: existing.endpointCheckedAt,
          sentence: endpointSentence(
            existing.identifier,
            existing.endpointStatus,
          ),
        }
      : null,
  };
}

/** What an Existing database's page says once a plan finds it gone, naming its cloud. */
export function notFoundSentence(
  identifier: string,
  cloud: CloudKind | null = null,
): string {
  return `${CLOUD_NAMES[cloudOrLegacy(cloud)]} cannot find ${identifier}`;
}

/**
 * What an Existing database's Delete says (ADR-0033): Cloudgate removed
 * only its own records, and the database is the operator's. A config that
 * still lists the entry makes it a new database at the next plan, which
 * the sentence says too, so a Delete is never mistaken for a switch.
 */
export function leftAsItWas(
  identifier: string,
  configName: string,
): { identifier: string; message: string } {
  return {
    identifier,
    message: `${identifier} was left as it was; it is yours. Cloudgate removed only its own records of ${configName}; if the Project config still lists ${configName}, the next plan creates it as a new database.`,
  };
}

/**
 * What the "Use an existing database" form shows (spec US57): where
 * this Environment's Services reach a database from, so the operator can
 * let them into its security group. Cloudgate never changes that group.
 */
export interface ExistingReach {
  readonly cloudAccountId: string;
  readonly cloudAccountName: string;
  readonly region: string;
  /** The Environment network's VPC, `null` while it is not made. */
  readonly vpcId: string | null;
  /** The subnets the Services' tasks run in, as address ranges. */
  readonly serviceSubnets: readonly string[];
  readonly port: number;
  /** Each cloud Service's own security group in that place, by its name in AWS. */
  readonly securityGroups: readonly {
    readonly configName: string;
    readonly groupName: string;
  }[];
  /**
   * On Google Cloud, where nothing is let in by hand — Cloudgate
   * makes its own endpoint and checks the reach — and the security-group
   * fields above are empty: the project this Environment's endpoint is made
   * in, which the instance must allow, and the read grant an instance in
   * another project needs, for its project. `null` on AWS.
   */
  readonly google: {
    readonly projectId: string;
    readonly serviceAccount: string;
    /** With `<instance-project>` for the instance's project. */
    readonly readGrant: string;
  } | null;
}

export async function existingReach(
  db: Pick<DrizzleDB, 'select'>,
  place: { environmentId: string; cloudAccountId: string; region: string },
  /** The port to let in: a postgres's 5432, a mysql's 3306, or a redis's 6379. */
  port = 5432,
): Promise<ExistingReach> {
  // On Google Cloud the read grant is Cloud SQL's for a postgres,
  // Memorystore's for a redis.
  const readGrant =
    port === 6379 ? memorystoreViewerGrant : cloudSqlViewerGrant;
  const [account] = await db
    .select({
      name: cloudAccount.name,
      cloud: cloudAccount.cloud,
      cloudId: cloudAccount.cloudId,
      serviceAccount: cloudAccount.deployServiceAccount,
    })
    .from(cloudAccount)
    .where(eq(cloudAccount.cloudAccountId, place.cloudAccountId));
  const google = byCloud(cloudOrLegacy(account?.cloud), {
    aws: null,
    gcp: account
      ? {
          projectId: account.cloudId,
          serviceAccount: account.serviceAccount ?? '',
          readGrant: readGrant(
            '<instance-project>',
            account.serviceAccount ?? '',
          ),
        }
      : null,
  });
  if (google) {
    return {
      cloudAccountId: place.cloudAccountId,
      cloudAccountName: account?.name ?? place.cloudAccountId,
      region: place.region,
      vpcId: null,
      serviceSubnets: [],
      port,
      securityGroups: [],
      google,
    };
  }
  const [network] = await db
    .select({ vpcId: environmentNetwork.vpcId })
    .from(environmentNetwork)
    .where(
      and(
        eq(environmentNetwork.environmentId, place.environmentId),
        eq(environmentNetwork.cloudAccountId, place.cloudAccountId),
        eq(environmentNetwork.region, place.region),
      ),
    );
  const services = await db
    .select({
      applicationId: application.applicationId,
      configName: application.configName,
      name: application.name,
    })
    .from(application)
    .where(
      and(
        eq(application.environmentId, place.environmentId),
        eq(application.cloudAccountId, place.cloudAccountId),
        eq(application.region, place.region),
      ),
    );
  return {
    cloudAccountId: place.cloudAccountId,
    cloudAccountName: account?.name ?? place.cloudAccountId,
    region: place.region,
    vpcId: network?.vpcId ?? null,
    serviceSubnets: [...NETWORK_ADDRESS_RANGE.publicSubnets],
    port,
    securityGroups: services
      .map((one) => ({
        configName: one.configName ?? one.name,
        groupName: serviceSecurityGroupName(one.applicationId),
      }))
      .sort((a, b) => a.configName.localeCompare(b.configName)),
    google: null,
  };
}

/** The refusal code for a Backup of an Existing database. */
export const EXISTING_NO_BACKUP_CODE = 'EXISTING_DATABASE_NO_BACKUP';

/**
 * Refuses a Backup or volume backup of an Existing database (spec
 * "Backups module", ADR-0005): Cloudgate runs nothing next to it, so a dump
 * or a volume archive could never run; its backups are its own, in AWS.
 */
export async function refuseExistingDatabaseBackup(
  db: Pick<DrizzleDB, 'select'>,
  serviceId: string,
): Promise<void> {
  // A postgres's, a mysql's or a redis's.
  const [found] = await db
    .select({
      identifier: existingDatabase.identifier,
      mysqlId: existingDatabase.mysqlId,
      redisId: existingDatabase.redisId,
    })
    .from(existingDatabase)
    .where(
      or(
        eq(existingDatabase.postgresId, serviceId),
        eq(existingDatabase.mysqlId, serviceId),
        eq(existingDatabase.redisId, serviceId),
      ),
    );
  if (!found) return;
  throw new ConflictException({
    message: `This ${found.redisId ? 'redis' : found.mysqlId ? 'mysql' : 'postgres'} is the existing database ${found.identifier}, which Cloudgate uses but doesn't manage, so it takes no Backup here: Cloudgate's backups run on a Server, and ${found.identifier}'s are its own, in AWS`,
    code: EXISTING_NO_BACKUP_CODE,
  });
}
