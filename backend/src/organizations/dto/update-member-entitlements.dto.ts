import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * A Member's row-level grants — the `accessed*` columns that decide what a
 * non-privileged role may reach at all (CONTEXT.md: a Member carries "a role
 * and the set of projects, environments and services they may reach").
 *
 * Declared in full here and derived below, rather than written twice: the
 * complete set is the shape `PermissionService` reads when it checks, and the
 * PATCH body is that shape with every key optional.
 *
 * The keys are the schema column names rather than a prettier product word
 * because `frontend/src/lib/api/endpoints/organizations.ts` already types the
 * member row with them, so the console reads and writes one vocabulary.
 */
export const memberEntitlementsSchema = z.object({
  accessedProjects: z.array(z.string().min(1)),
  accessedEnvironments: z.array(z.string().min(1)),
  accessedServices: z.array(z.string().min(1)),
});

/**
 * `PATCH /organizations/members/:id/entitlements`.
 *
 * Each key **replaces** that column: an absent key leaves it alone, `[]`
 * clears it. Add-one/remove-one was the alternative and it is the shape that
 * looks concurrency-safe, but it was the shape `PermissionService.grantAccess`
 * had — read the array, write a computed one — which lost a grant made between
 * the read and the write. (That helper has since moved onto SQL
 * `array_append`, so grant-on-create no longer races; the conclusion here is
 * unchanged, because a checkbox grid saving a whole row is a replacement
 * whatever the append does.) Replacement sends no read at all: the
 * set arrives from the caller and lands in one `UPDATE`, so two grants racing
 * leave one of the two sets somebody asked for rather than a set neither did.
 * It is also idempotent, which a permission grid saving a whole row of
 * checkboxes needs.
 *
 * The cost is real and belongs on the caller: a client that PATCHes a stale
 * array silently revokes whatever it did not know about. That is why the route
 * is owner/admin only, and why the console must send back the grid it just
 * read rather than a diff of it.
 *
 * There is deliberately no `organizationId` and no member id in the body — the
 * target comes off the path and the tenant off the resolved session, so
 * nothing a caller sends can move this write into another Organization (the
 * invitation route makes the same argument).
 */
export const updateMemberEntitlementsSchema =
  memberEntitlementsSchema.partial();

export class UpdateMemberEntitlementsDto extends createZodDto(
  updateMemberEntitlementsSchema,
) {}
