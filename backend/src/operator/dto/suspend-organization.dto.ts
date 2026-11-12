import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * `POST /operator/organizations/:id/suspension`: the reason the
 * customer is shown on the frozen banner and in the suspension email.
 */
export const suspendOrganizationSchema = z.object({
  reason: z.string().trim().min(1, 'reason cannot be empty').max(500),
});

export class SuspendOrganizationDto extends createZodDto(
  suspendOrganizationSchema,
) {}
