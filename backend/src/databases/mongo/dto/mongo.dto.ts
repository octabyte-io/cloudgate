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
  databaseImageSchema,
  databaseUpdateConfigSwarmSchema,
} from '../../common/database.constants';
import { databaseEnvSchema } from '../../common/reserved-env';

// Create input: connection identity plus placement — everything else is
// configured through update. An omitted password is generated server-side.
export const createMongoSchema = z.object({
  name: serviceNameSchema,
  appName: z
    .string()
    .min(1)
    .max(63)
    .regex(APP_NAME_REGEX, APP_NAME_MESSAGE)
    .optional(),
  databaseUser: z.string().min(1, 'databaseUser cannot be empty'),
  databasePassword: z
    .string()
    .regex(DATABASE_PASSWORD_REGEX, DATABASE_PASSWORD_MESSAGE)
    .optional(),
  dockerImage: databaseImageSchema.optional(),
  description: z.string().optional(),
  replicaSets: z.boolean().optional(),
  environmentId: z.string().min(1, 'environmentId cannot be empty'),
  // `.nullish()`, not `.optional()`: a row on the platform host carries
  // `serverId: null`, so `null` is the value a client reads off the resource
  // and sends back — ADR-0008's "no server row" contract. `.optional()`
  // answered 400 to the API's own output; widening keeps every payload that
  // was already accepted.
  serverId: z.string().nullish(),
});

export class CreateMongoDto extends createZodDto(createMongoSchema) {}

// Update input, without appName (immutable — it names the service and volume),
// environmentId (databases don't move environments) and applicationStatus (that
// goes through changeStatus / the lifecycle).
export const updateMongoSchema = z
  .object({
    name: serviceNameSchema,
    description: z.string().nullable(),
    databaseUser: z.string().min(1),
    databasePassword: z
      .string()
      .regex(DATABASE_PASSWORD_REGEX, DATABASE_PASSWORD_MESSAGE),
    dockerImage: databaseImageSchema,
    command: z.string().nullable(),
    args: z.array(z.string()).nullable(),
    replicaSets: z.boolean(),
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

export class UpdateMongoDto extends createZodDto(updateMongoSchema) {}

export const saveMongoEnvironmentSchema = z.object({
  // `databaseEnvSchema` refuses two sets of names for two different reasons —
  // the `CG_` holders wholesale, and this engine's own derived names,
  // which are refused here *and* overridden at the deploy. It argues
  // both and names the alternatives each rejects.
  env: databaseEnvSchema('mongo'),
});

export class SaveMongoEnvironmentDto extends createZodDto(
  saveMongoEnvironmentSchema,
) {}

export const changeMongoStatusSchema = z.object({
  applicationStatus: z.enum(applicationStatusEnum.enumValues),
});

export class ChangeMongoStatusDto extends createZodDto(
  changeMongoStatusSchema,
) {}

// Null unpublishes the port.
export const saveMongoExternalPortSchema = z.object({
  externalPort: z.number().int().min(1).max(65535).nullable(),
});

export class SaveMongoExternalPortDto extends createZodDto(
  saveMongoExternalPortSchema,
) {}
