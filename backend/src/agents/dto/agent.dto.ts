import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { memberEntitlementsSchema } from '../../organizations/dto/update-member-entitlements.dto';
import { AGENT_ROLES } from '../../rbac/access-control';
import {
  CALLER_RUNTIME_LOGS_REFUSAL,
  roleMayReadRuntimeLogs,
} from '../../rbac/member-role';
import {
  AGENT_KEY_EXPIRY_DAYS,
  DEFAULT_AGENT_KEY_EXPIRY_DAYS,
} from '../agent-key';

/**
 * `POST /agents` — everything the create modal asks for in one request:
 * a name, a role, a grant, and the first key's expiry.
 *
 * - **`role`** is one of the agent roles and defaults to Reader. Nothing
 *   else is accepted here, so the one writer of `member.role` is never asked
 *   to refuse an Agent's first role.
 * - **`grant`** is the Member entitlement shape, the same three columns
 *   Manage access writes, and every key defaults to empty: an Agent saved with
 *   nothing granted is a deliberate state ("Reaches nothing yet"), not a
 *   broken one.
 * - **`keyExpiresInDays`** is 30, 90 or 365 and defaults to 90. There is
 *   deliberately no "never".
 * - **`canReadRuntimeLogs`** is the Agent's switch (ADR-0095), off unless
 *   asked for, and refused on a Caller, which never holds it.
 *
 * No `organizationId`: the Agent lands in the caller's active Organization,
 * resolved from the session, for the reason `InviteMemberDto` gives.
 */
/** One of the three key lifetimes, in days, defaulting to 90. */
const agentKeyExpiry = z
  .union(AGENT_KEY_EXPIRY_DAYS.map((days) => z.literal(days)))
  .default(DEFAULT_AGENT_KEY_EXPIRY_DAYS);

export const createAgentSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'name cannot be empty')
      .max(64, 'name is at most 64 characters'),
    role: z.enum(AGENT_ROLES).default('agentReader'),
    grant: memberEntitlementsSchema.partial().default({}),
    keyExpiresInDays: agentKeyExpiry,
    canReadRuntimeLogs: z.boolean().default(false),
  })
  .refine(
    (body) => !body.canReadRuntimeLogs || roleMayReadRuntimeLogs(body.role),
    {
      path: ['canReadRuntimeLogs'],
      message: CALLER_RUNTIME_LOGS_REFUSAL,
    },
  );

export class CreateAgentDto extends createZodDto(createAgentSchema) {}

/**
 * `POST /agents/:id/keys` — another key for an existing Agent. The
 * same three lifetimes as the first key, and the same default, for the same
 * reason: an Agent key always expires. Recovery and rotation are both
 * this, then Revoke on the old key.
 */
export const addAgentKeySchema = z.object({
  expiresInDays: agentKeyExpiry,
});

export class AddAgentKeyDto extends createZodDto(addAgentKeySchema) {}

/**
 * `PATCH /agents/:id` — the one thing about an Agent that is neither its
 * role, its grant nor its keys: **Can read runtime logs** (ADR-0095), on or
 * off. Required, so an empty body is a 400 rather than a write of nothing.
 */
export const updateAgentSchema = z
  .object({ canReadRuntimeLogs: z.boolean() })
  .strict();

export class UpdateAgentDto extends createZodDto(updateAgentSchema) {}
