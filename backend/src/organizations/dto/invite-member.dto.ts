import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// Any role name: the static admin/member, or a custom role this organization
// has defined, which the service resolves and licence-checks the way it does
// for a role change. Owner is non-delegable — no one can invite as
// owner — and that stays a malformed request rather than a service refusal.
export const inviteMemberSchema = z.object({
  email: z.email('invalid email').max(255),
  role: z
    .string()
    .min(1, 'role is required')
    .max(50, 'role is at most 50 characters')
    .refine((role) => role !== 'owner', 'the owner role cannot be invited'),
  teamId: z.string().optional(),
});

export class InviteMemberDto extends createZodDto(inviteMemberSchema) {}
