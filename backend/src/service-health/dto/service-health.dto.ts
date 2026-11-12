import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { serviceTypeEnum } from '../../applications/application.schema';

/** `GET /service-health/:serviceType/:serviceId`'s path: the Service by kind and id. */
export const serviceHealthParamsSchema = z.object({
  serviceType: z.enum(serviceTypeEnum.enumValues),
  serviceId: z.string().min(1),
});
export class ServiceHealthParamsDto extends createZodDto(
  serviceHealthParamsSchema,
) {}

/**
 * `GET /service-health/:serviceType/:serviceId`'s page of Incident history.
 * Query strings arrive as strings, hence the coercion.
 */
export const serviceHealthQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export class ServiceHealthQueryDto extends createZodDto(
  serviceHealthQuerySchema,
) {}
