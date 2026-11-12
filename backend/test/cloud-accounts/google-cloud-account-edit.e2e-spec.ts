import { createPublicKey, verify } from 'node:crypto';
import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import {
  GOOGLE_ROLE,
  SHIPPED_GOOGLE_ROLE,
} from '../../src/cloud-accounts/gcp/deploy-role';
import type { GoogleRole } from '../../src/cloud-accounts/gcp/deploy-role';
import {
  cloudAccount,
  environment,
  webServerSettings,
} from '../../src/db/schema';
import { FAKE_PROJECT_NUMBER } from '../utils/fake-google-cloud-port';
import { signUpMember } from '../utils/test-auth';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

/**
 * Keeping a connected Google Cloud account working (copying AWS's): edit,
 * Check now, "permissions out of date",
 * the key change and Delete. Every Google answer comes from `ctx.google`.
 *
 * **A second role version, for this file only**, handed in at its seam
 * `GOOGLE_ROLE` the way `cloud-account-edit.e2e-spec.ts` hands in a second
 * AWS policy: while `mockRole.version` is 2, the current version is version 1
 * plus {@link NEW_PERMISSION}, the shape a real upgrade has.
 */
const mockRole = { version: 1 };
const NEW_PERMISSION = 'cloudsql.instances.create';

const testRole: GoogleRole = {
  get version() {
    return mockRole.version;
  },
  requiredPermissions: (version) =>
    version === 2
      ? [...SHIPPED_GOOGLE_ROLE.requiredPermissions(1), NEW_PERMISSION]
      : SHIPPED_GOOGLE_ROLE.requiredPermissions(version),
  requiredApis: (version) =>
    SHIPPED_GOOGLE_ROLE.requiredApis(Math.min(version, 1)),
  roleDefinition: (version) =>
    version === 2
      ? `${SHIPPED_GOOGLE_ROLE.roleDefinition(1)}  - ${NEW_PERMISSION}\n`
      : SHIPPED_GOOGLE_ROLE.roleDefinition(version),
};

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const PROJECT = 'shop-prod';

interface Template {
  policyVersion: number;
  script: string;
  jwks: string;
  roleDefinition: string;
  names: {
    pool: string;
    provider: string;
    role: string;
    serviceAccount: string;
    serviceAccountEmail: string;
  };
}

interface View {
  cloudAccountId: string;
  name: string;
  workloadIdentityProvider: string;
  deployServiceAccount: string;
  signingKeyId: string;
  signingPublicKey: string;
  hasPendingSigningKey: boolean;
  tokenIssuer: string;
  policyVersion: number;
  lastCheckedAt: string;
  lastCheckResult: 'passed' | 'failed';
  lastCheckReason: string | null;
}

interface NewKey {
  signingKeyId: string;
  signingPublicKey: string;
  template: Template;
}

/** A refusal's message. */
function messageOf(res: { body: unknown }): string | undefined {
  return (res.body as { message?: string }).message;
}

/** The `kid` of every JWK in a JWKS. */
function kids(jwks: string): string[] {
  return (JSON.parse(jwks) as { keys: { kid: string }[] }).keys.map(
    (key) => key.kid,
  );
}

describe('Google Cloud account edit, check, key change and delete (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;
  let ownerCookie: string;

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [{ provide: GOOGLE_ROLE, useValue: testRole }],
    });
    httpServer = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    mockRole.version = 1;
    await ctx.resetDb();
    await ctx.db
      .insert(webServerSettings)
      .values({ host: 'cloudgate.example.com', https: true });
    const res = await request(httpServer)
      .post('/api/auth/sign-up/email')
      .send(owner);
    expect(res.status).toBe(200);
    ownerCookie = (res.headers['set-cookie'] as unknown as string[])
      .map((entry) => entry.split(';')[0])
      .join('; ');
  });

  /** A connected Google Cloud account, with the fake's calls cleared. */
  async function connected(
    cookie = ownerCookie,
  ): Promise<View & { names: Template['names'] }> {
    const setup = await request(httpServer)
      .post('/cloud-accounts/setup')
      .set('Cookie', cookie)
      .send({ cloud: 'gcp', cloudId: PROJECT });
    expect(setup.status).toBe(200);
    const answer = setup.body as { setupToken: string; template: Template };
    const { names } = answer.template;
    const res = await request(httpServer)
      .post('/cloud-accounts')
      .set('Cookie', cookie)
      .send({
        cloud: 'gcp',
        setupToken: answer.setupToken,
        name: 'Production Google',
        cloudId: PROJECT,
        workloadIdentityProvider: `projects/${FAKE_PROJECT_NUMBER}/locations/global/workloadIdentityPools/${names.pool}/providers/${names.provider}`,
        deployServiceAccount: names.serviceAccountEmail,
      });
    expect(res.status).toBe(201);
    ctx.google.reset();
    return { ...(res.body as View), names };
  }

  function edit(
    id: string,
    body: Record<string, unknown>,
    cookie = ownerCookie,
  ) {
    return request(httpServer)
      .patch(`/cloud-accounts/${id}`)
      .set('Cookie', cookie)
      .send({ cloud: 'gcp', ...body });
  }

  function checkNow(id: string, cookie = ownerCookie) {
    return request(httpServer)
      .post(`/cloud-accounts/${id}/check`)
      .set('Cookie', cookie);
  }

  function template(id: string, cookie = ownerCookie) {
    return request(httpServer)
      .get(`/cloud-accounts/${id}/template`)
      .set('Cookie', cookie);
  }

  /** The JWKS the template route hands out now. */
  async function templateJwks(id: string): Promise<string> {
    return ((await template(id)).body as Template).jwks;
  }

  function newKey(id: string, cookie = ownerCookie) {
    return request(httpServer)
      .post(`/cloud-accounts/${id}/key`)
      .set('Cookie', cookie);
  }

  function checkNewKey(id: string, cookie = ownerCookie) {
    return request(httpServer)
      .post(`/cloud-accounts/${id}/key/check`)
      .set('Cookie', cookie);
  }

  async function stored(id: string) {
    const [row] = await ctx.db
      .select()
      .from(cloudAccount)
      .where(eq(cloudAccount.cloudAccountId, id));
    return row;
  }

  /** The `kid` and `iss` of the token STS was handed last. */
  function lastToken() {
    const exchange = ctx.google.calls
      .filter((call) => call.method === 'exchangeToken')
      .at(-1);
    if (exchange?.method !== 'exchangeToken') throw new Error('no exchange');
    return {
      kid: exchange.token.header.kid,
      iss: exchange.token.claims.iss,
    };
  }

  describe('edit', () => {
    it('keeps every field left out and calls no Google for a rename', async () => {
      const account = await connected();

      const res = await edit(account.cloudAccountId, { name: 'Renamed' });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        name: 'Renamed',
        workloadIdentityProvider: account.workloadIdentityProvider,
        deployServiceAccount: account.deployServiceAccount,
        signingKeyId: account.signingKeyId,
        hasSigningKey: true,
        lastCheckedAt: account.lastCheckedAt,
      });
      expect(ctx.google.calls).toEqual([]);
    });

    it('reruns the check, signed with the stored key, and saves a new provider once it passes', async () => {
      const account = await connected();
      const provider = `projects/${FAKE_PROJECT_NUMBER}/locations/global/workloadIdentityPools/${account.names.pool}/providers/other-provider`;

      const res = await edit(account.cloudAccountId, {
        workloadIdentityProvider: `//iam.googleapis.com/${provider}`,
      });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        workloadIdentityProvider: provider,
        lastCheckResult: 'passed',
        lastCheckReason: null,
      });
      expect(ctx.google.calls[0]).toMatchObject({
        method: 'exchangeToken',
        audience: `//iam.googleapis.com/${provider}`,
      });
      expect(lastToken().kid).toBe(account.signingKeyId);
      expect(
        (await stored(account.cloudAccountId)).workloadIdentityProvider,
      ).toBe(provider);
    });

    it('keeps the old values when the re-check fails, without marking the working account failed', async () => {
      const account = await connected();
      ctx.google.permissionDenied('impersonate');
      const serviceAccount = `cloudgate-other@${PROJECT}.iam.gserviceaccount.com`;

      const res = await edit(account.cloudAccountId, {
        name: 'Should not stick',
        deployServiceAccount: serviceAccount,
      });

      expect(res.status).toBe(400);
      expect(messageOf(res)).toBe(
        `Cloudgate cannot act as the deploy service account ${serviceAccount}: The caller does not have permission. Grant this Cloud account's principal roles/iam.workloadIdentityUser on it, as the setup script does`,
      );
      expect(await stored(account.cloudAccountId)).toMatchObject({
        name: 'Production Google',
        deployServiceAccount: account.deployServiceAccount,
        lastCheckResult: 'passed',
        lastCheckReason: null,
        lastCheckedAt: account.lastCheckedAt,
      });
    });

    it('never changes the project, its number, the key or the issuer, and refuses AWS fields', async () => {
      const account = await connected();

      for (const body of [
        { cloudId: 'other-project' },
        { projectNumber: '1' },
        { signingKeyId: 'chosen' },
        { tokenIssuer: 'https://evil.example.com' },
        { accessKeyId: 'AKIAIOSFODNN7EXAMPLE' },
      ]) {
        expect((await edit(account.cloudAccountId, body)).status).toBe(400);
      }
      expect(await stored(account.cloudAccountId)).toMatchObject({
        cloudId: PROJECT,
        signingKeyId: account.signingKeyId,
        tokenIssuer: account.tokenIssuer,
      });
      expect(ctx.google.calls).toEqual([]);
    });

    it('refuses an edit that names the other cloud', async () => {
      const account = await connected();

      const res = await request(httpServer)
        .patch(`/cloud-accounts/${account.cloudAccountId}`)
        .set('Cookie', ownerCookie)
        .send({ name: 'Renamed' });

      expect(res.status).toBe(400);
      expect(messageOf(res)).toBe(
        'Cloud account Production Google is on Google Cloud, not AWS',
      );
    });
  });

  describe('Check now and the issuer', () => {
    it('records a failed check with its reason, and a passing one clears it', async () => {
      const account = await connected();
      ctx.google.turnOff('secretmanager.googleapis.com');

      const failed = await checkNow(account.cloudAccountId);

      expect(failed.status).toBe(200);
      expect(failed.body).toMatchObject({
        lastCheckResult: 'failed',
        lastCheckReason: `1 API Cloudgate needs is off in project ${PROJECT}: secretmanager.googleapis.com. Turn it on, as the setup script does`,
      });

      ctx.google.reset();
      const passed = await checkNow(account.cloudAccountId);

      expect(passed.body).toMatchObject({
        lastCheckResult: 'passed',
        lastCheckReason: null,
      });
      expect(lastToken().kid).toBe(account.signingKeyId);
    });

    it('keeps the issuer it was set up with when the install moves to another address', async () => {
      const account = await connected();
      expect(account.tokenIssuer).toBe(
        `https://cloudgate.example.com/${account.cloudAccountId}`,
      );
      await ctx.db.update(webServerSettings).set({ host: 'moved.example.com' });

      expect((await checkNow(account.cloudAccountId)).body).toMatchObject({
        lastCheckResult: 'passed',
      });
      expect(lastToken().iss).toBe(account.tokenIssuer);
      expect((await template(account.cloudAccountId)).body).toMatchObject({
        script: expect.stringContaining(
          `ISSUER='${account.tokenIssuer}'`,
        ) as unknown,
      });
    });
  });

  describe('permissions out of date', () => {
    it('shows a newer role version naming the missing permissions, with the new role definition', async () => {
      const account = await connected();
      expect(account).toMatchObject({
        policyVersion: 1,
        currentPolicyVersion: 1,
        permissionsOutOfDate: false,
        missingActions: [],
      });

      mockRole.version = 2;
      const read = await request(httpServer)
        .get(`/cloud-accounts/${account.cloudAccountId}`)
        .set('Cookie', ownerCookie);

      expect(read.body).toMatchObject({
        policyVersion: 1,
        currentPolicyVersion: 2,
        permissionsOutOfDate: true,
        missingActions: [NEW_PERMISSION],
      });
      const res = await template(account.cloudAccountId);
      expect(res.status).toBe(200);
      const given = res.body as Template;
      expect(given.policyVersion).toBe(2);
      expect(given.roleDefinition).toContain(`  - ${NEW_PERMISSION}\n`);
      expect(given.script).toContain(given.roleDefinition.trimEnd());
      expect(given.script).toContain('gcloud iam roles update "$ROLE"');
      expect(kids(given.jwks)).toEqual([account.signingKeyId]);
      expect(given.names).toEqual(account.names);
      expect(ctx.google.calls).toEqual([]);
    });

    it('stays out of date while the role lacks the new permission, and clears once a check passes', async () => {
      const account = await connected();
      mockRole.version = 2;
      ctx.google.withhold(NEW_PERMISSION);

      const failed = await checkNow(account.cloudAccountId);

      expect(failed.body).toMatchObject({
        policyVersion: 1,
        permissionsOutOfDate: true,
        lastCheckResult: 'failed',
        lastCheckReason: `The deploy service account is missing 1 permission of role version 2: ${NEW_PERMISSION}. Update the role from the setup script`,
      });

      ctx.google.reset();
      expect((await checkNow(account.cloudAccountId)).body).toMatchObject({
        policyVersion: 2,
        permissionsOutOfDate: false,
        missingActions: [],
        lastCheckResult: 'passed',
      });
    });
  });

  describe('a new key', () => {
    it('offers a JWKS with both public halves and keeps signing with the old key', async () => {
      const account = await connected();

      const res = await newKey(account.cloudAccountId);

      expect(res.status).toBe(200);
      const answer = res.body as NewKey;
      expect(answer.signingKeyId).not.toBe(account.signingKeyId);
      expect(kids(answer.template.jwks)).toEqual([
        account.signingKeyId,
        answer.signingKeyId,
      ]);
      expect(answer.template.script).toContain(answer.template.jwks.trimEnd());
      expect(answer.template.script).toContain(
        'providers update-oidc "$PROVIDER"',
      );
      expect(JSON.stringify(answer)).not.toContain('PRIVATE KEY');
      expect(ctx.google.calls).toEqual([]);

      const read = await request(httpServer)
        .get(`/cloud-accounts/${account.cloudAccountId}`)
        .set('Cookie', ownerCookie);
      expect(read.body).toMatchObject({
        signingKeyId: account.signingKeyId,
        hasPendingSigningKey: true,
      });
      expect(kids(await templateJwks(account.cloudAccountId))).toEqual([
        account.signingKeyId,
        answer.signingKeyId,
      ]);
      const { rows: raw } = await ctx.db.$client.query<{
        pending_signing_key: string;
      }>(
        'select pending_signing_key from cloud_account where cloud_account_id = $1',
        [account.cloudAccountId],
      );
      expect(raw[0].pending_signing_key).toMatch(/^enc:v1:/);

      // Check now and every use still sign with the old key.
      await checkNow(account.cloudAccountId);
      expect(lastToken().kid).toBe(account.signingKeyId);
    });

    it('changes nothing when the check with the new key fails', async () => {
      const account = await connected();
      const answer = (await newKey(account.cloudAccountId)).body as NewKey;
      ctx.google.refuse(
        'exchangeToken',
        'invalid_grant',
        'The ID Token is signed by a key the provider does not hold.',
      );
      const before = await stored(account.cloudAccountId);

      const res = await checkNewKey(account.cloudAccountId);

      expect(res.status).toBe(400);
      expect(messageOf(res)).toMatch(
        /^Google's STS refused this Cloud account's token at projects\/.*: The ID Token is signed by a key the provider does not hold\./,
      );
      expect(lastToken().kid).toBe(answer.signingKeyId);
      expect(await stored(account.cloudAccountId)).toEqual(before);
    });

    it('switches to the new key once a check signed with it passes, drops the old one and reminds the operator to upload the new-only JWKS', async () => {
      const account = await connected();
      const answer = (await newKey(account.cloudAccountId)).body as NewKey;

      const res = await checkNewKey(account.cloudAccountId);

      expect(res.status).toBe(200);
      const switched = res.body as {
        cloudAccount: View;
        jwks: string;
        message: string;
      };
      expect(lastToken().kid).toBe(answer.signingKeyId);
      expect(switched.cloudAccount).toMatchObject({
        signingKeyId: answer.signingKeyId,
        signingPublicKey: answer.signingPublicKey,
        hasPendingSigningKey: false,
        lastCheckResult: 'passed',
      });
      expect(kids(switched.jwks)).toEqual([answer.signingKeyId]);
      expect(switched.message).toBe(
        `Cloud account Production Google now signs with key ${answer.signingKeyId}. Upload the JWKS that holds only the new key to provider ${account.workloadIdentityProvider}, so the old key is no longer trusted`,
      );
      expect(await stored(account.cloudAccountId)).toMatchObject({
        signingKeyId: answer.signingKeyId,
        pendingSigningKey: null,
      });
      expect(kids(await templateJwks(account.cloudAccountId))).toEqual([
        answer.signingKeyId,
      ]);

      // The new key is the one that signs from now on, verifiably.
      ctx.google.reset();
      await checkNow(account.cloudAccountId);
      const [token] = ctx.google.subjectTokens;
      const [header, payload, signature] = token.split('.');
      expect(
        verify(
          'RSA-SHA256',
          Buffer.from(`${header}.${payload}`),
          createPublicKey({
            key: JSON.parse(answer.signingPublicKey) as Record<string, string>,
            format: 'jwk',
          }),
          Buffer.from(signature, 'base64url'),
        ),
      ).toBe(true);
    });

    it('switches to nothing when another new key was asked for while the check ran, keeping that one waiting', async () => {
      const account = await connected();
      const first = (await newKey(account.cloudAccountId)).body as NewKey;
      const release = ctx.google.holdSignIn();
      const checking = checkNewKey(account.cloudAccountId).then((res) => res);
      for (
        let tries = 0;
        tries < 200 &&
        !ctx.google.calls.some((call) => call.method === 'exchangeToken');
        tries++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(lastToken().kid).toBe(first.signingKeyId);
      const second = (await newKey(account.cloudAccountId)).body as NewKey;
      const waiting = await stored(account.cloudAccountId);
      release();

      const res = await checking;

      expect(res.status).toBe(409);
      expect(messageOf(res)).toBe(
        'Cloud account Production Google was asked for another new key while this one was checked; check the new key again',
      );
      expect(await stored(account.cloudAccountId)).toMatchObject({
        signingKeyId: account.signingKeyId,
        pendingSigningKey: waiting.pendingSigningKey,
      });
      expect(kids(await templateJwks(account.cloudAccountId))).toEqual([
        account.signingKeyId,
        second.signingKeyId,
      ]);
    });

    it('refuses the check with no new key waiting', async () => {
      const account = await connected();

      const res = await checkNewKey(account.cloudAccountId);

      expect(res.status).toBe(400);
      expect(messageOf(res)).toBe(
        'Cloud account Production Google has no new key waiting; ask for a new key first',
      );
      expect(ctx.google.calls).toEqual([]);
    });

    it('refuses an AWS Cloud account, whose key is its access key', async () => {
      const setup = await request(httpServer)
        .post('/cloud-accounts/setup')
        .set('Cookie', ownerCookie)
        .send({ cloudId: '123456789012' });
      const created = await request(httpServer)
        .post('/cloud-accounts')
        .set('Cookie', ownerCookie)
        .send({
          setupToken: (setup.body as { setupToken: string }).setupToken,
          name: 'Production AWS',
          cloudId: '123456789012',
          accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
          secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
          deployRoleArn: 'arn:aws:iam::123456789012:role/cloudgate-deploy',
          taskExecutionRoleArn:
            'arn:aws:iam::123456789012:role/cloudgate-task-execution',
        });
      expect(created.status).toBe(201);
      const id = (created.body as { cloudAccountId: string }).cloudAccountId;

      for (const res of [await newKey(id), await checkNewKey(id)]) {
        expect(res.status).toBe(400);
        expect(messageOf(res)).toBe(
          'Cloud account Production AWS is on AWS, where its key is the access key; change it by editing the Cloud account',
        );
      }
    });
  });

  describe('delete', () => {
    it('is refused while an Environment targets it', async () => {
      const account = await connected();
      const project = await request(httpServer)
        .post('/projects')
        .set('Cookie', ownerCookie)
        .send({ name: 'shop' });
      const created = await request(httpServer)
        .post('/environments')
        .set('Cookie', ownerCookie)
        .send({
          projectId: (project.body as { projectId: string }).projectId,
          name: 'production',
          deployTarget: { kind: 'platform-host' },
        });
      expect(created.status).toBe(201);
      await ctx.db
        .update(environment)
        .set({
          deployTarget: {
            kind: 'cloud',
            cloudAccountId: account.cloudAccountId,
            region: 'europe-west1',
          },
        })
        .where(
          eq(
            environment.environmentId,
            (created.body as { environmentId: string }).environmentId,
          ),
        );

      const res = await request(httpServer)
        .delete(`/cloud-accounts/${account.cloudAccountId}`)
        .set('Cookie', ownerCookie);

      expect(res.status).toBe(409);
      expect(messageOf(res)).toBe(
        'Cloud account Production Google is still used by 1 Environment (shop / production) as its Deploy target',
      );
      expect(await stored(account.cloudAccountId)).toBeDefined();
    });

    it('removes the row and names the pool, provider, role and service account to remove by hand', async () => {
      const account = await connected();
      const { names } = account;

      const res = await request(httpServer)
        .delete(`/cloud-accounts/${account.cloudAccountId}`)
        .set('Cookie', ownerCookie);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        cloudAccountId: account.cloudAccountId,
        name: 'Production Google',
        message: `Cloud account Production Google is removed from Cloudgate. Nothing was removed in Google Cloud project ${PROJECT}: the workload identity pool ${names.pool}, its provider ${account.workloadIdentityProvider}, the custom role projects/${PROJECT}/roles/${names.role} and the deploy service account ${account.deployServiceAccount} are yours to remove.`,
      });
      expect(await stored(account.cloudAccountId)).toBeUndefined();
      expect(ctx.google.calls).toEqual([]);
    });
  });

  describe('the cloudAccount statement', () => {
    it('lets an admin edit, check and change the key', async () => {
      const admin = await signUpMember(httpServer, ownerCookie, {
        email: 'admin@example.com',
        role: 'admin',
      });
      const account = await connected(admin.cookie);

      for (const res of [
        await edit(account.cloudAccountId, { name: 'x' }, admin.cookie),
        await checkNow(account.cloudAccountId, admin.cookie),
        await template(account.cloudAccountId, admin.cookie),
        await newKey(account.cloudAccountId, admin.cookie),
        await checkNewKey(account.cloudAccountId, admin.cookie),
      ]) {
        expect(res.status).toBe(200);
      }
    });

    it('refuses the base member every route, without calling Google', async () => {
      const account = await connected();
      const person = await signUpMember(httpServer, ownerCookie);

      for (const res of [
        await edit(account.cloudAccountId, { name: 'x' }, person.cookie),
        await checkNow(account.cloudAccountId, person.cookie),
        await template(account.cloudAccountId, person.cookie),
        await newKey(account.cloudAccountId, person.cookie),
        await checkNewKey(account.cloudAccountId, person.cookie),
      ]) {
        expect(res.status).toBe(403);
      }
      expect(ctx.google.calls).toEqual([]);
      expect(
        (await stored(account.cloudAccountId)).pendingSigningKey,
      ).toBeNull();
    });
  });
});
