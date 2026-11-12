import { z } from 'zod';
import { inferenceRuntimeEnum } from '../ai-model.schema';
import {
  HF_TOKEN_RUNTIMES_PHRASE,
  INFERENCE_RUNTIMES,
} from '../inference-runtime';

/**
 * Which model an AI model serves, in the runtime's own naming:
 * `[namespace/]name[:tag]`, e.g. `smollm2:135m` or `hf.co/org/repo:Q4_K_M`.
 * It reaches the readiness pull as an argv word, never through a shell, and
 * this is the grammar on top of that, not the defence.
 */
const modelNameSchema = z
  .string()
  .max(255)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9._-]+)*(:[A-Za-z0-9._-]+)?$/,
    'model must be a model name such as "smollm2:135m"',
  );

/** A Docker image tag, by `distribution/reference`'s tag grammar. */
const imageTagSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/,
    'imageTag must be an image tag such as "0.12.6"',
  );

/**
 * A Hugging Face access token: one word, as the hub issues it. It
 * reaches the task as `HF_TOKEN` and is never returned, only `hasHfToken`.
 */
const hfTokenSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^\S+$/, 'hfToken must be a Hugging Face token such as "hf_…"');

/**
 * The facet `POST /applications` takes to create an **AI model**.
 * Create only: it is what makes the Application an AI model, for life.
 * `imageTag` left out runs the platform's tested pin. `hfToken` is write-only
 * and for vLLM and llama.cpp alone: Ollama does not fetch gated Hugging Face
 * weights.
 */
export const createAiModelSchema = z
  .object({
    runtime: z.enum(inferenceRuntimeEnum.enumValues),
    model: modelNameSchema,
    imageTag: imageTagSchema.optional(),
    hfToken: hfTokenSchema.optional(),
  })
  .strict()
  .refine(
    (facet) =>
      facet.hfToken === undefined ||
      INFERENCE_RUNTIMES[facet.runtime].takesHfToken,
    {
      message: `hfToken is for an AI model on ${HF_TOKEN_RUNTIMES_PHRASE}`,
      path: ['hfToken'],
    },
  );

/**
 * The facet's editable half on `PATCH /applications/:id`: the model, taking
 * effect on the next deploy, the image tag, `null` returning to the pin, and
 * the Hugging Face token, replaced by a new one or removed by `null`.
 *
 * `runtime` is accepted only to be refused by name (409) rather than as an
 * unknown key, and `aiModel: null` (removing the facet) and any `aiModel` on a
 * plain Application are refused the same way (`ai-model-facet.ts`).
 */
export const updateAiModelSchema = z
  .object({
    runtime: z.enum(inferenceRuntimeEnum.enumValues),
    model: modelNameSchema,
    imageTag: imageTagSchema.nullable(),
    // ADR-0019's write contract for a secret read back as its presence:
    // omitted keeps it, `''` clears it (as `null` does), anything else
    // replaces it.
    hfToken: hfTokenSchema.or(z.literal('')).nullable(),
  })
  .strict()
  .partial();

export type CreateAiModel = z.infer<typeof createAiModelSchema>;
export type UpdateAiModel = z.infer<typeof updateAiModelSchema>;
