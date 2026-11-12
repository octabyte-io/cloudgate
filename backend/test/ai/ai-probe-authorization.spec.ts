import { ForbiddenException } from '@nestjs/common';
import { PRIVATE_DESTINATION_REFUSAL } from '../../src/ai/ai-destination';
import { AiService } from '../../src/ai/ai.service';
import { passThroughGuard } from '../outbound/pass-through-guard';
import type { Ai } from '../../src/db/schema';
import type { DrizzleDB } from '../../src/db/drizzle.module';
import type {
  TextGenerationArgs,
  TextGenerationResult,
} from '../../src/ai/llm.provider';
import type { PermissionCtx } from '../../src/rbac/permission.service';
import type { PermissionService } from '../../src/rbac/permission.service';

/**
 * The probe-authorization fix, pinned where the fetch is: the two probe routes are refused
 * before anything leaves the box, and the two consumer routes are not.
 *
 * A unit spec rather than four more cases in `ai.e2e-spec.ts`, for
 * `host-reachability.spec.ts`'s reason — an e2e run costs a Postgres and a
 * machine-wide lock to assert something about a service that is `new`-able —
 * and because the assertion that matters here is a *negative* one: that
 * `FETCH_CLIENT` and the text generator were never reached. The e2e file still
 * carries the same refusals over HTTP, since the status code and the sentence
 * are part of the contract and a service call cannot see either.
 *
 * The two doubles are the two system boundaries (`FETCH_CLIENT`,
 * `TEXT_GENERATOR`) plus name resolution, which that fix added as a third for the
 * same reason; `PermissionService` and the database are stubs rather than
 * doubles, because what is under test is which of their answers this module
 * acts on.
 */

const PRIVATE_PROVIDER = 'http://169.254.169.254/latest/meta-data/';
const OWNER_OR_ADMIN_REFUSAL = 'Only owners and admins can manage AI settings';

const ctx: PermissionCtx = {
  user: { id: 'user-1' },
  session: { activeOrganizationId: 'org-1' },
};

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

/** `findOneWithCredentials`'s lookup, answering with the row above. */
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
  resolve: jest.Mock<Promise<string[]>, [string]>;
}

/**
 * `role` is what `ensureOwnerOrAdmin` reads; `instanceAuthority` is what
 * `checkInstanceAuthority` answers, and they are independent — an owner of a
 * second Organization is `owner` with no authority over the instance, which is
 * the caller the destination check is about (ADR-0013).
 */
function makeService({
  role,
  instanceAuthority,
  addresses = ['203.0.113.7'],
}: {
  role: 'owner' | 'admin' | 'member';
  instanceAuthority: boolean;
  addresses?: string[];
}): Harness {
  const fetchClient = jest.fn<Promise<Response>, [string, RequestInit?]>(() =>
    Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ data: [{ id: 'a-model' }] }),
      text: () => Promise.resolve(''),
    } as unknown as Response),
  );
  const generateText = jest.fn<
    Promise<TextGenerationResult>,
    [TextGenerationArgs]
  >(() => Promise.resolve({ text: 'ok' }));
  const resolve = jest.fn<Promise<string[]>, [string]>(() =>
    Promise.resolve(addresses),
  );

  const permissions = {
    findMember: jest.fn().mockResolvedValue({ role }),
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

  // The five collaborators no path under test reaches. `never` rather than a
  // stub object, so a path that *starts* using one fails loudly here instead of
  // quietly reading `undefined` off an empty object.
  const absent = {} as never;
  const service = new AiService(
    makeDb(),
    generateText,
    fetchClient,
    resolve,
    permissions,
    absent,
    absent,
    absent,
    absent,
    absent,
    passThroughGuard,
  );
  return { service, fetchClient, generateText, resolve };
}

describe('AiService.getModels', () => {
  it('refuses a plain member, and asks the provider nothing on the way out', async () => {
    const { service, fetchClient, resolve } = makeService({
      role: 'member',
      instanceAuthority: false,
    });

    const refusal = service.getModels(ctx, {
      apiUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test',
    });

    await expect(refusal).rejects.toThrow(ForbiddenException);
    await expect(refusal).rejects.toThrow(OWNER_OR_ADMIN_REFUSAL);
    // The caller is refused before the destination is even considered, and
    // nothing left the box: a 403 that arrives after the fetch is not a gate.
    expect(fetchClient).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('refuses an owner with no instance authority the metadata endpoint, and fetches nothing', async () => {
    const { service, fetchClient } = makeService({
      role: 'owner',
      instanceAuthority: false,
    });

    const refusal = service.getModels(ctx, {
      apiUrl: PRIVATE_PROVIDER,
      apiKey: 'sk-test',
    });

    await expect(refusal).rejects.toThrow(ForbiddenException);
    await expect(refusal).rejects.toThrow(PRIVATE_DESTINATION_REFUSAL);
    expect(fetchClient).not.toHaveBeenCalled();
  });

  it('refuses a public name that resolves onto the private network', async () => {
    const { service, fetchClient } = makeService({
      role: 'admin',
      instanceAuthority: false,
      addresses: ['203.0.113.7', '10.1.2.3'],
    });

    await expect(
      service.getModels(ctx, {
        apiUrl: 'https://llm.attacker.example/v1',
        apiKey: 'sk-test',
      }),
    ).rejects.toThrow(PRIVATE_DESTINATION_REFUSAL);
    expect(fetchClient).not.toHaveBeenCalled();
  });

  it('serves an instance admin a provider on the box, which is what Ollama is', async () => {
    const { service, fetchClient } = makeService({
      role: 'admin',
      instanceAuthority: true,
    });

    await expect(
      service.getModels(ctx, {
        apiUrl: 'http://localhost:11434',
        apiKey: '',
      }),
      // The `data` arm of this route's shape-sniffing chain, reduced to
      // `Model`'s four fields — an earlier fix narrowed it from the verbatim passthrough
      // it was. `ai-probe-disclosure.spec.ts` is where that is the subject.
    ).resolves.toEqual([
      {
        id: 'a-model',
        object: 'model',
        created: expect.any(Number) as number,
        owned_by: 'provider',
      },
    ]);
    expect(fetchClient).toHaveBeenCalledWith(
      'http://localhost:11434/api/tags',
      expect.anything(),
    );
  });

  it('answers a refused destination with 403 and not the 400 its own catch would produce', async () => {
    const { service } = makeService({
      role: 'owner',
      instanceAuthority: false,
    });

    // Everything inside `getModels`' try/catch comes back out as a 400 wearing
    // the caught message, so a gate placed in there would report 403's sentence
    // with 400's status.
    await expect(
      service.getModels(ctx, { apiUrl: PRIVATE_PROVIDER, apiKey: 'sk-test' }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('AiService.testConnection', () => {
  it('refuses a plain member without a token spent', async () => {
    const { service, generateText } = makeService({
      role: 'member',
      instanceAuthority: false,
    });

    await expect(
      service.testConnection(ctx, {
        apiUrl: 'https://api.openai.com/v1',
        apiKey: 'sk-test',
        model: 'gpt-4o',
      }),
    ).rejects.toThrow(OWNER_OR_ADMIN_REFUSAL);
    expect(generateText).not.toHaveBeenCalled();
  });

  it('refuses an owner with no instance authority a loopback port, and probes nothing', async () => {
    const { service, generateText } = makeService({
      role: 'owner',
      instanceAuthority: false,
    });

    const refusal = service.testConnection(ctx, {
      apiUrl: 'http://127.0.0.1:2375',
      apiKey: 'sk-test',
      model: 'gpt-4o',
    });

    await expect(refusal).rejects.toThrow(PRIVATE_DESTINATION_REFUSAL);
    await expect(refusal).rejects.toMatchObject({ status: 403 });
    expect(generateText).not.toHaveBeenCalled();
  });
});

describe('AiService.testSavedConnection', () => {
  it('refuses a second organization owner a stored row that names a private address', async () => {
    // The row predates the check at `create`, which is the case this call site
    // exists to cover.
    const { service, generateText } = makeService({
      role: 'owner',
      instanceAuthority: false,
      addresses: ['127.0.0.1'],
    });

    await expect(service.testSavedConnection(ctx, 'ai-1')).rejects.toThrow(
      PRIVATE_DESTINATION_REFUSAL,
    );
    expect(generateText).not.toHaveBeenCalled();
  });
});

describe('AiService.analyzeLogs', () => {
  it('serves a plain member, because the log they are reading is the caller', async () => {
    const { service, generateText, resolve } = makeService({
      role: 'member',
      instanceAuthority: false,
    });

    await expect(
      service.analyzeLogs(ctx, {
        aiId: 'ai-1',
        logs: 'ERROR: exit 1',
        context: 'build',
      }),
    ).resolves.toEqual({ analysis: 'ok' });
    // And the destination is not re-asked here: it is the one an owner
    // committed, so a member using the organization's local Ollama is served
    // rather than refused for holding no authority over the host.
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(resolve).not.toHaveBeenCalled();
  });
});
