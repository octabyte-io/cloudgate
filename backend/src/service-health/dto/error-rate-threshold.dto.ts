import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { serviceTypeEnum } from '../../applications/application.schema';
import { ERROR_RATE_THRESHOLD_WINDOWS } from '../error-rate-threshold.schema';

/**
 * `PUT /error-rate-thresholds/:serviceId?serviceType=` — the whole threshold,
 * created or replaced. Every field has the default the operator is
 * offered, so `{}` is "5 % over 5 minutes, at least 20 requests, on".
 *
 * Turning it off closes its open Incident with `turned-off`; any other edit
 * leaves an open Incident open, and the next collection judges it by the new
 * rule.
 */
export const putErrorRateThresholdSchema = z.object({
  /** A percent: 5 is 5 %. */
  percentage: z.number().min(0.1).max(100).default(5),
  windowMinutes: z
    .number()
    .int()
    .refine(
      (value) =>
        (ERROR_RATE_THRESHOLD_WINDOWS as readonly number[]).includes(value),
      'the window is 1, 5, 15 or 30 minutes',
    )
    .default(5),
  minRequests: z.number().int().min(1).max(1_000_000).default(20),
  enabled: z.boolean().default(true),
});
export class PutErrorRateThresholdDto extends createZodDto(
  putErrorRateThresholdSchema,
) {}

/** The Service a threshold route names, beside its id in the path. */
export const errorRateThresholdServiceSchema = z.object({
  serviceType: z.enum(serviceTypeEnum.enumValues),
});
export class ErrorRateThresholdServiceDto extends createZodDto(
  errorRateThresholdServiceSchema,
) {}
