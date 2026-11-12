import { api } from "../client";

/**
 * `ai.controller.ts` — the Organization's AI providers, and the three things
 * they are used for.
 *
 * **The `apiKey` never comes back.** `ai.service.ts` strips it on every read,
 * so an edit form starts with that box empty and a `PATCH` that omits it keeps
 * the stored key.
 *
 * Two consequences of that, both visible on the screen:
 *
 * 1. **`POST /ai/models` takes a URL and a key**, not a saved provider's id. So
 *    the model list is populated *while the form is being filled in* — which is
 *    also the only order that works, since you cannot pick a model from a
 *    provider you have not authenticated to yet.
 * 2. **Editing a saved provider cannot re-list its models** without the key
 *    being retyped, and the form says so rather than showing an empty picker.
 *
 * A *test* is no longer in that bind. `POST /ai/test-connection` takes a URL, a
 * key and a model, for the create case; `POST /ai/:id/test-connection` names a
 * saved provider and the server reads the key off the row
 * — which is how a
 * rotated or revoked key gets discovered from this screen rather than from a
 * failed build.
 *
 * `GET /ai` is owner/admin only (`ensureOwnerOrAdmin`); `GET /ai/enabled-providers`
 * is any member, which is what the two *consumer* features read.
 */

export interface AiProvider {
  aiId: string;
  name: string;
  apiUrl: string;
  model: string;
  isEnabled: boolean;
  createdAt: string;
  organizationId: string;
}

export interface AiInput {
  name: string;
  apiUrl: string;
  apiKey: string;
  model: string;
  isEnabled?: boolean;
}

/** What `GET /ai/enabled-providers` answers — the three fields a picker needs. */
export interface EnabledAiProvider {
  aiId: string;
  name: string;
  model: string;
}

/** `select-ai-provider.ts`'s `Model`. Only `id` reaches the screen. */
export interface AiModel {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}

/** A suggestion the model produced — a whole compose stack, ready to deploy. */
export interface AiSuggestion {
  id: string;
  name: string;
  shortDescription: string;
  description: string;
  dockerCompose: string;
  envVariables: Array<{ name: string; value: string }>;
  domains: Array<{ host: string; port: number; serviceName: string }>;
  configFiles?: Array<{ content: string; filePath: string }> | null;
}

export const aiApi = {
  list: () => api.get<AiProvider[]>("/ai"),

  /** Every member can read this; it is what the two consumer features pick from. */
  enabled: () => api.get<EnabledAiProvider[]>("/ai/enabled-providers"),

  create: (body: AiInput) => api.post<AiProvider>("/ai", body),

  /** Partial. Omitting `apiKey` keeps the stored one. */
  update: (aiId: string, body: Partial<AiInput>) =>
    api.patch<AiProvider>(`/ai/${aiId}`, body),

  remove: (aiId: string) => api.delete<AiProvider>(`/ai/${aiId}`),

  /**
   * The provider's own model list, fetched with caller-supplied credentials.
   *
   * The backend sniffs the provider from the URL and knows each one's quirks —
   * ollama's `/api/tags`, Gemini's `x-goog-api-key` header, and hardcoded lists
   * for the three providers with no models endpoint at all.
   */
  models: (body: { apiUrl: string; apiKey: string }) =>
    api.post<AiModel[]>("/ai/models", body),

  /** One token through the real model. A refusal carries the provider's words. */
  testConnection: (body: { apiUrl: string; apiKey: string; model: string }) =>
    api.post<{ success: boolean; message: string }>("/ai/test-connection", body),

  /**
   * The same one-token round trip against a **saved** provider, with the stored
   * key.
   *
   * It proves the URL, the key *and* the model as they are stored, which is
   * exactly what the two consumer features will use. Owner/admin only, like
   * every other route that names a config. A refusal keeps the provider's
   * diagnosis and not the key it quoted.
   */
  testSavedConnection: (aiId: string) =>
    api.post<{ success: boolean; message: string }>(
      `/ai/${aiId}/test-connection`,
    ),

  /** Up to three complete compose stacks for a described need. */
  suggest: (body: { aiId: string; input: string; serverId?: string }) =>
    api.post<AiSuggestion[]>("/ai/suggest", body),

  /** Build or runtime log triage. Answers Markdown-ish prose in one string. */
  analyzeLogs: (body: {
    aiId: string;
    logs: string;
    context: "build" | "runtime";
  }) => api.post<{ analysis: string }>("/ai/analyze-logs", body),

  /**
   * Instantiates an accepted suggestion as a **Compose stack** in an
   * Environment — a `raw` source with the generated file, its variables, its
   * domains and its config files, isolated on its own network.
   *
   * It rides the same create path a hand-made stack does
   * (`compose.createByTemplate`), which is why this belongs beside "Add a
   * service" rather than on a settings page.
   */
  deploy: (body: {
    environmentId: string;
    id: string;
    name: string;
    description: string;
    dockerCompose: string;
    envVariables: string;
    serverId?: string | null;
    domains?: Array<{ host: string; port: number; serviceName: string }>;
    configFiles?: Array<{ filePath: string; content: string }>;
  }) => api.post<{ composeId: string }>("/ai/deploy", body),
};
