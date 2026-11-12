import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { serviceNameSchema } from '../../../common/service-name';
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
import {
  createExistingPostgresSchema,
  savePostgresCloudSqlSettingsSchema,
  savePostgresRdsSettingsSchema,
  switchToExistingPostgresSchema,
  updateExistingPostgresSchema,
} from '../../postgres/dto/postgres.dto';

// Create input: connection identity plus placement — everything else is
// configured through update. Omitted passwords (user and root) are generated
// server-side.
export const createMysqlSchema = z.object({
  name: serviceNameSchema,
  appName: z
    .string()
    .min(1)
    .max(63)
    .regex(APP_NAME_REGEX, APP_NAME_MESSAGE)
    .optional(),
  databaseName: databaseIdentifierSchema('mysql', 'databaseName'),
  databaseUser: databaseIdentifierSchema('mysql', 'databaseUser'),
  databasePassword: z
    .string()
    .regex(DATABASE_PASSWORD_REGEX, DATABASE_PASSWORD_MESSAGE)
    .optional(),
  databaseRootPassword: z
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

export class CreateMysqlDto extends createZodDto(createMysqlSchema) {}

// Update input, without appName (immutable — it names the service and volume),
// environmentId (databases don't move environments) and applicationStatus (that
// goes through changeStatus / the lifecycle).
export const updateMysqlSchema = z
  .object({
    name: serviceNameSchema,
    description: z.string().nullable(),
    databaseName: z.string().min(1),
    databaseUser: z.string().min(1),
    databasePassword: z
      .string()
      .regex(DATABASE_PASSWORD_REGEX, DATABASE_PASSWORD_MESSAGE),
    databaseRootPassword: z
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

export class UpdateMysqlDto extends createZodDto(updateMysqlSchema) {}

export const saveMysqlEnvironmentSchema = z.object({
  // `databaseEnvSchema` refuses two sets of names for two different reasons —
  // the `CG_` holders wholesale, and this engine's own derived names,
  // which are refused here *and* overridden at the deploy. It argues
  // both and names the alternatives each rejects.
  env: databaseEnvSchema('mysql'),
});

export class SaveMysqlEnvironmentDto extends createZodDto(
  saveMysqlEnvironmentSchema,
) {}

export const changeMysqlStatusSchema = z.object({
  applicationStatus: z.enum(applicationStatusEnum.enumValues),
});

export class ChangeMysqlStatusDto extends createZodDto(
  changeMysqlStatusSchema,
) {}

// Null unpublishes the port.
export const saveMysqlExternalPortSchema = z.object({
  externalPort: z.number().int().min(1).max(65535).nullable(),
});

export class SaveMysqlExternalPortDto extends createZodDto(
  saveMysqlExternalPortSchema,
) {}

/**
 * A mysql on RDS takes what a postgres on RDS takes, under its own
 * names, so the OpenAPI document keeps one component per route: its RDS
 * settings, "Use an existing database", its switch and
 * an Existing database's edits.
 */
export class SaveMysqlRdsSettingsDto extends createZodDto(
  savePostgresRdsSettingsSchema,
) {}

/** A mysql on Cloud SQL's backup retention, as a postgres's. */
export class SaveMysqlCloudSqlSettingsDto extends createZodDto(
  savePostgresCloudSqlSettingsSchema,
) {}

export class CreateExistingMysqlDto extends createZodDto(
  createExistingPostgresSchema,
) {}

export class SwitchToExistingMysqlDto extends createZodDto(
  switchToExistingPostgresSchema,
) {}

export class UpdateExistingMysqlDto extends createZodDto(
  updateExistingPostgresSchema,
) {}
