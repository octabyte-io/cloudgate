import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

export const updateProfileSchema = z.object({
  firstName: z.string().min(1, 'firstName cannot be empty').max(255).optional(),
  lastName: z.string().max(255).optional(),
  /**
   * The sign-in email. Stored lower-cased, and changing it is an
   * account-security action: it needs an interactive session and
   * `currentPassword`. Sending the address already stored is not a change and
   * needs neither.
   */
  email: z.email('invalid email').max(255).optional(),
  /**
   * The account's current password. Required when `email` changes, and read
   * for nothing else — the name and avatar are not account security.
   */
  currentPassword: z
    .string()
    .min(1, 'currentPassword cannot be empty')
    .optional(),
  image: z.url('invalid image url').nullable().optional(),
});

export class UpdateProfileDto extends createZodDto(updateProfileSchema) {}
