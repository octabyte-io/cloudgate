import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const createApiKeySchema = z.object({
  name: z.string().min(1, 'name is required').max(255),
  prefix: z.string().max(64).optional(),
  /** Seconds until the key expires; omit for a non-expiring key. */
  expiresIn: z.number().int().positive().optional(),
});

export class CreateApiKeyDto extends createZodDto(createApiKeySchema) {}
