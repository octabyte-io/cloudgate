import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { serviceTypeEnum } from '../../applications/application.schema';
import {
  DEFAULT_TRACE_RETENTION_DAYS,
  TRACE_RETENTION_DAYS,
} from '../trace-store.schema';

/**
 * `PUT /traces/:serviceId?serviceType=` — the Service's traces setting, whole:
 * on or off, and how many days its Trace store keeps traces.
 *
 * Turning traces on takes effect on the Service's next deploy. Turning them
 * off removes the store and its traces now. A retention change restarts a
 * running store with the new retention and keeps what it holds; it applies
 * only to traces sent after it.
 */
export const putTracesSchema = z.object({
  enabled: z.boolean(),
  retentionDays: z
    .number()
    .int()
    .refine(
      (value) => (TRACE_RETENTION_DAYS as readonly number[]).includes(value),
      'retention is 1, 3 or 7 days',
    )
    .default(DEFAULT_TRACE_RETENTION_DAYS),
});
export class PutTracesDto extends createZodDto(putTracesSchema) {}

/** The Service a traces route names, beside its id in the path. */
export const tracesServiceSchema = z.object({
  serviceType: z.enum(serviceTypeEnum.enumValues),
});
export class TracesServiceDto extends createZodDto(tracesServiceSchema) {}
