import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * The query of an "Use an existing database" form's reach:
 * the Environment whose Services' security groups it lists.
 */
export const existingReachQuerySchema = z.object({
  environmentId: z.string().min(1, 'environmentId cannot be empty'),
});

export class ExistingReachQueryDto extends createZodDto(
  existingReachQuerySchema,
) {}
