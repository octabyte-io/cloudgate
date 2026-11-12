import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { serviceNameSchema } from '../../../common/service-name';
import { backupRetentionDaysField } from '../../common/backup-retention';
import { MEMORYSTORE_BACKUP_RETENTION } from '../../../cloud-accounts/gcp/definitions/memorystore-definition';
import { parseValkeyName } from '../../../cloud-accounts/gcp/plan-reader/existing-valkey';
import {
  endpointSpecSwarmSchema,
  healthCheckSwarmSchema,
  labelsSwarmSchema,
  networkSwarmSchema,
  placementSwarmSchema,
  restartPolicySwarmSchema,
  serviceModeSwarmSchema,
  ulimitsSwarmSchema,
} from '../../../applications/swarm.types';
import { applicationStatusEnum } from '../../../applications/application.schema';
import { APP_NAME_MESSAGE, APP_NAME_REGEX } from '../../../db/columns';
import {
  DATABASE_PASSWORD_MESSAGE,
  DATABASE_PASSWORD_REGEX,
  databaseImageSchema,
  databaseUpdateConfigSwarmSchema,
} from '../../common/database.constants';
import { databaseEnvSchema } from '../../common/reserved-env';
import { CONFIG_NAME_REGEX } from '../../../project-config/format/config-schema';

// Create input: no database name or user — the password is the whole connection
// identity. The password is still held to the password regex, and now
// for a weaker reason than the one that was written here. It said "because the
// password lands inside the requirepass entrypoint", and it no longer does:
// `RedisService.containerCommand` emits `--requirepass "$CG_REDIS_REQUIREPASS"`
// and the value reaches the container through the service spec's `Env`, so no
// shell ever parses it. The charset stays as the belt-and-braces
// `builders/build-strategy.ts` asks every charset in this tree to be — behind
// the mechanism, never in place of it — and it is still load-bearing for the
// *other* engines, whose commands this same regex guards.
export const createRedisSchema = z.object({
  name: serviceNameSchema,
  appName: z
    .string()
    .min(1)
    .max(63)
    .regex(APP_NAME_REGEX, APP_NAME_MESSAGE)
    .optional(),
  databasePassword: z
    .string()
    .regex(DATABASE_PASSWORD_REGEX, DATABASE_PASSWORD_MESSAGE)
    .optional(),
  dockerImage: databaseImageSchema.optional(),
  description: z.string().optional(),
  environmentId: z.string().min(1, 'environmentId cannot be empty'),
  // `.nullish()`, not `.optional()`: a row on the platform host carries
  // `serverId: null`, so `null` is the value a client reads off the resource
  // and sends back — ADR-0008's "no server row" contract. `.optional()`
  // answered 400 to the API's own output; widening keeps every payload that
  // was already accepted.
  serverId: z.string().nullish(),
});

export class CreateRedisDto extends createZodDto(createRedisSchema) {}

// Update input, without appName (immutable — it names the service and volume),
// environmentId (databases don't move environments) and applicationStatus (that
// goes through changeStatus / the lifecycle).
export const updateRedisSchema = z
  .object({
    name: serviceNameSchema,
    description: z.string().nullable(),
    databasePassword: z
      .string()
      .regex(DATABASE_PASSWORD_REGEX, DATABASE_PASSWORD_MESSAGE),
    dockerImage: databaseImageSchema,
    command: z.string().nullable(),
    args: z.array(z.string()).nullable(),
    memoryReservation: z.string().nullable(),
    memoryLimit: z.string().nullable(),
    cpuReservation: z.string().nullable(),
    cpuLimit: z.string().nullable(),
    replicas: z.number().int().min(0),
    // Swarm overrides
    healthCheckSwarm: healthCheckSwarmSchema.nullable(),
    restartPolicySwarm: restartPolicySwarmSchema.nullable(),
    placementSwarm: placementSwarmSchema.nullable(),
    updateConfigSwarm: databaseUpdateConfigSwarmSchema.nullable(),
    rollbackConfigSwarm: databaseUpdateConfigSwarmSchema.nullable(),
    modeSwarm: serviceModeSwarmSchema.nullable(),
    labelsSwarm: labelsSwarmSchema.nullable(),
    networkSwarm: networkSwarmSchema.nullable(),
    stopGracePeriodSwarm: z.number().nullable(),
    endpointSpecSwarm: endpointSpecSwarmSchema.nullable(),
    ulimitsSwarm: ulimitsSwarmSchema.nullable(),
  })
  .partial();

export class UpdateRedisDto extends createZodDto(updateRedisSchema) {}

export const saveRedisEnvironmentSchema = z.object({
  // `databaseEnvSchema` refuses two sets of names for two different reasons —
  // the `CG_` holders wholesale, and this engine's own derived names,
  // which are refused here *and* overridden at the deploy. It argues
  // both and names the alternatives each rejects.
  env: databaseEnvSchema('redis'),
});

export class SaveRedisEnvironmentDto extends createZodDto(
  saveRedisEnvironmentSchema,
) {}

export const changeRedisStatusSchema = z.object({
  applicationStatus: z.enum(applicationStatusEnum.enumValues),
});

export class ChangeRedisStatusDto extends createZodDto(
  changeRedisStatusSchema,
) {}

// Null unpublishes the port.
export const saveRedisExternalPortSchema = z.object({
  externalPort: z.number().int().min(1).max(65535).nullable(),
});

export class SaveRedisExternalPortDto extends createZodDto(
  saveRedisExternalPortSchema,
) {}

/**
 * Cloudgate's own settings of a redis on ElastiCache (spec
 * "Schema changes"), edited on its cloud Database page and never in the
 * config: the node type (only for an entry with no size), one replica in
 * another zone with automatic failover, and how many days daily snapshots
 * are kept, 0 to 35, 0 turning them off. Each is applied by the next plan's
 * Apply.
 */
export const saveRedisElastiCacheSettingsSchema = z
  .object({
    nodeType: z.string().min(1, 'nodeType cannot be empty'),
    replica: z.boolean(),
    snapshotRetentionDays: z
      .number()
      .int('snapshotRetentionDays must be a whole number of days')
      .min(
        0,
        'snapshotRetentionDays must be 0 to 35: 0 turns daily snapshots off',
      )
      .max(
        35,
        'snapshotRetentionDays must be 0 to 35: ElastiCache keeps daily snapshots at most 35 days',
      ),
  })
  .partial()
  .strict();

export class SaveRedisElastiCacheSettingsDto extends createZodDto(
  saveRedisElastiCacheSettingsSchema,
) {}

/**
 * Cloudgate's own settings of a redis on Memorystore (spec
 * "Schema changes"), edited on its cloud Database page and never in the
 * config: high availability, one replica in another zone, which doubles the
 * node cost; and, from its Backups tab, how many days each daily
 * automated backup is kept, 0 (off) to 365. Each is applied by the next
 * plan's Apply; a save names at least one.
 */
export const saveRedisMemorystoreSettingsSchema = z
  .object({
    highAvailability: z.boolean(),
    backupRetentionDays: backupRetentionDaysField(
      MEMORYSTORE_BACKUP_RETENTION,
      {
        belowMin:
          'backupRetentionDays must be 0 to 365: 0 turns daily backups off',
        aboveMax:
          'backupRetentionDays must be 0 to 365: Memorystore keeps a backup 365 days at most',
      },
    ),
  })
  .partial()
  .strict()
  .refine((body) => Object.keys(body).length > 0, {
    message: 'Name a setting to save: highAvailability or backupRetentionDays',
  });

export class SaveRedisMemorystoreSettingsDto extends createZodDto(
  saveRedisMemorystoreSettingsSchema,
) {}

/** An ElastiCache replication group id, as ElastiCache takes one. */
export const REPLICATION_GROUP_ID_REGEX =
  /^[a-zA-Z](?!.*--)[a-zA-Z0-9-]{0,39}(?<!-)$/;

/**
 * An ElastiCache AUTH token, as ElastiCache takes one: 16 to 128 printable
 * characters, none of them a space, `"`, `/` or `@`. Empty means the cache
 * has none (one with TLS off cannot have one).
 */
const AUTH_TOKEN_REGEX = /^[!#-.0-?A-~]{16,128}$/;

const existingCacheFields = {
  /**
   * The replication group's id (`acme-cache`), node-based, cluster mode off;
   * or on Google Cloud the Memorystore for Valkey instance's name
   * (`shop-prod/europe-west1/orders-cache`). Which one the
   * Environment's Cloud account takes is the service's to check: the body
   * does not say the cloud.
   */
  identifier: z
    .string()
    .refine(
      (value) =>
        REPLICATION_GROUP_ID_REGEX.test(value) ||
        parseValkeyName(value) !== null,
      'identifier must be an ElastiCache replication group id (1 to 40 letters, digits and hyphens, starting with a letter) or, on Google Cloud, a Memorystore instance name (project/region/instance)',
    ),
  /** Its AUTH token: stored encrypted and only ever read back as set. */
  authToken: z
    .string()
    .regex(
      AUTH_TOKEN_REGEX,
      'authToken must be an ElastiCache AUTH token: 16 to 128 printable characters, none of them a space, ", / or @',
    )
    .or(z.literal('')),
  /** TLS on (`rediss://`, with a `ca`) or off (`redis://`). */
  tls: z.boolean(),
  /** "I made it reachable from this Environment": Cloudgate cannot check it. */
  madeReachable: z.boolean(),
};

/**
 * "Use an existing database" for a `redis` (ADR-0033): an
 * Environment's `redis` entry stands for an ElastiCache replication group
 * the operator already has. `configName` is the entry's, typically from the
 * plan row that would create it; the Project config is not changed.
 */
export const createExistingRedisSchema = z
  .object({
    environmentId: z.string().min(1, 'environmentId cannot be empty'),
    configName: z
      .string()
      .regex(
        CONFIG_NAME_REGEX,
        'configName must be a Config name: lowercase letters, digits and hyphens, starting with a letter',
      ),
    identifier: existingCacheFields.identifier,
    authToken: existingCacheFields.authToken.default(''),
    tls: existingCacheFields.tls.default(true),
    madeReachable: existingCacheFields.madeReachable.default(false),
  })
  .strict();

export class CreateExistingRedisDto extends createZodDto(
  createExistingRedisSchema,
) {}

/**
 * A switch of a Cloudgate-made redis to an existing cache
 * (ADR-0033): what "Use an existing cache" takes, for the Service's own
 * Environment and Config name. Applied by the next plan, which removes one
 * Service and adds the other.
 */
export const switchToExistingRedisSchema = createExistingRedisSchema
  .omit({ environmentId: true, configName: true })
  .strict();

export class SwitchToExistingRedisDto extends createZodDto(
  switchToExistingRedisSchema,
) {}

/** An Existing cache's id, AUTH token, TLS flag or tick, edited on its page. */
export const updateExistingRedisSchema = z
  .object(existingCacheFields)
  .partial()
  .strict();

export class UpdateExistingRedisDto extends createZodDto(
  updateExistingRedisSchema,
) {}
