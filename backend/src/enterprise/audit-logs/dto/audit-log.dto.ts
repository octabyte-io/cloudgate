import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  AUDIT_ACTIONS,
  AUDIT_OUTCOMES,
  AUDIT_RESOURCE_TYPES,
} from '../audit-log.schema';

/**
 * The actors the trail can be narrowed to by kind. Only the platform
 * today: a person or an Agent is found by address or by `userId`, and the
 * platform has neither.
 */
export const AUDIT_ACTORS = ['platform'] as const;

export type AuditActorKind = (typeof AUDIT_ACTORS)[number];

/** The two trails a caller can read. */
export const AUDIT_SCOPES = ['organization', 'deleted-organizations'] as const;

// The trail's filters. The enums accept every action/resource type the trail
// can hold, so any entry it records — organization events, start/stop/move
// included — can be filtered for, and the values arrive as query strings so
// they are coerced.
export const listAuditLogsSchema = z.object({
  // Which trail: the active Organization's, or the entries whose
  // Organization has since been deleted — those take instance authority, see
  // AuditLogService.findTrail.
  scope: z.enum(AUDIT_SCOPES).default('organization'),
  userId: z.string().optional(),
  userEmail: z.string().optional(),
  resourceName: z.string().optional(),
  action: z.enum(AUDIT_ACTIONS).optional(),
  resourceType: z.enum(AUDIT_RESOURCE_TYPES).optional(),
  // How the call ended: the console's Outcome filter.
  outcome: z.enum(AUDIT_OUTCOMES).optional(),
  // What kind of actor wrote the row: `platform` selects the rows the
  // platform wrote with no caller (`platform-actor.ts`), which have no email
  // for the text filter to find.
  actor: z.enum(AUDIT_ACTORS).optional(),
  // A string first, then coerced. `z.coerce.date()` on its own says the
  // input *is* a Date, which is not a JSON type — the OpenAPI generator
  // refuses to emit it and takes the whole document down with it. Naming the
  // string that actually arrives on the query costs nothing at run time (a
  // query value is always a string, and an unparseable one is rejected either
  // way) and is what the wire really carries.
  from: z.string().pipe(z.coerce.date()).optional(),
  to: z.string().pipe(z.coerce.date()).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export class ListAuditLogsDto extends createZodDto(listAuditLogsSchema) {}
