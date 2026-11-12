import { createAnthropic } from '@ai-sdk/anthropic';
import { createAzure } from '@ai-sdk/azure';
import { createCohere } from '@ai-sdk/cohere';
import { createDeepInfra } from '@ai-sdk/deepinfra';
import { createMistral } from '@ai-sdk/mistral';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOllama } from 'ai-sdk-ollama';

// The provider is sniffed from the apiUrl, and each branch builds the matching
// Vercel AI SDK provider factory.

/**
 * Whether `apiUrl` is an AI model's Gateway base, `<platform host>/ai/<id>/v1`:
 * Cloudgate's own AI provider pointed at an AI model with a
 * caller Agent's key, so the platform's AI features run on the operator's own
 * model and are metered as that Agent's Token spend like any other caller's.
 *
 * **Asked first, before every host-name sniff.** The Gateway speaks OpenAI
 * `/v1` whatever runtime is behind it, and the runtime is usually Ollama — so
 * a platform host called `ollama.lan`, or a URL carrying `:11434`, would
 * otherwise pick the Ollama SDK, which dials `/api/chat` and gets the Gateway's
 * 404. Judged on the parsed path alone, so nothing in the host can move it; a
 * string that does not parse as a URL is not a Gateway URL.
 *
 * There is deliberately no provider arm of its own and no in-process shortcut:
 * the answer is the custom OpenAI-compatible arm, the backend dials the public
 * Gateway URL, and a refused key comes back as the Gateway's own OpenAI-shaped
 * refusal through the SDK.
 *
 * Known limit, documented rather than fixed: the URL still meets
 * `assertPublicApiUrl` where it is stored, so on a multi-organization
 * install whose platform host is on a private address, an owner of an
 * organization other than the instance's own cannot point the AI provider at
 * the Gateway by that address.
 */
export function isGatewayUrl(apiUrl: string): boolean {
  let pathname: string;
  try {
    pathname = new URL(apiUrl).pathname;
  } catch {
    return false;
  }
  return /\/ai\/[^/]+\/v1\/?$/.test(pathname);
}

export function getProviderName(apiUrl: string) {
  if (isGatewayUrl(apiUrl)) return 'custom';
  if (apiUrl.includes('api.openai.com')) return 'openai';
  if (apiUrl.includes('azure.com')) return 'azure';
  if (apiUrl.includes('api.anthropic.com')) return 'anthropic';
  if (apiUrl.includes('api.cohere.ai')) return 'cohere';
  if (apiUrl.includes('api.perplexity.ai')) return 'perplexity';
  if (apiUrl.includes('api.mistral.ai')) return 'mistral';
  if (apiUrl.includes(':11434') || apiUrl.includes('ollama')) return 'ollama';
  if (apiUrl.includes('api.deepinfra.com')) return 'deepinfra';
  if (apiUrl.includes('generativelanguage.googleapis.com')) return 'gemini';
  if (apiUrl.includes('openrouter.ai')) return 'openrouter';
  if (apiUrl.includes('api.z.ai')) return 'zai';
  if (apiUrl.includes('api.minimax.io')) return 'minimax';
  return 'custom';
}

/**
 * A provider's factory input: where, with which key, and **through which
 * fetch**.
 *
 * `fetch` is required, not optional, and every arm below hands it to its
 * factory: each SDK otherwise uses the global `fetch`, which follows a
 * redirect wherever it points and resolves the name again at connect. So a
 * provider at a public URL that answered with a redirect to the metadata
 * address, or a name rebound to loopback after it was checked, had the
 * platform host fetch it and the SDK quote what came back. `AiService` passes
 * `OutboundAddressGuard.fetchFor`, which checks and pins every connection,
 * redirect hops included (`ai-destination.ts`). A new arm that drops it is
 * caught by `select-ai-provider.spec.ts`, which sends a request through every
 * arm.
 */
export interface AiProviderConfig {
  apiUrl: string;
  apiKey: string;
  fetch: typeof globalThis.fetch;
}

export function selectAIProvider(config: AiProviderConfig) {
  const providerName = getProviderName(config.apiUrl);
  const { fetch } = config;

  switch (providerName) {
    case 'openai':
      return createOpenAI({
        apiKey: config.apiKey,
        baseURL: config.apiUrl,
        fetch,
      });
    case 'azure':
      // Azure OpenAI-compatible endpoints already include /v1 in the path.
      // Using createAzure with such URLs causes a doubled /v1//v1/ suffix.
      if (config.apiUrl.includes('/v1')) {
        return createOpenAICompatible({
          name: 'azure',
          baseURL: config.apiUrl,
          fetch,
          headers: {
            'api-key': config.apiKey,
            Authorization: `Bearer ${config.apiKey}`,
          },
        });
      }
      return createAzure({
        apiKey: config.apiKey,
        baseURL: config.apiUrl,
        fetch,
      });
    case 'anthropic':
      return createAnthropic({
        apiKey: config.apiKey,
        baseURL: config.apiUrl,
        fetch,
      });
    case 'cohere':
      return createCohere({
        baseURL: config.apiUrl,
        fetch,
        apiKey: config.apiKey,
      });
    case 'perplexity':
      return createOpenAICompatible({
        name: 'perplexity',
        baseURL: config.apiUrl,
        fetch,
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
        },
      });
    case 'mistral':
      return createMistral({
        baseURL: config.apiUrl,
        fetch,
        apiKey: config.apiKey,
      });
    case 'ollama':
      return createOllama({
        baseURL: config.apiUrl,
        fetch,
        headers: config.apiKey
          ? { Authorization: `Bearer ${config.apiKey}` }
          : undefined,
      });
    case 'deepinfra':
      return createDeepInfra({
        baseURL: config.apiUrl,
        fetch,
        apiKey: config.apiKey,
      });
    case 'gemini':
      return createOpenAICompatible({
        name: 'gemini',
        baseURL: config.apiUrl,
        fetch,
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
        },
      });
    case 'openrouter':
      return createOpenAICompatible({
        name: 'openrouter',
        baseURL: config.apiUrl,
        fetch,
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
        },
      });
    case 'zai':
      return createOpenAICompatible({
        name: 'zai',
        baseURL: config.apiUrl,
        fetch,
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
        },
      });
    case 'minimax':
      return createOpenAICompatible({
        name: 'minimax',
        baseURL: config.apiUrl,
        fetch,
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
        },
      });
    case 'custom':
      return createOpenAICompatible({
        name: 'custom',
        baseURL: config.apiUrl,
        fetch,
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
        },
      });
    default:
      throw new Error(`Unsupported AI provider: ${String(providerName)}`);
  }
}

/**
 * How the key is presented to a provider's own HTTP API, for the one caller
 * that speaks HTTP directly (`AiService.getModels`) rather than through an SDK.
 *
 * **The gemini branch is here rather than in that method's switch.** It
 * used to be there and it was not a header at all: the switch built
 * `${apiUrl}/models?key=${encodeURIComponent(apiKey)}` and passed
 * `{ headers: {} }`, throwing this function's answer away. `apiUrl` comes out
 * of a request body, so the organization's stored Google key was written into a
 * caller-chosen host's access log, every proxy on the path, and anything else
 * that records a URL — and even aimed at Google, a key in a URL is a key in
 * every log line along the way.
 *
 * `x-goog-api-key` is Google's own documented alternative, sourced rather than
 * remembered: *"All requests to the Gemini API must include a
 * `x-goog-api-key` header with your API key"* —
 * https://ai.google.dev/gemini-api/docs/api-key. No `Authorization: Bearer`
 * beside it: the default arm below would have sent one, and the key belongs in
 * exactly one place. (`selectAIProvider`'s gemini arm does send `Bearer`,
 * because that path talks to Gemini's OpenAI-compatible surface through the
 * SDK — a header either way, so the key-in-query fix does not reach it.)
 *
 * Owned here, not there, for §1.4: this function is *the* answer to "how does
 * this provider take its key", and a switch arm that discards it is the shape
 * that let one provider drift out of that answer unnoticed. The test is
 * `getProviderName`'s own `generativelanguage.googleapis.com` and not a looser
 * `includes('google')`, so the arm that builds the URL and the arm that builds
 * the header cannot disagree about which requests are gemini.
 */
export const getProviderHeaders = (
  apiUrl: string,
  apiKey: string,
): Record<string, string> => {
  // The Gateway takes an Agent key as an OpenAI bearer token, whatever words
  // its URL happens to carry (`isGatewayUrl`).
  if (isGatewayUrl(apiUrl)) {
    return {
      Authorization: `Bearer ${apiKey}`,
    };
  }

  // Gemini
  if (apiUrl.includes('generativelanguage.googleapis.com')) {
    return {
      'x-goog-api-key': apiKey,
    };
  }

  // Anthropic
  if (apiUrl.includes('anthropic')) {
    return {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    };
  }

  // Mistral
  if (apiUrl.includes('mistral')) {
    return {
      Authorization: `Bearer ${apiKey}`,
    };
  }

  // Default (OpenAI style)
  return {
    Authorization: `Bearer ${apiKey}`,
  };
};

export interface Model {
  id: string;
  object: string;
  created: number;
  owned_by: string;
}
