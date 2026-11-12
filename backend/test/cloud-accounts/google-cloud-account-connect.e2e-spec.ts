import { createPublicKey, verify } from 'node:crypto';
import request from 'supertest';
import { App } from 'supertest/types';

import { cloudAccount, webServerSettings } from '../../src/db/schema';
import {
  requiredPermissions,
  stackVmPermissionsMissing,
} from '../../src/cloud-accounts/gcp/deploy-role';
import { STACK_VM_GAP } from '../../src/cloud-accounts/stack-vm-permissions';
import { FAKE_PROJECT_NUMBER } from '../utils/fake-google-cloud-port';
import { signUpMember } from '../utils/test-auth';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

/**
 * Connecting a Google Cloud project as a Cloud account (spec
 * "Connecting"). Every Google answer comes from `ctx.google`, the
 * in-memory fake, which says yes unless a test scripts the refusal it is
 * about.
 */

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const PROJECT = 'shop-prod';

interface GoogleSetupAnswer {
  cloud: 'gcp';
  setupToken: string;
  cloudAccountId: string;
  signingKeyId: string;
  signingPublicKey: string;
  template: {
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
  };
}

/** A refusal's message. */
function messageOf(res: { body: unknown }): string | undefined {
  return (res.body as { message?: string }).message;
}

describe('Connecting a Google Cloud project (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;
  let ownerCookie: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    httpServer = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    // The install's own address, which the tokens' issuer is made from.
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

  async function setup(
    body: Record<string, unknown> = {},
    cookie = ownerCookie,
  ): Promise<GoogleSetupAnswer> {
    const res = await request(httpServer)
      .post('/cloud-accounts/setup')
      .set('Cookie', cookie)
      .send({ cloud: 'gcp', cloudId: PROJECT, ...body });
    expect(res.status).toBe(200);
    return res.body as GoogleSetupAnswer;
  }

  function providerOf(answer: GoogleSetupAnswer): string {
    return `projects/${FAKE_PROJECT_NUMBER}/locations/global/workloadIdentityPools/${answer.template.names.pool}/providers/${answer.template.names.provider}`;
  }

  function connect(
    answer: GoogleSetupAnswer,
    overrides: Record<string, unknown> = {},
    cookie = ownerCookie,
  ) {
    return request(httpServer)
      .post('/cloud-accounts')
      .set('Cookie', cookie)
      .send({
        cloud: 'gcp',
        setupToken: answer.setupToken,
        name: 'Production Google',
        cloudId: PROJECT,
        workloadIdentityProvider: providerOf(answer),
        deployServiceAccount: answer.template.names.serviceAccountEmail,
        ...overrides,
      });
  }

  async function rows() {
    return ctx.db.select().from(cloudAccount);
  }

  describe('setup', () => {
    it('hands out the script, the JWKS and the role, and calls nothing in Google', async () => {
      const answer = await setup();
      const { script, jwks, roleDefinition, names } = answer.template;
      const subject = `cloudgate:${answer.cloudAccountId}`;

      expect(answer.template.policyVersion).toBe(7);
      expect(names.serviceAccountEmail).toBe(
        `${names.serviceAccount}@${PROJECT}.iam.gserviceaccount.com`,
      );
      // The pool and its OIDC provider, trusting the uploaded JWKS, with the
      // mapping and the condition on `sub` (S16).
      expect(script).toContain(`PROJECT_ID='${PROJECT}'`);
      expect(script).toContain(`POOL='${names.pool}'`);
      expect(script).toContain(
        'gcloud iam workload-identity-pools create "$POOL"',
      );
      expect(script).toContain('providers create-oidc "$PROVIDER"');
      expect(script).toContain(
        `ISSUER='https://cloudgate.example.com/${answer.cloudAccountId}'`,
      );
      expect(script).toContain(`SUBJECT='${subject}'`);
      expect(script).toContain(
        '--attribute-mapping="google.subject=assertion.sub"',
      );
      expect(script).toContain(
        `--attribute-condition="assertion.sub == '\${SUBJECT}'"`,
      );
      expect(script).toContain('--jwk-json-path=cloudgate-jwks.json');
      expect(script).toContain(jwks.trimEnd());
      // The role, the service account and the grants.
      expect(script).toContain(roleDefinition.trimEnd());
      expect(script).toContain(
        'gcloud iam roles create "$ROLE" --project="$PROJECT_ID" --file=cloudgate-role.yaml',
      );
      expect(script).toContain(
        'gcloud iam service-accounts create "$SERVICE_ACCOUNT"',
      );
      expect(script).toContain('--role="projects/${PROJECT_ID}/roles/${ROLE}"');
      expect(script).toContain('--role=roles/iam.workloadIdentityUser');
      expect(script).toContain(
        '--member="principal://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/subject/${SUBJECT}"',
      );
      // All 19 APIs, Certificate Manager, Secret Manager, the databases', Cloud Storage's and IAP's among them.
      const lines = script.split('\n');
      const enable = lines.find((line) =>
        line.startsWith('gcloud services enable '),
      )!;
      // The project number is read through Cloud Resource Manager, which a
      // new project has off until this line turns it on (the live walk).
      expect(lines.indexOf(enable)).toBeLessThan(
        lines.findIndex((line) => line.includes('gcloud projects describe')),
      );
      expect(enable.split(' ').slice(3).sort()).toEqual([
        'artifactregistry.googleapis.com',
        'certificatemanager.googleapis.com',
        'cloudresourcemanager.googleapis.com',
        'compute.googleapis.com',
        'dns.googleapis.com',
        'iam.googleapis.com',
        'iamcredentials.googleapis.com',
        'iap.googleapis.com',
        'logging.googleapis.com',
        'memorystore.googleapis.com',
        'networkconnectivity.googleapis.com',
        'run.googleapis.com',
        'secretmanager.googleapis.com',
        'serviceconsumermanagement.googleapis.com',
        'servicenetworking.googleapis.com',
        'serviceusage.googleapis.com',
        'sqladmin.googleapis.com',
        'storage.googleapis.com',
        'sts.googleapis.com',
      ]);
      // Version 7, a Self-hosted instance's: version 5 (from the walk by
      // hand) plus a Stack VM's, named in the role's description.
      expect(roleDefinition).toContain(
        'description: Cloudgate deploy role, version 7\n',
      );
      for (const permission of requiredPermissions(7)) {
        expect(roleDefinition).toContain(`  - ${permission}\n`);
      }
      for (const permission of [
        'run.workerpools.create',
        'run.jobs.run',
        'run.executions.cancel',
        'dns.managedZones.setIamPolicy',
      ]) {
        expect(roleDefinition).toContain(`  - ${permission}\n`);
      }

      // The JWKS carries the public half only.
      const uploaded = JSON.parse(jwks) as { keys: Record<string, unknown>[] };
      expect(uploaded.keys).toEqual([JSON.parse(answer.signingPublicKey)]);
      expect(uploaded.keys[0]).toMatchObject({
        kty: 'RSA',
        alg: 'RS256',
        kid: answer.signingKeyId,
      });
      expect(JSON.stringify(answer)).not.toContain('PRIVATE KEY');

      expect(await rows()).toEqual([]);
      expect(ctx.google.calls).toEqual([]);
    });

    it('keeps the key and the id when its token is handed back for a corrected project id', async () => {
      const first = await setup({ cloudId: 'shop-prdo' });
      const second = await setup({
        cloudId: PROJECT,
        setupToken: first.setupToken,
      });
      const fresh = await setup();

      expect(second.cloudAccountId).toBe(first.cloudAccountId);
      expect(second.signingKeyId).toBe(first.signingKeyId);
      expect(second.template.script).toContain(`PROJECT_ID='${PROJECT}'`);
      expect(fresh.signingKeyId).not.toBe(first.signingKeyId);
    });

    it('refuses an AWS setup token, and a project id that is not one', async () => {
      const aws = await request(httpServer)
        .post('/cloud-accounts/setup')
        .set('Cookie', ownerCookie)
        .send({ cloudId: '123456789012' });
      expect(aws.status).toBe(200);

      const reused = await request(httpServer)
        .post('/cloud-accounts/setup')
        .set('Cookie', ownerCookie)
        .send({
          cloud: 'gcp',
          cloudId: PROJECT,
          setupToken: (aws.body as { setupToken: string }).setupToken,
        });
      expect(reused.status).toBe(400);

      const bad = await request(httpServer)
        .post('/cloud-accounts/setup')
        .set('Cookie', ownerCookie)
        .send({ cloud: 'gcp', cloudId: 'Shop_Prod' });
      expect(bad.status).toBe(400);
    });

    it('refuses while Cloudgate knows no address of its own to issue tokens under', async () => {
      await ctx.db.delete(webServerSettings);

      const res = await request(httpServer)
        .post('/cloud-accounts/setup')
        .set('Cookie', ownerCookie)
        .send({ cloud: 'gcp', cloudId: PROJECT });

      // No BETTER_AUTH_URL in the e2e environment either.
      expect(res.status).toBe(400);
      expect(messageOf(res)).toBe(
        "Cloudgate does not know its own address, which a Google Cloud project's provider names as the issuer. Set the instance URL in Settings first",
      );
    });
  });

  describe('connect', () => {
    it('passes, and stores the project number, the provider, the service account, the encrypted key and role version 7', async () => {
      const answer = await setup();

      const res = await connect(answer);

      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({
        cloudAccountId: answer.cloudAccountId,
        cloud: 'gcp',
        cloudId: PROJECT,
        name: 'Production Google',
        projectNumber: FAKE_PROJECT_NUMBER,
        workloadIdentityProvider: providerOf(answer),
        deployServiceAccount: answer.template.names.serviceAccountEmail,
        signingKeyId: answer.signingKeyId,
        signingPublicKey: answer.signingPublicKey,
        hasSigningKey: true,
        hasPendingSigningKey: false,
        policyVersion: 7,
        currentPolicyVersion: 7,
        permissionsOutOfDate: false,
        lastCheckResult: 'passed',
      });
      for (const field of ['signingKey', 'pendingSigningKey', 'externalId']) {
        expect(res.body).not.toHaveProperty(field);
      }
      expect(JSON.stringify(res.body)).not.toContain('PRIVATE KEY');

      const { rows: raw } = await ctx.db.$client.query<{
        signing_key: string;
      }>('select signing_key from cloud_account where cloud_account_id = $1', [
        answer.cloudAccountId,
      ]);
      expect(raw[0].signing_key).toMatch(/^enc:v1:/);

      const listed = await request(httpServer)
        .get('/cloud-accounts')
        .set('Cookie', ownerCookie);
      expect(listed.body).toEqual([res.body]);
    });

    it('signs the check with the Cloud account key, then steps into the service account and reads the project', async () => {
      const answer = await setup();
      expect((await connect(answer)).status).toBe(201);

      const exchange = ctx.google.calls[0];
      expect(exchange).toMatchObject({
        method: 'exchangeToken',
        audience: `//iam.googleapis.com/${providerOf(answer)}`,
      });
      if (exchange.method !== 'exchangeToken') throw new Error('unreachable');
      expect(exchange.token.header).toEqual({
        alg: 'RS256',
        typ: 'JWT',
        kid: answer.signingKeyId,
      });
      const claims = exchange.token.claims as Record<string, number | string>;
      expect(claims).toMatchObject({
        iss: `https://cloudgate.example.com/${answer.cloudAccountId}`,
        sub: `cloudgate:${answer.cloudAccountId}`,
        aud: `//iam.googleapis.com/${providerOf(answer)}`,
      });
      expect(Number(claims.exp) - Number(claims.iat)).toBe(300);

      expect(ctx.google.calls.slice(1)).toEqual([
        {
          method: 'impersonate',
          serviceAccount: answer.template.names.serviceAccountEmail,
          lifetimeSeconds: 300,
          federated: true,
        },
        { method: 'getProject', projectId: PROJECT, impersonated: true },
        {
          method: 'testIamPermissions',
          projectId: PROJECT,
          permissions: requiredPermissions(7),
        },
        { method: 'enabledApis', projectNumber: FAKE_PROJECT_NUMBER },
      ]);
    });

    it('accepts the provider as Google writes its full name', async () => {
      const answer = await setup();

      const res = await connect(answer, {
        workloadIdentityProvider: `//iam.googleapis.com/${providerOf(answer)}`,
      });

      expect(res.status).toBe(201);
      expect(
        (res.body as { workloadIdentityProvider: string })
          .workloadIdentityProvider,
      ).toBe(providerOf(answer));
    });

    it('signs with the key whose public half the setup handed out', async () => {
      const answer = await setup();
      expect((await connect(answer)).status).toBe(201);

      const [token] = ctx.google.subjectTokens;
      const [header, payload, signature] = token.split('.');
      const publicKey = createPublicKey({
        key: JSON.parse(answer.signingPublicKey) as Record<string, string>,
        format: 'jwk',
      });
      expect(
        verify(
          'RSA-SHA256',
          Buffer.from(`${header}.${payload}`),
          publicKey,
          Buffer.from(signature, 'base64url'),
        ),
      ).toBe(true);
    });

    it('refuses a project already connected to the Organization, calling nothing', async () => {
      expect((await connect(await setup())).status).toBe(201);
      ctx.google.calls.length = 0;

      const res = await connect(await setup());

      expect(res.status).toBe(409);
      expect(messageOf(res)).toBe(
        'This Google Cloud project is already connected to this Organization as a Cloud account',
      );
      expect(ctx.google.calls).toEqual([]);
    });

    describe('refuses the save with what to fix, saving nothing', () => {
      it.each([
        [
          'STS refused the token',
          () =>
            ctx.google.refuse(
              'exchangeToken',
              'invalid_grant',
              'The audience in ID Token does not match the expected audience.',
            ),
          /Google's STS refused this Cloud account's token at projects\/.*: The audience in ID Token does not match the expected audience\. Check the provider name, and that it holds this Cloud account's JWKS from the setup script/,
        ],
        [
          'impersonation refused',
          () => ctx.google.permissionDenied('impersonate'),
          /Cloudgate cannot act as the deploy service account cloudgate-deploy-[a-z2-7]+@shop-prod\.iam\.gserviceaccount\.com: The caller does not have permission\. Grant this Cloud account's principal roles\/iam\.workloadIdentityUser on it/,
        ],
        [
          'the project cannot be read (a wrong project id)',
          () => ctx.google.permissionDenied('getProject'),
          /Google Cloud project shop-prod could not be read as the deploy service account: The caller does not have permission\. Check the project id/,
        ],
        [
          'the project read is another one',
          () => ctx.google.answerProject({ projectId: 'other-project' }),
          /The deploy service account reached project other-project, not shop-prod/,
        ],
      ])('when %s', async (_case, script, message) => {
        const answer = await setup();
        script();

        const res = await connect(answer);

        expect(res.status).toBe(400);
        expect(messageOf(res)).toMatch(message);
        expect(await rows()).toEqual([]);
      });

      it('when the service account is outside the project, before calling Google', async () => {
        const answer = await setup();

        const res = await connect(answer, {
          deployServiceAccount:
            'cloudgate-deploy@other-project.iam.gserviceaccount.com',
        });

        expect(res.status).toBe(400);
        expect(messageOf(res)).toBe(
          'The deploy service account cloudgate-deploy@other-project.iam.gserviceaccount.com is not in project shop-prod. Use the one the setup script made there',
        );
        expect(ctx.google.calls).toEqual([]);
        expect(await rows()).toEqual([]);
      });

      it('when permissions are missing, naming every one', async () => {
        const answer = await setup();
        ctx.google.withhold(
          'run.services.create',
          'secretmanager.versions.add',
          'certificatemanager.certs.create',
        );

        const res = await connect(answer);

        expect(res.status).toBe(400);
        expect(messageOf(res)).toBe(
          'The deploy service account is missing 3 permissions of role version 7: run.services.create, certificatemanager.certs.create, secretmanager.versions.add. Update the role from the setup script',
        );
        expect(await rows()).toEqual([]);
      });

      it('when APIs are off, naming every one', async () => {
        const answer = await setup();
        ctx.google.turnOff(
          'certificatemanager.googleapis.com',
          'secretmanager.googleapis.com',
        );

        const res = await connect(answer);

        expect(res.status).toBe(400);
        expect(messageOf(res)).toBe(
          '2 APIs Cloudgate needs are off in project shop-prod: certificatemanager.googleapis.com, secretmanager.googleapis.com. Turn them on, as the setup script does',
        );
        expect(await rows()).toEqual([]);
      });
    });

    it("refuses a token made for another Organization's or for AWS", async () => {
      const aws = await request(httpServer)
        .post('/cloud-accounts/setup')
        .set('Cookie', ownerCookie)
        .send({ cloudId: '123456789012' });
      const answer = await setup();

      const res = await connect(answer, {
        setupToken: (aws.body as { setupToken: string }).setupToken,
      });

      expect(res.status).toBe(400);
      expect(messageOf(res)).toBe(
        'The setup token is not one Cloudgate made for a Google Cloud project in this Organization; get the setup script again',
      );
      expect(await rows()).toEqual([]);
    });

    it('refuses a member without the cloudAccount statement', async () => {
      const answer = await setup();
      const member = await signUpMember(httpServer, ownerCookie, {
        email: 'member@example.com',
        role: 'member',
      });

      expect((await connect(answer, {}, member.cookie)).status).toBe(403);
      expect(
        (
          await request(httpServer)
            .post('/cloud-accounts/setup')
            .set('Cookie', member.cookie)
            .send({ cloud: 'gcp', cloudId: PROJECT })
        ).status,
      ).toBe(403);
      expect(await rows()).toEqual([]);
    });
  });

  /**
   * The shipped role table, not a stand-in: a Cloud account last checked
   * on version 5, before Stack VMs, is out of date on a Self-hosted
   * instance by exactly what version 7 adds (#1366): a Stack VM's
   * permissions, never Cloud Build's.
   */
  describe('a Cloud account checked on role version 5', () => {
    const VERSION_7_ADDS = stackVmPermissionsMissing(5);
    const FIX =
      "Run the Cloud account's new setup script in Cloud Shell, which updates the role and turns on IAP's API, then Check now";

    async function onVersion5(): Promise<string> {
      const answer = await setup();
      expect((await connect(answer)).status).toBe(201);
      await ctx.db.update(cloudAccount).set({ policyVersion: 5 });
      ctx.google.reset();
      return answer.cloudAccountId;
    }

    it('reports permissions out of date, naming each permission version 7 adds and nothing else', async () => {
      const id = await onVersion5();

      const read = await request(httpServer)
        .get(`/cloud-accounts/${id}`)
        .set('Cookie', ownerCookie);

      expect(read.status).toBe(200);
      const body = read.body as {
        policyVersion: number;
        currentPolicyVersion: number;
        permissionsOutOfDate: boolean;
        missingActions: string[];
      };
      expect(body).toMatchObject({
        policyVersion: 5,
        currentPolicyVersion: 7,
        permissionsOutOfDate: true,
      });
      expect([...body.missingActions].sort()).toEqual(
        [...VERSION_7_ADDS].sort(),
      );
      expect(body.missingActions).toContain('iap.tunnelInstances.accessViaIAP');
      expect(body.missingActions.join(' ')).not.toContain('cloudbuild');
      expect(ctx.google.calls).toEqual([]);
    });

    it('hands out the setup script updating the role to version 7', async () => {
      const id = await onVersion5();

      const res = await request(httpServer)
        .get(`/cloud-accounts/${id}/template`)
        .set('Cookie', ownerCookie);

      expect(res.status).toBe(200);
      const given = res.body as GoogleSetupAnswer['template'];
      expect(given.policyVersion).toBe(7);
      expect(given.roleDefinition).toContain(
        'description: Cloudgate deploy role, version 7\n',
      );
      for (const permission of VERSION_7_ADDS) {
        expect(given.roleDefinition).toContain(`  - ${permission}\n`);
      }
      expect(given.script).toContain(given.roleDefinition.trimEnd());
      expect(given.script).toContain('gcloud iam roles update "$ROLE"');
      expect(given.script).toMatch(
        /gcloud services enable [^\n]*iap\.googleapis\.com/,
      );
    });

    it('fails Check now while the role lacks them, naming them as the Stack VM gap with its fix, then reports nothing missing on version 7', async () => {
      const id = await onVersion5();
      ctx.google.withhold(...VERSION_7_ADDS);

      const failed = await request(httpServer)
        .post(`/cloud-accounts/${id}/check`)
        .set('Cookie', ownerCookie);

      expect(failed.body).toMatchObject({
        policyVersion: 5,
        permissionsOutOfDate: true,
        lastCheckResult: 'failed',
        lastCheckReason: `The deploy service account is missing ${VERSION_7_ADDS.length} permissions of role version 7: ${VERSION_7_ADDS.join(', ')}. They are ${STACK_VM_GAP.gcp}, which version 7 adds. ${FIX}`,
      });

      ctx.google.reset();
      const passed = await request(httpServer)
        .post(`/cloud-accounts/${id}/check`)
        .set('Cookie', ownerCookie);

      expect(passed.body).toMatchObject({
        policyVersion: 7,
        currentPolicyVersion: 7,
        permissionsOutOfDate: false,
        missingActions: [],
        lastCheckResult: 'passed',
      });
    });
  });
});
