import type { Provider } from '@nestjs/common';
import type { LanguageModel } from 'ai';
import { generateText } from 'ai';

/**
 * Injection token for the Vercel AI SDK's generateText — the LLM boundary
 * the tests replace. Provider/model construction (select-ai-provider.ts)
 * stays real code; only the network-bound generation call is swappable.
 */
export const TEXT_GENERATOR = Symbol('TEXT_GENERATOR');

export interface TextGenerationArgs {
  model: LanguageModel;
  prompt: string;
  /** An Output.object({ schema }) spec for structured suggestions. */
  output?: unknown;
  /**
   * Aborted when `AI_GENERATION_TIMEOUT_MS` passes, so the provider request is
   * cancelled rather than left generating into a response nobody will read.
   */
  abortSignal?: AbortSignal;
}

export interface TextGenerationResult {
  text: string;
  output?: unknown;
}

export type TextGenerator = (
  args: TextGenerationArgs,
) => Promise<TextGenerationResult>;

/**
 * How long one AI call may take before Cloudgate stops waiting and says so
 * — three minutes, for the whole call including the SDK's own retries.
 *
 * **The ceiling used to be 30 s and it was nobody's.** It was the default of
 * the console's rewrite proxy, which dropped the socket and answered the
 * browser with a bare 500, so every model that accepted a draft request and
 * started generating was reported as a backend fault the backend never had.
 * `frontend/next.config.ts` now sets that proxy's limit *above* this one, which
 * makes this the ceiling that remains, and `AiService.generate` states it when
 * it is hit — a limit that is hit silently is the same defect one hop further in.
 *
 * Three minutes rather than none: a request with no deadline holds a socket and
 * a provider slot for as long as a stuck endpoint cares to hold it, and the
 * operator watching a spinner deserves an answer. Rejected: 60 s, which the
 * slow free models measured earlier would have crossed on an ordinary draft.
 *
 * The frontend's proxy test reads this constant from this file by name, so
 * renaming it or raising it past the proxy's limit fails there.
 */
export const AI_GENERATION_TIMEOUT_MS = 180_000;

export const textGeneratorProvider: Provider = {
  provide: TEXT_GENERATOR,
  useValue: generateText,
};
