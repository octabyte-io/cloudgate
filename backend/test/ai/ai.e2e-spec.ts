import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { eq } from 'drizzle-orm';
import { AiService } from '../../src/ai/ai.service';
import { compose } from '../../src/compose/compose.schema';
import { ComposeService } from '../../src/compose/compose.service';
import { domain } from '../../src/domains/domain.schema';
import { DomainsService } from '../../src/domains/domains.service';
import { member, projectConfigLocation } from '../../src/db/schema';
import { CustomRolesService } from '../../src/enterprise/custom-roles/custom-roles.service';
import { licenseKey } from '../../src/enterprise/license/license.schema';
import { LicenseService } from '../../src/enterprise/license/license.service';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { mount } from '../../src/mounts/mount.schema';
import { MountsService } from '../../src/mounts/mounts.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { PermissionService } from '../../src/rbac/permission.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import {
  ADDRESS_RESOLVER,
  PRIVATE_DESTINATION_REFUSAL,
} from '../../src/ai/ai-destination';
import { TEXT_GENERATOR } from '../../src/ai/llm.provider';
import type {
  TextGenerationArgs,
  TextGenerationResult,
} from '../../src/ai/llm.provider';
import { FETCH_CLIENT } from '../../src/git-providers/fetch.provider';
import {
  secondOrganizationOwner,
  signUpMember,
  createOrganization,
} from '../utils/test-auth';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

// Anthropic is the default example provider; the model is the current
// Opus-tier default (claude-api skill).
const anthropicConfig = {
  name: 'anthropic-prod',
  apiUrl: 'https://api.anthropic.com/v1',
  apiKey: 'sk-ant-test-key-do-not-leak',
  model: 'claude-opus-4-8',
};

async function signUp(
  server: App,
  body: { name: string; email: string; password: string },
): Promise<{ cookie: string; id: string }> {
  const res = await request(server).post('/api/auth/sign-up/email').send(body);
  expect(res.status).toBe(200);
  const { user } = res.body as { user: { id: string } };
  return { cookie: res.headers['set-cookie'], id: user.id };
}

/** The owner's bootstrap organization plus a service-seam permission ctx. */
async function setUpOwner(server: App) {
  const ownerSession = await signUp(server, owner);

  const orgs = await request(server)
    .get('/organizations')
    .set('Cookie', ownerSession.cookie);
  const organizationId = (orgs.body as { id: string }[])[0].id;

  return { organizationId, owner: ownerSession };
}

const permissionCtx = (userId: string, organizationId: string) => ({
  user: { id: userId },
  session: { activeOrganizationId: organizationId },
});

/** `AiService.ensureOwnerOrAdmin`'s refusal, written out. */
const OWNER_OR_ADMIN_REFUSAL = 'Only owners and admins can manage AI settings';

/** The message an `AllExceptionsFilter` response carries. */
const refusal = (res: { body: unknown }): string =>
  (res.body as { message: string }).message;

/** A complete suggestion as the mocked SDK would return it. */
const chatwootSuggestion = {
  id: 'chatwoot-postgres',
  name: 'Chatwoot with PostgreSQL',
  shortDescription: 'Chatwoot backed by PostgreSQL and Redis',
  description: 'Customer support platform with its full stack.',
  dockerCompose:
    'services:\n  app:\n    image: sendingtk/chatwoot:develop\n    ports:\n      - "3000"\n',
  envVariables: [{ name: 'SECRET_KEY_BASE', value: 'mypassword123' }],
  // No trailing hyphen on the label: `generateDomain` emits
  // `<appName>-<hash>.sslip.io` on the platform host, and an RFC 1123 label
  // cannot end in `-` — which `hostSchema` now refuses on this route too.
  domains: [{ host: 'app-a1b.sslip.io', port: 3000, serviceName: 'app' }],
  configFiles: null,
};

describe('AI (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let ai: AiService;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let mounts: MountsService;
  let composeService: ComposeService;
  let domains: DomainsService;
  let customRoles: CustomRolesService;
  let permissions: PermissionService;
  const generateText = jest.fn<
    Promise<TextGenerationResult>,
    [TextGenerationArgs]
  >();
  const fetchMock = jest.fn<Promise<Response>, [string, RequestInit?]>();
  // The third boundary, beside the LLM and the fetch: name resolution.
  // Defaulted to a routable address in `beforeEach`, so every existing case
  // reads as the public provider it names and no test reaches real DNS.
  const resolveMock = jest.fn<Promise<string[]>, [string]>();
  const execMock = {
    execAsync: jest.fn(),
    execAsyncRemote: jest.fn(),
  };
  // Custom roles are enterprise-only and resolve through the license
  // (`PermissionService.resolveRole`). Mocked so the custom-role deploy case
  // below can hold one; every other test in this file runs unlicensed, which
  // is what an unmocked instance answers too. By default the mock answers from
  // the Organization's license row, as the real service does: no test here
  // writes one, but `createOrganization` (and `secondOrganizationOwner`) license
  // the Instance organization through it for the one request that makes a
  // second Organization (the Self-hosted one-Organization limit).
  const license = { hasValidLicense: jest.fn<Promise<boolean>, [string]>() };
  const licenseRowValid = async (organizationId: string) => {
    const [row] = await ctx.db
      .select()
      .from(licenseKey)
      .where(eq(licenseKey.organizationId, organizationId))
      .limit(1);
    return (
      !!row?.key &&
      row.enableEnterpriseFeatures &&
      row.status === 'active' &&
      (!row.validUntil || row.validUntil.getTime() > Date.now())
    );
  };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: TEXT_GENERATOR, useValue: generateText },
        { provide: FETCH_CLIENT, useValue: fetchMock },
        { provide: ADDRESS_RESOLVER, useValue: resolveMock },
        { provide: RemoteExecService, useValue: execMock },
        { provide: LicenseService, useValue: license },
      ],
    });
    server = ctx.app.getHttpServer() as App;
    ai = ctx.app.get(AiService);
    projects = ctx.app.get(ProjectsService);
    environments = ctx.app.get(EnvironmentsService);
    mounts = ctx.app.get(MountsService);
    composeService = ctx.app.get(ComposeService);
    domains = ctx.app.get(DomainsService);
    customRoles = ctx.app.get(CustomRolesService);
    permissions = ctx.app.get(PermissionService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    generateText.mockReset();
    fetchMock.mockReset();
    resolveMock.mockReset().mockResolvedValue(['203.0.113.7']);
    license.hasValidLicense.mockReset().mockImplementation(licenseRowValid);
    execMock.execAsync
      .mockReset()
      .mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    execMock.execAsyncRemote
      .mockReset()
      .mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
  });

  describe('provider config CRUD', () => {
    it('stores a config retrievable by id, apiKey encrypted at rest and stripped from responses', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      const created = await ai.create(ownerCtx, anthropicConfig);

      expect(created.aiId).toEqual(expect.any(String));
      expect(created.organizationId).toBe(organizationId);
      expect(created.isEnabled).toBe(true);
      expect(created).not.toHaveProperty('apiKey');

      const found = await ai.findOne(ownerCtx, created.aiId);
      expect(found).toMatchObject({
        aiId: created.aiId,
        name: 'anthropic-prod',
        apiUrl: 'https://api.anthropic.com/v1',
        model: 'claude-opus-4-8',
        isEnabled: true,
        organizationId,
      });
      expect(found).not.toHaveProperty('apiKey');

      const raw = await ctx.db.$client.query<{ api_key: string }>(
        'select api_key from ai where ai_id = $1',
        [created.aiId],
      );
      expect(raw.rows[0].api_key).not.toContain('sk-ant-test-key-do-not-leak');
      expect(raw.rows[0].api_key.startsWith('enc:v1:')).toBe(true);
    });

    it('lists the organization configs newest first, keys stripped', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      await ai.create(ownerCtx, { ...anthropicConfig, name: 'older' });
      await new Promise((resolve) => setTimeout(resolve, 5));
      await ai.create(ownerCtx, { ...anthropicConfig, name: 'newer' });

      const listed = await ai.list(ownerCtx);
      expect(listed.map((row) => row.name)).toEqual(['newer', 'older']);
      for (const item of listed) {
        expect(item).not.toHaveProperty('apiKey');
      }
    });

    it('updates the given fields; a rotated key is re-encrypted and still stripped', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      const created = await ai.create(ownerCtx, anthropicConfig);

      const updated = await ai.update(ownerCtx, created.aiId, {
        name: 'renamed',
        model: 'claude-haiku-4-5',
        isEnabled: false,
        apiKey: 'sk-ant-rotated-key',
      });
      expect(updated).toMatchObject({
        aiId: created.aiId,
        name: 'renamed',
        model: 'claude-haiku-4-5',
        isEnabled: false,
        apiUrl: 'https://api.anthropic.com/v1',
      });
      expect(updated).not.toHaveProperty('apiKey');

      const raw = await ctx.db.$client.query<{ api_key: string }>(
        'select api_key from ai where ai_id = $1',
        [created.aiId],
      );
      expect(raw.rows[0].api_key).not.toContain('sk-ant-rotated-key');
      expect(raw.rows[0].api_key.startsWith('enc:v1:')).toBe(true);
    });

    it('removes the config', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      const created = await ai.create(ownerCtx, anthropicConfig);

      const removed = await ai.remove(ownerCtx, created.aiId);
      expect(removed.aiId).toBe(created.aiId);
      expect(removed).not.toHaveProperty('apiKey');

      await expect(ai.findOne(ownerCtx, created.aiId)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('getEnabledProviders', () => {
    it('returns only enabled configs, reduced to aiId/name/model', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      const enabled = await ai.create(ownerCtx, anthropicConfig);
      await ai.create(ownerCtx, {
        ...anthropicConfig,
        name: 'disabled-provider',
        isEnabled: false,
      });

      const providers = await ai.getEnabledProviders(ownerCtx);
      expect(providers).toEqual([
        {
          aiId: enabled.aiId,
          name: 'anthropic-prod',
          model: 'claude-opus-4-8',
        },
      ]);
    });
  });

  describe('admin gating', () => {
    it('denies a plain member the config CRUD but not getEnabledProviders', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);
      const memberSession = await signUpMember(server, ownerSession.cookie);
      const memberCtx = permissionCtx(memberSession.id, organizationId);

      const created = await ai.create(ownerCtx, anthropicConfig);

      await expect(ai.create(memberCtx, anthropicConfig)).rejects.toThrow(
        ForbiddenException,
      );
      await expect(ai.list(memberCtx)).rejects.toThrow(ForbiddenException);
      await expect(ai.findOne(memberCtx, created.aiId)).rejects.toThrow(
        ForbiddenException,
      );
      await expect(
        ai.update(memberCtx, created.aiId, { name: 'nope' }),
      ).rejects.toThrow(ForbiddenException);
      await expect(ai.remove(memberCtx, created.aiId)).rejects.toThrow(
        ForbiddenException,
      );

      // getEnabledProviders asks for no admin role — members pass.
      const providers = await ai.getEnabledProviders(memberCtx);
      expect(providers).toHaveLength(1);
    });
  });

  describe('HTTP endpoint surface', () => {
    it('supports the full CRUD round-trip over HTTP, never leaking the apiKey', async () => {
      const { owner: ownerSession } = await setUpOwner(server);
      const cookie = ownerSession.cookie;

      const created = await request(server)
        .post('/ai')
        .set('Cookie', cookie)
        .send(anthropicConfig);
      expect(created.status).toBe(201);
      expect(created.body).not.toHaveProperty('apiKey');
      const id = (created.body as { aiId: string }).aiId;

      const rejected = await request(server)
        .post('/ai')
        .set('Cookie', cookie)
        .send({ ...anthropicConfig, apiUrl: 'not-a-url' });
      expect(rejected.status).toBe(400);

      const listed = await request(server).get('/ai').set('Cookie', cookie);
      expect(listed.status).toBe(200);
      const listedBody = listed.body as { name: string }[];
      expect(listedBody.map((row) => row.name)).toEqual(['anthropic-prod']);
      expect(listedBody[0]).not.toHaveProperty('apiKey');

      const one = await request(server).get(`/ai/${id}`).set('Cookie', cookie);
      expect(one.status).toBe(200);
      expect(one.body).toMatchObject({
        name: 'anthropic-prod',
        model: 'claude-opus-4-8',
      });
      expect(one.body).not.toHaveProperty('apiKey');

      const enabled = await request(server)
        .get('/ai/enabled-providers')
        .set('Cookie', cookie);
      expect(enabled.status).toBe(200);
      expect(enabled.body).toEqual([
        { aiId: id, name: 'anthropic-prod', model: 'claude-opus-4-8' },
      ]);

      const patched = await request(server)
        .patch(`/ai/${id}`)
        .set('Cookie', cookie)
        .send({ isEnabled: false });
      expect(patched.status).toBe(200);
      expect(patched.body).toMatchObject({ isEnabled: false });
      expect(patched.body).not.toHaveProperty('apiKey');

      const removed = await request(server)
        .delete(`/ai/${id}`)
        .set('Cookie', cookie);
      expect(removed.status).toBe(200);

      const gone = await request(server).get(`/ai/${id}`).set('Cookie', cookie);
      expect(gone.status).toBe(404);
    });

    it('exposes the generate surface over HTTP (suggest, analyze, test, models, deploy)', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const cookie = ownerSession.cookie;
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);
      const config = await ai.create(ownerCtx, anthropicConfig);
      const project = await projects.create(ownerCtx, { name: 'support' });
      const environment = await environments.create(ownerCtx, {
        name: 'production',
        projectId: project.projectId,
      });

      generateText.mockResolvedValue({
        text: 'Healthy.',
        output: { suggestions: [chatwootSuggestion] },
      });

      const suggested = await request(server)
        .post('/ai/suggest')
        .set('Cookie', cookie)
        .send({ aiId: config.aiId, input: 'deploy Chatwoot' });
      expect(suggested.status).toBe(200);
      expect(suggested.body).toEqual([chatwootSuggestion]);

      const analyzed = await request(server)
        .post('/ai/analyze-logs')
        .set('Cookie', cookie)
        .send({ aiId: config.aiId, logs: 'some logs', context: 'build' });
      expect(analyzed.status).toBe(200);
      expect(analyzed.body).toEqual({ analysis: 'Healthy.' });

      const tested = await request(server)
        .post('/ai/test-connection')
        .set('Cookie', cookie)
        .send({
          apiUrl: 'https://api.anthropic.com/v1',
          apiKey: 'sk-ant-test',
          model: 'claude-opus-4-8',
        });
      expect(tested.status).toBe(200);
      expect(tested.body).toEqual({
        success: true,
        message: 'Connection successful',
      });

      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: [{ id: 'claude-opus-4-8' }] }),
        text: () => Promise.resolve(''),
      } as unknown as Response);
      const models = await request(server)
        .post('/ai/models')
        .set('Cookie', cookie)
        .send({ apiUrl: 'https://api.anthropic.com/v1', apiKey: 'sk-ant' });
      expect(models.status).toBe(200);
      // `Model`'s four fields, not the object the target wrote: an earlier fix narrowed
      // every arm of the shape-sniffing chain to the `id` the console renders.
      expect(models.body).toEqual([
        {
          id: 'claude-opus-4-8',
          object: 'model',
          created: expect.any(Number) as number,
          owned_by: 'provider',
        },
      ]);

      const deployed = await request(server)
        .post('/ai/deploy')
        .set('Cookie', cookie)
        .send({
          environmentId: environment.environmentId,
          id: 'chatwoot-postgres',
          name: 'Chatwoot',
          description: 'Support platform',
          dockerCompose: chatwootSuggestion.dockerCompose,
          envVariables: 'A=b',
        });
      expect(deployed.status).toBe(201);
      expect(deployed.body).toMatchObject({ name: 'Chatwoot' });

      const invalid = await request(server)
        .post('/ai/deploy')
        .set('Cookie', cookie)
        .send({ environmentId: environment.environmentId, id: '' });
      expect(invalid.status).toBe(400);
    });

    it('denies members the admin endpoints over HTTP', async () => {
      const { owner: ownerSession } = await setUpOwner(server);
      const memberSession = await signUpMember(server, ownerSession.cookie);

      const created = await request(server)
        .post('/ai')
        .set('Cookie', memberSession.cookie)
        .send(anthropicConfig);
      // The message, not the bare 403: the controller's `toCtx` refuses a
      // member with no active organization first, so a status-only assertion
      // would pass with `ensureOwnerOrAdmin` deleted.
      expect([created.status, refusal(created)]).toEqual([
        403,
        OWNER_OR_ADMIN_REFUSAL,
      ]);

      const listed = await request(server)
        .get('/ai')
        .set('Cookie', memberSession.cookie);
      expect([listed.status, refusal(listed)]).toEqual([
        403,
        OWNER_OR_ADMIN_REFUSAL,
      ]);

      const enabled = await request(server)
        .get('/ai/enabled-providers')
        .set('Cookie', memberSession.cookie);
      expect([enabled.status, enabled.body]).toEqual([200, []]);
    });
  });

  describe('suggest', () => {
    it('calls the selected provider with the DevOps prompt and returns suggestions that carry a compose file', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);
      const config = await ai.create(ownerCtx, anthropicConfig);

      generateText.mockResolvedValue({
        text: '',
        output: {
          suggestions: [
            chatwootSuggestion,
            { ...chatwootSuggestion, id: 'chatwoot-empty', dockerCompose: '' },
          ],
        },
      });

      const suggestions = await ai.suggest(ownerCtx, {
        aiId: config.aiId,
        input: 'deploy Chatwoot',
      });

      // Suggestions without a compose file are dropped.
      expect(suggestions).toEqual([chatwootSuggestion]);

      expect(generateText).toHaveBeenCalledTimes(1);
      const args = generateText.mock.calls[0][0];
      // The model comes from selectAIProvider against the stored config: the
      // apiUrl routes to the Anthropic provider and the stored model id.
      const model = args.model as { modelId: string; provider: string };
      expect(model.modelId).toBe('claude-opus-4-8');
      expect(model.provider).toContain('anthropic');
      expect(args.prompt).toContain('Act as advanced DevOps engineer');
      expect(args.prompt).toContain("User's request: deploy Chatwoot");
      // Structured output is requested (Output.object over the suggestions schema).
      expect(args.output).toBeDefined();
    });

    it('rejects a disabled config with a 400 saying AI features are not enabled', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);
      const config = await ai.create(ownerCtx, {
        ...anthropicConfig,
        isEnabled: false,
      });

      await expect(
        ai.suggest(ownerCtx, { aiId: config.aiId, input: 'a blog' }),
      ).rejects.toThrow(
        new BadRequestException(
          'AI features are not enabled for this configuration',
        ),
      );
      expect(generateText).not.toHaveBeenCalled();
    });

    it('maps an empty suggestions output to the 400 No suggestions found', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);
      const config = await ai.create(ownerCtx, anthropicConfig);

      generateText.mockResolvedValue({ text: '', output: { suggestions: [] } });

      await expect(
        ai.suggest(ownerCtx, { aiId: config.aiId, input: 'a blog' }),
      ).rejects.toThrow(new BadRequestException('No suggestions found'));
    });
  });

  describe('analyzeLogs', () => {
    it('sends the logs with the context label and returns the analysis text', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);
      const config = await ai.create(ownerCtx, anthropicConfig);

      generateText.mockResolvedValue({ text: 'Everything looks healthy.' });

      const result = await ai.analyzeLogs(ownerCtx, {
        aiId: config.aiId,
        logs: 'ERROR: connection refused to db:5432',
        context: 'build',
      });
      expect(result).toEqual({ analysis: 'Everything looks healthy.' });

      const args = generateText.mock.calls[0][0];
      expect(args.prompt).toContain(
        'You are a DevOps engineer analyzing build/deployment logs.',
      );
      expect(args.prompt).toContain('ERROR: connection refused to db:5432');
      const model = args.model as { modelId: string };
      expect(model.modelId).toBe('claude-opus-4-8');
    });

    it('labels runtime logs runtime/container and 400s on a disabled provider', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);
      const enabled = await ai.create(ownerCtx, anthropicConfig);
      const disabled = await ai.create(ownerCtx, {
        ...anthropicConfig,
        name: 'disabled',
        isEnabled: false,
      });

      generateText.mockResolvedValue({ text: 'ok' });
      await ai.analyzeLogs(ownerCtx, {
        aiId: enabled.aiId,
        logs: 'log line',
        context: 'runtime',
      });
      expect(generateText.mock.calls[0][0].prompt).toContain(
        'analyzing runtime/container logs',
      );

      await expect(
        ai.analyzeLogs(ownerCtx, {
          aiId: disabled.aiId,
          logs: 'log line',
          context: 'build',
        }),
      ).rejects.toThrow(new BadRequestException('AI provider is not enabled'));
    });
  });

  describe('testConnection', () => {
    it('reports success when the model answers, 400 when it stays silent or errors', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      generateText.mockResolvedValueOnce({ text: 'ok' });
      const result = await ai.testConnection(ownerCtx, {
        apiUrl: 'https://api.anthropic.com/v1',
        apiKey: 'sk-ant-test',
        model: 'claude-opus-4-8',
      });
      expect(result).toEqual({
        success: true,
        message: 'Connection successful',
      });
      expect(generateText.mock.calls[0][0].prompt).toBe("Reply with 'ok'");

      generateText.mockResolvedValueOnce({ text: '' });
      await expect(
        ai.testConnection(ownerCtx, {
          apiUrl: 'https://api.anthropic.com/v1',
          apiKey: 'sk-ant-test',
          model: 'claude-opus-4-8',
        }),
      ).rejects.toThrow(
        new BadRequestException('No response received from the model'),
      );

      generateText.mockRejectedValueOnce(new Error('invalid x-api-key'));
      await expect(
        ai.testConnection(ownerCtx, {
          apiUrl: 'https://api.anthropic.com/v1',
          apiKey: 'sk-ant-bad',
          model: 'claude-opus-4-8',
        }),
      ).rejects.toThrow(new BadRequestException('invalid x-api-key'));
    });
  });

  // `POST /ai/test-connection` takes a URL, a key and a model, and
  // the key never comes back on a read — so "is the provider I configured in
  // March still answering?" had no route. The id-taking variant loads the row's
  // decrypted apiKey server-side, the same lookup `suggest` already does.
  describe('POST /ai/:id/test-connection — testing a saved provider', () => {
    it('runs the one-token probe against the stored provider and model', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);
      const config = await ai.create(ownerCtx, anthropicConfig);

      generateText.mockResolvedValueOnce({ text: 'ok' });
      const probe = await request(server)
        .post(`/ai/${config.aiId}/test-connection`)
        .set('Cookie', ownerSession.cookie);
      expect(probe.status).toBe(200);
      expect(probe.body).toEqual({
        success: true,
        message: 'Connection successful',
      });

      // Nothing was sent: the model and the provider both come off the row.
      const args = generateText.mock.calls[0][0];
      const model = args.model as { modelId: string; provider: string };
      expect(model.modelId).toBe('claude-opus-4-8');
      expect(model.provider).toContain('anthropic');
      expect(args.prompt).toBe("Reply with 'ok'");
      expect(JSON.stringify(probe.body)).not.toContain(anthropicConfig.apiKey);
    });

    it('maps a silent model and a provider error to a 400, the stored key redacted', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);
      const config = await ai.create(ownerCtx, anthropicConfig);

      generateText.mockResolvedValueOnce({ text: '' });
      const silent = await request(server)
        .post(`/ai/${config.aiId}/test-connection`)
        .set('Cookie', ownerSession.cookie);
      expect(silent.status).toBe(400);
      expect((silent.body as { message: string }).message).toBe(
        'No response received from the model',
      );

      // A provider that quotes the key it rejected — the caller never sent it,
      // so the caller cannot take it back out.
      generateText.mockRejectedValueOnce(
        new Error(
          `invalid x-api-key: ${anthropicConfig.apiKey} is not authorized`,
        ),
      );
      const refused = await request(server)
        .post(`/ai/${config.aiId}/test-connection`)
        .set('Cookie', ownerSession.cookie);
      expect(refused.status).toBe(400);
      const { message } = refused.body as { message: string };
      expect(message).not.toContain(anthropicConfig.apiKey);
      expect(message).toContain('invalid x-api-key');
      expect(message).toContain('is not authorized');
    });

    it('an id from another Organization reads as absent', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);

      const secondOrg = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Org' },
      );
      const secondOrgCtx = permissionCtx(
        ownerSession.id,
        (secondOrg.body as { id: string }).id,
      );
      const foreign = await ai.create(secondOrgCtx, anthropicConfig);

      const probe = await request(server)
        .post(`/ai/${foreign.aiId}/test-connection`)
        .set('Cookie', ownerSession.cookie);
      expect(probe.status).toBe(404);
      expect(generateText).not.toHaveBeenCalled();

      const firstOrgCtx = permissionCtx(ownerSession.id, organizationId);
      await expect(
        ai.testSavedConnection(firstOrgCtx, foreign.aiId),
      ).rejects.toThrow(NotFoundException);
    });

    it('is admin-gated like every other route that names a config', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);
      const config = await ai.create(ownerCtx, anthropicConfig);
      const member = await signUpMember(server, ownerSession.cookie);

      const probe = await request(server)
        .post(`/ai/${config.aiId}/test-connection`)
        .set('Cookie', member.cookie);
      expect([probe.status, refusal(probe)]).toEqual([
        403,
        OWNER_OR_ADMIN_REFUSAL,
      ]);
      expect(generateText).not.toHaveBeenCalled();
    });

    it('the credential-taking route is untouched — a provider is still provable before it is saved', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      generateText.mockResolvedValueOnce({ text: 'ok' });
      const probe = await request(server)
        .post('/ai/test-connection')
        .set('Cookie', ownerSession.cookie)
        .send({
          apiUrl: 'https://api.anthropic.com/v1',
          apiKey: 'sk-ant-not-saved-anywhere',
          model: 'claude-opus-4-8',
        });
      expect(probe.status).toBe(200);
      expect(probe.body).toEqual({
        success: true,
        message: 'Connection successful',
      });
      expect(await ai.list(ownerCtx)).toEqual([]);
    });
  });

  describe('getModels', () => {
    const asResponse = (body: unknown, ok = true): Response =>
      ({
        ok,
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(JSON.stringify(body)),
      }) as unknown as Response;

    it('fetches /models with Anthropic headers and returns the data array', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      const models = [
        {
          id: 'claude-opus-4-8',
          object: 'model',
          created: 1,
          owned_by: 'anthropic',
        },
      ];
      fetchMock.mockResolvedValue(asResponse({ data: models }));

      const result = await ai.getModels(ownerCtx, {
        apiUrl: 'https://api.anthropic.com/v1',
        apiKey: 'sk-ant-test',
      });
      // The provider's own `created` and `owned_by` are *not* repeated since
      // The `data` arm used to be handed back verbatim, and nothing
      // reads either field ("Only `id` reaches the screen", `endpoints/ai.ts`).
      expect(result).toEqual([
        {
          id: 'claude-opus-4-8',
          object: 'model',
          created: expect.any(Number) as number,
          owned_by: 'provider',
        },
      ]);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.anthropic.com/v1/models',
        {
          headers: {
            'x-api-key': 'sk-ant-test',
            'anthropic-version': '2023-06-01',
          },
        },
      );
    });

    it('fetches ollama tags and maps model names to ids', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      fetchMock.mockResolvedValue(
        asResponse({ models: [{ name: 'llama3.3:latest' }] }),
      );

      const result = (await ai.getModels(ownerCtx, {
        apiUrl: 'http://localhost:11434',
        apiKey: '',
      })) as Array<{ id: string; object: string }>;
      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:11434/api/tags',
        { headers: { Authorization: 'Bearer ' } },
      );
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: 'llama3.3:latest',
        object: 'model',
        owned_by: 'provider',
      });
    });

    it('answers the hardcoded list for providers without a models endpoint', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      const result = (await ai.getModels(ownerCtx, {
        apiUrl: 'https://api.z.ai/v1',
        apiKey: 'zai-key',
      })) as Array<{ id: string }>;
      expect(result.map((m) => m.id)).toEqual(['glm-5', 'glm-4.7']);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('400s on a missing key for key-requiring providers and on provider errors', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);

      await expect(
        ai.getModels(ownerCtx, {
          apiUrl: 'https://api.anthropic.com/v1',
          apiKey: '',
        }),
      ).rejects.toThrow(
        new BadRequestException('API key must contain at least 1 character(s)'),
      );

      fetchMock.mockResolvedValue(asResponse({ error: 'nope' }, false));
      await expect(
        ai.getModels(ownerCtx, {
          apiUrl: 'https://api.anthropic.com/v1',
          apiKey: 'sk-ant-test',
        }),
      ).rejects.toThrow(BadRequestException);
    });
  });

  /**
   * The HTTP half of the probe-disclosure fix. `ai-probe-disclosure.spec.ts` asserts the
   * request that left and the sentence that came back at the service seam,
   * where both are visible without a Postgres; these three cases are the ones
   * a service-level assertion cannot make — the global pipe answers the DTO
   * refusal before `AiService` is entered at all, and the capped message has to
   * be capped *on the wire*, after `AllExceptionsFilter` has rendered it.
   */
  describe('what the two probes disclose', () => {
    const bigBody = (tail: string) =>
      ({
        ok: false,
        json: () => Promise.resolve({}),
        text: () =>
          Promise.resolve(`Bad gateway: ${'A'.repeat(20_000)}${tail}`),
      }) as unknown as Response;

    it('refuses an apiUrl that is not a URL at both credential-taking probes, and asks nothing', async () => {
      const { owner: ownerSession } = await setUpOwner(server);

      const models = await request(server)
        .post('/ai/models')
        .set('Cookie', ownerSession.cookie)
        .send({ apiUrl: 'api.openai.com/v1', apiKey: 'sk-x' });
      expect(models.status).toBe(400);
      expect(models.body).toMatchObject({
        message: 'Validation failed',
        details: [{ path: 'apiUrl', message: 'Please enter a valid URL' }],
      });

      const tested = await request(server)
        .post('/ai/test-connection')
        .set('Cookie', ownerSession.cookie)
        .send({
          apiUrl: 'ollama on the box',
          apiKey: 'sk-x',
          model: 'llama3.3',
        });
      expect(tested.status).toBe(400);
      expect(tested.body).toMatchObject({
        message: 'Validation failed',
        details: [{ path: 'apiUrl', message: 'Please enter a valid URL' }],
      });

      // The DTO is the layer pinned here, and it is the only one that answers
      // for *this* caller: the instance owner skips the destination check
      // entirely (ADR-0013), so `assertPublicApiUrl`'s http(s) refusal never
      // runs for them. Nothing was resolved, fetched or generated.
      expect(resolveMock).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(generateText).not.toHaveBeenCalled();
    });

    it('sends a Google key in a header and writes no key into the URL', async () => {
      const { owner: ownerSession } = await setUpOwner(server);
      const geminiUrl = 'https://generativelanguage.googleapis.com/v1beta';
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ models: [{ name: 'gemini-3.5-flash' }] }),
        text: () => Promise.resolve(''),
      } as unknown as Response);

      const served = await request(server)
        .post('/ai/models')
        .set('Cookie', ownerSession.cookie)
        .send({ apiUrl: geminiUrl, apiKey: 'AIzaSy-not-a-real-google-key' });

      expect(served.status).toBe(200);
      // The URL is the part a target's access log keeps, so it is asserted
      // whole rather than by a `not.toContain`.
      expect(fetchMock).toHaveBeenCalledWith(`${geminiUrl}/models`, {
        headers: { 'x-goog-api-key': 'AIzaSy-not-a-real-google-key' },
      });
    });

    it('bounds the provider body a refusal quotes, on the wire', async () => {
      const { owner: ownerSession } = await setUpOwner(server);
      fetchMock.mockResolvedValue(bigBody('SECRET-PAGE-TAIL'));

      const refused = await request(server)
        .post('/ai/models')
        .set('Cookie', ownerSession.cookie)
        .send({ apiUrl: 'https://api.openai.com/v1', apiKey: 'sk-x' });

      expect(refused.status).toBe(400);
      const message = refusal(refused);
      // The provider's own words survive, which is why they are quoted at all.
      expect(message).toContain('Failed to fetch models: Bad gateway:');
      expect(message).not.toContain('SECRET-PAGE-TAIL');
      expect(message.endsWith('…')).toBe(true);
      expect(message.length).toBeLessThanOrEqual(501);
    });
  });

  describe('deploy', () => {
    /** An owner ctx plus a project + environment to deploy suggestions into. */
    async function setUpEnvironment() {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);
      const project = await projects.create(ownerCtx, { name: 'support' });
      const environment = await environments.create(ownerCtx, {
        name: 'production',
        projectId: project.projectId,
      });
      return { organizationId, ownerSession, ownerCtx, project, environment };
    }

    const deployInput = (environmentId: string) => ({
      environmentId,
      id: 'chatwoot-postgres',
      name: 'Chatwoot with PostgreSQL',
      description: 'Customer support platform with its full stack.',
      dockerCompose: chatwootSuggestion.dockerCompose,
      envVariables: 'SECRET_KEY_BASE=mypassword123',
      domains: chatwootSuggestion.domains,
      configFiles: [
        { filePath: './config/database.yml', content: 'adapter: postgresql' },
      ],
    });

    it('instantiates the suggestion: raw compose + env + domains + file mounts', async () => {
      const { ownerCtx, environment } = await setUpEnvironment();

      const compose = await ai.deploy(
        ownerCtx,
        deployInput(environment.environmentId),
      );

      expect(compose).toMatchObject({
        name: 'Chatwoot with PostgreSQL',
        description: 'Customer support platform with its full stack.',
        environmentId: environment.environmentId,
        sourceType: 'raw',
        composeFile: chatwootSuggestion.dockerCompose,
        env: 'SECRET_KEY_BASE=mypassword123',
        isolatedDeployment: true,
        serverId: null,
      });
      // slugify('<project name> <suggestion id>') + '-<generatePassword(6)>'
      // (slugify is strict: it drops the suggestion id's inner hyphen).
      expect(compose.appName).toMatch(/^support-chatwootpostgres-[a-z0-9]{6}$/);

      // The stack joins the Project's Cloudgate-kept config as a
      // console-managed line.
      const [location] = await ctx.db
        .select({ text: projectConfigLocation.text })
        .from(projectConfigLocation)
        .where(eq(projectConfigLocation.projectId, environment.projectId));
      expect(location.text).toContain(
        `  ${compose.configName}:\n    kind: compose\n    managed: console\n`,
      );

      const domains = await ctx.db.$client.query<{
        host: string;
        port: number;
        service_name: string;
        domain_type: string;
        certificate_type: string;
      }>('select * from domain where compose_id = $1', [compose.composeId]);
      expect(domains.rows).toHaveLength(1);
      expect(domains.rows[0]).toMatchObject({
        host: 'app-a1b.sslip.io',
        port: 3000,
        service_name: 'app',
        domain_type: 'compose',
        certificate_type: 'none',
      });

      const mountRows = await mounts.listByService(ownerCtx, {
        serviceId: compose.composeId,
        serviceType: 'compose',
      });
      expect(mountRows).toHaveLength(1);
      expect(mountRows[0]).toMatchObject({
        type: 'file',
        filePath: './config/database.yml',
        content: 'adapter: postgresql',
        mountPath: '',
      });
    });

    /**
     * `AiService.deploy` loops `configFiles` into `MountsService.create`
     * with an object it built, so the global pipe never validated it and the
     * traversal refusal — which lives on `createMountSchema` — did not apply:
     * `filePath` was `z.string().min(1)`, the exact shape the traversal rule
     * replaced, taken straight off this request body. `getCreateFileCommand` joins it onto
     * `…/<appName>/files` with a `path.join` that normalises `../` away.
     *
     * **The layer pinned is the route and its DTO**, which is where the fix
     * went (`deployAiSchema.configFiles[].filePath` derives from the exported
     * `filePathSchema`): a service-level test would pass against a fix that put
     * the rule inside `MountsService` instead, and vice versa. The path carries
     * no shell metacharacter, so `resolveShellSafePath`'s separate refusal
     * is not what answers here.
     */
    it('refuses a configFiles filePath that escapes the service files directory', async () => {
      const { ownerSession, environment } = await setUpEnvironment();

      const refused = await request(server)
        .post('/ai/deploy')
        .set('Cookie', ownerSession.cookie)
        .send({
          ...deployInput(environment.environmentId),
          configFiles: [
            { filePath: '../../../etc/cloudgate/x', content: 'http: {}' },
          ],
        });

      expect(refused.status).toBe(400);
      expect(refused.body).toMatchObject({
        message: 'Validation failed',
        details: [
          {
            path: 'configFiles.0.filePath',
            message: 'filePath must stay inside the service files directory',
          },
        ],
      });

      // Nothing was written on the way to being refused: no file on the build
      // server, and no stack, mount or domain row either.
      expect(execMock.execAsync).not.toHaveBeenCalled();
      expect({
        compose: (await ctx.db.select().from(compose)).length,
        mounts: (await ctx.db.select().from(mount)).length,
        domains: (await ctx.db.select().from(domain)).length,
      }).toEqual({ compose: 0, mounts: 0, domains: 0 });
    });

    /**
     * The sibling of the mount case above: `AiService.deploy` loops
     * `domains` into `DomainsService.create` with an object it built, so the
     * global pipe never validated it and the host refusal — which lives on
     * `hostSchema` — did not apply. `host` was `z.string().min(1)`, the exact
     * shape the host rule replaced, straight off this request body, and a compose
     * domain's host is interpolated into a Traefik router label the Docker
     * provider parses as a rule.
     *
     * **The layer pinned is the route and its DTO**, which is where the fix went
     * (`deployAiSchema.domains[].host` derives from the exported `hostSchema`):
     * a service-level test would pass against a fix placed inside
     * `DomainsService` instead, and vice versa. This route's gate is
     * `service:['create']`, which `memberRole` does not hold — so the bar is
     * the host rule's rather than the Domain-injection fix's, and that is why it
     * is a fix at the same level rather than a more urgent one.
     */
    it('refuses a domains host that carries a Traefik router rule of its own', async () => {
      const { ownerSession, environment } = await setUpEnvironment();

      const refused = await request(server)
        .post('/ai/deploy')
        .set('Cookie', ownerSession.cookie)
        .send({
          ...deployInput(environment.environmentId),
          domains: [
            {
              host: 'x.example.com`) || Host(`victim.example.com',
              port: 3000,
              serviceName: 'app',
            },
          ],
        });

      expect(refused.status).toBe(400);
      expect(refused.body).toMatchObject({
        message: 'Validation failed',
        details: [
          {
            path: 'domains.0.host',
            message:
              'Invalid domain name. Use only letters, numbers, hyphens and dots (e.g. example.com). Underscores are not allowed.',
          },
        ],
      });

      // Nothing was written on the way to being refused: no stack, no mount and
      // no domain row, so the router label the host would have become never
      // reached a compose file.
      expect(execMock.execAsync).not.toHaveBeenCalled();
      expect({
        compose: (await ctx.db.select().from(compose)).length,
        mounts: (await ctx.db.select().from(mount)).length,
        domains: (await ctx.db.select().from(domain)).length,
      }).toEqual({ compose: 0, mounts: 0, domains: 0 });
    });

    /**
     * The host-claim pre-flight on this route, which its own pass missed.
     * `deployAiSchema`'s docblock recorded that the ownership check "does apply
     * already, since it lives in `DomainsService.create`" — and it does, but *late*: the
     * domains loop runs after `createByTemplate`, so a squatted hostname was
     * refused with the caller's compose row already committed. That is exactly
     * the residual the pre-flight closed for `POST /templates/deploy` by hoisting
     * `assertHostsUnclaimed` to a pre-flight, and the sibling route never got
     * it.
     *
     * **The holder sits on a different path on purpose.** `(host, /isotest)`
     * against this deploy's `(host, /)` means the `(host, path)` pair check
     * inside `create` cannot account for the refusal — the ownership rule is
     * the only thing that can answer, which is what pins the fix to
     * `assertHostsUnclaimed` rather than to a collision that was already
     * refused.
     *
     * **Both halves of the assertion matter.** The 409 alone passed against the
     * broken code; the compose count is the half only a pre-flight can deliver.
     * The transaction-guarded check inside `create` stays the authority, so
     * this shortens the window rather than closing it (the K-3 residual is
     * untouched).
     */
    it('refuses a domains host another organization holds, before any stack exists', async () => {
      const { organizationId, ownerSession, environment } =
        await setUpEnvironment();

      // A second organization to hold the hostname. Created from the same
      // session because sign-up closes once an owner exists
      // (`auth/auth.config.ts`); the rule compares the write's
      // `activeOrganizationId` against the holder's `project.organizationId`
      // and never asks which human is behind either
      // (`test/domains/domain-host-claims.e2e-spec.ts` is the shape).
      const neighbour = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'Neighbour', slug: `neighbour-${Date.now()}` },
      );
      expect(neighbour.status).toBe(201);
      const neighbourCtx = permissionCtx(
        ownerSession.id,
        (neighbour.body as { id: string }).id,
      );
      const neighbourProject = await projects.create(neighbourCtx, {
        name: 'neighbour',
      });
      const neighbourEnvironment = await environments.create(neighbourCtx, {
        name: 'production',
        projectId: neighbourProject.projectId,
      });
      const heldStack = await composeService.create(neighbourCtx, {
        name: 'Held',
        appName: 'held-stack',
        environmentId: neighbourEnvironment.environmentId,
      });
      await domains.create(neighbourCtx, {
        host: 'x06-claimed-241.example.com',
        path: '/isotest',
        composeId: heldStack.composeId,
        serviceName: 'held',
        domainType: 'compose',
      });

      // Back to the deploying organization: creating one activates it, and the
      // route reads the session's active organization.
      const activated = await request(server)
        .post('/api/auth/organization/set-active')
        .set('Cookie', ownerSession.cookie)
        .send({ organizationId });
      expect(activated.status).toBe(200);

      const refused = await request(server)
        .post('/ai/deploy')
        .set('Cookie', ownerSession.cookie)
        .send({
          ...deployInput(environment.environmentId),
          domains: [
            {
              host: 'x06-claimed-241.example.com',
              port: 3000,
              serviceName: 'app',
            },
          ],
        });

      expect(refused.status).toBe(409);
      expect(refusal(refused)).toBe('This hostname is already in use');
      // Nothing was written on the way to being refused, and nothing was run on
      // a Server. The compose count is scoped to the deploying organization's
      // environment so the holder's own stack cannot mask an orphan.
      expect(execMock.execAsync).not.toHaveBeenCalled();
      expect({
        compose: (
          await ctx.db
            .select()
            .from(compose)
            .where(eq(compose.environmentId, environment.environmentId))
        ).length,
        mounts: (await ctx.db.select().from(mount)).length,
      }).toEqual({ compose: 0, mounts: 0 });
      // The holder's row, on its own path, is all the domain table holds.
      expect(
        await ctx.db
          .select({ host: domain.host, path: domain.path })
          .from(domain),
      ).toEqual([{ host: 'x06-claimed-241.example.com', path: '/isotest' }]);
    });

    /**
     * The sibling of the templates route's. The `(host, path)` pair check
     * fired only inside `DomainsService.create`, after `createByTemplate`, so a
     * refused deploy left a compose row behind. This body carries no `path`, so
     * every domain is a router at `/` — a host already routed there, or two
     * entries naming one host, is the collision.
     */
    describe('and a host already routed at /', () => {
      const stacksIn = async (environmentId: string) =>
        (
          await ctx.db
            .select()
            .from(compose)
            .where(eq(compose.environmentId, environmentId))
        ).length;

      it('refuses a domains host the Environment already routes at /, creating nothing', async () => {
        const { ownerCtx, ownerSession, environment } =
          await setUpEnvironment();
        const held = await composeService.create(ownerCtx, {
          name: 'Held',
          appName: 'held-523',
          environmentId: environment.environmentId,
        });
        await domains.create(ownerCtx, {
          host: 'routed-523.example.com',
          path: '/',
          composeId: held.composeId,
          serviceName: 'held',
          domainType: 'compose',
        });
        const before = await stacksIn(environment.environmentId);

        const refused = await request(server)
          .post('/ai/deploy')
          .set('Cookie', ownerSession.cookie)
          .send({
            ...deployInput(environment.environmentId),
            domains: [
              {
                host: 'routed-523.example.com',
                port: 3000,
                serviceName: 'app',
              },
            ],
          });

        expect(refused.status).toBe(409);
        expect(refusal(refused)).toBe(
          'Domain with this host and path already exists',
        );
        // Before the fix this was `before + 1`: a stack with no domain.
        expect(await stacksIn(environment.environmentId)).toBe(before);
        expect((await ctx.db.select().from(mount)).length).toBe(0);
        expect(execMock.execAsync).not.toHaveBeenCalled();
      });

      it('refuses two domains naming one host, creating nothing', async () => {
        const { ownerSession, environment } = await setUpEnvironment();

        const refused = await request(server)
          .post('/ai/deploy')
          .set('Cookie', ownerSession.cookie)
          .send({
            ...deployInput(environment.environmentId),
            domains: [
              { host: 'twice-523.example.com', port: 3000, serviceName: 'app' },
              { host: 'twice-523.example.com', port: 8080, serviceName: 'api' },
            ],
          });

        expect(refused.status).toBe(409);
        expect(refusal(refused)).toBe(
          'This deploy names the domain twice-523.example.com at path / more than once',
        );
        expect(execMock.execAsync).not.toHaveBeenCalled();
        expect({
          compose: await stacksIn(environment.environmentId),
          mounts: (await ctx.db.select().from(mount)).length,
          domains: (await ctx.db.select().from(domain)).length,
        }).toEqual({ compose: 0, mounts: 0, domains: 0 });
      });
    });

    /**
     * The grant-on-create runs **last** on this route, and that is a bug rather
     * than an ordering preference: the sibling `template.toml` deploy (removed
     * in #1364) called `addNewService` immediately after `createByTemplate`,
     * before its mounts and domains loops, for exactly this reason.
     *
     * `DomainsService.create` and `MountsService.create` both run
     * `checkServiceAccess` against the stack they are being asked to attach to.
     * Owner and admin skip the row-level half of that check, which is why the
     * defect stayed invisible: they are the only static roles holding
     * `service:['create']`, so nothing in the base role set can reach the route
     * at all. A custom (enterprise) role can, and for that caller every
     * `POST /ai/deploy` carrying a domain or a config file was refused with
     * *"You don't have access to this service"* — the caller's own stack, one
     * statement old, refused to the caller — leaving an orphan compose row that
     * the missing grant then put out of that caller's reach entirely.
     *
     * The role below is the narrowest one that clears the route's own gates.
     * The entitlement write grants the *project* — what
     * `checkServiceAccess(…, 'create')` reads — and deliberately not the
     * service, because granting the service is precisely what the route is
     * supposed to do for itself.
     */
    it('grants the caller access to the stack before attaching its domains and mounts', async () => {
      const { organizationId, ownerSession, ownerCtx, project, environment } =
        await setUpEnvironment();
      license.hasValidLicense.mockResolvedValue(true);

      // An invited member who accepted — signing up with a token alone creates
      // no member row (`test/enterprise/custom-roles` is the shape).
      const invite = await request(server)
        .post('/organizations/invitations')
        .set('Cookie', ownerSession.cookie)
        .send({ email: 'invitee@example.com', role: 'member' });
      const inviteId = (invite.body as { id: string }).id;
      const invitee = await request(server)
        .post('/api/auth/sign-up/email')
        .set('x-cloudgate-token', inviteId)
        .send({
          name: 'Ida Rhodes',
          email: 'invitee@example.com',
          password: 'super-secret-password',
        });
      const inviteeCookie = invitee.headers['set-cookie'];
      const inviteeId = (invitee.body as { user: { id: string } }).user.id;
      expect(
        (
          await request(server)
            .post(`/organizations/invitations/${inviteId}/accept`)
            .set('Cookie', inviteeCookie)
        ).status,
      ).toBe(201);

      await customRoles.create(ownerCtx, {
        roleName: 'deployer',
        permissions: {
          service: ['create', 'read'],
          domain: ['create', 'read'],
          volume: ['create', 'read'],
          environment: ['read'],
        },
      });
      await ctx.db
        .update(member)
        .set({ role: 'deployer' })
        .where(eq(member.userId, inviteeId));
      const [inviteeMember] = await ctx.db
        .select({ id: member.id })
        .from(member)
        .where(eq(member.userId, inviteeId));
      await permissions.setMemberEntitlements(
        organizationId,
        inviteeMember.id,
        {
          accessedProjects: [project.projectId],
        },
      );

      const deployed = await ai.deploy(
        permissionCtx(inviteeId, organizationId),
        deployInput(environment.environmentId),
      );

      // The deploy completes, and the caller ends up holding the stack it just
      // made — the grant is what both the domain and the mount write needed.
      expect(deployed.environmentId).toBe(environment.environmentId);
      const [granted] = await ctx.db
        .select({ services: member.accessedServices })
        .from(member)
        .where(eq(member.userId, inviteeId));
      expect(granted.services).toEqual([deployed.composeId]);
      expect(
        (
          await ctx.db
            .select()
            .from(domain)
            .where(eq(domain.composeId, deployed.composeId))
        ).length,
      ).toBe(1);
      expect(
        (
          await ctx.db
            .select()
            .from(mount)
            .where(eq(mount.composeId, deployed.composeId))
        ).length,
      ).toBe(1);
    });

    it('rejects an environment from another organization with NotFound', async () => {
      const { ownerSession, environment } = await setUpEnvironment();

      const secondOrg = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Org' },
      );
      const secondOrgId = (secondOrg.body as { id: string }).id;
      const secondOrgCtx = permissionCtx(ownerSession.id, secondOrgId);

      await expect(
        ai.deploy(secondOrgCtx, deployInput(environment.environmentId)),
      ).rejects.toThrow(NotFoundException);
    });
  });

  /**
   * Over HTTP: the two routes that took a URL out of the request body and
   * fetched it with no authorization at all — the `ctx` was spelled `_ctx`.
   *
   * Over HTTP rather than at the service seam (`ai-probe-authorization.spec.ts`
   * asserts the same refusals there, and that nothing was fetched on the way to
   * them) because the status code is half the contract: `getModels` wraps its
   * own body in a catch that answers 400, so a gate that landed inside it would
   * be invisible to a service-level assertion and wrong on the wire.
   */
  describe('SSRF gating on the two credential-taking probes', () => {
    it('denies a plain member both probes, and asks the destination nothing', async () => {
      const { owner: ownerSession } = await setUpOwner(server);
      const memberSession = await signUpMember(server, ownerSession.cookie);

      const tested = await request(server)
        .post('/ai/test-connection')
        .set('Cookie', memberSession.cookie)
        .send({
          apiUrl: 'http://169.254.169.254/latest/meta-data/',
          apiKey: 'x',
          model: 'y',
        });
      expect([tested.status, refusal(tested)]).toEqual([
        403,
        OWNER_OR_ADMIN_REFUSAL,
      ]);

      const models = await request(server)
        .post('/ai/models')
        .set('Cookie', memberSession.cookie)
        .send({ apiUrl: 'http://127.0.0.1:2375', apiKey: 'x' });
      expect([models.status, refusal(models)]).toEqual([
        403,
        OWNER_OR_ADMIN_REFUSAL,
      ]);

      // Nothing left the box on the way to either refusal.
      expect(fetchMock).not.toHaveBeenCalled();
      expect(generateText).not.toHaveBeenCalled();
      expect(resolveMock).not.toHaveBeenCalled();
    });

    it('denies a second organization owner a probe of the platform host, and stores no such provider either', async () => {
      const { owner: ownerSession } = await setUpOwner(server);
      const mallory = await secondOrganizationOwner(
        server,
        ctx.db,
        ownerSession.cookie,
      );

      // Owner of her own Organization, so `ensureOwnerOrAdmin` passes and the
      // destination is the only thing left to refuse her (ADR-0013).
      const models = await request(server)
        .post('/ai/models')
        .set('Cookie', mallory.cookie)
        .send({
          apiUrl: 'http://169.254.169.254/latest/meta-data/',
          apiKey: 'sk-x',
        });
      expect([models.status, refusal(models)]).toEqual([
        403,
        PRIVATE_DESTINATION_REFUSAL,
      ]);

      const tested = await request(server)
        .post('/ai/test-connection')
        .set('Cookie', mallory.cookie)
        .send({
          apiUrl: 'http://127.0.0.1:2375',
          apiKey: 'sk-x',
          model: 'claude-opus-4-8',
        });
      expect([tested.status, refusal(tested)]).toEqual([
        403,
        PRIVATE_DESTINATION_REFUSAL,
      ]);

      // And the two-step version: store the destination, then probe the row.
      // The check is at the point the URL enters the system, so there is no row
      // to probe.
      const created = await request(server)
        .post('/ai')
        .set('Cookie', mallory.cookie)
        .send({ ...anthropicConfig, apiUrl: 'http://10.0.0.5:11434' });
      expect([created.status, refusal(created)]).toEqual([
        403,
        PRIVATE_DESTINATION_REFUSAL,
      ]);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(generateText).not.toHaveBeenCalled();
    });

    it('refuses a public name that resolves onto the private network, and admits one that does not', async () => {
      const { owner: ownerSession } = await setUpOwner(server);
      const mallory = await secondOrganizationOwner(
        server,
        ctx.db,
        ownerSession.cookie,
      );
      // One name, two records: taking the first would admit this.
      resolveMock.mockResolvedValue(['203.0.113.7', '169.254.169.254']);

      const refused = await request(server)
        .post('/ai/models')
        .set('Cookie', mallory.cookie)
        .send({ apiUrl: 'https://llm.attacker.example/v1', apiKey: 'sk-x' });
      expect([refused.status, refusal(refused)]).toEqual([
        403,
        PRIVATE_DESTINATION_REFUSAL,
      ]);
      expect(resolveMock).toHaveBeenCalledWith('llm.attacker.example');
      expect(fetchMock).not.toHaveBeenCalled();

      resolveMock.mockResolvedValue(['203.0.113.7']);
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: [{ id: 'a-model' }] }),
        text: () => Promise.resolve(''),
      } as unknown as Response);
      const served = await request(server)
        .post('/ai/models')
        .set('Cookie', mallory.cookie)
        .send({ apiUrl: 'https://llm.mycorp.example/v1', apiKey: 'sk-x' });
      expect([served.status, served.body]).toEqual([
        200,
        [
          {
            id: 'a-model',
            object: 'model',
            created: expect.any(Number) as number,
            owned_by: 'provider',
          },
        ],
      ]);
    });

    it('lets the instance owner reach a provider on the box, which is what Ollama is', async () => {
      // The flow a flat refusal of private addresses would have broken: an
      // operator on the single-organization install `deploy/install.sh`
      // produces, pointing this at the Ollama beside it. `resolveMock` answers
      // loopback for `localhost`, as the real resolver would.
      const { owner: ownerSession } = await setUpOwner(server);
      resolveMock.mockResolvedValue(['127.0.0.1']);
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ models: [{ name: 'llama3.3' }] }),
        text: () => Promise.resolve(''),
      } as unknown as Response);

      const served = await request(server)
        .post('/ai/models')
        .set('Cookie', ownerSession.cookie)
        .send({ apiUrl: 'http://localhost:11434', apiKey: '' });

      expect(served.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledWith(
        'http://localhost:11434/api/tags',
        {
          headers: { Authorization: 'Bearer ' },
        },
      );

      const stored = await request(server)
        .post('/ai')
        .set('Cookie', ownerSession.cookie)
        .send({ ...anthropicConfig, apiUrl: 'http://localhost:11434' });
      expect(stored.status).toBe(201);
    });
  });

  /**
   * The answer to the follow-up question is that these two are not the config routes.
   *
   * Filed as the missing `ensureOwnerOrAdmin` every sibling calls; the module's
   * own gating comment, `getEnabledProviders`'s member-readability and
   * `explain-log.tsx` all say the omission is the design. Pinned in the
   * direction the product actually wants, so a later refactor that "fixes the
   * asymmetry" goes red and has to read the docblocks first.
   */
  describe('member access to the two consumer routes', () => {
    it('serves a member suggest and analyze-logs against the organization provider, and still refuses them its config', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);
      const ownerCtx = permissionCtx(ownerSession.id, organizationId);
      const config = await ai.create(ownerCtx, anthropicConfig);
      const memberSession = await signUpMember(server, ownerSession.cookie);

      generateText.mockResolvedValue({
        text: 'Healthy.',
        output: { suggestions: [chatwootSuggestion] },
      });

      const analyzed = await request(server)
        .post('/ai/analyze-logs')
        .set('Cookie', memberSession.cookie)
        .send({ aiId: config.aiId, logs: 'ERROR: exit 1', context: 'build' });
      expect([analyzed.status, analyzed.body]).toEqual([
        200,
        { analysis: 'Healthy.' },
      ]);

      const suggested = await request(server)
        .post('/ai/suggest')
        .set('Cookie', memberSession.cookie)
        .send({ aiId: config.aiId, input: 'deploy Chatwoot' });
      expect([suggested.status, suggested.body]).toEqual([
        200,
        [chatwootSuggestion],
      ]);

      // The destination is not re-asked on these two — it is the one the owner
      // committed — so a member is served the organization's provider even when
      // it is the local Ollama they hold no authority over.
      expect(resolveMock).not.toHaveBeenCalled();

      // What a member is still refused: the row that names it, and the probes.
      const read = await request(server)
        .get(`/ai/${config.aiId}`)
        .set('Cookie', memberSession.cookie);
      expect([read.status, refusal(read)]).toEqual([
        403,
        OWNER_OR_ADMIN_REFUSAL,
      ]);
    });
  });

  describe('cross-org isolation', () => {
    it('a config is invisible and unmodifiable outside its own organization', async () => {
      const { organizationId, owner: ownerSession } = await setUpOwner(server);

      const secondOrg = await createOrganization(
        server,
        ctx.db,
        ownerSession.cookie,
        { name: 'Second Org' },
      );
      const secondOrgId = (secondOrg.body as { id: string }).id;

      const secondOrgCtx = permissionCtx(ownerSession.id, secondOrgId);
      const foreign = await ai.create(secondOrgCtx, {
        ...anthropicConfig,
        name: 'org-b-only',
      });

      // Same user, but acting in the first organization: the config from the
      // second organization must not resolve, even for its creator.
      const firstOrgCtx = permissionCtx(ownerSession.id, organizationId);
      await expect(ai.findOne(firstOrgCtx, foreign.aiId)).rejects.toThrow(
        NotFoundException,
      );
      await expect(
        ai.update(firstOrgCtx, foreign.aiId, { name: 'stolen' }),
      ).rejects.toThrow(NotFoundException);
      await expect(ai.remove(firstOrgCtx, foreign.aiId)).rejects.toThrow(
        NotFoundException,
      );
      expect(await ai.list(firstOrgCtx)).toEqual([]);
    });
  });
});
