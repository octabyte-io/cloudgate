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

// Create input: connection identity plus sqld topology — a replica must name
// its primary, and only a replica may.
export const createLibsqlSchema = z
  .object({
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
    sqldNode: z.enum(['primary', 'replica']).optional(),
    sqldPrimaryUrl: z.string().nullable().optional(),
    enableNamespaces: z.boolean().optional(),
    dockerImage: databaseImageSchema.optional(),
    description: z.string().optional(),
    environmentId: z.string().min(1, 'environmentId cannot be empty'),
    // `.nullish()`, not `.optional()`: a row on the platform host carries
    // `serverId: null`, so `null` is the value a client reads off the resource
    // and sends back — ADR-0008's "no server row" contract. `.optional()`
    // answered 400 to the API's own output; widening keeps every payload that
    // was already accepted.
    serverId: z.string().nullish(),
  })
  .superRefine((data, ctx) => {
    if (data.sqldNode === 'replica' && !data.sqldPrimaryUrl) {
      ctx.addIssue({
        code: 'custom',
        path: ['sqldPrimaryUrl'],
        message: "sqldPrimaryUrl is required when sqldNode is 'replica'.",
      });
    }
    if (data.sqldNode !== 'replica' && data.sqldPrimaryUrl) {
      ctx.addIssue({
        code: 'custom',
        path: ['sqldPrimaryUrl'],
        message:
          "sqldPrimaryUrl should not be provided when sqldNode is not 'replica'.",
      });
    }
  });

export class CreateLibsqlDto extends createZodDto(createLibsqlSchema) {}

// Update input, without appName (immutable — it names the service and volume),
// environmentId (databases don't move environments) and applicationStatus (that
// goes through changeStatus / the lifecycle). Nor args or ulimitsSwarm: the
// table keeps those columns only so the shared base's spec source stays
// uniform, and the update surface does not expose them.
export const updateLibsqlSchema = z
  .object({
    name: serviceNameSchema,
    description: z.string().nullable(),
    databaseUser: z.string().min(1),
    databasePassword: z
      .string()
      .regex(DATABASE_PASSWORD_REGEX, DATABASE_PASSWORD_MESSAGE),
    sqldNode: z.enum(['primary', 'replica']),
    sqldPrimaryUrl: z.string().nullable(),
    enableNamespaces: z.boolean(),
    dockerImage: databaseImageSchema,
    command: z.string().nullable(),
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
  })
  .partial();

export class UpdateLibsqlDto extends createZodDto(updateLibsqlSchema) {}

export const saveLibsqlEnvironmentSchema = z.object({
  // `databaseEnvSchema` refuses two sets of names for two different reasons —
  // the `CG_` holders wholesale, and this engine's own derived names,
  // which are refused here *and* overridden at the deploy. It argues
  // both and names the alternatives each rejects.
  env: databaseEnvSchema('libsql'),
});

export class SaveLibsqlEnvironmentDto extends createZodDto(
  saveLibsqlEnvironmentSchema,
) {}

export const changeLibsqlStatusSchema = z.object({
  applicationStatus: z.enum(applicationStatusEnum.enumValues),
});

export class ChangeLibsqlStatusDto extends createZodDto(
  changeLibsqlStatusSchema,
) {}

// sqld exposes http, grpc and admin listeners, each published independently.
// Every key is required — an empty body is a mistake, not an instruction — but
// null is a valid value for all three at once: that is how a database is closed
// back to publishing nothing, the same way the single-port engines unpublish on
// null.
export const saveLibsqlExternalPortsSchema = z.object({
  externalPort: z.number().int().min(1).max(65535).nullable(),
  externalGRPCPort: z.number().int().min(1).max(65535).nullable(),
  externalAdminPort: z.number().int().min(1).max(65535).nullable(),
});

export class SaveLibsqlExternalPortsDto extends createZodDto(
  saveLibsqlExternalPortsSchema,
) {}
