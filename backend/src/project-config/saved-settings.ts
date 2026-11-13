import { createHash } from 'node:crypto';

import { parse as parseDotenv } from 'dotenv';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import { serviceTypeEnum } from '../applications/application.schema';
import type { ServiceType } from '../applications/application.schema';
import type { DrizzleDB } from '../db/drizzle.module';
import {
  application,
  bucket,
  cloudAccount,
  compose,
  databaseSwitch,
  domain,
  existingDatabase,
  mysql,
  postgres,
  redis,
  registry,
} from '../db/schema';
import { byCloud, cloudOrLegacy } from '../cloud-accounts/cloud-provider';
import { SERVICE_SOURCES } from '../environments/environment-services';
import { storedDockerSettings } from '../native/docker-native';
import { isExpressibleServiceType } from './format/config-schema';
import type { ExpressibleServiceType } from './format/config-schema';
import type { ConfigLinks } from './project-config.types';
import type {
  DeployTarget,
  SavedCloudPlace,
  SavedService,
  SavedStackVm,
} from './planner/plan.types';
import type { CloudKind } from '../cloud-accounts/cloud-account.schema';
import type { StackVmSettings } from '../cloud-accounts/definitions/stack-vm';

/** The database, or a transaction on it: only reads are made. */
type SavedSettingsReader = Pick<DrizzleDB, 'select'>;

/** A saved postgres's cloud place and its cloud's own settings of it. */
type PostgresCloudPart = Partial<
  Pick<
    Extract<SavedService, { serviceType: 'postgres' }>,
    'cloud' | 'rds' | 'cloudSql' | 'nativeAws' | 'nativeGcp'
  >
>;

/** A mysql's cloud place and settings, as a postgres's. */
type MysqlCloudPart = Partial<
  Pick<
    Extract<SavedService, { serviceType: 'mysql' }>,
    'cloud' | 'rds' | 'cloudSql' | 'nativeAws' | 'nativeGcp'
  >
>;

/** A saved redis's cloud place and its cloud's own settings of it. */
type RedisCloudPart = Partial<
  Pick<
    Extract<SavedService, { serviceType: 'redis' }>,
    'cloud' | 'elasticache' | 'memorystore' | 'nativeAws' | 'nativeGcp'
  >
>;

/**
 * The planner's input from the database: every Service in one Environment,
 * with the saved settings of the fields the config owns and the *keys* of its
 * variable blobs. Values are decrypted by the column type on read and
 * dropped here; nothing past this function sees one.
 */
export async function readSavedServices(
  db: SavedSettingsReader,
  environmentId: string,
): Promise<SavedService[]> {
  const [applications, postgresRows, mysqlRows, redisRows, bucketRows, others] =
    await Promise.all([
      db
        .select({
          serviceId: application.applicationId,
          name: application.name,
          configName: application.configName,
          configKind: application.configKind,
          description: application.description,
          cpuLimit: application.cpuLimit,
          memoryLimit: application.memoryLimit,
          command: application.command,
          args: application.args,
          port: application.port,
          cronSchedule: application.cronSchedule,
          cronTimezone: application.cronTimezone,
          cronTimeoutSeconds: application.cronTimeoutSeconds,
          sourceType: application.sourceType,
          owner: application.owner,
          repository: application.repository,
          buildPath: application.buildPath,
          gitlabOwner: application.gitlabOwner,
          gitlabRepository: application.gitlabRepository,
          gitlabPathNamespace: application.gitlabPathNamespace,
          gitlabBuildPath: application.gitlabBuildPath,
          giteaOwner: application.giteaOwner,
          giteaRepository: application.giteaRepository,
          giteaBuildPath: application.giteaBuildPath,
          bitbucketOwner: application.bitbucketOwner,
          bitbucketRepository: application.bitbucketRepository,
          bitbucketBuildPath: application.bitbucketBuildPath,
          customGitUrl: application.customGitUrl,
          customGitBuildPath: application.customGitBuildPath,
          dockerImage: application.dockerImage,
          dropBuildPath: application.dropBuildPath,
          buildType: application.buildType,
          railpackVersion: application.railpackVersion,
          herokuVersion: application.herokuVersion,
          dockerfile: application.dockerfile,
          dockerContextPath: application.dockerContextPath,
          dockerBuildStage: application.dockerBuildStage,
          publishDirectory: application.publishDirectory,
          isStaticSpa: application.isStaticSpa,
          createEnvFile: application.createEnvFile,
          enableSubmodules: application.enableSubmodules,
          watchPaths: application.watchPaths,
          env: application.env,
          buildArgs: application.buildArgs,
          buildSecrets: application.buildSecrets,
          cloudAccountId: application.cloudAccountId,
          region: application.region,
          registryId: application.registryId,
          buildRegistryId: application.buildRegistryId,
          serverId: application.serverId,
          configLinks: application.configLinks,
          // The `native.aws` its last Apply laid on ECS.
          nativeAws: application.nativeAws,
          // The `native.gcp` its last Apply laid on Cloud Run.
          nativeGcp: application.nativeGcp,
          // What closing its `run.app` address warns of without.
          hasDomain: sql<boolean>`exists (select 1 from ${domain} where ${domain.applicationId} = ${application.applicationId})`,
          // The seven Swarm settings `native.docker` owns.
          swarm: swarmColumnsOf(application),
          // The cloud of a Service in a Cloud account; null elsewhere.
          cloudKind: cloudAccount.cloud,
        })
        .from(application)
        .leftJoin(
          cloudAccount,
          eq(cloudAccount.cloudAccountId, application.cloudAccountId),
        )
        .where(
          and(
            eq(application.environmentId, environmentId),
            // A cloud Service being deleted, or Delete incomplete, has left
            // the config already: its Delete, not a plan, ends it.
            isNull(application.cloudDelete),
          ),
        ),
      db
        .select({
          serviceId: postgres.postgresId,
          name: postgres.name,
          configName: postgres.configName,
          description: postgres.description,
          cpuLimit: postgres.cpuLimit,
          memoryLimit: postgres.memoryLimit,
          dockerImage: postgres.dockerImage,
          databaseName: postgres.databaseName,
          databaseUser: postgres.databaseUser,
          env: postgres.env,
          serverId: postgres.serverId,
          configLinks: postgres.configLinks,
          // The seven Swarm settings `native.docker` owns.
          swarm: swarmColumnsOf(postgres),
          cloudAccountId: postgres.cloudAccountId,
          region: postgres.region,
          instanceClass: postgres.instanceClass,
          storageGb: postgres.storageGb,
          maxStorageGb: postgres.maxStorageGb,
          multiAz: postgres.multiAz,
          backupRetentionDays: postgres.backupRetentionDays,
          rdsApplied: postgres.rdsApplied,
          // The `native.aws` its last Apply laid on AWS.
          nativeAws: postgres.nativeAws,
          // The `native.gcp` its last Apply laid on Cloud SQL.
          nativeGcp: postgres.nativeGcp,
          cloudSqlApplied: postgres.cloudSqlApplied,
          rdsEndpoint: postgres.rdsEndpoint,
          // Whether a Cloud SQL instance's address is saved; never its value.
          cloudSqlEndpointSaved: sql<boolean>`${postgres.cloudSqlEndpoint} is not null`,
          applicationStatus: postgres.applicationStatus,
          // The cloud of a postgres in a Cloud account; null elsewhere.
          cloudKind: cloudAccount.cloud,
          // An Existing database's place; null on every other one.
          existingCloudAccountId: existingDatabase.cloudAccountId,
          existingRegion: existingDatabase.region,
          existingIdentifier: existingDatabase.identifier,
          existingReachable: existingDatabase.madeReachable,
          // A switch the next plan makes; null on every other one.
          switchTo: databaseSwitch.to,
          switchIdentifier: databaseSwitch.identifier,
        })
        .from(postgres)
        .leftJoin(
          cloudAccount,
          eq(cloudAccount.cloudAccountId, postgres.cloudAccountId),
        )
        .leftJoin(
          existingDatabase,
          eq(existingDatabase.postgresId, postgres.postgresId),
        )
        .leftJoin(
          databaseSwitch,
          and(
            eq(databaseSwitch.environmentId, postgres.environmentId),
            eq(databaseSwitch.configName, postgres.configName),
            eq(databaseSwitch.kind, 'postgres'),
          ),
        )
        .where(eq(postgres.environmentId, environmentId)),
      db
        .select({
          serviceId: mysql.mysqlId,
          name: mysql.name,
          configName: mysql.configName,
          description: mysql.description,
          cpuLimit: mysql.cpuLimit,
          memoryLimit: mysql.memoryLimit,
          dockerImage: mysql.dockerImage,
          databaseName: mysql.databaseName,
          databaseUser: mysql.databaseUser,
          env: mysql.env,
          serverId: mysql.serverId,
          configLinks: mysql.configLinks,
          // The seven Swarm settings `native.docker` owns.
          swarm: swarmColumnsOf(mysql),
          // A mysql on RDS: its place and Cloudgate's settings of
          // it, as a postgres on RDS's; null elsewhere.
          cloudAccountId: mysql.cloudAccountId,
          region: mysql.region,
          instanceClass: mysql.instanceClass,
          storageGb: mysql.storageGb,
          maxStorageGb: mysql.maxStorageGb,
          multiAz: mysql.multiAz,
          backupRetentionDays: mysql.backupRetentionDays,
          rdsApplied: mysql.rdsApplied,
          // The `native.aws` its last Apply laid on AWS.
          nativeAws: mysql.nativeAws,
          // On Cloud SQL, as a postgres's: its `native.gcp`, its
          // backups as last applied, and whether its address is saved.
          nativeGcp: mysql.nativeGcp,
          cloudSqlApplied: mysql.cloudSqlApplied,
          rdsEndpoint: mysql.rdsEndpoint,
          cloudSqlEndpointSaved: sql<boolean>`${mysql.cloudSqlEndpoint} is not null`,
          applicationStatus: mysql.applicationStatus,
          // The cloud of a mysql in a Cloud account; null elsewhere.
          cloudKind: cloudAccount.cloud,
          existingCloudAccountId: existingDatabase.cloudAccountId,
          existingRegion: existingDatabase.region,
          existingIdentifier: existingDatabase.identifier,
          existingReachable: existingDatabase.madeReachable,
          switchTo: databaseSwitch.to,
          switchIdentifier: databaseSwitch.identifier,
        })
        .from(mysql)
        .leftJoin(
          cloudAccount,
          eq(cloudAccount.cloudAccountId, mysql.cloudAccountId),
        )
        .leftJoin(existingDatabase, eq(existingDatabase.mysqlId, mysql.mysqlId))
        .leftJoin(
          databaseSwitch,
          and(
            eq(databaseSwitch.environmentId, mysql.environmentId),
            eq(databaseSwitch.configName, mysql.configName),
            eq(databaseSwitch.kind, 'mysql'),
          ),
        )
        .where(eq(mysql.environmentId, environmentId)),
      db
        .select({
          serviceId: redis.redisId,
          name: redis.name,
          configName: redis.configName,
          description: redis.description,
          cpuLimit: redis.cpuLimit,
          memoryLimit: redis.memoryLimit,
          dockerImage: redis.dockerImage,
          env: redis.env,
          serverId: redis.serverId,
          configLinks: redis.configLinks,
          // The seven Swarm settings `native.docker` owns.
          swarm: swarmColumnsOf(redis),
          cloudAccountId: redis.cloudAccountId,
          region: redis.region,
          nodeType: redis.nodeType,
          replica: redis.replica,
          snapshotRetentionDays: redis.snapshotRetentionDays,
          elasticacheApplied: redis.elasticacheApplied,
          // The `native.aws` its last Apply laid on AWS.
          nativeAws: redis.nativeAws,
          // The `native.gcp` its last Apply laid on Memorystore.
          nativeGcp: redis.nativeGcp,
          elasticacheEndpoint: redis.elasticacheEndpoint,
          memorystoreHighAvailability: redis.memorystoreHighAvailability,
          memorystoreBackupRetentionDays: redis.memorystoreBackupRetentionDays,
          memorystoreApplied: redis.memorystoreApplied,
          memorystoreEngineVersion: redis.memorystoreEngineVersion,
          // Whether a Memorystore instance's address is saved; never its value.
          memorystoreEndpointSaved: sql<boolean>`${redis.memorystoreEndpoint} is not null`,
          applicationStatus: redis.applicationStatus,
          // The cloud of a redis in a Cloud account; null elsewhere.
          cloudKind: cloudAccount.cloud,
          // An Existing database's place; null on every other one.
          existingCloudAccountId: existingDatabase.cloudAccountId,
          existingRegion: existingDatabase.region,
          existingIdentifier: existingDatabase.identifier,
          existingReachable: existingDatabase.madeReachable,
          // A switch the next plan makes; null elsewhere.
          switchTo: databaseSwitch.to,
          switchIdentifier: databaseSwitch.identifier,
        })
        .from(redis)
        .leftJoin(
          cloudAccount,
          eq(cloudAccount.cloudAccountId, redis.cloudAccountId),
        )
        .leftJoin(existingDatabase, eq(existingDatabase.redisId, redis.redisId))
        .leftJoin(
          databaseSwitch,
          and(
            eq(databaseSwitch.environmentId, redis.environmentId),
            eq(databaseSwitch.configName, redis.configName),
            eq(databaseSwitch.kind, 'redis'),
          ),
        )
        .where(eq(redis.environmentId, environmentId)),
      // Never the key or the admin credential: a plan compares neither.
      db
        .select({
          serviceId: bucket.bucketId,
          name: bucket.name,
          configName: bucket.configName,
          description: bucket.description,
          bucketName: bucket.bucketName,
          // Where a linking Service must be to reach it (ADR-0031).
          serverId: bucket.serverId,
          // Its endpoint follows its Domains, so a plan notes none.
          hasDomain: sql<boolean>`exists (select 1 from ${domain} where ${domain.bucketId} = ${bucket.bucketId})`,
          cloudAccountId: bucket.cloudAccountId,
          region: bucket.region,
          origins: bucket.origins,
          appliedOrigins: bucket.appliedOrigins,
          existing: bucket.existing,
          // Its Garage's labels, its `native.docker`'s one key.
          labelsSwarm: bucket.labelsSwarm,
          // The `native.aws` its last Apply laid on S3.
          nativeAws: bucket.nativeAws,
          // The cloud of a bucket in a Cloud account; null elsewhere.
          cloudKind: cloudAccount.cloud,
        })
        .from(bucket)
        .leftJoin(
          cloudAccount,
          eq(cloudAccount.cloudAccountId, bucket.cloudAccountId),
        )
        .where(
          and(
            eq(bucket.environmentId, environmentId),
            // A bucket on AWS being deleted, or Delete incomplete, has left
            // the config already, as a cloud Service has.
            isNull(bucket.cloudDelete),
          ),
        ),
      // Compose stacks with the fields a `compose` entry owns, then the
      // kinds version 1 cannot describe.
      Promise.all([
        readComposeStacks(db, environmentId),
        readUnexpressible(db, environmentId),
      ]).then((parts) => parts.flat()),
    ]);

  const registryNames = await readRegistryNames(
    db,
    applications.flatMap((row) =>
      row.cloudAccountId === null
        ? []
        : [row.registryId, row.buildRegistryId].filter(
            (id): id is string => id !== null,
          ),
    ),
  );
  const saved: SavedService[] = [];
  for (const {
    serviceId,
    name,
    configName,
    env,
    buildArgs,
    buildSecrets,
    cloudAccountId,
    region,
    registryId,
    buildRegistryId,
    serverId,
    configLinks,
    cloudKind,
    swarm,
    nativeAws,
    nativeGcp,
    hasDomain,
    dropBuildPath,
    ...settings
  } of applications) {
    const cloud: SavedCloudPlace | null =
      cloudAccountId !== null && region !== null
        ? {
            cloudAccountId,
            region,
            // Said only on Google Cloud, where a static site's change
            // differs, so a Service on AWS fingerprints as before.
            ...byCloud<{ cloud?: 'gcp' }>(cloudOrLegacy(cloudKind), {
              aws: {},
              gcp: { cloud: 'gcp' },
            }),
            linkedRegistries: [
              ...(registryId === null
                ? []
                : [
                    {
                      as: 'Registry' as const,
                      name: registryNames.get(registryId) ?? registryId,
                    },
                  ]),
              ...(buildRegistryId === null
                ? []
                : [
                    {
                      as: 'build Registry' as const,
                      name:
                        registryNames.get(buildRegistryId) ?? buildRegistryId,
                    },
                  ]),
            ],
          }
        : null;
    saved.push({
      serviceType: 'application',
      serviceId,
      name,
      configName,
      // Only on a cloud Service, so a Server one's fingerprint is unchanged.
      ...(cloud ? { cloud } : {}),
      ...placeAndLinks(serverId, configLinks),
      ...dockerOf(swarm),
      // Only once an Apply laid one, so a Service with none fingerprints
      // as before.
      ...(cloud && nativeAws ? { nativeAws } : {}),
      ...(cloud && nativeGcp ? { nativeGcp } : {}),
      // Said only on Google Cloud, so a Service elsewhere fingerprints as
      // before.
      ...(cloud
        ? byCloud<{ hasDomain?: boolean }>(cloudOrLegacy(cloudKind), {
            aws: {},
            gcp: { hasDomain },
          })
        : {}),
      // An upload's build path only on an upload, so every other
      // Application fingerprints as before.
      settings:
        settings.sourceType === 'drop'
          ? { ...settings, dropBuildPath }
          : settings,
      variables: {
        env: keysOf(env),
        buildArgs: keysOf(buildArgs),
        buildSecrets: keysOf(buildSecrets),
      },
    });
  }
  for (const {
    serviceId,
    name,
    configName,
    env,
    serverId,
    configLinks,
    cloudAccountId,
    region,
    instanceClass,
    storageGb,
    maxStorageGb,
    multiAz,
    backupRetentionDays,
    rdsApplied,
    cloudSqlApplied,
    nativeAws,
    nativeGcp,
    rdsEndpoint,
    cloudSqlEndpointSaved,
    applicationStatus,
    cloudKind,
    existingCloudAccountId,
    existingRegion,
    existingIdentifier,
    existingReachable,
    switchTo,
    switchIdentifier,
    swarm,
    ...settings
  } of postgresRows) {
    const cloud = cloudOrLegacy(cloudKind);
    saved.push({
      serviceType: 'postgres',
      serviceId,
      name,
      configName,
      ...placeAndLinks(serverId, configLinks),
      ...dockerOf(swarm),
      // A switch the next plan makes; absent elsewhere.
      ...(switchTo !== null
        ? { switching: { to: switchTo, identifier: switchIdentifier } }
        : {}),
      // An Existing database; absent elsewhere, so no other
      // Service's fingerprint changes.
      ...(existingCloudAccountId !== null &&
      existingRegion !== null &&
      existingIdentifier !== null
        ? {
            existing: {
              cloudAccountId: existingCloudAccountId,
              region: existingRegion,
              identifier: existingIdentifier,
              madeReachable: existingReachable ?? false,
            },
          }
        : {}),
      // Its cloud's managed instance's place and settings (ADR-0043), absent
      // elsewhere, as on an Application.
      ...(cloudAccountId !== null && region !== null
        ? byCloud<() => PostgresCloudPart>(cloud, {
            // An RDS instance, with Cloudgate's own settings of it,
            // now and as last applied.
            aws: () => ({
              cloud: { cloudAccountId, region, linkedRegistries: [] },
              // Only once an Apply laid one, so one with none
              // fingerprints as before.
              ...(nativeAws ? { nativeAws } : {}),
              rds: {
                instanceClass,
                storageGb,
                maxStorageGb,
                multiAz,
                backupRetentionDays,
                applied: rdsApplied,
                // Run again by the next plan's Apply.
                ...(failedBeforeItsAddress(
                  rdsEndpoint !== null,
                  applicationStatus,
                )
                  ? { unmade: true as const }
                  : {}),
              },
            }),
            // A Cloud SQL instance, its cloud said, so a change is
            // checked against Cloud SQL's rules; RDS's settings are not its
            // own. With its backup retention, now and as last applied.
            gcp: () => ({
              cloud: { cloudAccountId, region, cloud, linkedRegistries: [] },
              // Only once an Apply laid one, as on AWS.
              ...(nativeGcp ? { nativeGcp } : {}),
              cloudSql: {
                backupRetentionDays,
                applied: cloudSqlApplied,
                // The tier it runs on, which a native one taken
                // out with no size stays on.
                ...(instanceClass ? { tier: instanceClass } : {}),
                // Run again by the next plan's Apply (the live walk).
                ...(failedBeforeItsAddress(
                  cloudSqlEndpointSaved,
                  applicationStatus,
                )
                  ? { unmade: true as const }
                  : {}),
              },
            }),
          })()
        : {}),
      settings,
      variables: { env: keysOf(env) },
    });
  }
  for (const {
    serviceId,
    name,
    configName,
    env,
    serverId,
    configLinks,
    cloudAccountId,
    region,
    instanceClass,
    storageGb,
    maxStorageGb,
    multiAz,
    backupRetentionDays,
    rdsApplied,
    nativeAws,
    nativeGcp,
    cloudSqlApplied,
    rdsEndpoint,
    cloudSqlEndpointSaved,
    applicationStatus,
    cloudKind,
    existingCloudAccountId,
    existingRegion,
    existingIdentifier,
    existingReachable,
    switchTo,
    switchIdentifier,
    swarm,
    ...settings
  } of mysqlRows) {
    const cloud = cloudOrLegacy(cloudKind);
    saved.push({
      serviceType: 'mysql',
      serviceId,
      name,
      configName,
      ...placeAndLinks(serverId, configLinks),
      ...dockerOf(swarm),
      // A switch, an Existing database and an RDS instance or a
      // Cloud SQL one, each as a postgres's, and absent elsewhere,
      // so a mysql on a Server fingerprints as before.
      ...(switchTo !== null
        ? { switching: { to: switchTo, identifier: switchIdentifier } }
        : {}),
      ...(existingCloudAccountId !== null &&
      existingRegion !== null &&
      existingIdentifier !== null
        ? {
            existing: {
              cloudAccountId: existingCloudAccountId,
              region: existingRegion,
              identifier: existingIdentifier,
              madeReachable: existingReachable ?? false,
            },
          }
        : {}),
      ...(cloudAccountId !== null && region !== null
        ? byCloud<() => MysqlCloudPart>(cloud, {
            aws: () => ({
              cloud: { cloudAccountId, region, linkedRegistries: [] },
              ...(nativeAws ? { nativeAws } : {}),
              rds: {
                instanceClass,
                storageGb,
                maxStorageGb,
                multiAz,
                backupRetentionDays,
                applied: rdsApplied,
                ...(failedBeforeItsAddress(
                  rdsEndpoint !== null,
                  applicationStatus,
                )
                  ? { unmade: true as const }
                  : {}),
              },
            }),
            // A Cloud SQL for MySQL instance, its cloud said, as a
            // postgres's on Cloud SQL.
            gcp: () => ({
              cloud: { cloudAccountId, region, cloud, linkedRegistries: [] },
              ...(nativeGcp ? { nativeGcp } : {}),
              cloudSql: {
                backupRetentionDays,
                applied: cloudSqlApplied,
                ...(instanceClass ? { tier: instanceClass } : {}),
                ...(failedBeforeItsAddress(
                  cloudSqlEndpointSaved,
                  applicationStatus,
                )
                  ? { unmade: true as const }
                  : {}),
              },
            }),
          })()
        : {}),
      settings,
      variables: { env: keysOf(env) },
    });
  }
  for (const {
    serviceId,
    name,
    configName,
    env,
    serverId,
    configLinks,
    cloudAccountId,
    region,
    nodeType,
    replica,
    snapshotRetentionDays,
    elasticacheApplied,
    nativeAws,
    nativeGcp,
    elasticacheEndpoint,
    memorystoreHighAvailability,
    memorystoreBackupRetentionDays,
    memorystoreApplied,
    memorystoreEngineVersion,
    memorystoreEndpointSaved,
    applicationStatus,
    cloudKind,
    existingCloudAccountId,
    existingRegion,
    existingIdentifier,
    existingReachable,
    switchTo,
    switchIdentifier,
    swarm,
    ...settings
  } of redisRows) {
    const cloud = cloudOrLegacy(cloudKind);
    saved.push({
      serviceType: 'redis',
      serviceId,
      name,
      configName,
      ...placeAndLinks(serverId, configLinks),
      ...dockerOf(swarm),
      // A switch the next plan makes; absent elsewhere.
      ...(switchTo !== null
        ? { switching: { to: switchTo, identifier: switchIdentifier } }
        : {}),
      // An Existing database; absent elsewhere, so no other
      // Service's fingerprint changes.
      ...(existingCloudAccountId !== null &&
      existingRegion !== null &&
      existingIdentifier !== null
        ? {
            existing: {
              cloudAccountId: existingCloudAccountId,
              region: existingRegion,
              identifier: existingIdentifier,
              madeReachable: existingReachable ?? false,
            },
          }
        : {}),
      // Its cloud's managed cache's place and settings (ADR-0043), absent
      // elsewhere.
      ...(cloudAccountId !== null && region !== null
        ? byCloud<() => RedisCloudPart>(cloud, {
            // An ElastiCache replication group, with Cloudgate's own
            // settings of it, now and as last applied.
            aws: () => ({
              cloud: { cloudAccountId, region, linkedRegistries: [] },
              ...(nativeAws ? { nativeAws } : {}),
              elasticache: {
                nodeType,
                replica,
                snapshotRetentionDays,
                applied: elasticacheApplied,
                ...(failedBeforeItsAddress(
                  elasticacheEndpoint !== null,
                  applicationStatus,
                )
                  ? { unmade: true as const }
                  : {}),
              },
            }),
            // A Memorystore instance, its cloud said, so a change is
            // checked against Memorystore's rules; ElastiCache's settings are
            // not its own. With its high availability, now and as last
            // applied, and the engine version it runs.
            gcp: () => ({
              cloud: { cloudAccountId, region, cloud, linkedRegistries: [] },
              ...(nativeGcp ? { nativeGcp } : {}),
              memorystore: {
                highAvailability: memorystoreHighAvailability,
                // Its Backups tab's retention.
                backupRetentionDays: memorystoreBackupRetentionDays,
                applied: memorystoreApplied,
                engineVersion: memorystoreEngineVersion,
                // The node type it runs on, which a native one
                // taken out with no size stays on.
                ...(nodeType ? { nodeType } : {}),
                // Run again by the next plan's Apply (the live walk).
                ...(failedBeforeItsAddress(
                  memorystoreEndpointSaved,
                  applicationStatus,
                )
                  ? { unmade: true as const }
                  : {}),
              },
            }),
          })()
        : {}),
      settings,
      variables: { env: keysOf(env) },
    });
  }
  for (const {
    serviceId,
    name,
    configName,
    serverId,
    cloudAccountId,
    region,
    origins,
    appliedOrigins,
    existing,
    cloudKind,
    labelsSwarm,
    nativeAws,
    ...settings
  } of bucketRows) {
    saved.push({
      serviceType: 'bucket',
      serviceId,
      name,
      configName,
      // A bucket links nothing; its Server is what a link to it is checked
      // against, so a Service on that Server can be planned again.
      ...placeAndLinks(serverId, {}),
      // Its Garage's labels, the one Swarm column a bucket has; the
      // rest of its Garage's Swarm settings are Cloudgate's.
      ...dockerOf({
        labelsSwarm,
        healthCheckSwarm: null,
        restartPolicySwarm: null,
        updateConfigSwarm: null,
        rollbackConfigSwarm: null,
        stopGracePeriodSwarm: null,
        ulimitsSwarm: null,
      }),
      settings,
      variables: { env: [] },
      // An existing bucket: looked up where it is, never made by a
      // Cloud run, so its origins are never a plan's either.
      ...(existing && cloudAccountId !== null && region !== null
        ? {
            existing: {
              cloudAccountId,
              region,
              bucketName: settings.bucketName,
              // On Google Cloud it has its own key.
              ...byCloud(cloudOrLegacy(cloudKind), {
                aws: {},
                gcp: { cloud: 'gcp' as const },
              }),
            },
          }
        : {}),
      // Only on a bucket in a Cloud account, so a Server one's
      // fingerprint is unchanged and its origins are never a plan's. On
      // Google Cloud its cloud is said, so a link to it is read by
      // Google's Outputs, where its key has a value; an AWS one's place reads
      // as it did before Google could be one.
      ...(!existing && cloudAccountId !== null && region !== null
        ? {
            cloud: byCloud(cloudOrLegacy(cloudKind), {
              aws: { cloudAccountId, region, linkedRegistries: [] },
              gcp: {
                cloudAccountId,
                region,
                cloud: 'gcp' as const,
                linkedRegistries: [],
              },
            }),
            cors: { origins, applied: appliedOrigins },
            // Only once an Apply laid one, so a bucket with none
            // fingerprints as before.
            ...(nativeAws ? { nativeAws } : {}),
          }
        : {}),
    });
  }
  saved.push(...others);
  return saved.sort((a, b) => a.configName.localeCompare(b.configName));
}

/**
 * Every Compose stack with the fields a `compose` entry owns (ADR-0069):
 * where its compose file is, its path there and how it is deployed —
 * never the file, its branch or its variables, which are Cloudgate's. A
 * stack on its own Stack VM (ADR-0070) has its cloud place too, and its
 * Stack VM as the plan compares it (#1368): never its instance's ids,
 * which its Cloud run records.
 */
async function readComposeStacks(
  db: SavedSettingsReader,
  environmentId: string,
): Promise<SavedService[]> {
  const rows = await db
    .select({
      serviceId: compose.composeId,
      name: compose.name,
      configName: compose.configName,
      serverId: compose.serverId,
      sourceType: compose.sourceType,
      owner: compose.owner,
      repository: compose.repository,
      gitlabOwner: compose.gitlabOwner,
      gitlabRepository: compose.gitlabRepository,
      gitlabPathNamespace: compose.gitlabPathNamespace,
      giteaOwner: compose.giteaOwner,
      giteaRepository: compose.giteaRepository,
      bitbucketOwner: compose.bitbucketOwner,
      bitbucketRepository: compose.bitbucketRepository,
      customGitUrl: compose.customGitUrl,
      composePath: compose.composePath,
      composeType: compose.composeType,
      cloudAccountId: compose.cloudAccountId,
      region: compose.region,
      stackVm: compose.stackVm,
      cloudKind: cloudAccount.cloud,
    })
    .from(compose)
    .leftJoin(
      cloudAccount,
      eq(cloudAccount.cloudAccountId, compose.cloudAccountId),
    )
    .where(eq(compose.environmentId, environmentId));
  return rows.map(
    ({
      serviceId,
      name,
      configName,
      serverId,
      cloudAccountId,
      region,
      stackVm,
      cloudKind,
      ...settings
    }): SavedService => ({
      serviceType: 'compose',
      serviceId,
      name,
      configName,
      // A stack links nothing and is linked by nothing; its Server is
      // where it runs, which its plan never moves.
      ...placeAndLinks(serverId, {}),
      settings,
      // The config names none of a stack's variables.
      variables: { env: [] },
      // Its own Stack VM in a Cloud account (ADR-0070), which holds the
      // Environment network and whose destroy keeps a final snapshot; and
      // what its plan compares it by (#1368): what its last Apply wrote,
      // what the console asks and the pins it was made with.
      ...(cloudAccountId && region && stackVm
        ? {
            stackVm: savedStackVm(
              { cloudAccountId, region, cloud: cloudOrLegacy(cloudKind) },
              stackVm,
            ),
          }
        : {}),
    }),
  );
}

/** A stack's Stack VM as its row keeps it, read for a plan. */
export function savedStackVm(
  place: { cloudAccountId: string; region: string; cloud: CloudKind },
  stackVm: StackVmSettings,
): SavedStackVm {
  return {
    ...place,
    made: stackVm.made !== null,
    machineType: stackVm.machineType,
    dataDiskGb: stackVm.dataDiskGb,
    consoleSize: stackVm.console?.sizeName ?? null,
    consoleDataDiskGb: stackVm.console?.dataDiskGb ?? null,
    sizeName: stackVm.sizeName,
    snapshotDays: stackVm.snapshotDays,
    ...(stackVm.native ? { native: stackVm.native } : {}),
    ...(stackVm.nativeGcp ? { nativeGcp: stackVm.nativeGcp } : {}),
    pins: stackVm.made?.pins ?? null,
  };
}

const UNEXPRESSIBLE = serviceTypeEnum.enumValues.filter(
  (serviceType): serviceType is Exclude<ServiceType, ExpressibleServiceType> =>
    !isExpressibleServiceType(serviceType),
);

/** The kinds version 1 cannot describe: only who they are, never settings. */
async function readUnexpressible(
  db: SavedSettingsReader,
  environmentId: string,
): Promise<SavedService[]> {
  const perKind = await Promise.all(
    UNEXPRESSIBLE.map(async (serviceType) => {
      const source = SERVICE_SOURCES[serviceType];
      const rows = (await db
        .select({
          serviceId: source.id,
          name: source.name,
          configName: source.configName,
        })
        .from(source.table)
        .where(eq(source.environmentId, environmentId))) as {
        serviceId: string;
        name: string;
        configName: string;
      }[];
      return rows.map((row): SavedService => ({
        serviceType,
        ...row,
      }));
    }),
  );
  return perKind.flat();
}

/** The names of the Registries a cloud Service links, which its plan refuses. */
async function readRegistryNames(
  db: SavedSettingsReader,
  registryIds: readonly string[],
): Promise<Map<string, string>> {
  if (registryIds.length === 0) return new Map();
  const rows = await db
    .select({ registryId: registry.registryId, name: registry.name })
    .from(registry)
    .where(inArray(registry.registryId, [...new Set(registryIds)]));
  return new Map(rows.map((row) => [row.registryId, row.name]));
}

/**
 * Whether a cloud database's Cloud run failed before Cloudgate saved where
 * it answers — an RDS or Cloud SQL instance, an ElastiCache or Memorystore
 * cache — so it is `unmade`: only a plan's Apply runs it again, and a
 * linked deploy fails saying so. One still being made (no address, not
 * failed) is not.
 */
function failedBeforeItsAddress(
  addressSaved: boolean,
  applicationStatus: string | null,
): boolean {
  return !addressSaved && applicationStatus === 'error';
}

/**
 * The Server a Service runs on and the links it last applied, each
 * only when it has one. Both are in the fingerprint, so a plan made before
 * either moved is stale.
 */
function placeAndLinks(
  serverId: string | null,
  links: ConfigLinks,
): { serverId?: string; links?: ConfigLinks } {
  return {
    ...(serverId === null ? {} : { serverId }),
    ...(Object.keys(links).length > 0 ? { links } : {}),
  };
}

/** The seven Swarm columns `native.docker` owns, on any table that has them. */
function swarmColumnsOf(
  table: typeof application | typeof postgres | typeof mysql | typeof redis,
) {
  return {
    labelsSwarm: table.labelsSwarm,
    healthCheckSwarm: table.healthCheckSwarm,
    restartPolicySwarm: table.restartPolicySwarm,
    updateConfigSwarm: table.updateConfigSwarm,
    rollbackConfigSwarm: table.rollbackConfigSwarm,
    stopGracePeriodSwarm: table.stopGracePeriodSwarm,
    ulimitsSwarm: table.ulimitsSwarm,
  };
}

/**
 * A Service's stored Swarm settings for the plan to compare, only
 * when one is set, so a Service with none fingerprints as before.
 */
function dockerOf(swarm: Parameters<typeof storedDockerSettings>[0]): {
  docker?: NonNullable<ReturnType<typeof storedDockerSettings>>;
} {
  const docker = storedDockerSettings(swarm);
  return docker === undefined ? {} : { docker };
}

/** A dotenv blob's keys, in the order it holds them (dotenv's own reading). */
function keysOf(blob: string | null): string[] {
  return blob ? Object.keys(parseDotenv(blob)) : [];
}

/**
 * A fingerprint of what a plan compared with: the saved settings (variable
 * keys, never values) and the Deploy target. An Apply recomputes it
 * and refuses a plan whose fingerprint has moved on (US23).
 */
export function settingsFingerprint(
  saved: readonly SavedService[],
  deployTarget: DeployTarget,
): string {
  const digest = createHash('sha256')
    .update(canonicalJson({ deployTarget, saved }))
    .digest('hex');
  return `sha256:${digest}`;
}

/** `sha256:<hex>` of a Cloudgate-kept config's text, as a plan records it. */
export function textHash(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(
          Object.entries(inner as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : inner,
  );
}
