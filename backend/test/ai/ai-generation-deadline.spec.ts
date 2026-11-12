import { BadRequestException } from '@nestjs/common';
import { AiService } from '../../src/ai/ai.service';
import { passThroughGuard } from '../outbound/pass-through-guard';
import { AI_GENERATION_TIMEOUT_MS } from '../../src/ai/llm.provider';
import type { Ai } from '../../src/db/schema';
import type { DrizzleDB } from '../../src/db/drizzle.module';
import type {
  TextGenerationArgs,
  TextGenerationResult,
} from '../../src/ai/llm.provider';
import type { PermissionCtx } from '../../src/rbac/permission.service';
import type { PermissionService } from '../../src/rbac/permission.service';
import type { SettingsService } from '../../src/settings/settings.service';

/**
 * The one ceiling an AI call has, and that it is *said* when it is hit.
 *
 * Every generative call used to die at 30 s in the console's rewrite proxy,
 * which answered the browser with a bare 500 that read as "the backend hit an
 * error" while the backend was still waiting on the model. The proxy's limit is
 * raised past this one (`frontend/next.config.ts`), so this deadline is the
 * ceiling that remains — and a ceiling nobody names is the same defect again,
 * one hop further in.
 *
 * `TEXT_GENERATOR` is the boundary double: it stands in for a model that is
 * still generating. Fake timers so the deadline is crossed without waiting
 * three minutes for it.
 */

const ctx: PermissionCtx = {
  user: { id: 'user-1' },
  session: { activeOrganizationId: 'org-1' },
};

const storedRow: Ai = {
  aiId: 'ai-1',
  name: 'slow-model',
  apiUrl: 'https://openrouter.ai/api/v1',
  apiKey: 'sk-test',
  model: 'nex-agi/nex-n2.5-mini:free',
  isEnabled: true,
  organizationId: 'org-1',
  createdAt: '2026-09-18T00:00:00.000Z',
};

const makeDb = () =>
  ({
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve([storedRow]) }),
      }),
    }),
  }) as unknown as DrizzleDB;

/**
 * A model that has accepted the request and is still generating: it answers
 * only when the caller's signal aborts, the way the AI SDK's fetch does.
 */
function stillGenerating(
  args: TextGenerationArgs,
): Promise<TextGenerationResult> {
  return new Promise((_, reject) => {
    args.abortSignal?.addEventListener('abort', () =>
      reject(new DOMException('This operation was aborted', 'AbortError')),
    );
  });
}

function makeService(
  generation: (args: TextGenerationArgs) => Promise<TextGenerationResult>,
) {
  const generateText = jest.fn<
    Promise<TextGenerationResult>,
    [TextGenerationArgs]
  >(generation);
  const permissions = {
    findMember: jest.fn().mockResolvedValue({ role: 'owner' }),
    checkInstanceAuthority: jest.fn().mockResolvedValue(undefined),
  } as unknown as PermissionService;
  const settings = {
    getWebServerSettings: jest.fn().mockResolvedValue({ serverIp: '' }),
  } as unknown as SettingsService;
  const absent = {} as never;
  const service = new AiService(
    makeDb(),
    generateText,
    absent,
    jest.fn(() => Promise.resolve(['203.0.113.7'])),
    permissions,
    absent,
    settings,
    absent,
    absent,
    absent,
    passThroughGuard,
  );
  return { service, generateText };
}

/** Crosses the deadline, then reads the refusal the call settled with. */
async function refusalPastDeadline(
  call: Promise<unknown>,
): Promise<BadRequestException> {
  const settled = call.then(
    () => {
      throw new Error('expected a refusal');
    },
    (error: unknown) => error,
  );
  await jest.advanceTimersByTimeAsync(AI_GENERATION_TIMEOUT_MS);
  const error = await settled;
  expect(error).toBeInstanceOf(BadRequestException);
  return error as BadRequestException;
}

const STATED = new RegExp(
  `did not answer within ${AI_GENERATION_TIMEOUT_MS / 1000} seconds`,
);

describe('AiService', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  describe('the generation deadline', () => {
    it('is longer than the 30 s the console proxy used to cut every call at', () => {
      expect(AI_GENERATION_TIMEOUT_MS).toBeGreaterThan(30_000);
    });

    it('refuses a draft that outlasts it with a 400 naming how long it waited', async () => {
      const { service, generateText } = makeService(stillGenerating);

      const refusal = await refusalPastDeadline(
        service.suggest(ctx, { aiId: 'ai-1', input: 'redis' }),
      );

      expect(refusal.message).toMatch(STATED);
      // A timeout is not a backend fault, and it must not send the operator to
      // the backend logs, which hold nothing about it.
      expect(refusal.message).not.toMatch(/error|logs/i);
      // The model was told to stop, rather than left generating into nothing.
      expect(generateText.mock.calls[0][0].abortSignal?.aborted).toBe(true);
    });

    it('refuses a log explanation that outlasts it the same way', async () => {
      const { service } = makeService(stillGenerating);

      const refusal = await refusalPastDeadline(
        service.analyzeLogs(ctx, {
          aiId: 'ai-1',
          logs: 'Error: exit code 1',
          context: 'build',
        }),
      );

      expect(refusal.message).toMatch(STATED);
    });

    it('refuses a connection test that outlasts it the same way', async () => {
      const { service } = makeService(stillGenerating);

      const refusal = await refusalPastDeadline(
        service.testSavedConnection(ctx, 'ai-1'),
      );

      expect(refusal.message).toMatch(STATED);
    });

    /**
     * A provider client that ignores the abort must not hold the request open
     * past the deadline either — the deadline is Cloudgate's, not the SDK's.
     */
    it('answers at the deadline even when the model never honours the abort', async () => {
      const { service } = makeService(() => new Promise(() => undefined));

      const refusal = await refusalPastDeadline(
        service.analyzeLogs(ctx, {
          aiId: 'ai-1',
          logs: 'Error: exit code 1',
          context: 'runtime',
        }),
      );

      expect(refusal.message).toMatch(STATED);
    });

    it('leaves a call that finishes inside it untouched, and no timer behind', async () => {
      const { service } = makeService(() =>
        Promise.resolve({ text: 'All healthy' }),
      );

      await expect(
        service.analyzeLogs(ctx, {
          aiId: 'ai-1',
          logs: 'ok',
          context: 'runtime',
        }),
      ).resolves.toEqual({ analysis: 'All healthy' });
      // Nothing is left to fire an abort into a request that already ended.
      expect(jest.getTimerCount()).toBe(0);
    });
  });
});
