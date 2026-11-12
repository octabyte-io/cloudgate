import { eq } from 'drizzle-orm';

import { existingPostgresLookup } from '../cloud-accounts/aws/definitions/existing-postgres-lookup';
import type { ExistingPostgresLookupInput } from '../cloud-accounts/aws/definitions/existing-postgres-lookup';
import {
  existingRedisLookup,
  existingServerlessLookup,
} from '../cloud-accounts/aws/definitions/existing-redis-lookup';
import type { TofuDefinition } from '../cloud-accounts/definitions/tofu-json';
import type { CloudSqlEngineName } from '../cloud-accounts/gcp/definitions/cloud-sql-engines';
import {
  foundPostgres,
  judgeLookup,
} from '../cloud-accounts/aws/plan-reader/existing-postgres';
import type {
  LookupContext,
  LookupVerdict,
} from '../cloud-accounts/aws/plan-reader/existing-postgres';
import {
  foundRedis,
  foundServerless,
  isMissingReplicationGroup,
  isMissingServerlessCache,
  judgeRedisLookup,
} from '../cloud-accounts/aws/plan-reader/existing-redis';
import { readPlan } from '../cloud-accounts/aws/plan-reader/read-plan';
import type { CloudAccount } from '../cloud-accounts/cloud-account.schema';
import type {
  AwsCloudAccount,
  GcpCloudAccount,
} from '../cloud-accounts/cloud-provider';
import { credentialOf, onCloud } from '../cloud-accounts/cloud-provider';
import type { TofuRunSignal, TofuShow } from '../cloud-accounts/cloud.port';
import type { InfrastructureStatesService } from '../cloud-accounts/infrastructure-state/infrastructure-states.service';
import type { DrizzleDB } from '../db/drizzle.module';
import { existingDatabase, mysql, postgres, redis } from '../db/schema';
import { lookedUpAddress, noteFound } from './existing-database-address';
import type { GoogleExistingBucket } from './existing-bucket-reads';
import { describeError } from '../common/describe-error';
import type { CloudRead, PlanStep } from './planner/plan.types';
import { savedDatabaseNetwork } from './rds-postgres-places';

type Change = Extract<PlanStep, { action: 'change' }>;

/** What the lookup needs of the plan reads' own collaborators. */
export interface ExistingReadDeps {
  readonly db: DrizzleDB;
  readonly states: Pick<InfrastructureStatesService, 'planFresh'>;
  findAccount(cloudAccountId: string): Promise<CloudAccount | null>;
  credentialRefusal(account: AwsCloudAccount): Promise<string | null>;
  /**
   * Google Cloud's half: a Cloud SQL `postgres`'s or `mysql`'s
   * lookup and the plan of Cloudgate's endpoint and zone for it
   * (`GooglePlanReads`).
   */
  readGoogle?(
    account: GcpCloudAccount,
    existing: GoogleExisting,
  ): Promise<CloudRead>;
  /**
   * Google Cloud's half for a Memorystore for Valkey `redis`: its
   * lookup and the plan of Cloudgate's two endpoints for it.
   */
  readGoogleRedis?(
    account: GcpCloudAccount,
    existing: GoogleExistingCache,
  ): Promise<CloudRead>;
  /**
   * Google Cloud's half of an existing bucket's lookup: the bucket
   * read through the Google client port, and the plan of the key account
   * and key Cloudgate makes for it (`GooglePlanReads`).
   */
  readGoogleBucket?(
    account: GcpCloudAccount,
    existing: GoogleExistingBucket,
  ): Promise<CloudRead>;
}

/** What Google Cloud's half reads of an existing Valkey's row. */
export interface GoogleExistingCache {
  readonly existingDatabaseId: string;
  readonly redisId: string;
  readonly environmentId: string;
  readonly region: string;
  readonly identifier: string;
}

/** What Google Cloud's half reads of an Existing database's row on Cloud SQL. */
export interface GoogleExisting {
  readonly existingDatabaseId: string;
  /** The kind it is the place of, and that Service's id. */
  readonly kind: CloudSqlEngineName;
  readonly serviceId: string;
  readonly environmentId: string;
  readonly region: string;
  readonly identifier: string;
}

/**
 * The lookup of an **Existing database** on a plan's step (ADR-0033; the AWS databases
 * spec "Each plan's lookup"): a `tofu plan` of `data` sources only, in
 * the Cloud account and region it was created in, against its own
 * workspace, which holds nothing, so nothing is locked or written. What it
 * finds is judged (`judgeLookup`, or `judgeRedisLookup` for a redis's
 * replication group): a refusal is the step's failed read, which
 * refuses the Apply naming it; one found as given saves the address and
 * port it answers at, which every deploy then builds its Outputs from ("the
 * address saved by the last plan"). The login or AUTH token never reaches
 * `tofu`.
 */
export async function readExistingDatabase(
  deps: ExistingReadDeps,
  step: Change & { readonly existing: NonNullable<Change['existing']> },
  signal: TofuRunSignal | undefined,
): Promise<CloudRead> {
  const row = await existingRowOf(deps.db, step);
  const name = step.configName;
  if (!row) return failed(`${name} is no longer an existing database`);
  const cloudAccountRow = await deps.findAccount(row.cloudAccountId);
  if (!cloudAccountRow) {
    return failed(
      `The Cloud account ${name}'s existing database ${row.identifier} is looked up in is gone`,
    );
  }
  // Each cloud's half (ADR-0043): on Google Cloud a postgres's or a
  // mysql's, on Cloud SQL, and a redis's, on Memorystore for
  // Valkey.
  return onCloud(cloudAccountRow, {
    aws: (account) => readOnAws(deps, step, row, account, signal),
    gcp: (account) => {
      const place = {
        existingDatabaseId: row.existingDatabaseId,
        environmentId: row.environmentId,
        region: row.region,
        identifier: row.identifier,
      };
      if (
        (step.serviceType === 'postgres' || step.serviceType === 'mysql') &&
        deps.readGoogle
      ) {
        return deps.readGoogle(account, {
          ...place,
          kind: step.serviceType,
          serviceId: step.serviceId,
        });
      }
      if (step.serviceType === 'redis' && deps.readGoogleRedis) {
        return deps.readGoogleRedis(account, {
          ...place,
          redisId: step.serviceId,
        });
      }
      return Promise.resolve(
        failed(
          `Cloud account ${account.name} is a Google Cloud project, and an existing ${step.serviceType} is not available on Google Cloud yet; an existing postgres or mysql on Cloud SQL and an existing redis on Memorystore for Valkey are`,
        ),
      );
    },
  });
}

/** An Existing database's lookup in AWS. */
async function readOnAws(
  deps: ExistingReadDeps,
  step: Change & { readonly existing: NonNullable<Change['existing']> },
  row: NonNullable<Awaited<ReturnType<typeof existingRowOf>>>,
  account: AwsCloudAccount,
  signal: TofuRunSignal | undefined,
): Promise<CloudRead> {
  const name = step.configName;
  const refused = await deps.credentialRefusal(account);
  if (refused) return failed(refused);
  const network = await savedDatabaseNetwork(deps.db, {
    environmentId: row.environmentId,
    cloudAccountId: row.cloudAccountId,
    region: row.region,
  });
  const stateId = row.existingDatabaseId;
  const input: ExistingPostgresLookupInput = {
    account: {
      awsAccountId: account.cloudId,
      deployRoleArn: account.deployRoleArn,
      externalId: account.externalId,
      cloudAccountId: account.cloudAccountId,
    },
    region: row.region,
    environmentId: row.environmentId,
    stateId,
    identifier: row.identifier,
  };
  const context: LookupContext = {
    // A mysql uses only a MySQL instance, a postgres only a PostgreSQL one.
    engine: step.serviceType === 'mysql' ? 'mysql' : 'postgres',
    serviceName: name,
    identifier: row.identifier,
    cloudAccount: `${account.name} (${account.cloudId})`,
    region: row.region,
    networkVpcId: network?.vpcId ?? null,
    madeReachable: row.madeReachable,
    configVersion: step.existing.version,
  };
  const plan = (definition: TofuDefinition) =>
    deps.states.planFresh({
      stateId,
      credential: credentialOf(account),
      definition,
      ...(signal ? { signal } : {}),
    });
  const asked = (message: string) =>
    failed(
      `${name}: AWS could not be asked for the existing database ${row.identifier}: ${message}`,
    );
  let verdict: LookupVerdict;
  let show: TofuShow;
  try {
    if (step.serviceType === 'redis') {
      const redisContext = { ...context, tls: row.tls };
      const outcome = await plan(existingRedisLookup(input));
      if (!outcome.ok) {
        if (!isMissingReplicationGroup(outcome.message)) {
          return asked(outcome.message);
        }
        // No replication group by that id: a serverless cache's name, or
        // nothing at all, which a second look tells apart.
        const serverless = await plan(existingServerlessLookup(input));
        if (!serverless.ok && !isMissingServerlessCache(serverless.message)) {
          return asked(serverless.message);
        }
        const missing = judgeRedisLookup(
          serverless.ok && foundServerless(serverless.show)
            ? 'serverless'
            : 'missing',
          redisContext,
        );
        // Gone, unless it is a serverless cache under that name.
        await noteFound(deps.db, row.existingDatabaseId, missing);
        return failed(missing.ok ? `${name} was not found` : missing.reason);
      }
      show = outcome.show;
      verdict = judgeRedisLookup(foundRedis(show) ?? 'missing', redisContext);
    } else {
      const outcome = await plan(existingPostgresLookup(input));
      if (!outcome.ok) return asked(outcome.message);
      show = outcome.show;
      verdict = judgeLookup(foundPostgres(show), context);
    }
  } catch (error) {
    return failed(
      `${name}: the lookup of ${row.identifier} could not be read: ${describeError(error)}`,
    );
  }
  // Gone: its page says so until a lookup finds it again.
  await noteFound(deps.db, row.existingDatabaseId, verdict);
  if (!verdict.ok) return failed(verdict.reason);
  const moved = await lookedUpAddress(deps.db, {
    existingDatabaseId: row.existingDatabaseId,
    serviceType: step.serviceType,
    configName: name,
    identifier: row.identifier,
    found: verdict.address,
  });
  const reading = readPlan({
    show,
    tagSearch: [],
    context: { serviceName: name },
  });
  return {
    status: 'read',
    ...reading,
    summary: moved ? [...verdict.lines, moved.line] : verdict.lines,
    ...(moved ? { addressMoved: moved.addressMoved } : {}),
    stateId,
    serviceId: step.serviceId,
    readAt: new Date().toISOString(),
  };
}

/**
 * The Existing database a step looks up, with what its lookup needs: a
 * postgres's, a mysql's or a redis's, by the step's Service.
 */
async function existingRowOf(
  db: DrizzleDB,
  step: Pick<Change, 'serviceType' | 'serviceId'>,
) {
  const columns = {
    existingDatabaseId: existingDatabase.existingDatabaseId,
    cloudAccountId: existingDatabase.cloudAccountId,
    region: existingDatabase.region,
    identifier: existingDatabase.identifier,
    madeReachable: existingDatabase.madeReachable,
    tls: existingDatabase.tls,
  };
  if (step.serviceType === 'redis') {
    const [row] = await db
      .select({ ...columns, environmentId: redis.environmentId })
      .from(existingDatabase)
      .innerJoin(redis, eq(redis.redisId, existingDatabase.redisId))
      .where(eq(existingDatabase.redisId, step.serviceId));
    return row;
  }
  if (step.serviceType === 'mysql') {
    const [row] = await db
      .select({ ...columns, environmentId: mysql.environmentId })
      .from(existingDatabase)
      .innerJoin(mysql, eq(mysql.mysqlId, existingDatabase.mysqlId))
      .where(eq(existingDatabase.mysqlId, step.serviceId));
    return row;
  }
  const [row] = await db
    .select({ ...columns, environmentId: postgres.environmentId })
    .from(existingDatabase)
    .innerJoin(postgres, eq(postgres.postgresId, existingDatabase.postgresId))
    .where(eq(existingDatabase.postgresId, step.serviceId));
  return row;
}

function failed(reason: string): CloudRead {
  return { status: 'failed', reason };
}
