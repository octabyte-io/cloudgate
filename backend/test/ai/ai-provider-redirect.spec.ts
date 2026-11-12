import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { generateText } from 'ai';
import type { Dispatcher } from 'undici';
import { AiService } from '../../src/ai/ai.service';
import type {
  TextGenerationArgs,
  TextGenerationResult,
} from '../../src/ai/llm.provider';
import type { Ai } from '../../src/db/schema';
import type { DrizzleDB } from '../../src/db/drizzle.module';
import type { FetchClient } from '../../src/git-providers/fetch.provider';
import {
  OUTBOUND_ADDRESS_REFUSED_CODE,
  OutboundAddressGuard,
} from '../../src/outbound/outbound-address-guard';
import type { AddressResolver } from '../../src/outbound/outbound-address';
import type {
  PermissionCtx,
  PermissionService,
} from '../../src/rbac/permission.service';
import { passThroughGuard } from '../outbound/pass-through-guard';
import { selfHostedOwnAddresses } from '../outbound/self-hosted-own-addresses';

/**
 * A customer's AI provider at a public URL that redirects every request to
 * the cloud metadata address, and what the platform host does with it.
 *
 * `assertPublicApiUrl` checks only the URL that enters, so the fetch used to
 * follow the redirect and `getModels` quoted the metadata answer back in its
 * 400, and the SDK probes went the same way through their own fetch. Every
 * provider request now goes through `OutboundAddressGuard.fetchFor` for the
 * provider's Organization, whose connector refuses the hop before it connects.
 *
 * The guard is the real one. The transport double plays the network: the
 * provider answers with a redirect, and following it opens a connection
 * through whatever dispatcher the request carried, as `fetch` does for each
 * hop. So the refusal under test is the real connector's; without a
 * dispatcher, the double "reaches" the metadata service and answers with
 * {@link METADATA_SECRET}, which is what used to leak.
 */

const INSTANCE_ORG = 'org-instance';
const CUSTOMER_ORG = 'org-customer';
const PROVIDER_URL = 'https://attacker.example/v1';
const METADATA_ORIGIN = 'http://169.254.169.254';
const METADATA_SECRET = 'AKIA-METADATA-ROLE-CREDENTIALS';

const resolve = ((host: string) =>
  host === 'attacker.example'
    ? Promise.resolve(['203.0.113.7'])
    : Promise.reject(
        Object.assign(new Error('nope'), { code: 'ENOTFOUND' }),
      )) as AddressResolver;

/**
 * The network as the platform host sees it: a request to the provider is
 * redirected to the metadata address, and the hop is opened through the
 * request's dispatcher when it has one (a guarded fetch), else reached.
 */
function redirectingNetwork() {
  const hops: string[] = [];
  const network = jest.fn(
    async (input: Parameters<FetchClient>[0], init?: RequestInit) => {
      const href =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      hops.push(href);
      const dispatcher = (init as { dispatcher?: Dispatcher } | undefined)
        ?.dispatcher;
      if (new URL(href).hostname === 'localhost') {
        // The instance organization's own Ollama on the box.
        return new Response(JSON.stringify({ models: [{ name: 'llama3' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      // 302 → the metadata address: the next hop.
      hops.push(`${METADATA_ORIGIN}/latest/meta-data/`);
      if (dispatcher) {
        try {
          await dispatcher.request({
            origin: METADATA_ORIGIN,
            path: '/latest/meta-data/',
            method: 'GET',
          });
        } catch (error) {
          // What `fetch` throws for a connection that failed.
          throw new TypeError('fetch failed', { cause: error });
        }
        throw new Error(
          'the guarded dispatcher connected to the metadata address',
        );
      }
      return new Response(METADATA_SECRET, { status: 500 });
    },
  );
  return { network, hops };
}

function rowIn(organizationId: string, apiUrl = PROVIDER_URL): Ai {
  return {
    aiId: 'ai-1',
    name: 'provider',
    apiUrl,
    apiKey: 'customer-key',
    model: 'some-model',
    isEnabled: true,
    organizationId,
    createdAt: '2026-11-12T00:00:00.000Z',
  };
}

function makeService(options: {
  activeOrganizationId: string;
  instanceAuthority: boolean;
  stored?: Ai;
  guard?: 'real' | 'pass-through';
}) {
  const { network, hops } = redirectingNetwork();
  const permissions = {
    findMember: jest.fn().mockResolvedValue({ role: 'owner' }),
    instanceOrganizationId: () => Promise.resolve(INSTANCE_ORG),
    checkInstanceAuthority: jest.fn(() =>
      options.instanceAuthority
        ? Promise.resolve()
        : Promise.reject(new ForbiddenException('not the instance')),
    ),
  } as unknown as PermissionService;
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve(options.stored ? [options.stored] : []),
        }),
      }),
    }),
  } as unknown as DrizzleDB;
  const guard =
    options.guard === 'pass-through'
      ? passThroughGuard
      : new OutboundAddressGuard(
          resolve,
          permissions,
          db,
          selfHostedOwnAddresses,
        );
  // The real generator, so the SDK's own requests go through the fetch the
  // provider factory was given.
  const generator = (args: TextGenerationArgs) =>
    generateText({
      ...args,
      maxRetries: 0,
    } as Parameters<typeof generateText>[0]) as Promise<TextGenerationResult>;
  const absent = {} as never;
  const service = new AiService(
    db,
    generator,
    network,
    resolve,
    permissions,
    absent,
    // `suggest` reads the platform's address for its prompt.
    { getWebServerSettings: () => Promise.resolve({ serverIp: '' }) } as never,
    absent,
    absent,
    absent,
    guard,
  );
  const ctx: PermissionCtx = {
    user: { id: 'user-1' },
    session: { activeOrganizationId: options.activeOrganizationId },
  };
  return { service, ctx, hops };
}

/** The 400's body, or a failure naming what happened instead. */
async function refusalOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof BadRequestException)) throw error;
    const body = error.getResponse();
    return {
      text: JSON.stringify(body) + error.message,
      body: body as { code?: string; field?: string },
    };
  }
  throw new Error('expected a refusal, and the request succeeded');
}

describe("AiService, on a customer's provider that redirects to the metadata address", () => {
  const customer = () =>
    makeService({
      activeOrganizationId: CUSTOMER_ORG,
      instanceAuthority: false,
      stored: rowIn(CUSTOMER_ORG),
    });

  it('the double does disclose the metadata answer to an unguarded fetch (the control)', async () => {
    const { service, ctx } = makeService({
      activeOrganizationId: CUSTOMER_ORG,
      instanceAuthority: false,
      guard: 'pass-through',
    });

    const refusal = await refusalOf(
      service.getModels(ctx, { apiUrl: PROVIDER_URL, apiKey: 'k' }),
    );

    expect(refusal.text).toContain(METADATA_SECRET);
  });

  it('getModels refuses the redirect hop with the guard’s 400 and echoes nothing of it', async () => {
    const { service, ctx, hops } = customer();

    const refusal = await refusalOf(
      service.getModels(ctx, { apiUrl: PROVIDER_URL, apiKey: 'k' }),
    );

    expect(refusal.body).toMatchObject({
      code: OUTBOUND_ADDRESS_REFUSED_CODE,
      field: 'apiUrl',
    });
    expect(refusal.text).not.toContain(METADATA_SECRET);
    expect(hops).toContain(`${METADATA_ORIGIN}/latest/meta-data/`);
  });

  it('testConnection sends the SDK request through the guard and echoes nothing', async () => {
    const { service, ctx, hops } = customer();

    const refusal = await refusalOf(
      service.testConnection(ctx, {
        apiUrl: PROVIDER_URL,
        apiKey: 'k',
        model: 'some-model',
      }),
    );

    expect(refusal.body.code).toBe(OUTBOUND_ADDRESS_REFUSED_CODE);
    expect(refusal.text).not.toContain(METADATA_SECRET);
    expect(hops[0]).toMatch(/^https:\/\/attacker\.example\/v1\//);
  });

  it('testSavedConnection does the same for a stored destination', async () => {
    const { service, ctx } = customer();

    const refusal = await refusalOf(service.testSavedConnection(ctx, 'ai-1'));

    expect(refusal.body.code).toBe(OUTBOUND_ADDRESS_REFUSED_CODE);
    expect(refusal.text).not.toContain(METADATA_SECRET);
  });

  it('analyzeLogs, a plain member’s call on the stored row, is guarded too', async () => {
    const { service, ctx } = customer();

    const refusal = await refusalOf(
      service.analyzeLogs(ctx, {
        aiId: 'ai-1',
        logs: 'boom',
        context: 'build',
      }),
    );

    expect(refusal.body.code).toBe(OUTBOUND_ADDRESS_REFUSED_CODE);
    expect(refusal.text).not.toContain(METADATA_SECRET);
  });

  it('suggest is guarded too', async () => {
    const { service, ctx } = customer();

    const refusal = await refusalOf(
      service.suggest(ctx, { aiId: 'ai-1', input: 'a blog' }),
    );

    expect(refusal.body.code).toBe(OUTBOUND_ADDRESS_REFUSED_CODE);
    expect(refusal.text).not.toContain(METADATA_SECRET);
  });
});

describe('AiService, for the instance organization (ADR-0013)', () => {
  it('lists its own Ollama on the box, through the transport untouched', async () => {
    const { service, ctx } = makeService({
      activeOrganizationId: INSTANCE_ORG,
      instanceAuthority: true,
    });

    await expect(
      service.getModels(ctx, {
        apiUrl: 'http://localhost:11434',
        apiKey: '',
      }),
    ).resolves.toEqual([expect.objectContaining({ id: 'llama3' })]);
  });

  it('is not refused the redirect hop: its dial is exempt', async () => {
    const { service, ctx } = makeService({
      activeOrganizationId: INSTANCE_ORG,
      instanceAuthority: true,
    });

    const refusal = await refusalOf(
      service.getModels(ctx, { apiUrl: PROVIDER_URL, apiKey: 'k' }),
    );

    // The exempt dial reached what it was sent to, as it did before.
    expect(refusal.body.code).toBeUndefined();
    expect(refusal.text).toContain(METADATA_SECRET);
  });
});
