import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { decryptValue } from '../../src/common/encryption/encryption';
import {
  AWS_POLICY,
  SHIPPED_AWS_POLICY,
} from '../../src/cloud-accounts/aws/aws-policy';
import type { AwsPolicy } from '../../src/cloud-accounts/aws/aws-policy';
import { CloudAccountsService } from '../../src/cloud-accounts/cloud-accounts.service';
import { cloudAccount } from '../../src/db/schema';
import { signUpMember, createOrganization } from '../utils/test-auth';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

/**
 * Keeping a connected Cloud account working: edit, Check now, the last
 * check, "permissions out of date" and Delete, every AWS answer from
 * `ctx.cloud`.
 *
 * **A second policy version, for this file only.** Cloudgate ships one, and
 * "permissions out of date" needs a newer Cloudgate than the one that checked
 * the role. So the version table is wrapped: while `mockPolicy.version` is 2,
 * the current version is 2, which is version 1 plus {@link NEW_ACTION} — the
 * shape a real upgrade has, since a shipped version is never edited. The
 * table is handed in at its seam, `AWS_POLICY`.
 */
const mockPolicy = { version: 1 };
const NEW_ACTION = 'bedrock:InvokeModel';

/** The shipped table, with a version 2 that adds {@link NEW_ACTION}. */
const testPolicy: AwsPolicy = {
  get version() {
    return mockPolicy.version;
  },
  requiredActions: (version) =>
    version === 2
      ? [...SHIPPED_AWS_POLICY.requiredActions(1), NEW_ACTION]
      : SHIPPED_AWS_POLICY.requiredActions(version),
  simulationChecks: (ids, version = mockPolicy.version) =>
    version === 2
      ? [
          ...SHIPPED_AWS_POLICY.simulationChecks(ids, 1),
          { actions: [NEW_ACTION], resourceArn: '*', context: [] },
        ]
      : SHIPPED_AWS_POLICY.simulationChecks(ids, version),
  setupTemplate: (input, version = mockPolicy.version) => ({
    ...SHIPPED_AWS_POLICY.setupTemplate(input, Math.min(version, 1)),
    policyVersion: version,
  }),
};

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const ACCOUNT = '123456789012';
const SECRET = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
const NEW_SECRET = 'je7MtGbClwBF/2Zp9Utk/h3yCo8nvbEXAMPLEKEY';
const KEY = 'AKIAIOSFODNN7EXAMPLE';
const DEPLOY_ROLE = `arn:aws:iam::${ACCOUNT}:role/cloudgate-deploy`;
const EXECUTION_ROLE = `arn:aws:iam::${ACCOUNT}:role/cloudgate-task-execution`;

interface View {
  cloudAccountId: string;
  name: string;
  cloudId: string;
  accessKeyId: string;
  deployRoleArn: string;
  taskExecutionRoleArn: string;
  externalId: string;
  policyVersion: number;
  lastCheckedAt: string;
  lastCheckResult: 'passed' | 'failed';
  lastCheckReason: string | null;
  hasSecretAccessKey: boolean;
  currentPolicyVersion: number;
  permissionsOutOfDate: boolean;
  missingActions: string[];
}

describe('Cloud account edit, check and delete (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;
  let ownerCookie: string;

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [{ provide: AWS_POLICY, useValue: testPolicy }],
    });
    httpServer = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    mockPolicy.version = 1;
    await ctx.resetDb();
    const res = await request(httpServer)
      .post('/api/auth/sign-up/email')
      .send(owner);
    expect(res.status).toBe(200);
    ownerCookie = (res.headers['set-cookie'] as unknown as string[])
      .map((entry) => entry.split(';')[0])
      .join('; ');
  });

  /** A connected Cloud account, with the fake's calls cleared. */
  async function connected(cookie = ownerCookie): Promise<View> {
    const setup = await request(httpServer)
      .post('/cloud-accounts/setup')
      .set('Cookie', cookie)
      .send({ cloudId: ACCOUNT });
    expect(setup.status).toBe(200);
    const res = await request(httpServer)
      .post('/cloud-accounts')
      .set('Cookie', cookie)
      .send({
        setupToken: (setup.body as { setupToken: string }).setupToken,
        name: 'Production AWS',
        cloudId: ACCOUNT,
        accessKeyId: KEY,
        secretAccessKey: SECRET,
        deployRoleArn: DEPLOY_ROLE,
        taskExecutionRoleArn: EXECUTION_ROLE,
      });
    expect(res.status).toBe(201);
    ctx.cloud.reset();
    return res.body as View;
  }

  function edit(
    id: string,
    body: Record<string, unknown>,
    cookie = ownerCookie,
  ) {
    return request(httpServer)
      .patch(`/cloud-accounts/${id}`)
      .set('Cookie', cookie)
      .send(body);
  }

  function checkNow(id: string, cookie = ownerCookie) {
    return request(httpServer)
      .post(`/cloud-accounts/${id}/check`)
      .set('Cookie', cookie);
  }

  async function stored(id: string) {
    const [row] = await ctx.db
      .select()
      .from(cloudAccount)
      .where(eq(cloudAccount.cloudAccountId, id));
    return row;
  }

  describe('edit', () => {
    it('keeps every field left out, the secret especially, and calls no AWS for a rename', async () => {
      const account = await connected();

      const res = await edit(account.cloudAccountId, { name: 'Renamed' });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        name: 'Renamed',
        accessKeyId: KEY,
        deployRoleArn: DEPLOY_ROLE,
        taskExecutionRoleArn: EXECUTION_ROLE,
        externalId: account.externalId,
        hasSecretAccessKey: true,
        lastCheckedAt: account.lastCheckedAt,
      });
      expect(res.body).not.toHaveProperty('secretAccessKey');
      const row = await stored(account.cloudAccountId);
      expect(row.secretAccessKey).toBe(SECRET);
      expect(ctx.cloud.calls).toEqual([]);
    });

    it('reruns the check with the new key and saves it once the check passes', async () => {
      const account = await connected();

      const res = await edit(account.cloudAccountId, {
        accessKeyId: 'AKIANEWKEYEXAMPLE1',
        secretAccessKey: NEW_SECRET,
      });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        accessKeyId: 'AKIANEWKEYEXAMPLE1',
        lastCheckResult: 'passed',
        lastCheckReason: null,
      });
      expect(ctx.cloud.calls[0]).toEqual({
        method: 'callerIdentity',
        accessKeyId: 'AKIANEWKEYEXAMPLE1',
        session: false,
      });
      const row = await stored(account.cloudAccountId);
      expect(row.secretAccessKey).toBe(NEW_SECRET);
      const raw = await ctx.db.execute<{ secret_access_key: string }>(
        'select secret_access_key from cloud_account',
      );
      expect(decryptValue(raw.rows[0].secret_access_key)).toBe(NEW_SECRET);
    });

    it('checks a new role ARN with the stored secret when no secret is given', async () => {
      const account = await connected();
      const newRole = `arn:aws:iam::${ACCOUNT}:role/cloudgate-deploy-2`;

      const res = await edit(account.cloudAccountId, {
        deployRoleArn: newRole,
      });

      expect(res.status).toBe(200);
      expect((res.body as View).deployRoleArn).toBe(newRole);
      expect(ctx.cloud.calls[1]).toMatchObject({
        method: 'assumeRole',
        accessKeyId: KEY,
        roleArn: newRole,
        externalId: account.externalId,
      });
    });

    it('keeps the old values when the re-check fails, naming each denied action', async () => {
      const account = await connected();
      ctx.cloud.denyActions(['ec2:CreateVpc', 'iam:PassRole']);
      const newRole = `arn:aws:iam::${ACCOUNT}:role/cloudgate-deploy-2`;

      const res = await edit(account.cloudAccountId, {
        name: 'Should not stick',
        deployRoleArn: newRole,
        secretAccessKey: NEW_SECRET,
      });

      expect(res.status).toBe(400);
      expect((res.body as { message: string }).message).toBe(
        'The deploy role is missing 2 actions of policy version 1: ec2:CreateVpc, iam:PassRole. Update it from the setup template',
      );
      expect(JSON.stringify(res.body)).not.toContain(NEW_SECRET);
      const row = await stored(account.cloudAccountId);
      expect(row).toMatchObject({
        name: 'Production AWS',
        deployRoleArn: DEPLOY_ROLE,
        secretAccessKey: SECRET,
        // The working account is not marked failed by a failed edit.
        lastCheckResult: 'passed',
        lastCheckReason: null,
        lastCheckedAt: account.lastCheckedAt,
      });
    });

    it('refuses a role ARN in another AWS account before asking AWS', async () => {
      const account = await connected();

      const res = await edit(account.cloudAccountId, {
        taskExecutionRoleArn: 'arn:aws:iam::999999999999:role/x',
      });

      expect(res.status).toBe(400);
      expect((res.body as { message: string }).message).toBe(
        `taskExecutionRoleArn is in AWS account 999999999999, not ${ACCOUNT}`,
      );
      expect(ctx.cloud.calls).toEqual([]);
    });

    it('never changes the AWS account id or the external id', async () => {
      const account = await connected();

      for (const body of [
        { cloudId: '210987654321' },
        { externalId: 'chosen-by-caller' },
      ]) {
        const res = await edit(account.cloudAccountId, body);
        expect(res.status).toBe(400);
      }
      const row = await stored(account.cloudAccountId);
      expect(row.cloudId).toBe(ACCOUNT);
      expect(row.externalId).toBe(account.externalId);
    });

    it("answers another Organization's Cloud account as not found", async () => {
      const account = await connected();
      const other = await createOrganization(httpServer, ctx.db, ownerCookie, {
        name: 'Other',
      });
      await ctx.db
        .update(cloudAccount)
        .set({ organizationId: (other.body as { id: string }).id })
        .where(eq(cloudAccount.cloudAccountId, account.cloudAccountId));

      for (const res of [
        await edit(account.cloudAccountId, { name: 'x' }),
        await checkNow(account.cloudAccountId),
        await request(httpServer)
          .delete(`/cloud-accounts/${account.cloudAccountId}`)
          .set('Cookie', ownerCookie),
      ]) {
        expect(res.status).toBe(404);
      }
      expect(ctx.cloud.calls).toEqual([]);
    });
  });

  describe('Check now and the last check', () => {
    it('records a failed check with its time and reason, and a passing one clears it', async () => {
      const account = await connected();
      ctx.cloud.refuseRole('Access denied');

      const failed = await checkNow(account.cloudAccountId);

      expect(failed.status).toBe(200);
      expect(failed.body).toMatchObject({
        lastCheckResult: 'failed',
        lastCheckReason: `The access key cannot take on the deploy role ${DEPLOY_ROLE} with this Cloud account's external id: Access denied`,
      });
      expect(Date.parse((failed.body as View).lastCheckedAt)).toBeGreaterThan(
        Date.parse(account.lastCheckedAt),
      );
      const read = await request(httpServer)
        .get(`/cloud-accounts/${account.cloudAccountId}`)
        .set('Cookie', ownerCookie);
      expect(read.body).toMatchObject({
        lastCheckResult: 'failed',
        lastCheckReason: (failed.body as View).lastCheckReason,
      });

      ctx.cloud.reset();
      const passed = await checkNow(account.cloudAccountId);

      expect(passed.status).toBe(200);
      expect(passed.body).toMatchObject({
        lastCheckResult: 'passed',
        lastCheckReason: null,
      });
      expect(ctx.cloud.calls[0]).toMatchObject({ accessKeyId: KEY });
    });

    it('lets a use record the failure it found, shown until a check passes', async () => {
      const account = await connected();
      const service = ctx.app.get(CloudAccountsService);

      await service.recordUseFailure(
        account.cloudAccountId,
        'AWS refused ecs:CreateService: AccessDeniedException',
      );

      const read = await request(httpServer)
        .get(`/cloud-accounts/${account.cloudAccountId}`)
        .set('Cookie', ownerCookie);
      expect(read.body).toMatchObject({
        lastCheckResult: 'failed',
        lastCheckReason: 'AWS refused ecs:CreateService: AccessDeniedException',
      });
      expect((await checkNow(account.cloudAccountId)).body).toMatchObject({
        lastCheckResult: 'passed',
        lastCheckReason: null,
      });
    });
  });

  describe('permissions out of date', () => {
    it('shows when a newer Cloudgate needs more actions, lists them and offers the new template', async () => {
      const account = await connected();
      expect(account).toMatchObject({
        policyVersion: 1,
        currentPolicyVersion: 1,
        permissionsOutOfDate: false,
        missingActions: [],
      });

      mockPolicy.version = 2;
      const read = await request(httpServer)
        .get(`/cloud-accounts/${account.cloudAccountId}`)
        .set('Cookie', ownerCookie);

      expect(read.body).toMatchObject({
        policyVersion: 1,
        currentPolicyVersion: 2,
        permissionsOutOfDate: true,
        missingActions: [NEW_ACTION],
      });
      const template = await request(httpServer)
        .get(`/cloud-accounts/${account.cloudAccountId}/template`)
        .set('Cookie', ownerCookie);
      expect(template.status).toBe(200);
      expect(template.body).toMatchObject({
        policyVersion: 2,
        json: {
          externalId: account.externalId,
          tagValue: account.cloudAccountId,
        },
      });
      expect(ctx.cloud.calls).toEqual([]);
    });

    it('stays out of date while the role lacks the new actions, and clears once a check passes', async () => {
      const account = await connected();
      mockPolicy.version = 2;
      ctx.cloud.denyActions([NEW_ACTION]);

      const failed = await checkNow(account.cloudAccountId);

      expect(failed.body).toMatchObject({
        policyVersion: 1,
        permissionsOutOfDate: true,
        lastCheckResult: 'failed',
        lastCheckReason: `The deploy role is missing 1 action of policy version 2: ${NEW_ACTION}. Update it from the setup template`,
      });

      ctx.cloud.reset();
      const passed = await checkNow(account.cloudAccountId);

      expect(passed.body).toMatchObject({
        policyVersion: 2,
        permissionsOutOfDate: false,
        missingActions: [],
        lastCheckResult: 'passed',
      });
    });
  });

  describe('delete', () => {
    it("removes the row and says what in AWS is the operator's to remove", async () => {
      const account = await connected();

      const res = await request(httpServer)
        .delete(`/cloud-accounts/${account.cloudAccountId}`)
        .set('Cookie', ownerCookie);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        cloudAccountId: account.cloudAccountId,
        name: 'Production AWS',
        message: `Cloud account Production AWS is removed from Cloudgate. Nothing was removed in AWS account ${ACCOUNT}: the IAM user with access key ${KEY}, that key, the deploy role ${DEPLOY_ROLE} and the task execution role ${EXECUTION_ROLE} are yours to remove.`,
      });
      expect(await stored(account.cloudAccountId)).toBeUndefined();
      expect(ctx.cloud.calls).toEqual([]);
    });
  });

  describe('the cloudAccount statement', () => {
    it('lets an admin edit, check and delete', async () => {
      const admin = await signUpMember(httpServer, ownerCookie, {
        email: 'admin@example.com',
        role: 'admin',
      });
      const account = await connected(admin.cookie);

      expect(
        (await edit(account.cloudAccountId, { name: 'x' }, admin.cookie))
          .status,
      ).toBe(200);
      expect(
        (await checkNow(account.cloudAccountId, admin.cookie)).status,
      ).toBe(200);
      expect(
        (
          await request(httpServer)
            .delete(`/cloud-accounts/${account.cloudAccountId}`)
            .set('Cookie', admin.cookie)
        ).status,
      ).toBe(200);
    });

    it('refuses the base member every route, without calling AWS', async () => {
      const account = await connected();
      const person = await signUpMember(httpServer, ownerCookie);

      for (const res of [
        await edit(account.cloudAccountId, { name: 'x' }, person.cookie),
        await checkNow(account.cloudAccountId, person.cookie),
        await request(httpServer)
          .get(`/cloud-accounts/${account.cloudAccountId}/template`)
          .set('Cookie', person.cookie),
        await request(httpServer)
          .delete(`/cloud-accounts/${account.cloudAccountId}`)
          .set('Cookie', person.cookie),
      ]) {
        expect(res.status).toBe(403);
      }
      expect(ctx.cloud.calls).toEqual([]);
      expect(await stored(account.cloudAccountId)).toBeDefined();
    });
  });
});
