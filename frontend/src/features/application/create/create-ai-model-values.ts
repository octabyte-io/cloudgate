import { z } from "zod";

import {
  TAKES_HF_TOKEN,
  type CreateApplicationInput,
  type InferenceRuntime,
} from "@/lib/api/endpoints/applications";
import type { GpuCounts } from "@/lib/api/endpoints/settings";
import { serviceNameField } from "@/lib/forms/service-name";

import { INFERENCE_RUNTIMES } from "../model/inference-runtimes";

/**
 * What the "Add an AI model" form holds, and how it becomes
 * `POST /applications`.
 *
 * An AI model is an Application with the model facet, so it is created
 * on the same route with `aiModel` in the body; the platform writes its image,
 * command, port and health check. The form asks only what is the operator's:
 * name, description, where it runs, the runtime, the model and its GPUs,
 * and on vLLM or llama.cpp a Hugging Face token for gated weights.
 */
export const createAiModelSchema = z.object({
  name: serviceNameField("An AI model needs a name."),
  description: z.string(),
  runtime: z.enum(INFERENCE_RUNTIMES),
  model: z.string().trim().min(1, "Name the model it serves."),
  hfToken: z.string(),
  gpus: z.coerce
    .number()
    .int("GPUs has to be a whole number.")
    .min(0, "GPUs cannot be negative."),
});

export type CreateAiModelValues = z.infer<typeof createAiModelSchema>;

export const BLANK_AI_MODEL: CreateAiModelValues = {
  name: "",
  description: "",
  runtime: "ollama" satisfies InferenceRuntime,
  model: "",
  hfToken: "",
  gpus: 0,
};

/**
 * The form's values as the route wants them. Blank optional keys are left out,
 * as the Application dialog leaves them (`create-application-values.ts`); the
 * image tag is never sent, so the AI model starts on the platform's pin. A
 * Hugging Face token goes only with a runtime that reads it: vLLM or
 * llama.cpp.
 */
export function toCreateAiModelInput(
  values: CreateAiModelValues,
  environmentId: string,
  serverId: string | null | undefined,
): CreateApplicationInput {
  const description = values.description.trim();
  const hfToken = TAKES_HF_TOKEN[values.runtime] ? values.hfToken.trim() : "";
  return {
    name: values.name.trim(),
    ...(description === "" ? {} : { description }),
    environmentId,
    // Read off the picker: the platform host is `null`, never left out, since
    // a body with no `serverId` lands on the Deploy target's Server.
    // Left out only for nothing chosen in a cloud Environment.
    ...(serverId === undefined ? {} : { serverId }),
    gpus: Number(values.gpus),
    aiModel: {
      runtime: values.runtime,
      model: values.model.trim(),
      ...(hfToken === "" ? {} : { hfToken }),
    },
  };
}

/**
 * A host as the Server picker names it: its name, then its cards and how many
 * are free — "gpu-1 · 2 GPUs, 1 free" — or why it has none to offer. A read
 * not back yet leaves the name alone.
 */
export function hostWithCards(name: string, counts: GpuCounts | undefined): string {
  if (!counts) return name;
  if (counts.gpuSetup === "card-id") {
    const gpus = `${counts.cards} ${counts.cards === 1 ? "GPU" : "GPUs"}`;
    return `${name} · ${gpus}, ${counts.free} free`;
  }
  if (counts.gpuSetup === "count") return `${name} · GPUs set up the old way`;
  return `${name} · no GPUs set up`;
}
