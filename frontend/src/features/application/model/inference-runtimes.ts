import type { InferenceRuntime } from "@/lib/api/endpoints/applications";

/**
 * How the console names each inference runtime, and the one list of them the
 * "Add an AI model" dialog offers and its form accepts: a runtime is
 * added here once, and the picker, the form's enum and both Model cards
 * follow. Whether one takes a Hugging Face token is the API's fact, so it
 * stays beside the type as `TAKES_HF_TOKEN`.
 */
export const RUNTIME_LABEL: Record<InferenceRuntime, string> = {
  ollama: "Ollama",
  vllm: "vLLM",
  "llama.cpp": "llama.cpp",
};

/**
 * Every runtime, in {@link RUNTIME_LABEL}'s order. The `Record` already holds
 * every one of them, so the cast says only that the list is not empty, which
 * `z.enum` asks for.
 */
export const INFERENCE_RUNTIMES = Object.keys(RUNTIME_LABEL) as [
  InferenceRuntime,
  ...InferenceRuntime[],
];

/** The runtimes as a select offers them. */
export const RUNTIME_OPTIONS = INFERENCE_RUNTIMES.map((runtime) => ({
  value: runtime,
  label: RUNTIME_LABEL[runtime],
}));

/**
 * How each runtime names a model, and what its deploy does with it: Ollama
 * pulls it after start, vLLM and llama.cpp download and load it from Hugging
 * Face as they start. llama.cpp takes only a GGUF repo, with a
 * quant after the `:` or its own default without one.
 */
export const MODEL_NAMING: Record<
  InferenceRuntime,
  { placeholder: string; naming: string; deploy: string }
> = {
  ollama: {
    placeholder: "smollm2:135m",
    naming: "In Ollama's own naming.",
    deploy: "pulls it before the AI model reads as ready.",
  },
  vllm: {
    placeholder: "Qwen/Qwen2.5-0.5B-Instruct",
    naming: "A Hugging Face repo id.",
    deploy: "loads it before the AI model reads as ready.",
  },
  "llama.cpp": {
    placeholder: "ggml-org/gemma-3-1b-it-GGUF:Q4_K_M",
    naming:
      "A Hugging Face GGUF repo id, with a quant after the colon if you want one.",
    deploy: "loads it before the AI model reads as ready.",
  },
};
