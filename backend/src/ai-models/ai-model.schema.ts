import { relations } from 'drizzle-orm';
import { pgEnum, pgTable, text } from 'drizzle-orm/pg-core';
import { application } from '../applications/application.schema';
import { encryptedText, isoTimestamp, nanoidPk } from '../db/columns';

/**
 * The inference runtimes the platform knows how to configure
 * (`CONTEXT.md` "Inference runtime"). A closed list: `ollama`, `vllm`
 * and `llama.cpp`. What each one gets written is
 * `inference-runtime.ts`.
 */
export const inferenceRuntimeEnum = pgEnum('inference_runtime', [
  'ollama',
  'vllm',
  'llama.cpp',
]);

export type InferenceRuntime = (typeof inferenceRuntimeEnum.enumValues)[number];

/**
 * An **AI model**'s facet: the child row that makes an
 * Application one, for life.
 *
 * - **At most one per Application**, as a database fact (`application_id`
 *   is `UNIQUE`), and it goes with its Application by the cascade. Written
 *   only by `POST /applications`; an update can neither add one to a plain
 *   Application nor remove one (`ai-model-facet.ts`).
 * - **`runtime`** is fixed at create.
 * - **`model`** is which model it serves, read at each deploy, so a change
 *   takes effect on the next one.
 * - **`servedModel`** is the model the running version serves: written when
 *   a Deployment's model is ready, so the gateway holds calls to it, and its
 *   usage rows name it, until the next deploy succeeds ("takes
 *   effect on the next deploy"). `null` until the first one has.
 * - **`imageTag`** is the runtime image's tag, `null` meaning the platform's
 *   tested pin. The Application row's `dockerImage` is rewritten with it, so
 *   the row stays what a deploy reads.
 * - **`upstreamSecret`** is the per-AI-model secret the gateway presents to
 *   the run Server's Traefik. Generated at create, encrypted at rest
 *   (ADR-0006), and never read back or projected, not even as a flag: no read
 *   of this table selects it but the gateway's own.
 * - **`hfToken`** is the operator's Hugging Face token, which
 *   the deploy injects as `HF_TOKEN` so vLLM or llama.cpp can fetch gated
 *   weights.
 *   Write-only and encrypted at rest (ADR-0006): no read returns it, only
 *   whether there is one (`hasHfToken`), and only the deploy and a Rollback
 *   select it (`hfTokenEnv`), never into a rollback's stored context.
 */
export const aiModelFacet = pgTable('ai_model', {
  aiModelId: nanoidPk('ai_model_id'),
  applicationId: text('application_id')
    .notNull()
    .unique('ai_model_application_id_unique')
    .references(() => application.applicationId, { onDelete: 'cascade' }),
  runtime: inferenceRuntimeEnum('runtime').notNull(),
  model: text('model').notNull(),
  servedModel: text('served_model'),
  imageTag: text('image_tag'),
  upstreamSecret: encryptedText('upstream_secret').notNull(),
  hfToken: encryptedText('hf_token'),
  createdAt: isoTimestamp('created_at'),
});

export type AiModelFacetRow = typeof aiModelFacet.$inferSelect;

export const aiModelFacetRelations = relations(aiModelFacet, ({ one }) => ({
  application: one(application, {
    fields: [aiModelFacet.applicationId],
    references: [application.applicationId],
  }),
}));
