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

// Create input: connection identity plus placement — everything else is
// configured through update. Omitted passwords (user and root) are generated
// server-side.
export const createMariadbSchema = z.object({
  name: serviceNameSchema,
  appName: z
    .string()
    .min(1)
    .max(63)
    .regex(APP_NAME_REGEX, APP_NAME_MESSAGE)
    .optional(),
  databaseName: databaseIdentifierSchema('mariadb', 'databaseName'),
  databaseUser: databaseIdentifierSchema('mariadb', 'databaseUser'),
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

export class CreateMariadbDto extends createZodDto(createMariadbSchema) {}

// Update input, without appName (immutable — it names the service and volume),
// environmentId (databases don't move environments) and applicationStatus (that
// goes through changeStatus / the lifecycle).
export const updateMariadbSchema = z
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

export class UpdateMariadbDto extends createZodDto(updateMariadbSchema) {}

export const saveMariadbEnvironmentSchema = z.object({
  // `databaseEnvSchema` refuses two sets of names for two different reasons —
  // the `CG_` holders wholesale, and this engine's own derived names,
  // which are refused here *and* overridden at the deploy. It argues
  // both and names the alternatives each rejects.
  env: databaseEnvSchema('mariadb'),
});

export class SaveMariadbEnvironmentDto extends createZodDto(
  saveMariadbEnvironmentSchema,
) {}

export const changeMariadbStatusSchema = z.object({
  applicationStatus: z.enum(applicationStatusEnum.enumValues),
});

export class ChangeMariadbStatusDto extends createZodDto(
  changeMariadbStatusSchema,
) {}

// Null unpublishes the port.
export const saveMariadbExternalPortSchema = z.object({
  externalPort: z.number().int().min(1).max(65535).nullable(),
});

export class SaveMariadbExternalPortDto extends createZodDto(
  saveMariadbExternalPortSchema,
) {}
