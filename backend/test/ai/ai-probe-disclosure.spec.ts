import { ForbiddenException } from '@nestjs/common';
import { AiService } from '../../src/ai/ai.service';
import { passThroughGuard } from '../outbound/pass-through-guard';
import { getModelsSchema, testConnectionSchema } from '../../src/ai/dto/ai.dto';
import { getProviderHeaders } from '../../src/ai/select-ai-provider';
import type { Ai } from '../../src/db/schema';
import type { DrizzleDB } from '../../src/db/drizzle.module';
import type {
  TextGenerationArgs,
  TextGenerationResult,
} from '../../src/ai/llm.provider';
import type { PermissionCtx } from '../../src/rbac/permission.service';
import type { PermissionService } from '../../src/rbac/permission.service';

/**
 * What the two probes hand back and how the key travels on the way out
 * pinned at the service seam.
 *
 * A unit spec for `ai-probe-authorization.spec.ts`'s reason: an e2e run costs a
 * Postgres and a machine-wide lock to assert something about a service that is
 * `new`-able, and every subject here — the request `FETCH_CLIENT` was handed,
 * the sentence the 400 carries, the fields of the array — is visible at that
 * seam. `ai.e2e-spec.ts` keeps the HTTP half, where the status code and the
 * global pipe's refusal are the contract.
 *
 * The doubles are the two system boundaries (`FETCH_CLIENT`, `TEXT_GENERATOR`)
 * plus name resolution; `PermissionService` and the database are stubs, because
 * what is under test is what this module does with their answers.
 */

const ctx: PermissionCtx = {
  user: { id: 'user-1' },
  session: { activeOrganizationId: 'org-1' },
};

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta';
const GEMINI_KEY = 'AIzaSy-not-a-real-google-key';

/** The row `findOneWithCredentials` answers with, key and all. */
const storedRow: Ai = {
  aiId: 'ai-1',
  name: 'ollama-on-the-box',
  apiUrl: 'http://localhost:11434',
  apiKey: 'ollama-key',
  model: 'llama3.3',
  isEnabled: true,
  organizationId: 'org-1',
  createdAt: '2026-09-03T00:00:00.000Z',
};

const makeDb = () =>
  ({
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve([storedRow]) }),
      }),
    }),
  }) as unknown as DrizzleDB;

interface Harness {
  service: AiService;
  fetchClient: jest.Mock<Promise<Response>, [string, RequestInit?]>;
  generateText: jest.Mock<Promise<TextGenerationResult>, [TextGenerationArgs]>;
}

/**
 * An owner who also administers the instance, which is the caller these two
 * findings are about: ADR-0013 exempts them from the destination check by
 * design, so what the probe *discloses* is all that is left between them and
 * the response — and DNS rebinding leaves that reachable for anyone else
 * (`ai-destination.ts`).
 */
function makeService(
  fetchResponse: Partial<Response> | (() => Promise<Response>) = {},
  generation: () => Promise<TextGenerationResult> = () =>
    Promise.resolve({ text: 'ok' }),
  instanceAuthority = true,
): Harness {
  const fetchClient = jest.fn<Promise<Response>, [string, RequestInit?]>(
    typeof fetchResponse === 'function'
      ? fetchResponse
      : () =>
          Promise.resolve({
            ok: true,
            json: () => Promise.resolve({}),
            text: () => Promise.resolve(''),
            ...fetchResponse,
          } as unknown as Response),
  );
  const generateText = jest.fn<
    Promise<TextGenerationResult>,
    [TextGenerationArgs]
  >(generation);

  const permissions = {
    findMember: jest.fn().mockResolvedValue({ role: 'owner' }),
    checkInstanceAuthority: jest.fn(() =>
      instanceAuthority
        ? Promise.resolve()
        : Promise.reject(
            new ForbiddenException(
              'Only an owner or admin of the instance organization can configure the platform host',
            ),
          ),
    ),
  } as unknown as PermissionService;

  const absent = {} as never;
  const service = new AiService(
    makeDb(),
    generateText,
    fetchClient,
    jest.fn(() => Promise.resolve(['203.0.113.7'])),
    permissions,
    absent,
    absent,
    absent,
    absent,
    absent,
    passThroughGuard,
  );
  return { service, fetchClient, generateText };
}

/** The refused promise's `message`, whatever kind of throw produced it. */
async function refusalMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as { message: string }).message;
  }
  throw new Error('expected a refusal');
}

/**
 * Whether a string ends in half a character — written out here rather than
 * asked of `capMessage`, so the assertion does not verify the cap with the
 * cap's own arithmetic (§1.7).
 */
function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe('getProviderHeaders', () => {
  it('presents a Google key in the x-goog-api-key header and sends no bearer beside it', () => {
    // Google's documented alternative to `?key=`: "All requests to the Gemini
    // API must include a x-goog-api-key header with your API key" —
    // https://ai.google.dev/gemini-api/docs/api-key
    expect(getProviderHeaders(GEMINI_URL, GEMINI_KEY)).toEqual({
      'x-goog-api-key': GEMINI_KEY,
    });
  });
});

describe('AiService.getModels', () => {
  it('asks Gemini for its models with the key in a header, and writes no key into the URL', async () => {
    const { service, fetchClient } = makeService({
      json: () => Promise.resolve({ models: [{ name: 'gemini-3.5-flash' }] }),
    });

    await service.getModels(ctx, { apiUrl: GEMINI_URL, apiKey: GEMINI_KEY });

    const [url, init] = fetchClient.mock.calls[0];
    // The URL is what a target's access log, and every proxy on the path,
    // writes down.
    expect(url).toBe(`${GEMINI_URL}/models`);
    expect(url).not.toContain('key=');
    expect(url).not.toContain(GEMINI_KEY);
    expect(init?.headers).toEqual({ 'x-goog-api-key': GEMINI_KEY });
  });

  it('caps the provider body it quotes in a refusal, and says the provider said more', async () => {
    const body = `Bad gateway: ${'A'.repeat(20_000)} SECRET-PAGE-TAIL`;
    const { service } = makeService({
      ok: false,
      text: () => Promise.resolve(body),
    });

    const message = await refusalMessage(
      service.getModels(ctx, {
        apiUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
      }),
    );

    // The provider's own words survive — the reason they were put there.
    expect(message).toContain('Failed to fetch models: Bad gateway:');
    // The rest of its response does not, and the operator can see it was cut.
    expect(message).not.toContain('SECRET-PAGE-TAIL');
    expect(message.endsWith('…')).toBe(true);
    expect(message.length).toBeLessThanOrEqual(501);
  });

  it('does not end a capped refusal in half a character', async () => {
    // `Failed to fetch models: ` is 24 code units, so this puts the two halves
    // of one emoji at indices 499 and 500 of the message — the split
    // `substring` makes and `capMessage` steps back off.
    const body = `${'a'.repeat(475)}😀 the rest of the page`;
    const { service } = makeService({
      ok: false,
      text: () => Promise.resolve(body),
    });

    const message = await refusalMessage(
      service.getModels(ctx, {
        apiUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
      }),
    );

    expect(hasLoneSurrogate(message)).toBe(false);
    expect(message).not.toContain('the rest of the page');
  });

  it('narrows a provider model to the id the console renders', async () => {
    const { service } = makeService({
      json: () =>
        Promise.resolve({
          data: [
            {
              id: 'gpt-5',
              object: 'model',
              created: 1,
              owned_by: 'openai',
              // Anything else the target put in the object used to come back
              // with it: `res.data` was handed over verbatim.
              internal_note: 'ADMIN-TOKEN-FROM-THE-TARGET',
            },
          ],
        }),
    });

    const models = await service.getModels(ctx, {
      apiUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
    });

    expect(models).toEqual([
      {
        id: 'gpt-5',
        object: 'model',
        created: expect.any(Number) as number,
        owned_by: 'provider',
      },
    ]);
    expect(JSON.stringify(models)).not.toContain('ADMIN-TOKEN');
  });

  it('answers with no models when the array it found was never a model list', async () => {
    const { service } = makeService({
      json: () =>
        Promise.resolve({
          // Not a models endpoint at all: the shape a non-LLM target on the
          // private network answers with, whose strings used to reach the
          // caller through the last-resort array sniff.
          errors: [
            { detail: 'traefik: 3 routers on this entrypoint' },
            { detail: 'admin api requires a token' },
          ],
        }),
    });

    const models = await service.getModels(ctx, {
      apiUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
    });

    expect(models).toEqual([]);
    expect(JSON.stringify(models)).not.toContain('traefik');
  });

  it('still reads an unknown provider shape, which is why the sniffing chain stays', async () => {
    const { service } = makeService({
      json: () =>
        Promise.resolve({ available_models: [{ name: 'mixtral-8x7b' }] }),
    });

    await expect(
      service.getModels(ctx, {
        apiUrl: 'https://llm.mycorp.example/v1',
        apiKey: 'sk-test',
      }),
    ).resolves.toEqual([
      {
        id: 'mixtral-8x7b',
        object: 'model',
        created: expect.any(Number) as number,
        owned_by: 'provider',
      },
    ]);
  });

  it('refuses a URL that parses but is not http(s), which is the guard the DTO does not replace', async () => {
    // `z.string().url()` accepts this — see `getModelsSchema` below — so the
    // shape rule is asked twice on purpose: once on the DTO, where §2.4 puts
    // it, and once in `assertPublicApiUrl`, which is a security boundary and
    // is also reachable without a DTO. This caller holds no instance
    // authority, which is the arm of `assertDestinationAllowed` that runs it.
    const { service, fetchClient } = makeService({}, undefined, false);

    const message = await refusalMessage(
      service.getModels(ctx, { apiUrl: 'ftp://files.example/v1', apiKey: 'k' }),
    );
    expect(message).toBe('apiUrl must be an absolute http(s) URL');
    expect(fetchClient).not.toHaveBeenCalled();
  });
});

describe('AiService.testSavedConnection', () => {
  it('masks the stored key before the cap, so no fragment of it survives the cut', async () => {
    // The key straddles the cut: capping first would leave its first characters
    // at the end of the message with nothing left to match, so the redaction
    // has to run first.
    const quoted = `${'x'.repeat(495)}${storedRow.apiKey} rejected by upstream`;
    const { service } = makeService({}, () =>
      Promise.reject(new Error(quoted)),
    );

    const message = await refusalMessage(
      service.testSavedConnection(ctx, 'ai-1'),
    );

    expect(message).not.toContain(storedRow.apiKey);
    expect(message).not.toContain('ollam');
    expect(message).toContain('•••');
    expect(message.length).toBeLessThanOrEqual(501);
  });
});

describe('AiService.testConnection', () => {
  it('caps the SDK message a non-LLM target produces', async () => {
    const { service } = makeService({}, () =>
      Promise.reject(
        new Error(
          `Invalid JSON response: <!doctype html>${'<td>row</td>'.repeat(500)}END-OF-PAGE`,
        ),
      ),
    );

    const message = await refusalMessage(
      service.testConnection(ctx, {
        apiUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
        model: 'gpt-5',
      }),
    );

    expect(message).toContain('Invalid JSON response: <!doctype html>');
    expect(message).not.toContain('END-OF-PAGE');
    expect(message.length).toBeLessThanOrEqual(501);
  });

  it('answers a live provider with the bare verdict, which is all this route is for', async () => {
    const { service } = makeService();

    await expect(
      service.testConnection(ctx, {
        apiUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
        model: 'gpt-5',
      }),
    ).resolves.toEqual({ success: true, message: 'Connection successful' });
  });
});

describe('getModelsSchema', () => {
  it('refuses an apiUrl that is not a URL, which is where the shape rule belongs (§2.4)', () => {
    const refused = getModelsSchema.safeParse({
      apiUrl: 'api.openai.com/v1',
      apiKey: 'sk-test',
    });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]).toMatchObject({
      path: ['apiUrl'],
      message: 'Please enter a valid URL',
    });

    expect(
      getModelsSchema.safeParse({
        apiUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
      }).success,
    ).toBe(true);
  });

  it('admits a URL of another scheme, which is why the service still checks', () => {
    // Not an oversight to assert: `z.string().url()` is `new URL()`, so the DTO
    // answers the *shape* question only. `assertPublicApiUrl` is what refuses
    // this, and the case above proves it does.
    expect(
      getModelsSchema.safeParse({ apiUrl: 'ftp://files.example', apiKey: 'k' })
        .success,
    ).toBe(true);
  });
});

describe('testConnectionSchema', () => {
  it('refuses an apiUrl that is not a URL, like its sibling', () => {
    const refused = testConnectionSchema.safeParse({
      apiUrl: 'ollama on the box',
      apiKey: 'k',
      model: 'llama3.3',
    });
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]).toMatchObject({ path: ['apiUrl'] });
  });
});
