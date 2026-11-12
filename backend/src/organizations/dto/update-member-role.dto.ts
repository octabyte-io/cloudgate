import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// Any role name: the static admin/member, or a custom role defined in the
// organization, which the service resolves. The owner role is non-transferable, which the service rejects —
// that is a rule about the target, not a malformed request.
export const updateMemberRoleSchema = z.object({
  role: z.string().min(1).max(50),
});

export class UpdateMemberRoleDto extends createZodDto(updateMemberRoleSchema) {}
