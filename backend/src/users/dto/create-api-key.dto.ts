import { createZodDto } from 'nestjs-zod';
import { PERSONAL_KEY_NAME_MAX_LENGTH } from 'api-schemas';
import { z } from 'zod';

export const createApiKeySchema = z.object({
  name: z.string().min(1, 'name is required').max(PERSONAL_KEY_NAME_MAX_LENGTH),
  prefix: z.string().max(64).optional(),
  /** Seconds until the key expires; omit for a non-expiring key. */
  expiresIn: z.number().int().positive().optional(),
});

export class CreateApiKeyDto extends createZodDto(createApiKeySchema) {}
