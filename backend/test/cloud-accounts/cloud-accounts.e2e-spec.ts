import { ForbiddenException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import {
  cloudAccount,
  licenseKey,
  member,
  organizationRole,
} from '../../src/db/schema';
import { PermissionService } from '../../src/rbac/permission.service';
import { GOOGLE_COLUMNS } from '../utils/google-cloud-account';
import { signUpMember, createOrganization } from '../utils/test-auth';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

/**
 * Connecting an AWS Cloud account through the cloud port. Every AWS
 * answer comes from `ctx.cloud`, the in-memory fake, which says yes unless a
 * test scripts the refusal it is about.
 */

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const ACCOUNT = '123456789012';
const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';

interface SetupAnswer {
  setupToken: string;
  cloudAccountId: string;
  externalId: string;
  template: {
    policyVersion: number;
    cloudFormation: string;
    json: { externalId: string; tagValue: string };
  };
}

describe('Cloud accounts (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;
  let ownerCookie: string;
  let organizationId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    httpServer = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    const res = await request(httpServer)
      .post('/api/auth/sign-up/email')
      .send(owner);
    expect(res.status).toBe(200);
    ownerCookie = (res.headers['set-cookie'] as unknown as string[])
      .map((entry) => entry.split(';')[0])
      .join('; ');
    const active = await request(httpServer)
      .get('/organizations/active')
      .set('Cookie', ownerCookie);
    organizationId = (active.body as { id: string }).id;
  });

  async function setup(
    cookie = ownerCookie,
    cloudId = ACCOUNT,
  ): Promise<SetupAnswer> {
    const res = await request(httpServer)
      .post('/cloud-accounts/setup')
      .set('Cookie', cookie)
      .send({ cloudId });
    expect(res.status).toBe(200);
    return res.body as SetupAnswer;
  }

  function connect(
    setupToken: string,
    overrides: Record<string, unknown> = {},
    cookie = ownerCookie,
  ) {
    return request(httpServer)
      .post('/cloud-accounts')
      .set('Cookie', cookie)
      .send({
        setupToken,
        name: 'Production AWS',
        cloudId: ACCOUNT,
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: SECRET,
        deployRoleArn: `arn:aws:iam::${ACCOUNT}:role/cloudgate-deploy`,
        taskExecutionRoleArn: `arn:aws:iam::${ACCOUNT}:role/cloudgate-task-execution`,
        ...overrides,
      });
  }

  async function rows() {
    return ctx.db.select().from(cloudAccount);
  }

  describe('setup template', () => {
    it('carries a Cloudgate-made external id and the Cloud account id as its tag value, and calls no AWS', async () => {
      const first = await setup();
      const second = await setup();

      expect(first.externalId).toMatch(/^[\w-]{20,}$/);
      expect(first.externalId).not.toBe(second.externalId);
      expect(first.template.json.externalId).toBe(first.externalId);
      expect(first.template.json.tagValue).toBe(first.cloudAccountId);
      expect(first.template.cloudFormation).toContain(first.externalId);
      expect(first.template.cloudFormation).toContain(
        `arn:aws:iam::${ACCOUNT}:role/cloudgate-deploy-${first.cloudAccountId}`,
      );
      expect(ctx.cloud.calls).toEqual([]);
      // Handing out a template keeps nothing.
      expect(await rows()).toEqual([]);
    });

    it('keeps the external id when given back its token for another account id', async () => {
      const first = await setup();

      const res = await request(httpServer)
        .post('/cloud-accounts/setup')
        .set('Cookie', ownerCookie)
        .send({ cloudId: '210987654321', setupToken: first.setupToken });

      expect(res.status).toBe(200);
      const again = res.body as SetupAnswer;
      expect(again.externalId).toBe(first.externalId);
      expect(again.cloudAccountId).toBe(first.cloudAccountId);
      expect(again.template.cloudFormation).toContain('210987654321');
    });
  });

  describe('connect', () => {
    it('saves the Cloud account once every step of the check passes, in order', async () => {
      const { setupToken, cloudAccountId, externalId } = await setup();

      const res = await connect(setupToken);

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        cloudAccountId,
        organizationId,
        name: 'Production AWS',
        cloud: 'aws',
        cloudId: ACCOUNT,
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        externalId,
        policyVersion: 4,
        lastCheckResult: 'passed',
        lastCheckReason: null,
        hasSecretAccessKey: true,
      });
      expect(res.body).not.toHaveProperty('secretAccessKey');

      const deployRoleArn = `arn:aws:iam::${ACCOUNT}:role/cloudgate-deploy`;
      const calls = ctx.cloud.calls;
      expect(calls.slice(0, 4)).toEqual([
        {
          method: 'callerIdentity',
          accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
          session: false,
        },
        {
          method: 'assumeRole',
          accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
          roleArn: deployRoleArn,
          externalId,
        },
        { method: 'callerIdentity', accessKeyId: deployRoleArn, session: true },
        {
          method: 'assumeRole',
          accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
          roleArn: deployRoleArn,
          externalId: null,
        },
      ]);
      const simulated = calls.slice(4);
      expect(simulated.length).toBeGreaterThan(0);
      for (const call of simulated) {
        expect(call).toMatchObject({
          method: 'simulatePrincipalPolicy',
          policySourceArn: deployRoleArn,
        });
      }
      // The Cloud account's own tag is the context of the tag-scoped checks.
      expect(
        simulated.some(
          (call) =>
            call.method === 'simulatePrincipalPolicy' &&
            call.context.some(
              (entry) =>
                entry.key === 'aws:RequestTag/cloudgate:cloud-account' &&
                entry.values[0] === cloudAccountId,
            ),
        ),
      ).toBe(true);
    });

    it('keeps the secret access key encrypted at rest', async () => {
      const { setupToken } = await setup();
      expect((await connect(setupToken)).status).toBe(201);

      const raw = await ctx.db.execute<{ secret_access_key: string }>(
        'select secret_access_key from cloud_account',
      );
      expect(raw.rows[0].secret_access_key).toMatch(/^enc:v1:/);
      expect(raw.rows[0].secret_access_key).not.toContain(SECRET);
    });

    it('refuses a key AWS does not accept, and saves nothing', async () => {
      ctx.cloud.rejectKey();
      const { setupToken } = await setup();

      const res = await connect(setupToken);

      expect(res.status).toBe(400);
      expect((res.body as { message: string }).message).toBe(
        'AWS refused the access key AKIAIOSFODNN7EXAMPLE: The security token included in the request is invalid.',
      );
      expect(JSON.stringify(res.body)).not.toContain(SECRET);
      expect(await rows()).toEqual([]);
    });

    it('refuses a role in another account than the one typed', async () => {
      ctx.cloud.identityIs('999999999999');
      const { setupToken } = await setup();

      const res = await connect(setupToken);

      expect(res.status).toBe(400);
      expect((res.body as { message: string }).message).toBe(
        `The deploy role is in AWS account 999999999999, not ${ACCOUNT}`,
      );
      expect(await rows()).toEqual([]);
    });

    it('refuses a role that can be taken on without the external id', async () => {
      ctx.cloud.worksWithoutExternalId();
      const { setupToken } = await setup();

      const res = await connect(setupToken);

      expect(res.status).toBe(400);
      expect((res.body as { message: string }).message).toBe(
        `The deploy role arn:aws:iam::${ACCOUNT}:role/cloudgate-deploy can be taken on without the external id. Add the sts:ExternalId condition from the setup template to its trust policy`,
      );
      // Refused before simulating anything.
      expect(
        ctx.cloud.calls.filter(
          (call) => call.method === 'simulatePrincipalPolicy',
        ),
      ).toEqual([]);
      expect(await rows()).toEqual([]);
    });

    it('refuses a role missing actions, naming each denied one', async () => {
      ctx.cloud.denyActions(['ec2:CreateVpc', 'iam:PassRole']);
      const { setupToken } = await setup();

      const res = await connect(setupToken);

      expect(res.status).toBe(400);
      expect((res.body as { message: string }).message).toBe(
        'The deploy role is missing 2 actions of policy version 4: ec2:CreateVpc, iam:PassRole. Update it from the setup template',
      );
      expect(await rows()).toEqual([]);
    });

    it('refuses a role whose ARN is in another account, before asking AWS', async () => {
      const { setupToken } = await setup();

      const res = await connect(setupToken, {
        deployRoleArn: 'arn:aws:iam::999999999999:role/cloudgate-deploy',
      });

      expect(res.status).toBe(400);
      expect((res.body as { details: unknown }).details).toEqual([
        {
          path: 'deployRoleArn',
          message: `deployRoleArn is in AWS account 999999999999, not ${ACCOUNT}`,
        },
      ]);
      expect(ctx.cloud.calls).toEqual([]);
    });

    it('refuses a setup token it did not make', async () => {
      const res = await connect('enc:v1:bm90LWEtdG9rZW4=');

      expect(res.status).toBe(400);
      expect((res.body as { message: string }).message).toBe(
        'The setup token is not one Cloudgate made for this Organization; get the setup template again',
      );
      expect(ctx.cloud.calls).toEqual([]);
    });

    it('refuses connecting the same AWS account twice in one Organization, without calling AWS', async () => {
      expect((await connect((await setup()).setupToken)).status).toBe(201);
      ctx.cloud.reset();

      const res = await connect((await setup()).setupToken, {
        name: 'Same account again',
      });

      expect(res.status).toBe(409);
      expect((res.body as { message: string }).message).toBe(
        'This AWS account is already connected to this Organization as a Cloud account',
      );
      expect(ctx.cloud.calls).toEqual([]);
      expect(await rows()).toHaveLength(1);
    });
  });

  describe('read', () => {
    it('lists and reads Cloud accounts with their last check, presence-only, and never calls AWS', async () => {
      const { setupToken, cloudAccountId } = await setup();
      expect((await connect(setupToken)).status).toBe(201);
      ctx.cloud.reset();

      const list = await request(httpServer)
        .get('/cloud-accounts')
        .set('Cookie', ownerCookie);
      const one = await request(httpServer)
        .get(`/cloud-accounts/${cloudAccountId}`)
        .set('Cookie', ownerCookie);

      expect(list.status).toBe(200);
      expect(one.status).toBe(200);
      expect(list.body).toEqual([one.body]);
      expect(one.body).toMatchObject({
        cloudAccountId,
        lastCheckResult: 'passed',
        lastCheckedAt: expect.any(String) as string,
        hasSecretAccessKey: true,
      });
      expect(one.body).not.toHaveProperty('secretAccessKey');
      expect(JSON.stringify([list.body, one.body])).not.toContain(SECRET);
      expect(ctx.cloud.calls).toEqual([]);
    });

    it("answers another Organization's Cloud account as not found", async () => {
      const { setupToken, cloudAccountId } = await setup();
      expect((await connect(setupToken)).status).toBe(201);
      // Moved under a second Organization the caller is not active in.
      const other = await createOrganization(httpServer, ctx.db, ownerCookie, {
        name: 'Other',
      });
      await ctx.db
        .update(cloudAccount)
        .set({ organizationId: (other.body as { id: string }).id })
        .where(eq(cloudAccount.cloudAccountId, cloudAccountId));

      const res = await request(httpServer)
        .get(`/cloud-accounts/${cloudAccountId}`)
        .set('Cookie', ownerCookie);

      expect(res.status).toBe(404);
      expect((res.body as { message: string }).message).toBe(
        'Cloud account not found',
      );
    });
  });

  describe('a second cloud (slice 6, S12)', () => {
    /** A Google Cloud account written directly, so no connect check runs. */
    async function googleRow() {
      const [row] = await ctx.db
        .insert(cloudAccount)
        .values({
          organizationId,
          name: 'Production Google',
          cloud: 'gcp',
          cloudId: 'shop-prod',
          ...GOOGLE_COLUMNS,
          policyVersion: 1,
          lastCheckedAt: new Date().toISOString(),
          lastCheckResult: 'passed',
        })
        .returning();
      return row;
    }

    // Connecting one is `google-cloud-account-connect.e2e-spec.ts`'s.

    it('answers an AWS Cloud account with its own fields only, as before', async () => {
      const { setupToken, cloudAccountId } = await setup();
      expect((await connect(setupToken)).status).toBe(201);

      const one = await request(httpServer)
        .get(`/cloud-accounts/${cloudAccountId}`)
        .set('Cookie', ownerCookie);

      expect(Object.keys(one.body as object).sort()).toEqual([
        'accessKeyId',
        'cloud',
        'cloudAccountId',
        'cloudId',
        'createdAt',
        'currentPolicyVersion',
        'deployRoleArn',
        'externalId',
        'hasSecretAccessKey',
        'lastCheckReason',
        'lastCheckResult',
        'lastCheckedAt',
        'missingActions',
        'name',
        'organizationId',
        'permissionsOutOfDate',
        'policyVersion',
        'taskExecutionRoleArn',
      ]);
    });

    it('lists a Google Cloud account with its public key and only the presence of its private one', async () => {
      const { cloudAccountId } = await googleRow();

      const one = await request(httpServer)
        .get(`/cloud-accounts/${cloudAccountId}`)
        .set('Cookie', ownerCookie);

      expect(one.status).toBe(200);
      expect(one.body).toMatchObject({
        cloudAccountId,
        cloud: 'gcp',
        cloudId: 'shop-prod',
        projectNumber: GOOGLE_COLUMNS.projectNumber,
        workloadIdentityProvider: GOOGLE_COLUMNS.workloadIdentityProvider,
        deployServiceAccount: GOOGLE_COLUMNS.deployServiceAccount,
        signingKeyId: GOOGLE_COLUMNS.signingKeyId,
        signingPublicKey: GOOGLE_COLUMNS.signingPublicKey,
        hasSigningKey: true,
        hasPendingSigningKey: false,
      });
      for (const field of [
        'signingKey',
        'pendingSigningKey',
        'accessKeyId',
        'secretAccessKey',
        'hasSecretAccessKey',
        'externalId',
      ]) {
        expect(one.body).not.toHaveProperty(field);
      }
      expect(JSON.stringify(one.body)).not.toContain('not-a-real-key');
      // Encrypted at rest (ADR-0006).
      const { rows: raw } = await ctx.db.$client.query<{
        signing_key: string;
      }>('select signing_key from cloud_account where cloud_account_id = $1', [
        cloudAccountId,
      ]);
      expect(raw[0].signing_key).toMatch(/^enc:v1:/);
    });

    // Editing, checking, the key change and deleting one are
    // `google-cloud-account-edit.e2e-spec.ts`'s.

    it('refuses an edit that names the other cloud', async () => {
      const { setupToken, cloudAccountId } = await setup();
      expect((await connect(setupToken)).status).toBe(201);

      const res = await request(httpServer)
        .patch(`/cloud-accounts/${cloudAccountId}`)
        .set('Cookie', ownerCookie)
        .send({ cloud: 'gcp' });

      expect(res.status).toBe(400);
      expect((res.body as { message: string }).message).toBe(
        'Cloud account Production AWS is on AWS, not Google Cloud',
      );
    });
  });

  describe('the cloudAccount statement', () => {
    it('lets an admin connect and read one', async () => {
      const admin = await signUpMember(httpServer, ownerCookie, {
        email: 'admin@example.com',
        role: 'admin',
      });
      const { setupToken } = await setup(admin.cookie);

      expect((await connect(setupToken, {}, admin.cookie)).status).toBe(201);
      const list = await request(httpServer)
        .get('/cloud-accounts')
        .set('Cookie', admin.cookie);
      expect(list.status).toBe(200);
      expect(list.body).toHaveLength(1);
    });

    it('refuses the base member every route, without calling AWS', async () => {
      const person = await signUpMember(httpServer, ownerCookie);

      for (const res of [
        await request(httpServer)
          .post('/cloud-accounts/setup')
          .set('Cookie', person.cookie)
          .send({ cloudId: ACCOUNT }),
        await connect((await setup()).setupToken, {}, person.cookie),
        await request(httpServer)
          .get('/cloud-accounts')
          .set('Cookie', person.cookie),
      ]) {
        expect(res.status).toBe(403);
      }
      expect(ctx.cloud.calls).toEqual([]);
    });

    it('is held by neither agentReader nor agentOperator, not even read', async () => {
      const permissions = ctx.app.get(PermissionService);
      for (const role of ['agentReader', 'agentOperator'] as const) {
        const created = await request(httpServer)
          .post('/agents')
          .set('Cookie', ownerCookie)
          .send({ name: `${role}-bot`, role });
        expect(created.status).toBe(201);
        const agentId = (created.body as { agent: { id: string } }).agent.id;

        for (const action of ['read', 'create', 'update', 'delete'] as const) {
          await expect(
            permissions.checkPermission(
              {
                user: { id: agentId },
                session: { activeOrganizationId: organizationId },
              },
              { cloudAccount: [action] },
            ),
          ).rejects.toBeInstanceOf(ForbiddenException);
        }
      }
    });

    it('is grantable in a licensed custom role, read without create', async () => {
      await ctx.db.insert(licenseKey).values({
        organizationId,
        key: 'test-license-key',
        status: 'active',
        enableEnterpriseFeatures: true,
      });
      await ctx.db.insert(organizationRole).values({
        organizationId,
        role: 'cloud-viewer',
        permission: { cloudAccount: ['read'] },
      });
      const person = await signUpMember(httpServer, ownerCookie);
      await ctx.db
        .update(member)
        .set({ role: 'cloud-viewer' })
        .where(eq(member.userId, person.id));

      const list = await request(httpServer)
        .get('/cloud-accounts')
        .set('Cookie', person.cookie);
      const setupRes = await request(httpServer)
        .post('/cloud-accounts/setup')
        .set('Cookie', person.cookie)
        .send({ cloudId: ACCOUNT });

      expect(list.status).toBe(200);
      expect(setupRes.status).toBe(403);
    });

    it('is offered in the custom-role grid', async () => {
      await ctx.db.insert(licenseKey).values({
        organizationId,
        key: 'test-license-key',
        status: 'active',
        enableEnterpriseFeatures: true,
      });

      const res = await request(httpServer)
        .get('/custom-roles/statements')
        .set('Cookie', ownerCookie);

      expect(res.status).toBe(200);
      expect(
        (res.body as { statements: Record<string, string[]> }).statements
          .cloudAccount,
      ).toEqual(['read', 'create', 'update', 'delete']);
    });
  });
});
