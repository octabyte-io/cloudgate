import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { serviceNameSchema } from '../../../common/service-name';
import { backupRetentionDaysField } from '../../common/backup-retention';
import { CLOUD_SQL_BACKUP_RETENTION } from '../../../cloud-accounts/gcp/definitions/cloud-sql-definition';
import { parseConnectionName } from '../../../cloud-accounts/gcp/plan-reader/existing-cloud-sql';
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
  databaseIdentifierSchema,
  databaseImageSchema,
  databaseUpdateConfigSwarmSchema,
} from '../../common/database.constants';
import { databaseEnvSchema } from '../../common/reserved-env';
import { CONFIG_NAME_REGEX } from '../../../project-config/format/config-schema';

// Create input: connection identity plus placement — everything else is
// configured through update. An omitted password is generated server-side.
export const createPostgresSchema = z.object({
  name: serviceNameSchema,
  appName: z
    .string()
    .min(1)
    .max(63)
    .regex(APP_NAME_REGEX, APP_NAME_MESSAGE)
    .optional(),
  databaseName: databaseIdentifierSchema('postgres', 'databaseName'),
  databaseUser: databaseIdentifierSchema('postgres', 'databaseUser'),
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

export class CreatePostgresDto extends createZodDto(createPostgresSchema) {}

// Update input, without appName (immutable — it names the service and volume),
// environmentId (databases don't move environments) and applicationStatus (that
// goes through changeStatus / the lifecycle).
export const updatePostgresSchema = z
  .object({
    name: serviceNameSchema,
    description: z.string().nullable(),
    databaseName: z.string().min(1),
    databaseUser: z.string().min(1),
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

export class UpdatePostgresDto extends createZodDto(updatePostgresSchema) {}

export const savePostgresEnvironmentSchema = z.object({
  // `databaseEnvSchema` refuses two sets of names for two different reasons —
  // the `CG_` holders wholesale, and this engine's own derived names,
  // which are refused here *and* overridden at the deploy. It argues
  // both and names the alternatives each rejects.
  env: databaseEnvSchema('postgres'),
});

export class SavePostgresEnvironmentDto extends createZodDto(
  savePostgresEnvironmentSchema,
) {}

export const changePostgresStatusSchema = z.object({
  applicationStatus: z.enum(applicationStatusEnum.enumValues),
});

export class ChangePostgresStatusDto extends createZodDto(
  changePostgresStatusSchema,
) {}

// Null unpublishes the port.
export const savePostgresExternalPortSchema = z.object({
  externalPort: z.number().int().min(1).max(65535).nullable(),
});

export class SavePostgresExternalPortDto extends createZodDto(
  savePostgresExternalPortSchema,
) {}

/**
 * Cloudgate's own settings of a postgres on RDS (spec "Schema
 * changes"), edited on its cloud Database page and never in the config:
 * the class (only for an entry with no size), storage and the ceiling it
 * grows to (RDS gp3: 20 GB up to 64 TiB), Multi-AZ, and backup retention,
 * 1 to 35 days. 0 would turn RDS's automated backups and point-in-time
 * restore off, which Cloudgate never does. Each is applied by the next
 * plan's Apply.
 */
export const savePostgresRdsSettingsSchema = z
  .object({
    instanceClass: z.string().min(1, 'instanceClass cannot be empty'),
    storageGb: z
      .number()
      .int()
      .min(20, 'storageGb must be at least 20: RDS gp3 storage starts at 20 GB')
      .max(65536, 'storageGb must be at most 65536'),
    maxStorageGb: z
      .number()
      .int()
      .min(20, 'maxStorageGb must be at least 20')
      .max(
        65536,
        'maxStorageGb must be at most 65536: RDS grows gp3 storage to 64 TiB',
      ),
    multiAz: z.boolean(),
    backupRetentionDays: z
      .number()
      .int()
      .min(
        1,
        'backupRetentionDays must be 1 to 35: 0 turns off RDS automated backups and point-in-time restore, which Cloudgate never does',
      )
      .max(
        35,
        'backupRetentionDays must be 1 to 35: RDS keeps automated backups at most 35 days',
      ),
  })
  .partial()
  .strict();

export class SavePostgresRdsSettingsDto extends createZodDto(
  savePostgresRdsSettingsSchema,
) {}

/**
 * Cloudgate's own setting of a postgres on Cloud SQL (spec
 * "Schema changes"), edited on its Backups tab and never in the config:
 * how many daily automated backups it keeps, 1 to 365. 0 would turn
 * automated backups and point-in-time recovery off, which Cloudgate never
 * does. Applied by the next plan's Apply.
 */
export const savePostgresCloudSqlSettingsSchema = z
  .object({
    backupRetentionDays: backupRetentionDaysField(CLOUD_SQL_BACKUP_RETENTION, {
      belowMin:
        'backupRetentionDays must be 1 to 365: 0 turns off Cloud SQL automated backups and point-in-time recovery, which Cloudgate never does',
      aboveMax:
        'backupRetentionDays must be 1 to 365: Cloud SQL keeps 365 automated backups at most',
    }),
  })
  .strict();

export class SavePostgresCloudSqlSettingsDto extends createZodDto(
  savePostgresCloudSqlSettingsSchema,
) {}

/** An RDS DB instance identifier, as RDS takes one. */
export const RDS_IDENTIFIER_REGEX =
  /^[a-zA-Z](?!.*--)[a-zA-Z0-9-]{0,62}(?<!-)$/;

const existingLoginFields = {
  /**
   * The RDS instance's identifier (`acme-prod`), or on Google Cloud the
   * Cloud SQL instance's connection name (`shop-prod:europe-west1:acme-prod`).
   * Which one the Environment's Cloud account takes is the
   * service's to check: the body does not say the cloud.
   */
  identifier: z
    .string()
    .refine(
      (value) =>
        RDS_IDENTIFIER_REGEX.test(value) || parseConnectionName(value) !== null,
      'identifier must be an RDS DB instance identifier (1 to 63 letters, digits and hyphens, starting with a letter) or, on Google Cloud, a Cloud SQL connection name (project:region:instance)',
    ),
  /** The login the apps use, never an admin one (ADR-0033). */
  databaseUser: z.string().min(1, 'databaseUser cannot be empty').max(63),
  databasePassword: z
    .string()
    .min(1, 'databasePassword cannot be empty')
    .max(128),
  databaseName: z.string().min(1, 'databaseName cannot be empty').max(63),
  /** "I made it reachable from this Environment": Cloudgate cannot check it. */
  madeReachable: z.boolean(),
};

/**
 * "Use an existing database" (ADR-0033): an Environment's `postgres`
 * entry stands for an RDS instance the operator already has. `configName`
 * is the entry's, typically from the plan row that would create it; the
 * Project config is not changed.
 */
export const createExistingPostgresSchema = z
  .object({
    environmentId: z.string().min(1, 'environmentId cannot be empty'),
    configName: z
      .string()
      .regex(
        CONFIG_NAME_REGEX,
        'configName must be a Config name: lowercase letters, digits and hyphens, starting with a letter',
      ),
    ...existingLoginFields,
    madeReachable: existingLoginFields.madeReachable.default(false),
  })
  .strict();

export class CreateExistingPostgresDto extends createZodDto(
  createExistingPostgresSchema,
) {}

/**
 * A switch of a Cloudgate-made postgres to an existing database
 * (ADR-0033): what "Use an existing database" takes, for the Service's own
 * Environment and Config name. Applied by the next plan, which removes one
 * Service and adds the other.
 */
export const switchToExistingPostgresSchema = z
  .object({
    ...existingLoginFields,
    madeReachable: existingLoginFields.madeReachable.default(false),
  })
  .strict();

export class SwitchToExistingPostgresDto extends createZodDto(
  switchToExistingPostgresSchema,
) {}

/** An Existing database's login, identifier or tick, edited on its page. */
export const updateExistingPostgresSchema = z
  .object(existingLoginFields)
  .partial()
  .strict();

export class UpdateExistingPostgresDto extends createZodDto(
  updateExistingPostgresSchema,
) {}
