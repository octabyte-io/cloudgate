import {
  getProviderHeaders,
  getProviderName,
  selectAIProvider,
} from '../../src/ai/select-ai-provider';

/** A fetch for a test that only builds a model and never calls it. */
const unusedFetch = (() =>
  Promise.reject(new Error('not called'))) as unknown as typeof fetch;

describe('getProviderName (apiUrl sniffing table)', () => {
  const cases: Array<[string, string]> = [
    ['https://api.openai.com/v1', 'openai'],
    ['https://myresource.openai.azure.com', 'azure'],
    ['https://api.anthropic.com/v1', 'anthropic'],
    ['https://api.cohere.ai/v1', 'cohere'],
    ['https://api.perplexity.ai', 'perplexity'],
    ['https://api.mistral.ai/v1', 'mistral'],
    ['http://localhost:11434', 'ollama'],
    ['http://ollama.internal:8080', 'ollama'],
    ['https://api.deepinfra.com/v1/openai', 'deepinfra'],
    ['https://generativelanguage.googleapis.com/v1beta/openai', 'gemini'],
    ['https://openrouter.ai/api/v1', 'openrouter'],
    ['https://api.z.ai/api/paas/v4', 'zai'],
    ['https://api.minimax.io/v1', 'minimax'],
    ['https://llm.mycorp.example/v1', 'custom'],
  ];

  it.each(cases)('%s → %s', (apiUrl, expected) => {
    expect(getProviderName(apiUrl)).toBe(expected);
  });
});

/**
 * Cloudgate's own AI provider pointed at an AI model through the Gateway
 * the Gateway speaks OpenAI `/v1` whatever runtime is behind it, so
 * its path wins over every host-name sniff below it — the Ollama one above
 * all, since an AI model is usually Ollama and an operator's platform host or
 * model name may well say so.
 */
describe('getProviderName (a Gateway URL)', () => {
  const gateway: string[] = [
    'https://cloud.example.com/ai/0b6f3c7e-2a1d-4b8e-9f3a-5c2d1e0a9b7c/v1',
    'https://cloud.example.com/ai/0b6f3c7e-2a1d-4b8e-9f3a-5c2d1e0a9b7c/v1/',
    'https://cloud.example.com/ai/ollama-llm/v1',
    'http://ollama.lan/ai/0b6f3c7e/v1',
    'http://ollama.lan:11434/ai/0b6f3c7e/v1',
    'https://console.example.com/cloudgate/ai/0b6f3c7e/v1',
    'https://cloud.example.com/ai/mistral-anthropic/v1',
  ];

  it.each(gateway)('%s → custom (OpenAI-compatible)', (apiUrl) => {
    expect(getProviderName(apiUrl)).toBe('custom');
  });

  it.each(gateway)('%s → the key as an OpenAI bearer token', (apiUrl) => {
    expect(getProviderHeaders(apiUrl, 'cg_agent_key')).toEqual({
      Authorization: 'Bearer cg_agent_key',
    });
  });

  it('builds the OpenAI-compatible client, not the Ollama one', () => {
    const gatewayed = selectAIProvider({
      apiUrl: 'http://ollama.lan/ai/0b6f3c7e/v1',
      apiKey: 'cg_agent_key',
      fetch: unusedFetch,
    });
    const model = gatewayed('smollm2:135m') as { provider: string };
    expect(model.provider).toContain('custom');
  });

  it.each([
    // Not the Gateway's path: these still sniff as before.
    ['http://ollama.lan/ai/0b6f3c7e/v2', 'ollama'],
    ['http://ollama.lan/ai//v1', 'ollama'],
    ['http://ollama.lan/v1', 'ollama'],
    ['not a url with ollama in it', 'ollama'],
  ])('%s → %s', (apiUrl, expected) => {
    expect(getProviderName(apiUrl)).toBe(expected);
  });
});

describe('selectAIProvider', () => {
  it('builds a provider whose models carry the provider identity', () => {
    const anthropic = selectAIProvider({
      apiUrl: 'https://api.anthropic.com/v1',
      apiKey: 'sk-ant-test',
      fetch: unusedFetch,
    });
    const model = anthropic('claude-opus-4-8') as {
      modelId: string;
      provider: string;
    };
    expect(model.modelId).toBe('claude-opus-4-8');
    expect(model.provider).toContain('anthropic');

    const custom = selectAIProvider({
      apiUrl: 'https://llm.mycorp.example/v1',
      apiKey: 'key',
      fetch: unusedFetch,
    });
    const customModel = custom('some-model') as {
      modelId: string;
      provider: string;
    };
    expect(customModel.modelId).toBe('some-model');
    expect(customModel.provider).toContain('custom');
  });

  it('routes azure URLs already carrying /v1 through the openai-compatible client', () => {
    const azure = selectAIProvider({
      apiUrl: 'https://myresource.azure.com/openai/v1',
      apiKey: 'azure-key',
      fetch: unusedFetch,
    });
    const model = azure('gpt-model') as { provider: string };
    expect(model.provider).toContain('azure');
  });
});

describe('getProviderHeaders', () => {
  it('uses the anthropic header pair for anthropic URLs', () => {
    expect(
      getProviderHeaders('https://api.anthropic.com/v1', 'sk-ant-key'),
    ).toEqual({
      'x-api-key': 'sk-ant-key',
      'anthropic-version': '2023-06-01',
    });
  });

  it('falls back to a bearer Authorization header elsewhere', () => {
    expect(getProviderHeaders('https://api.mistral.ai/v1', 'key')).toEqual({
      Authorization: 'Bearer key',
    });
    expect(getProviderHeaders('https://api.openai.com/v1', 'key')).toEqual({
      Authorization: 'Bearer key',
    });
  });
});

/**
 * Every arm hands its factory the fetch it was given, so a request to any
 * provider goes through `AiService`'s guarded fetch rather than the global
 * one, which follows a redirect to an internal address (`ai-destination.ts`).
 * One request per sniffed provider, so an arm added without `fetch` fails here.
 */
describe('selectAIProvider, on the fetch every provider dials through', () => {
  const ARMS: Array<[string, string]> = [
    ['openai', 'https://api.openai.com/v1'],
    ['azure', 'https://myresource.openai.azure.com/openai'],
    ['azure /v1', 'https://myresource.azure.com/openai/v1'],
    ['anthropic', 'https://api.anthropic.com/v1'],
    ['cohere', 'https://api.cohere.ai/v2'],
    ['perplexity', 'https://api.perplexity.ai'],
    ['mistral', 'https://api.mistral.ai/v1'],
    ['ollama', 'http://ollama.example.com:11434'],
    ['deepinfra', 'https://api.deepinfra.com/v1/openai'],
    ['gemini', 'https://generativelanguage.googleapis.com/v1beta/openai'],
    ['openrouter', 'https://openrouter.ai/api/v1'],
    ['zai', 'https://api.z.ai/api/paas/v4'],
    ['minimax', 'https://api.minimax.io/v1'],
    ['custom', 'https://llm.mycorp.example/v1'],
    ['a Gateway URL', 'https://cloud.example.com/ai/0b6f3c7e/v1'],
  ];

  it.each(ARMS)(
    '%s sends its request through the given fetch',
    async (_arm, apiUrl) => {
      const marker = new Error('refused by the test fetch');
      const given = jest.fn<
        Promise<Response>,
        [RequestInfo | URL, RequestInit?]
      >(() => Promise.reject(marker));
      const provider = selectAIProvider({
        apiUrl,
        apiKey: 'key',
        fetch: given,
      });
      const model = provider('some-model') as unknown as {
        doGenerate(options: unknown): Promise<unknown>;
      };

      await expect(
        model.doGenerate({
          prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        }),
      ).rejects.toBeDefined();

      expect(given).toHaveBeenCalled();
      const [input] = given.mock.calls[0];
      const href =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      expect(new URL(href).hostname).toBe(new URL(apiUrl).hostname);
    },
  );
});
