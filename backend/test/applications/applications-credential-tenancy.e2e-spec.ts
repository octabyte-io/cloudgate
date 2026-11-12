import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { ApplicationsService } from '../../src/applications/applications.service';
import { application as applicationTable } from '../../src/db/schema';
import { SourceCloneService } from '../../src/git-providers/source-clone.service';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { secondOrganizationOwner } from '../utils/test-auth';

jest.setTimeout(120_000);

const instanceOwner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

/** An id shaped like the real ones and naming nothing anywhere. */
const NOWHERE = 'no-such-credential-id';

/** Every field of an error body except the wall clock. */
function withoutTimestamp(body: unknown): unknown {
  const rest = { ...(body as Record<string, unknown>) };
  delete rest.timestamp;
  return rest;
}

/**
 * `PATCH /applications/:id` as a cross-tenant **credential** write.
 *
 * `updateApplicationSchema` accepts eight parent ids. `update` resolved exactly
 * one of them — `checkServerAccess(this.db, ctx, data.buildServerId)`, whose
 * comment says as much because `buildServerId` is what an earlier fix fixed — and then
 * wrote `.set(data)`, so the other seven landed on foreign keys that require
 * only that the row exist. `findOwnedForUpdate` is not the gap: it org-scopes
 * the *Application*, not the credentials being attached to it.
 *
 * `findDeployable` loads all seven back as relations and its docblock states
 * the point — *"the full relation tree with credentials intact"* — so an owner
 * of organization A could `PATCH` their **own** Application with organization
 * B's `registryId`, `customGitSSHKeyId` or `githubId` and get a build that
 * pushed to B's private registry or cloned B's private repository as B. What
 * the caller got was never the plaintext but the **use** of it, which is the same
 * consequence reached through a Service rather than through a Server. The base
 * member role holds `sshKeys: []`, `gitProviders: []` and `registry: []`, so
 * this crossed the statement vocabulary as well as the organization.
 *
 * **Two accounts, not one account with two organizations**, for the reason
 * `patch-tenancy.e2e-spec.ts` and `server-ssh-key-tenancy.e2e-spec.ts` both
 * give: a second organization owned by the same user carries that user's
 * row-level grants and privileged role with it, so it cannot tell "the
 * credential is in another organization" from "the caller is the same person".
 * `secondOrganizationOwner` gives Mallory, a Member of exactly one
 * organization and an owner of it (ADR-0013's fixture).
 *
 * **Why not a row in `create-routes-server-id.e2e-spec.ts`**, which the earlier fix names
 * as the existing home for "unknown and foreign ids are refused byte-identically
 * and nothing is written". That table is *nine create routes × one id*: half of
 * this defect is a **PATCH**, which it has no column for; the id here is not a
 * `serverId`; its `insertForeignServer` builds its second organization out of
 * the same user and so cannot spell the caller above; and the clone assertion
 * at the bottom is not an HTTP create at all.
 *
 * **The pair is the point, not the 404.** §2.2 and ADR-0008 require that a
 * refusal disclose nothing about which ids exist elsewhere on the instance, so
 * every direction below asserts the foreign-id body against the
 * nothing-anywhere body field by field. A 404 saying *"Registry not found"*
 * beside a 404 saying *"that registry is in another organization"* would pass a
 * status check and be the oracle ADR-0008 names.
 *
 * Before the fix every refusal below read **200** with the foreign id on the
 * stored row, and the clone command carried the victim's private key.
 */
describe('Application credential tenancy (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
  });

  /** The credential-bearing columns, and the refusal each one's owner raises. */
  const REFUSALS = {
    githubId: 'GitHub provider not found',
    gitlabId: 'GitLab provider not found',
    giteaId: 'Gitea provider not found',
    bitbucketId: 'Bitbucket provider not found',
    customGitSSHKeyId: 'SSH key not found',
    registryId: 'Registry not found',
    buildRegistryId: 'Registry not found',
  } as const;

  type CredentialColumn = keyof typeof REFUSALS;

  /**
   * One credential of every kind in a single organization, plus an Application
   * to attach them to — all over HTTP, as the account that owns them.
   *
   * The generate path of `POST /ssh-keys` is the one response that carries a
   * private half (`SshKeysService.create`'s documented exception), which is
   * what lets the clone assertions below compare against the key that was
   * minted without ever asking the database for it.
   */
  async function organizationOf(cookie: string, slug: string) {
    const project = await request(server)
      .post('/projects')
      .set('Cookie', cookie)
      .send({ name: slug });
    expect(project.status).toBe(201);

    const environment = await request(server)
      .post('/environments')
      .set('Cookie', cookie)
      .send({
        name: 'production',
        projectId: (project.body as { projectId: string }).projectId,
      });
    expect(environment.status).toBe(201);

    // `appName` is unique across every Application row on the instance, so the
    // two organizations' services are named apart rather than by role.
    const app = await request(server)
      .post('/applications')
      .set('Cookie', cookie)
      .send({
        name: 'Blog',
        appName: `${slug}-app`,
        environmentId: (environment.body as { environmentId: string })
          .environmentId,
      });
    expect(app.status).toBe(201);

    const post = async (path: string, body: Record<string, unknown>) => {
      const res = await request(server)
        .post(path)
        .set('Cookie', cookie)
        .send(body);
      expect(res.status).toBe(201);
      return res.body as Record<string, string>;
    };

    const sshKey = await post('/ssh-keys', {
      name: `${slug}-key`,
      type: 'ed25519',
    });
    // The private half really was minted — asserted as a boolean rather than a
    // value, because a failing `expect` prints what it received and no private
    // key belongs in test output (the standing rule).
    expect(sshKey.privateKey.length > 0).toBe(true);

    const registry = await post('/registries', {
      name: `${slug}-registry`,
      username: slug,
      password: `${slug}-registry-secret`,
      url: '',
      registryType: 'cloud',
    });
    const buildRegistry = await post('/registries', {
      name: `${slug}-build-registry`,
      username: slug,
      password: `${slug}-build-secret`,
      url: '',
      registryType: 'cloud',
    });
    const github = await post('/github', { name: `${slug}-github` });
    const gitlab = await post('/gitlab', { name: `${slug}-gitlab` });
    const gitea = await post('/gitea', { name: `${slug}-gitea` });
    const bitbucket = await post('/bitbucket', { name: `${slug}-bitbucket` });

    const credentials: Record<CredentialColumn, string> = {
      githubId: github.githubId,
      gitlabId: gitlab.gitlabId,
      giteaId: gitea.giteaId,
      bitbucketId: bitbucket.bitbucketId,
      customGitSSHKeyId: sshKey.sshKeyId,
      registryId: registry.registryId,
      buildRegistryId: buildRegistry.registryId,
    };

    return {
      cookie,
      applicationId: (app.body as { applicationId: string }).applicationId,
      credentials,
      sshPrivateKey: sshKey.privateKey,
    };
  }

  /** Two organizations, an owner each, a full credential set in both. */
  async function setUpTwoOrganizations() {
    const signUp = await request(server)
      .post('/api/auth/sign-up/email')
      .send(instanceOwner);
    expect(signUp.status).toBe(200);
    const ownerCookie: string = signUp.headers['set-cookie'];

    const mallory = await secondOrganizationOwner(server, ctx.db, ownerCookie, {
      organizationName: 'Neighbour Org',
    });

    return {
      ours: await organizationOf(ownerCookie, 'cloudgate'),
      theirs: await organizationOf(mallory.cookie, 'neighbour'),
    };
  }

  const patch = (
    cookie: string,
    applicationId: string,
    body: Record<string, unknown>,
  ) =>
    request(server)
      .patch(`/applications/${applicationId}`)
      .set('Cookie', cookie)
      .send(body);

  /** The stored row, whichever organization owns it. */
  async function storedRow(applicationId: string) {
    const [row] = await ctx.db
      .select()
      .from(applicationTable)
      .where(eq(applicationTable.applicationId, applicationId));
    return row;
  }

  const columns = Object.keys(REFUSALS) as CredentialColumn[];

  describe('PATCH /applications/:id', () => {
    it.each(columns.map((column) => [column] as const))(
      "refuses another organization's %s, identically to an id that exists nowhere, and leaves the stored value alone",
      async (column) => {
        const { ours, theirs } = await setUpTwoOrganizations();

        // Attach our own first, so the assertion below is about a value being
        // *kept* rather than about a column that was null either way.
        const own = await patch(ours.cookie, ours.applicationId, {
          [column]: ours.credentials[column],
        });
        expect(own.status).toBe(200);

        const foreign = await patch(ours.cookie, ours.applicationId, {
          [column]: theirs.credentials[column],
        });
        const absent = await patch(ours.cookie, ours.applicationId, {
          [column]: NOWHERE,
        });

        expect(foreign.status).toBe(404);
        expect(withoutTimestamp(foreign.body)).toEqual(
          withoutTimestamp(absent.body),
        );
        expect(foreign.body).toMatchObject({ message: REFUSALS[column] });
        // The stored row still points where it did. The pre-fix behaviour was a
        // *successful* 200 carrying the neighbour's id, so a fix that wrote and
        // then answered 404 would also pass the assertions above.
        expect((await storedRow(ours.applicationId))[column]).toBe(
          ours.credentials[column],
        );
      },
    );

    it.each(columns.map((column) => [column] as const))(
      "refuses the other organization's owner our %s, identically to an id that exists nowhere",
      async (column) => {
        // The same claim from the other side: the refusal is not a property of
        // being the instance owner.
        const { ours, theirs } = await setUpTwoOrganizations();

        const foreign = await patch(theirs.cookie, theirs.applicationId, {
          [column]: ours.credentials[column],
        });
        const absent = await patch(theirs.cookie, theirs.applicationId, {
          [column]: NOWHERE,
        });

        expect(foreign.status).toBe(404);
        expect(withoutTimestamp(foreign.body)).toEqual(
          withoutTimestamp(absent.body),
        );
        expect(foreign.body).toMatchObject({ message: REFUSALS[column] });
        expect((await storedRow(theirs.applicationId))[column]).toBeNull();
      },
    );

    it("attaches every credential of the caller's own organization", async () => {
      // The control that keeps the seven refusals honest: a guard that refused
      // everything would pass every case above.
      const { ours } = await setUpTwoOrganizations();

      const attached = await patch(
        ours.cookie,
        ours.applicationId,
        ours.credentials,
      );

      expect(attached.status).toBe(200);
      expect(attached.body).toMatchObject(ours.credentials);
      expect(await storedRow(ours.applicationId)).toMatchObject(
        ours.credentials,
      );
    });

    it('detaches a credential on an explicit null, and takes a PATCH that names none', async () => {
      // `null` is how the console removes a registry or disconnects a provider,
      // and the schema is `.partial()`, so `undefined` is "untouched". A guard
      // that tried to resolve either would have refused both.
      const { ours } = await setUpTwoOrganizations();
      expect(
        (await patch(ours.cookie, ours.applicationId, ours.credentials)).status,
      ).toBe(200);

      const renamed = await patch(ours.cookie, ours.applicationId, {
        description: 'renamed',
      });
      expect(renamed.status).toBe(200);
      expect(renamed.body).toMatchObject({
        description: 'renamed',
        registryId: ours.credentials.registryId,
      });

      const detached = await patch(ours.cookie, ours.applicationId, {
        registryId: null,
        customGitSSHKeyId: null,
      });
      expect(detached.status).toBe(200);
      const row = await storedRow(ours.applicationId);
      expect(row.registryId).toBeNull();
      expect(row.customGitSSHKeyId).toBeNull();
    });

    it('refuses a body pairing our own registry with their SSH key, and writes neither', async () => {
      // The shape: one body, two ids, one of them legitimate. Nothing may
      // ride in beside an id that was refused.
      const { ours, theirs } = await setUpTwoOrganizations();

      const mixed = await patch(ours.cookie, ours.applicationId, {
        registryId: ours.credentials.registryId,
        customGitSSHKeyId: theirs.credentials.customGitSSHKeyId,
      });

      expect(mixed.status).toBe(404);
      expect(mixed.body).toMatchObject({ message: 'SSH key not found' });
      const row = await storedRow(ours.applicationId);
      expect(row.customGitSSHKeyId).toBeNull();
      // And the legitimate half did not land either — the refusal is the whole
      // write, not the credential column alone.
      expect(row.registryId).toBeNull();
    });
  });

  /**
   * The consequence, at the last seam reachable without a network: the clone
   * command the build would run.
   *
   * The comment is what makes this obligatory rather than nice to have. A
   * sweep had concluded the `customGitSSHKeyId` arm was latent because
   * `grep -rn customGitSSHKeyId src` finds only the schema, the DTOs and the
   * service — and missed the consumer, because the **relation is named
   * `customGitSSHKey`, without the `Id`**: `findDeployable` loads it,
   * `deployment-engine.types.ts` carries it, and
   * `SourceCloneService.cloneProgram` passes it into the clone as
   * `sshKey: application.customGitSSHKey`, where `git.strategy.ts` writes the
   * decrypted private key to `/tmp/cloudgate/id_rsa` and exports a
   * `GIT_SSH_COMMAND` that uses it. So the row being refused is only half the
   * claim; the other half is that no build would have authenticated with the
   * victim's key, and this is where that is asked.
   *
   * Every comparison against key material is a **boolean**, for the stated
   * reason: a failing `expect` prints what it received, and no private key
   * belongs in test output.
   */
  describe('the clone a build would run', () => {
    /**
     * Whether the command carries this key — **base64, because that is how the
     * key travels now**. `git.strategy.ts` used to write
     * `echo '<the PEM>' > /tmp/cloudgate/id_rsa`, which put the decrypted key
     * into `ExecError.command` on every failed clone and from there into the
     * journal; it now ships the same bytes in the
     * `echo <base64> | base64 -d` shape the rest of the tree uses, so a
     * plaintext `includes` would answer `false` for every key and quietly turn
     * the negative arms below into assertions about nothing.
     *
     * The trailing newline is the one `echo` used to add and the encoder now
     * adds explicitly. Still a boolean, for the same reason: no private key
     * belongs in test output.
     */
    const carriesKey = (command: string, privateKey: string): boolean =>
      command.includes(
        Buffer.from(`${privateKey}\n`, 'utf-8').toString('base64'),
      );

    const cloneCommandFor = async (applicationId: string) => {
      const applications = ctx.app.get(ApplicationsService);
      const clones = ctx.app.get(SourceCloneService);
      const deployable = await applications.findDeployable(applicationId);
      // On a Server, so the clone's host is not the address check's question.
      return (
        await clones.cloneProgram(deployable, '/tmp/cloudgate-test-out', {
          on: { serverId: 'srv_any', serviceId: applicationId },
        })
      ).command;
    };

    /** A `git`-source Application pointed at an ssh URL, which is the only
     * source type that reads `customGitSSHKey` at all. */
    async function asSshSourced(cookie: string, applicationId: string) {
      const res = await patch(cookie, applicationId, {
        sourceType: 'git',
        customGitUrl: 'git@github.com:neighbour/private.git',
        customGitBranch: 'main',
      });
      expect(res.status).toBe(200);
    }

    it("does not carry the other organization's private key after the PATCH that tried to attach it", async () => {
      const { ours, theirs } = await setUpTwoOrganizations();
      await asSshSourced(ours.cookie, ours.applicationId);

      const refused = await patch(ours.cookie, ours.applicationId, {
        customGitSSHKeyId: theirs.credentials.customGitSSHKeyId,
      });
      expect(refused.status).toBe(404);

      const command = await cloneCommandFor(ours.applicationId);
      expect(carriesKey(command, theirs.sshPrivateKey)).toBe(false);
      // Not merely absent from the command: the Application has no key at all,
      // so the build stops at the strategy's own refusal rather than cloning
      // anonymously against a private repository.
      expect(command).toContain(
        'You are trying to clone a ssh repository without a ssh key',
      );
    });

    it("carries the caller's own private key once their own key is attached", async () => {
      // The control that keeps the assertion above from passing on a command
      // that never carries any key. Before the fix, this same command carried
      // the *neighbour's* key.
      const { ours, theirs } = await setUpTwoOrganizations();
      await asSshSourced(ours.cookie, ours.applicationId);

      const attached = await patch(ours.cookie, ours.applicationId, {
        customGitSSHKeyId: ours.credentials.customGitSSHKeyId,
      });
      expect(attached.status).toBe(200);

      const command = await cloneCommandFor(ours.applicationId);
      expect(carriesKey(command, ours.sshPrivateKey)).toBe(true);
      expect(carriesKey(command, theirs.sshPrivateKey)).toBe(false);
    });
  });
});
