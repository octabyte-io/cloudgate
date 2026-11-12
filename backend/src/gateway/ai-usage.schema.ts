import { relations } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
} from 'drizzle-orm/pg-core';
import { application } from '../applications/application.schema';
import { user } from '../auth/auth.schema';
import { nanoidPk } from '../db/columns';

/**
 * How a call through the Gateway ended:
 *
 * - `ok`: the runtime answered, whatever its status.
 * - `runtime-error`: the runtime could not be reached, or its answer broke off.
 * - `client-aborted`: the caller went away before the answer was whole.
 * - `refused`: the Gateway refused it after authenticating the key (no
 *   `call`, a `model` that is not the one served, a path outside the
 *   allowlist, or an AI model that is not running). Its tokens are zero.
 */
export const aiUsageOutcomeEnum = pgEnum('ai_usage_outcome', [
  'ok',
  'runtime-error',
  'client-aborted',
  'refused',
]);

export type AiUsageOutcome = (typeof aiUsageOutcomeEnum.enumValues)[number];

/**
 * One call through the **Gateway** (`CONTEXT.md` "Token spend", the gateway
 * ADR): written once, when the call settles, and never updated.
 *
 * - **It belongs to the AI model**, not the caller: `applicationId`
 *   cascades, so the rows go with the AI model, and with its Environment and
 *   Project through theirs.
 * - **It outlives the Agent**: `agentUserId` is set null when the
 *   Agent's user is removed, and `agentName` keeps who it was, as text.
 *   `agentId` is the same id as plain text, never nulled, so two removed
 *   Agents that shared a name are still two Agents.
 * - **`apikeyId` is the credential's id, never its secret**, and plain text
 *   rather than a reference, so a revoked key's rows still say which key.
 * - **Never a body**: no prompt, no completion, no header. `model` is the
 *   model served, which the Gateway holds every call to.
 * - **Tokens are each flagged** reported (the runtime said) or estimated.
 *
 * Times are ISO text, as `isoTimestamp` writes them, but set by the Gateway
 * from the call itself rather than defaulted.
 */
export const aiUsage = pgTable(
  'ai_usage',
  {
    aiUsageId: nanoidPk('ai_usage_id'),
    applicationId: text('application_id')
      .notNull()
      .references(() => application.applicationId, { onDelete: 'cascade' }),
    agentUserId: text('agent_user_id').references(() => user.id, {
      onDelete: 'set null',
    }),
    agentName: text('agent_name').notNull(),
    agentId: text('agent_id').notNull(),
    apikeyId: text('apikey_id').notNull(),
    model: text('model').notNull(),
    endpoint: text('endpoint').notNull(),
    streamed: boolean('streamed').notNull(),
    promptTokens: integer('prompt_tokens').notNull(),
    promptTokensEstimated: boolean('prompt_tokens_estimated').notNull(),
    completionTokens: integer('completion_tokens').notNull(),
    completionTokensEstimated: boolean('completion_tokens_estimated').notNull(),
    startedAt: text('started_at').notNull(),
    endedAt: text('ended_at').notNull(),
    outcome: aiUsageOutcomeEnum('outcome').notNull(),
  },
  (table) => [
    index('ai_usage_application_started_idx').on(
      table.applicationId,
      table.startedAt,
    ),
  ],
);

export type AiUsageRow = typeof aiUsage.$inferSelect;
export type NewAiUsageRow = typeof aiUsage.$inferInsert;

export const aiUsageRelations = relations(aiUsage, ({ one }) => ({
  application: one(application, {
    fields: [aiUsage.applicationId],
    references: [application.applicationId],
  }),
}));
