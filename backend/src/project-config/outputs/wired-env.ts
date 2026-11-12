import { CLOUD_STORAGE_S3 } from '../../cloud-accounts/gcp/cloud-storage-s3';
import { ConflictException } from '@nestjs/common';
import { parse } from 'dotenv';
import { and, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';

import { byCloud, cloudOrLegacy } from '../../cloud-accounts/cloud-provider';
import { bucketAddress } from '../../buckets/bucket-address';
import { bucket } from '../../buckets/bucket.schema';
import { GARAGE_REGION } from '../../buckets/garage';
import { STAND_IN_MARKER } from '../../cloud-accounts/aws/definitions/stand-ins';
import { ELASTICACHE_CA_BUNDLE } from '../../cloud-accounts/aws/elasticache-ca';
import { rdsCaBundle } from '../../cloud-accounts/aws/rds-ca';
import { cloudAccount } from '../../cloud-accounts/cloud-account.schema';
import type { DrizzleDB } from '../../db/drizzle.module';
import { existingDatabase } from '../../databases/postgres/existing-database.schema';
import { mysql } from '../../databases/mysql/mysql.schema';
import { postgres } from '../../databases/postgres/postgres.schema';
import { redis } from '../../databases/redis/redis.schema';
import { domain } from '../../domains/domain.schema';
import type { DrizzleTx } from '../../environments/config-name';
import type { ConfigLinks } from '../project-config.types';
import { cloudTarget, outputsWithoutValue, outputValues } from './outputs';
import type { OutputSource, SourceAddress } from './outputs';

type Db = Pick<DrizzleDB | DrizzleTx, 'select'>;

/** The refusal code for a typed value given to a linked name. */
export const VARIABLE_IS_LINKED_CODE = 'VARIABLE_IS_LINKED';

/**
 * The port each engine listens on inside its Server's network, which is
 * where a Service on the same Server reaches it (the console's connection
 * card says the same).
 */
const SERVER_PORTS = {
  postgres: 5432,
  mysql: 3306,
  redis: 6379,
} as const;

/**
 * How long a deploy waits for a bucket's key while the bucket's first
 * deploy is still making it, and how often it looks. The Apply runs
 * the bucket's step before the linked Service's, but Garage makes the key
 * only once its container runs, so a linked deploy queued by the same
 * Apply can reach this first.
 */
export interface KeyWait {
  readonly budgetMs: number;
  readonly everyMs: number;
}

const KEY_WAIT: KeyWait = { budgetMs: 10 * 60_000, everyMs: 1_000 };

/**
 * A Service's **wired variables**, filled in for this deploy (ADR-0031): each
 * link's value built by the Outputs module from its source's
 * saved settings (its password decrypted by the column, ADR-0006) and the
 * address its target reports. Nothing here is saved; the caller hands the
 * map to the container's env and drops it.
 *
 * On a Server, and on the platform host, a source is reached at its
 * `appName` and its engine's port on the Server's network, without TLS (a mysql
 * there) — except a bucket's `endpoint`, which is its Domain while it has one
 * read now, so a Domain added or removed since reaches this deploy. A
 * postgres on RDS is reached at the address its last Cloud run read
 * from `tofu`, with TLS required and its region's RDS CA bundle as `ca`;
 * one whose instance is not made yet fails the deploy saying so; a mysql on
 * RDS likewise, its `url` naming no TLS, which RDS's default
 * parameter group does not require. A redis on
 * ElastiCache likewise, at its primary endpoint, its URL `rediss://`
 * with its AUTH token as the password and Amazon's public roots as `ca`. A
 * postgres on Cloud SQL at its own Private Service Connect DNS name,
 * never the endpoint's IP, with TLS required and its own CA as `ca`; a
 * mysql on Cloud SQL likewise, its `url` naming no TLS, which it
 * offers without requiring; a redis on Memorystore at its primary endpoint, `rediss://` with no
 * password and its own CA as `ca` (ADR-0042): a variable linked to
 * its `password` is left unset, never empty. A
 * source the plan checked but that is gone now (deleted in the console
 * since) fails the deploy with a sentence naming the variable, rather than
 * starting the container without it.
 *
 * A plan's read of a cloud Service in `region` (`standIns`) builds
 * the same map before a source has an address — one the plan creates has
 * no row yet, one on RDS whose create has not finished has no endpoint —
 * with a stand-in in place of each such value (the source's real CA bundle
 * for `ca`, so its size is the real one — RDS's region bundle unless the
 * source is a redis, by its row or by `standIns.kinds` for one the plan
 * creates; on Google, the marker, as a Cloud SQL or Memorystore instance's
 * CA is its own), so the read names every parameter its deploy will write. No
 * stand-in ever reaches a deploy.
 *
 * A bucket on AWS (ADR-0032) hands out its real name, its region,
 * S3's regional endpoint and `path_style` `"false"`; its key Outputs have
 * no value there, so a variable linked to one is **left out** of the map —
 * no parameter, not an empty one — and the app's SDK falls back to the
 * task's own role. Its values are known from its row before its Cloud run
 * has made it, and a plan read takes those of a bucket the same plan
 * creates from `standIns.buckets`, its real name by Config name; a deploy
 * of a Service linking one whose Cloud run has not made it fails, as for
 * RDS. A bucket on Cloud Storage hands out its real name, `region`
 * `auto`, Cloud Storage's S3 endpoint path-style and its own HMAC key,
 * which its Cloud run saved, so every Output has a value there; one whose
 * key is not saved yet is not made, and a plan read takes stand-ins for it.
 */
export async function wiredEnv(
  db: Db,
  environmentId: string,
  links: ConfigLinks | null | undefined,
  options: {
    keyWait?: KeyWait;
    standIns?: {
      region: string;
      /**
       * The cloud the reading Service is on: on Google (`gcp`) a
       * postgres's `ca` is the Cloud SQL instance's own CA, known only once
       * its Cloud run has read it, so a not-made one's stand-in is the
       * marker, never RDS's region bundle (empty for a Google region).
       */
      cloud?: 'aws' | 'gcp';
      /** The kind of each source the plan creates, by Config name. */
      kinds?: Readonly<Record<string, string>>;
      /** The real name of each bucket on AWS the plan creates. */
      buckets?: ReadonlyMap<string, string>;
    };
  } = {},
): Promise<Record<string, string>> {
  const entries = Object.entries(links ?? {});
  if (entries.length === 0) return {};
  const keyWait = options.keyWait ?? KEY_WAIT;
  const { standIns } = options;
  const values: Record<string, string> = {};
  const sources = new Map<string, Found>();
  for (const [variable, link] of entries) {
    if (!sources.has(link.source)) {
      sources.set(
        link.source,
        await sourceOutputs(db, environmentId, link.source, keyWait),
      );
    }
    const planned = standIns?.buckets?.get(link.source);
    const found =
      sources.get(link.source) ??
      (standIns && planned !== undefined
        ? s3Bucket(planned, standIns.region, null)
        : null);
    // A deploy of a Service linking a source not made yet fails, whichever
    // of its Outputs the link names, one with no value too.
    if (!standIns && found?.unmade !== undefined) {
      throw new Error(
        `${variable} links to ${link.source}.${link.output}, but ${found.unmade}`,
      );
    }
    // An Output with no value here: the variable is left unset, as
    // for one the plan creates where its cloud leaves it none.
    const unset =
      found?.unset ??
      (standIns
        ? outputsWithoutValue(
            standIns.kinds?.[link.source] ?? '',
            cloudTarget(standIns.cloud),
          )
        : []);
    if (unset.includes(link.output)) continue;
    if (standIns && (found === null || found.unmade !== undefined)) {
      const kind = found?.kind ?? standIns.kinds?.[link.source];
      values[variable] =
        found?.values[link.output] ??
        (link.output === 'ca'
          ? byCloud(cloudOrLegacy(standIns.cloud), {
              aws: () =>
                kind === 'redis'
                  ? ELASTICACHE_CA_BUNDLE
                  : rdsCaBundle(standIns.region),
              gcp: () => `${STAND_IN_MARKER}-${link.source}-${link.output}`,
            })()
          : `${STAND_IN_MARKER}-${link.source}-${link.output}`);
      continue;
    }
    const value = found?.values[link.output];
    if (value === undefined) {
      throw new Error(
        found
          ? `${variable} links to ${link.source}.${link.output}, which ${link.source} does not hand out here. Plan and apply the Project config again.`
          : `${variable} links to ${link.source}.${link.output}, but this Environment has no ${link.source} that hands out Outputs. Plan and apply the Project config again.`,
      );
    }
    values[variable] = value;
  }
  return values;
}

/**
 * A source's Outputs: their values, the ones it hands out with no value
 * here (`unset`), and, while it is not made yet, why (`unmade`) —
 * with whatever values are already known. `null` when the Environment has
 * no such source.
 */
type Found = {
  readonly values: Readonly<Record<string, string>>;
  readonly unset: readonly string[];
  readonly unmade?: string;
  /** What the source is, while it is not made. */
  readonly kind?: 'postgres' | 'mysql' | 'redis' | 'bucket';
} | null;

/** A source made where it is, every Output with a value. */
function made(values: Readonly<Record<string, string>>): Found {
  return { values, unset: [] };
}

/**
 * A bucket on S3 (ADR-0032): its real name, its region, S3's regional
 * endpoint (virtual-hosted, so `path_style` is `"false"`) and no key, since
 * the linking task's role gives access. `unmade` while its Cloud run has
 * not made it.
 */
function s3Bucket(
  bucketName: string,
  region: string,
  unmade: string | null,
): NonNullable<Found> {
  return {
    values: outputValues(
      {
        kind: 'bucket',
        name: bucketName,
        region,
        accessKeyId: null,
        secretAccessKey: null,
        pathStyle: false,
      },
      { host: `s3.${region}.amazonaws.com`, port: 443, tls: true, ca: null },
    ),
    unset: outputsWithoutValue('bucket', { ownRole: true }),
    ...(unmade === null ? {} : { unmade, kind: 'bucket' as const }),
  };
}

/**
 * A bucket on Cloud Storage's Outputs (ADR-0032 as amended): its real name,
 * `region` `auto`, Cloud Storage's S3 endpoint
 * addressed path-style, and its own HMAC key, the same for every Service
 * that links it. Pure.
 */
export function cloudStorageBucketValues(
  bucketName: string,
  key: { readonly accessKeyId: string; readonly secretAccessKey: string },
): Readonly<Record<string, string>> {
  return outputValues(
    {
      kind: 'bucket',
      name: bucketName,
      region: CLOUD_STORAGE_S3.region,
      accessKeyId: key.accessKeyId,
      secretAccessKey: key.secretAccessKey,
      pathStyle: true,
    },
    { host: CLOUD_STORAGE_S3.host, port: 443, tls: true, ca: null },
  );
}

/**
 * An Existing database that is a redis (ADR-0033): the AUTH token the
 * operator typed, at the address the last plan's lookup found. With TLS on,
 * `rediss://` and a `ca` (Amazon's public roots, as for a cache Cloudgate
 * made); with it off, `redis://` and no `ca`. A cache with no AUTH token
 * has no `password`: a variable linked to it is left unset, never empty.
 *
 * On Google Cloud a Memorystore for Valkey instance: at its primary
 * endpoint's address, which Cloudgate's endpoints' run saved, with no
 * password (ADR-0042), TLS as the lookup read it and the instance's own CA
 * as `ca`. One whose endpoints are not made yet is not made.
 */
function existingCache(
  configName: string,
  cache: {
    readonly identifier: string;
    readonly tls: boolean;
    readonly address: { readonly host: string; readonly port: number } | null;
    readonly authToken: string | null;
    /** Its `ca` with TLS on: each cloud's (ADR-0043). */
    readonly ca: string | null;
    /** Why it has no address yet, when it has none. */
    readonly unmade: string;
  },
): NonNullable<Found> {
  const token = cache.authToken ?? '';
  const unset = [
    ...(token === '' ? ['password'] : []),
    ...(cache.tls ? [] : ['ca']),
  ];
  if (!cache.address || (cache.tls && cache.ca === null)) {
    return {
      values: {},
      unset,
      kind: 'redis',
      unmade: cache.unmade,
    };
  }
  const { password, ...values } = outputValues(
    { kind: 'redis', password: token },
    {
      ...cache.address,
      tls: cache.tls,
      ca: cache.tls ? cache.ca : null,
    },
  );
  return {
    values: token === '' ? values : { ...values, password },
    unset,
  };
}

/** Every Output of the source this Environment has under `configName`. */
async function sourceOutputs(
  db: Db,
  environmentId: string,
  configName: string,
  keyWait: KeyWait,
): Promise<Found> {
  const [pg] = await db
    .select({
      appName: postgres.appName,
      user: postgres.databaseUser,
      password: postgres.databasePassword,
      database: postgres.databaseName,
      region: postgres.region,
      rdsEndpoint: postgres.rdsEndpoint,
      cloudSqlEndpoint: postgres.cloudSqlEndpoint,
      cloud: cloudAccount.cloud,
      status: postgres.applicationStatus,
      existingRegion: existingDatabase.region,
      existingIdentifier: existingDatabase.identifier,
      existingAddress: existingDatabase.address,
      existingCa: existingDatabase.ca,
    })
    .from(postgres)
    .leftJoin(
      existingDatabase,
      eq(existingDatabase.postgresId, postgres.postgresId),
    )
    // A Cloudgate-made instance's Cloud account, or an Existing database's
    // whose own row holds it.
    .leftJoin(
      cloudAccount,
      eq(
        cloudAccount.cloudAccountId,
        sql`coalesce(${postgres.cloudAccountId}, ${existingDatabase.cloudAccountId})`,
      ),
    )
    .where(
      and(
        eq(postgres.environmentId, environmentId),
        eq(postgres.configName, configName),
      ),
    );
  if (pg) {
    const {
      appName,
      region,
      rdsEndpoint,
      cloudSqlEndpoint,
      cloud,
      status,
      existingRegion,
      existingIdentifier,
      existingAddress,
      existingCa,
      ...login
    } = pg;
    // An Existing database: the login the operator typed, at the
    // address the last plan's lookup found, with TLS. Its `ca` is each
    // cloud's (ADR-0043): RDS's bundle for its region on AWS; on Google
    // Cloud the server CA the instance reports, beside its own
    // `….sql.goog.` name exactly as reported, trailing dot included.
    if (existingRegion !== null) {
      const ca = byCloud(cloudOrLegacy(cloud), {
        aws: rdsCaBundle(existingRegion),
        gcp: existingCa,
      });
      if (!existingAddress || ca === null) {
        return {
          values: {},
          unset: [],
          kind: 'postgres',
          unmade: `${configName} uses the existing database ${existingIdentifier}, which no plan has found yet. Check for changes, then deploy again.`,
        };
      }
      return made(
        outputValues({ kind: 'postgres', ...login } satisfies OutputSource, {
          ...existingAddress,
          tls: true,
          ca,
        }),
      );
    }
    if (region === null) {
      return made(
        outputValues(
          { kind: 'postgres', ...login } satisfies OutputSource,
          serverAddress(appName, 'postgres'),
        ),
      );
    }
    // Each cloud's managed postgres (ADR-0043). A Cloud SQL instance: its PSC
    // DNS name, TLS required, and its own CA, as its last
    // Cloud run read them. An RDS instance: its endpoint, TLS checked
    // against RDS's CA bundle for its region.
    return byCloud<() => Found>(cloudOrLegacy(cloud), {
      aws: () => {
        if (!rdsEndpoint) {
          return {
            values: {},
            unset: [],
            kind: 'postgres',
            unmade:
              status === 'error'
                ? `${configName} is not made on RDS: its Cloud run failed before the instance was made. Its Deployment log says why; apply the plan again, then deploy this Service.`
                : `${configName} is not made on RDS yet: its Cloud run has not finished making it. Deploy again once ${configName} is made.`,
          };
        }
        return made(
          outputValues({ kind: 'postgres', ...login } satisfies OutputSource, {
            ...rdsEndpoint,
            tls: true,
            ca: rdsCaBundle(region),
          }),
        );
      },
      gcp: () => {
        if (!cloudSqlEndpoint) {
          return {
            values: {},
            unset: [],
            kind: 'postgres',
            unmade:
              status === 'error'
                ? `${configName} is not made on Cloud SQL: its Cloud run failed before the instance was made. Its Deployment log says why; apply the plan again, then deploy this Service.`
                : `${configName} is not made on Cloud SQL yet: its Cloud run has not finished making it. Deploy again once ${configName} is made.`,
          };
        }
        const { ca, ...address } = cloudSqlEndpoint;
        return made(
          outputValues({ kind: 'postgres', ...login } satisfies OutputSource, {
            ...address,
            tls: true,
            ca,
          }),
        );
      },
    })();
  }
  // A mysql: on a Server at its Service name, as a postgres there.
  // On RDS at its endpoint, and an Existing database at the address
  // the last plan's lookup found, each with RDS's CA bundle for its region
  // as `ca`. On Cloud SQL at its PSC DNS name, and an Existing
  // database at its `….sql.goog.` name as reported, each with the
  // instance's own CA as `ca`. Its `url` never names TLS on either cloud: a
  // MySQL there offers TLS without requiring it.
  const [my] = await db
    .select({
      appName: mysql.appName,
      user: mysql.databaseUser,
      password: mysql.databasePassword,
      database: mysql.databaseName,
      region: mysql.region,
      rdsEndpoint: mysql.rdsEndpoint,
      cloudSqlEndpoint: mysql.cloudSqlEndpoint,
      cloud: cloudAccount.cloud,
      status: mysql.applicationStatus,
      existingRegion: existingDatabase.region,
      existingIdentifier: existingDatabase.identifier,
      existingAddress: existingDatabase.address,
      existingCa: existingDatabase.ca,
    })
    .from(mysql)
    .leftJoin(existingDatabase, eq(existingDatabase.mysqlId, mysql.mysqlId))
    // A Cloudgate-made instance's Cloud account, or an Existing database's,
    // whose own row holds it, as a postgres's.
    .leftJoin(
      cloudAccount,
      eq(
        cloudAccount.cloudAccountId,
        sql`coalesce(${mysql.cloudAccountId}, ${existingDatabase.cloudAccountId})`,
      ),
    )
    .where(
      and(
        eq(mysql.environmentId, environmentId),
        eq(mysql.configName, configName),
      ),
    );
  if (my) {
    const {
      appName,
      region,
      rdsEndpoint,
      cloudSqlEndpoint,
      cloud,
      status,
      existingRegion,
      existingIdentifier,
      existingAddress,
      existingCa,
      ...login
    } = my;
    const source = { kind: 'mysql', ...login } satisfies OutputSource;
    if (existingRegion !== null) {
      const ca = byCloud(cloudOrLegacy(cloud), {
        aws: rdsCaBundle(existingRegion),
        gcp: existingCa,
      });
      if (!existingAddress || ca === null) {
        return {
          values: {},
          unset: [],
          kind: 'mysql',
          unmade: `${configName} uses the existing database ${existingIdentifier}, which no plan has found yet. Check for changes, then deploy again.`,
        };
      }
      return made(outputValues(source, { ...existingAddress, tls: false, ca }));
    }
    if (region === null) {
      return made(outputValues(source, serverAddress(appName, 'mysql')));
    }
    // Each cloud's managed mysql (ADR-0043), with its own product's words.
    const notMade = (product: string): Found => ({
      values: {},
      unset: [],
      kind: 'mysql',
      unmade:
        status === 'error'
          ? `${configName} is not made on ${product}: its Cloud run failed before the instance was made. Its Deployment log says why; apply the plan again, then deploy this Service.`
          : `${configName} is not made on ${product} yet: its Cloud run has not finished making it. Deploy again once ${configName} is made.`,
    });
    return byCloud<() => Found>(cloudOrLegacy(cloud), {
      aws: () =>
        rdsEndpoint
          ? made(
              outputValues(source, {
                ...rdsEndpoint,
                tls: false,
                ca: rdsCaBundle(region),
              }),
            )
          : notMade('RDS'),
      gcp: () => {
        if (!cloudSqlEndpoint) return notMade('Cloud SQL');
        const { ca, ...address } = cloudSqlEndpoint;
        return made(outputValues(source, { ...address, tls: false, ca }));
      },
    })();
  }
  const [cache] = await db
    .select({
      appName: redis.appName,
      password: redis.databasePassword,
      region: redis.region,
      authToken: redis.authToken,
      endpoint: redis.elasticacheEndpoint,
      memorystoreEndpoint: redis.memorystoreEndpoint,
      cloud: cloudAccount.cloud,
      status: redis.applicationStatus,
      existingIdentifier: existingDatabase.identifier,
      existingTls: existingDatabase.tls,
      existingAddress: existingDatabase.address,
      existingCa: existingDatabase.ca,
    })
    .from(redis)
    .leftJoin(existingDatabase, eq(existingDatabase.redisId, redis.redisId))
    // A Cloudgate-made cache's Cloud account, or an existing one's,
    // whose own row holds it.
    .leftJoin(
      cloudAccount,
      eq(
        cloudAccount.cloudAccountId,
        sql`coalesce(${redis.cloudAccountId}, ${existingDatabase.cloudAccountId})`,
      ),
    )
    .where(
      and(
        eq(redis.environmentId, environmentId),
        eq(redis.configName, configName),
      ),
    );
  if (cache) {
    if (cache.existingIdentifier !== null) {
      const identifier = cache.existingIdentifier;
      return existingCache(configName, {
        identifier,
        tls: cache.existingTls ?? true,
        address: cache.existingAddress,
        authToken: cache.authToken,
        ...byCloud(cloudOrLegacy(cache.cloud), {
          aws: {
            ca: ELASTICACHE_CA_BUNDLE,
            unmade: `${configName} uses the existing cache ${identifier}, which no plan has found yet. Check for changes, then deploy again.`,
          },
          gcp: {
            ca: cache.existingCa,
            unmade: `${configName} uses the existing cache ${identifier}, and Cloudgate's endpoints to it are not made yet. Check for changes and apply the plan, then deploy again.`,
          },
        }),
      });
    }
    if (cache.region === null) {
      return made(
        outputValues(
          { kind: 'redis', password: cache.password },
          serverAddress(cache.appName, 'redis'),
        ),
      );
    }
    // Each cloud's managed redis (ADR-0043).
    return byCloud<() => Found>(cloudOrLegacy(cache.cloud), {
      aws: () => {
        // On ElastiCache: its AUTH token is the password, and it takes
        // only TLS connections, trusting Amazon's public roots.
        if (!cache.endpoint || !cache.authToken) {
          return {
            values: {},
            unset: [],
            kind: 'redis',
            unmade:
              cache.status === 'error'
                ? `${configName} is not made on ElastiCache: its Cloud run failed before the cache was made. Its Deployment log says why; apply the plan again, then deploy this Service.`
                : `${configName} is not made on ElastiCache yet: its Cloud run has not finished making it. Deploy again once ${configName} is made.`,
          };
        }
        return made(
          outputValues(
            { kind: 'redis', password: cache.authToken },
            { ...cache.endpoint, tls: true, ca: ELASTICACHE_CA_BUNDLE },
          ),
        );
      },
      gcp: () => {
        // On Memorystore: no password (its cloud's target says so,
        // ADR-0042), so a `password` link is left unset; its primary endpoint on
        // the private link, which only this Environment's network reaches, TLS
        // checked against the instance's own CA, as its last Cloud run read them.
        const unset = outputsWithoutValue('redis', cloudTarget('gcp'));
        if (!cache.memorystoreEndpoint) {
          return {
            values: {},
            unset,
            kind: 'redis',
            unmade:
              cache.status === 'error'
                ? `${configName} is not made on Memorystore: its Cloud run failed before the instance's address was saved. Its Deployment log says why; apply the plan again, then deploy this Service.`
                : `${configName} is not made on Memorystore yet: its Cloud run has not finished making it. Deploy again once ${configName} is made.`,
          };
        }
        const { ca, ...address } = cache.memorystoreEndpoint;
        return {
          values: outputValues(
            { kind: 'redis', password: null },
            { ...address, tls: true, ca },
          ),
          unset,
        };
      },
    })();
  }
  const [onS3] = await db
    .select({
      bucketName: bucket.bucketName,
      region: bucket.region,
      appliedOrigins: bucket.appliedOrigins,
      status: bucket.applicationStatus,
      existing: bucket.existing,
      accessKeyId: bucket.accessKeyId,
      secretAccessKey: bucket.secretAccessKey,
      keyRotation: bucket.keyRotation,
      rotationKeys: bucket.rotationKeys,
      cloud: cloudAccount.cloud,
    })
    .from(bucket)
    .leftJoin(
      cloudAccount,
      eq(cloudAccount.cloudAccountId, bucket.cloudAccountId),
    )
    .where(
      and(
        eq(bucket.environmentId, environmentId),
        eq(bucket.configName, configName),
        isNotNull(bucket.cloudAccountId),
      ),
    );
  if (onS3?.region) {
    const region = onS3.region;
    // Each cloud's bucket (ADR-0043): on S3, or on Cloud Storage with
    // its own key.
    return byCloud<() => Found>(cloudOrLegacy(onS3.cloud), {
      aws: () => {
        // An existing bucket: the same Outputs as one Cloudgate
        // made, once a plan's lookup has found it.
        if (onS3.existing) {
          return s3Bucket(
            onS3.bucketName,
            region,
            onS3.status === 'done'
              ? null
              : `${configName} uses the existing bucket ${onS3.bucketName}, which no plan has found yet. Check for changes, then deploy again.`,
          );
        }
        // Its first Cloud run records the origins it wrote once it made the
        // bucket, so none recorded is a bucket not made yet.
        const unmade =
          onS3.appliedOrigins !== null
            ? null
            : onS3.status === 'error'
              ? `${configName} is not made on S3: its Cloud run failed before the bucket was made. Its Deployment log says why; apply the plan again, then deploy this Service.`
              : `${configName} is not made on S3 yet: its Cloud run has not finished making it. Deploy again once ${configName} is made.`;
        return s3Bucket(onS3.bucketName, region, unmade);
      },
      gcp: () => {
        // Its first Cloud run saves the key once it made the bucket and the
        // key, so none saved is a bucket not made yet. Every Service that
        // links it is handed this one key (ADR-0032 as amended).
        // An existing bucket's key is made by the Apply after the plan that
        // first found it; its grant is never waited on.
        if (onS3.accessKeyId === null || onS3.secretAccessKey === null) {
          return {
            values: {},
            unset: [],
            kind: 'bucket',
            unmade: onS3.existing
              ? `${configName} uses the existing bucket ${onS3.bucketName}, whose key Cloudgate has not made yet: the Apply of the plan that finds it makes it. Check for changes, apply the plan, then deploy again.`
              : onS3.status === 'error'
                ? `${configName} is not made on Cloud Storage: its Cloud run failed before the bucket's key was saved. Its Deployment log says why; apply the plan again, then deploy this Service.`
                : `${configName} is not made on Cloud Storage yet: its Cloud run has not finished making it. Deploy again once ${configName} is made.`,
          };
        }
        // While a Rotate key redeploys the Services linking it (as on a
        // Server), each is deployed with the new key; the stored one
        // stays valid until they all run with it, and is what a put-back
        // after a failed redeploy reads.
        const rotating =
          onS3.keyRotation?.phase === 'redeploying'
            ? (onS3.rotationKeys?.newKey ?? null)
            : null;
        return made(
          cloudStorageBucketValues(
            onS3.bucketName,
            rotating ?? {
              accessKeyId: onS3.accessKeyId,
              secretAccessKey: onS3.secretAccessKey,
            },
          ),
        );
      },
    })();
  }
  const store = await bucketWithKey(db, environmentId, configName, keyWait);
  if (store) {
    return made(
      outputValues(
        {
          kind: 'bucket',
          name: store.bucketName,
          // Garage on a Server is started with this one region, and is
          // addressed path-style (ADR-0037).
          region: GARAGE_REGION,
          accessKeyId: store.accessKeyId,
          secretAccessKey: store.secretAccessKey,
          pathStyle: true,
        },
        bucketAddress(
          store.appName,
          await db
            .select({
              host: domain.host,
              https: domain.https,
              createdAt: domain.createdAt,
              uniqueConfigKey: domain.uniqueConfigKey,
            })
            .from(domain)
            .where(eq(domain.bucketId, store.bucketId)),
        ),
      ),
    );
  }
  return null;
}

/**
 * The real names of the buckets on S3 a cloud Service's `links` name, any
 * of their Outputs (ADR-0032: a link is the access), sorted: what its
 * task role's policy grants object access on, so a bucket it stops linking
 * is one its next run takes that access from. A plan read names a bucket
 * the same plan creates from `planned`, its real name by Config name.
 */
export async function linkedS3Buckets(
  db: Db,
  environmentId: string,
  links: ConfigLinks | null | undefined,
  planned?: ReadonlyMap<string, string>,
): Promise<string[]> {
  const sources = [
    ...new Set(Object.values(links ?? {}).map((link) => link.source)),
  ];
  if (sources.length === 0) return [];
  const rows = await db
    .select({ configName: bucket.configName, bucketName: bucket.bucketName })
    .from(bucket)
    .where(
      and(
        eq(bucket.environmentId, environmentId),
        inArray(bucket.configName, sources),
        isNotNull(bucket.cloudAccountId),
      ),
    );
  const names = new Set(rows.map((row) => row.bucketName));
  for (const source of sources) {
    const name = planned?.get(source);
    if (name !== undefined && !rows.some((row) => row.configName === source)) {
      names.add(name);
    }
  }
  return [...names].sort();
}

/**
 * The bucket this Environment has under `configName` with its key,
 * or `null` when it has none. Garage makes the key on the bucket's first
 * deploy, so while that deploy has not ended this waits for it, up to
 * `keyWait.budgetMs`; a deploy that ended without one fails this deploy
 * with a sentence saying so, rather than starting the container without it.
 */
async function bucketWithKey(
  db: Db,
  environmentId: string,
  configName: string,
  keyWait: KeyWait,
): Promise<{
  bucketId: string;
  appName: string;
  bucketName: string;
  accessKeyId: string;
  secretAccessKey: string;
} | null> {
  const deadline = Date.now() + keyWait.budgetMs;
  for (;;) {
    const [found] = await db
      .select({
        bucketId: bucket.bucketId,
        appName: bucket.appName,
        bucketName: bucket.bucketName,
        accessKeyId: bucket.accessKeyId,
        secretAccessKey: bucket.secretAccessKey,
        status: bucket.applicationStatus,
        keyRotation: bucket.keyRotation,
        rotationKeys: bucket.rotationKeys,
      })
      .from(bucket)
      .where(
        and(
          eq(bucket.environmentId, environmentId),
          eq(bucket.configName, configName),
          isNull(bucket.cloudAccountId),
        ),
      );
    if (!found) return null;
    // While a Rotate key redeploys the Services linking it, each is
    // deployed with the new key; the stored one stays valid until they all
    // run with it, and is what a put-back after a failed redeploy reads.
    const rotating =
      found.keyRotation?.phase === 'redeploying'
        ? (found.rotationKeys?.newKey ?? null)
        : null;
    const { accessKeyId, secretAccessKey } = rotating ?? found;
    if (accessKeyId !== null && secretAccessKey !== null) {
      return {
        bucketId: found.bucketId,
        appName: found.appName,
        bucketName: found.bucketName,
        accessKeyId,
        secretAccessKey,
      };
    }
    const deploying = found.status === 'idle' || found.status === 'running';
    if (!deploying || Date.now() >= deadline) {
      throw new Error(
        deploying
          ? `${configName} has no key yet: Garage makes it on the bucket's first deploy, which has not finished. Deploy again once ${configName} is done.`
          : `${configName} has no key: Garage makes it on the bucket's first deploy, which did not finish. Deploy ${configName} again, then this Service.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, keyWait.everyMs));
  }
}

function serverAddress(
  appName: string,
  kind: keyof typeof SERVER_PORTS,
): SourceAddress {
  // A Server reports no CA bundle, so `ca` is never among these Outputs.
  return { host: appName, port: SERVER_PORTS[kind], tls: false, ca: null };
}

/**
 * Refuses an env text that types a value for a name the Service's config
 * links (ADR-0031): a wired variable has one source, the link. Parsed with
 * `dotenv`, what the deploy reads the env through, so what is refused is
 * exactly what the deploy would call an assignment. A Preview deployment's
 * `previewEnv` is not checked here: overriding a link for a preview is
 * allowed (ADR-0021).
 */
export function refuseTypedLinkedNames(
  env: string | null | undefined,
  links: ConfigLinks | null | undefined,
): void {
  if (!env || !links) return;
  const linked = Object.keys(parse(env)).filter((name) =>
    Object.hasOwn(links, name),
  );
  if (linked.length === 0) return;
  throw new ConflictException({
    message: `${linked
      .map(
        (name) =>
          `${name} is linked to ${links[name].source}.${links[name].output}`,
      )
      .join(
        '; ',
      )} by the Project config, so it takes no typed value; remove it from these variables, or change the link in the config`,
    code: VARIABLE_IS_LINKED_CODE,
  });
}

/**
 * The links a Preview deployment fills in (ADR-0021): its parent's,
 * less each name its `previewEnv` types a value for. That value overrides
 * the link for the preview alone, so the link's source is not read at all,
 * and a preview pointed at a staging database deploys whether or not the
 * parent's source answers. Parsed with `dotenv`, as the deploy reads it.
 */
export function previewLinks(
  links: ConfigLinks,
  previewEnv: string | null,
): ConfigLinks {
  if (!previewEnv) return links;
  const typed = parse(previewEnv);
  return Object.fromEntries(
    Object.entries(links).filter(([name]) => !Object.hasOwn(typed, name)),
  );
}
