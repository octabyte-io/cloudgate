import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * Rebuild from the cloud is confirmed by name: the Service's name, or
 * for an Environment network its Environment's, typed by the operator.
 */
export const rebuildStateSchema = z.object({
  confirmName: z.string().min(1, 'confirmName cannot be empty'),
});

export class RebuildStateDto extends createZodDto(rebuildStateSchema) {}
