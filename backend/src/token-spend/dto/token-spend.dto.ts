import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

/**
 * A UTC day, `YYYY-MM-DD`, that is a real date: `2026-02-30` is refused
 * rather than read as March.
 */
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a day as YYYY-MM-DD')
  .refine(
    (value) =>
      !Number.isNaN(Date.parse(`${value}T00:00:00.000Z`)) &&
      new Date(`${value}T00:00:00.000Z`).toISOString().startsWith(value),
    'Expected a day as YYYY-MM-DD',
  );

/**
 * `GET /applications/:id/token-spend`: inclusive UTC days, the only
 * grain. `to` defaults to today; `from` to the day the AI model was
 * created, which is "all". The Environment and Project totals take the
 * same days, `from` defaulting to the 30 days ending `to` instead: a total
 * over many AI models has no one creation day to mean "all".
 */
export const tokenSpendQuerySchema = z.object({
  from: day.optional(),
  to: day.optional(),
});

export class TokenSpendQueryDto extends createZodDto(tokenSpendQuerySchema) {}

/** Tokens, the part the runtime reported and the part the Gateway estimated. */
export interface SpendTokens {
  reported: number;
  estimated: number;
}

/** Calls, one count per outcome of `ai_usage_outcome`. */
export interface SpendCalls {
  ok: number;
  runtimeError: number;
  clientAborted: number;
  refused: number;
}

export interface SpendFigures {
  promptTokens: SpendTokens;
  completionTokens: SpendTokens;
  calls: SpendCalls;
}

/**
 * One AI model's Token spend over `from`..`to`: the window's total, every day
 * of it (a day with no calls included, as zeros), and the window by Agent ×
 * model served. A removed Agent is listed by its kept name with
 * `agentUserId: null`.
 */
export interface TokenSpend {
  from: string;
  to: string;
  total: SpendFigures;
  days: (SpendFigures & { day: string })[];
  breakdown: (SpendFigures & {
    /** The Agent's id, kept past its removal; one line per Agent × model. */
    agentId: string;
    agentUserId: string | null;
    agentName: string;
    model: string;
  })[];
}

/** A total over `from`..`to`, each day of it, as {@link TokenSpend} has. */
type SpendTotals = Pick<TokenSpend, 'from' | 'to' | 'total' | 'days'>;

/**
 * An Environment's Token spend: the sum of the AI models in it the
 * reader can read, by day, and each of those AI models' total. An AI model
 * the reader can't read is in neither, so two readers may see different
 * totals.
 */
export interface EnvironmentTokenSpend extends SpendTotals {
  aiModels: { applicationId: string; name: string; total: SpendFigures }[];
}

/**
 * A Project's Token spend: the sum of the AI models the reader can
 * read in the Environments they can see, by day, and each such Environment's
 * total, with how many AI models it summed — so a zero says "nothing spent"
 * apart from "nothing to spend on".
 */
export interface ProjectTokenSpend extends SpendTotals {
  environments: {
    environmentId: string;
    name: string;
    aiModelCount: number;
    total: SpendFigures;
  }[];
}
