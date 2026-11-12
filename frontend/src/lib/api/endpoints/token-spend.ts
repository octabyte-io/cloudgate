import { api } from "../client";

/** Tokens, the part the runtime reported and the part the Gateway estimated. */
export interface SpendTokens {
  reported: number;
  estimated: number;
}

/** Calls, one count per outcome of a call through the Gateway. */
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
 * `GET /applications/:id/token-spend`: one AI model's Token spend over
 * `from`..`to` (inclusive UTC days): the total, every day of the window (zero
 * days included), and the window by Agent × model served. A removed Agent is
 * listed by its kept name with `agentUserId: null`.
 */
export interface TokenSpend {
  from: string;
  to: string;
  total: SpendFigures;
  days: (SpendFigures & { day: string })[];
  breakdown: (SpendFigures & {
    /** The Agent's id, kept past its removal. */
    agentId: string;
    agentUserId: string | null;
    agentName: string;
    model: string;
  })[];
}

/** A total over `from`..`to` and each day of it, as {@link TokenSpend} has. */
type SpendTotals = Pick<TokenSpend, "from" | "to" | "total" | "days">;

/**
 * `GET /environments/:id/token-spend`: the Environment's spend, summing
 * only the AI models in it the caller can read, and each of those AI models'
 * total. Two readers may see different totals.
 */
export interface EnvironmentTokenSpend extends SpendTotals {
  aiModels: { applicationId: string; name: string; total: SpendFigures }[];
}

/**
 * `GET /projects/:id/token-spend`: the Project's spend over the AI
 * models the caller can read in the Environments they can see, and each such
 * Environment's total with how many AI models it summed.
 */
export interface ProjectTokenSpend extends SpendTotals {
  environments: {
    environmentId: string;
    name: string;
    aiModelCount: number;
    total: SpendFigures;
  }[];
}

export const tokenSpendApi = {
  /**
   * Anyone who can read the AI model. `to` defaults to today and `from` to
   * the day the AI model was created ("all"), both `YYYY-MM-DD`.
   */
  forAiModel: (
    applicationId: string,
    range: { from?: string; to?: string } = {},
  ) =>
    api.get<TokenSpend>(`/applications/${applicationId}/token-spend`, {
      query: range,
    }),

  /** Anyone who can read the Environment. The last 30 days by default. */
  forEnvironment: (environmentId: string) =>
    api.get<EnvironmentTokenSpend>(
      `/environments/${environmentId}/token-spend`,
    ),

  /** Anyone who can read the Project. The last 30 days by default. */
  forProject: (projectId: string) =>
    api.get<ProjectTokenSpend>(`/projects/${projectId}/token-spend`),
};
