import { relations } from 'drizzle-orm';
import {
  bigint,
  integer,
  pgTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { application } from '../applications/application.schema';
import { user } from '../auth/auth.schema';
import { nanoidPk } from '../db/columns';

/**
 * One day of **Token spend** on one AI model by one caller credential, for
 * one model served (`CONTEXT.md` "Token spend"): what the nightly
 * job keeps once a day's raw `ai_usage` rows are summed, and what is left of
 * a day once those rows are pruned at 90 days.
 *
 * - **It belongs to the AI model**, as the raw row does: `applicationId`
 *   cascades, so the rollups go with the AI model, and with its Environment
 *   and Project through theirs. Nothing else ever deletes one.
 * - **It outlives the Agent**: `agentUserId` is set null when the Agent's
 *   user is removed, and `agentName` keeps who it was. `agentId` keeps its
 *   id as plain text, which a read sums by, so two removed Agents with one
 *   name stay two.
 * - **Keyed by the credential, not the Agent's user.** `apikeyId` is the one
 *   identity a raw row holds that is never nulled, and a key belongs to one
 *   Agent for life, so the grain is the spec's (AI model × Agent × model
 *   served × day) split no coarser and summed by Agent (`agentId`) on read. Keying on
 *   `agentUserId` would collide the moment two removed Agents' rows were both
 *   set null, which would refuse the second Agent's removal.
 * - **`day`** is the UTC day the calls started, `YYYY-MM-DD`, as the raw
 *   rows' ISO `startedAt` begins.
 * - **Token sums are `bigint`**: a busy model's day can pass what `integer`
 *   holds, where one call's count cannot.
 * - **Tokens are split** reported (the runtime said) and estimated, so a read
 *   can mark the estimated part; **calls are counted per outcome**.
 */
export const aiUsageDaily = pgTable(
  'ai_usage_daily',
  {
    aiUsageDailyId: nanoidPk('ai_usage_daily_id'),
    applicationId: text('application_id')
      .notNull()
      .references(() => application.applicationId, { onDelete: 'cascade' }),
    apikeyId: text('apikey_id').notNull(),
    agentUserId: text('agent_user_id').references(() => user.id, {
      onDelete: 'set null',
    }),
    agentName: text('agent_name').notNull(),
    agentId: text('agent_id').notNull(),
    model: text('model').notNull(),
    day: text('day').notNull(),
    promptTokensReported: bigint('prompt_tokens_reported', {
      mode: 'number',
    }).notNull(),
    promptTokensEstimated: bigint('prompt_tokens_estimated', {
      mode: 'number',
    }).notNull(),
    completionTokensReported: bigint('completion_tokens_reported', {
      mode: 'number',
    }).notNull(),
    completionTokensEstimated: bigint('completion_tokens_estimated', {
      mode: 'number',
    }).notNull(),
    callsOk: integer('calls_ok').notNull(),
    callsRuntimeError: integer('calls_runtime_error').notNull(),
    callsClientAborted: integer('calls_client_aborted').notNull(),
    callsRefused: integer('calls_refused').notNull(),
  },
  (table) => [
    uniqueIndex('ai_usage_daily_application_day_key_model_idx').on(
      table.applicationId,
      table.day,
      table.apikeyId,
      table.model,
    ),
  ],
);

export type AiUsageDailyRow = typeof aiUsageDaily.$inferSelect;

export const aiUsageDailyRelations = relations(aiUsageDaily, ({ one }) => ({
  application: one(application, {
    fields: [aiUsageDaily.applicationId],
    references: [application.applicationId],
  }),
}));
