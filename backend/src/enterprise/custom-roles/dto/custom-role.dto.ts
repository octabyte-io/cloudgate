import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { AGENT_ROLES } from '../../../rbac/access-control';
import { PLATFORM_ACTOR_ROLE } from '../../audit-logs/platform-actor';

// The grant map is validated structurally here and semantically in the service
// (resource and action names are checked against the access-control
// statements).
const permissionsSchema = z.record(z.string(), z.array(z.string()));

/**
 * A custom role may not take a built-in role's name. The agent roles are
 * built-in too: a custom role called `agentReader` would be shadowed by
 * the static one in `PermissionService.resolveRole`, and renaming one onto it
 * would move its holders — people — onto a role only an Agent may hold, which
 * `member-role.ts` refuses in any case.
 */
const RESERVED_ROLE_NAMES = [
  'owner',
  'admin',
  'member',
  ...AGENT_ROLES,
  // The platform's audit role: no Member may hold it, so no role may
  // be named it. `platform-actor.ts` says why.
  PLATFORM_ACTOR_ROLE,
];

const roleNameSchema = z
  .string()
  .min(1)
  .max(50)
  .refine(
    (name) => !RESERVED_ROLE_NAMES.includes(name),
    `Cannot use reserved role names (${RESERVED_ROLE_NAMES.join(', ')})`,
  )
  // better-auth reads a role string as a comma-separated list
  // (`plugins/organization/permission.mjs`), and Cloudgate's delegating member,
  // invitation and team routes run its check: `ops,admin` would be an admin
  // there and `x,owner` an owner.
  .refine((name) => !name.includes(','), 'A role name cannot contain a comma');

export const createCustomRoleSchema = z.object({
  roleName: roleNameSchema,
  permissions: permissionsSchema,
});

export class CreateCustomRoleDto extends createZodDto(createCustomRoleSchema) {}

// The role being updated arrives in the path; `newRoleName` renames it.
export const updateCustomRoleSchema = z.object({
  newRoleName: roleNameSchema.optional(),
  permissions: permissionsSchema,
});

export class UpdateCustomRoleDto extends createZodDto(updateCustomRoleSchema) {}
