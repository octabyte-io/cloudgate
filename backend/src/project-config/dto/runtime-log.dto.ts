import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * `GET /applications/:id/runtime-log`. `since`: epoch milliseconds,
 * the `next` of the read before; left out, the read opens on the last few
 * minutes.
 */
export const runtimeLogQuerySchema = z.object({
  since: z.coerce.number().int().nonnegative().optional(),
});

export class RuntimeLogQueryDto extends createZodDto(runtimeLogQuerySchema) {}
