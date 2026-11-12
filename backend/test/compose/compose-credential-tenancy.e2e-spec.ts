import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { ComposeService } from '../../src/compose/compose.service';
import { compose as composeTable } from '../../src/db/schema';
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
 * `PATCH /compose/:id` as a cross-tenant **credential** write.
 *
 * The Application half is `test/applications/applications-credential-tenancy.e2e-spec.ts`,
 * which carries the full argument for the fixture and for asserting the pair
 * rather than the status. This is the same defect through the same fields on
 * the other write: `updateComposeSchema` accepts five credential-bearing parent
 * ids, `ComposeService.update` resolved none of them, and `.set(data)` wrote
 * all five onto foreign keys that require only that the row exist.
 * `findDeployable` loads them back for the build and
 * `DeploymentEngineService` hands the row straight to
 * `SourceCloneService.cloneProgram`, so a stack pointed at a neighbouring
 * organization's `customGitSSHKeyId` cloned as the victim.
 *
 * **Five columns rather than the Application's seven**, and the difference is
 * real rather than an omission here: a Compose stack has no
 * `registryId`/`buildRegistryId` and no `buildServerId`.
 *
 * Before the fix every refusal below read **200** with the foreign id on the
 * stored row, and the clone command carried the victim's private key.
 */
describe('Compose credential tenancy (e2e)', () => {
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
  } as const;

  type CredentialColumn = keyof typeof REFUSALS;

  /** A Compose stack and one credential of every kind, in one organization. */
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

    // `appName` is unique across every Compose row on the instance, so the two
    // organizations' stacks are named apart rather than by role.
    const stack = await request(server)
      .post('/compose')
      .set('Cookie', cookie)
      .send({
        name: 'Stack',
        appName: `${slug}-stack`,
        environmentId: (environment.body as { environmentId: string })
          .environmentId,
      });
    expect(stack.status).toBe(201);

    const post = async (path: string, body: Record<string, unknown>) => {
      const res = await request(server)
        .post(path)
        .set('Cookie', cookie)
        .send(body);
      expect(res.status).toBe(201);
      return res.body as Record<string, string>;
    };

    // The generate path of `POST /ssh-keys` is the one response that carries a
    // private half (`SshKeysService.create`'s documented exception), which is
    // what lets the clone assertions compare against the key that was minted
    // without ever asking the database for it.
    const sshKey = await post('/ssh-keys', {
      name: `${slug}-key`,
      type: 'ed25519',
    });
    // Asserted as a boolean rather than a value, because a failing `expect`
    // prints what it received and no private key belongs in test output.
    expect(sshKey.privateKey.length > 0).toBe(true);

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
    };

    return {
      cookie,
      composeId: (stack.body as { composeId: string }).composeId,
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
    composeId: string,
    body: Record<string, unknown>,
  ) =>
    request(server)
      .patch(`/compose/${composeId}`)
      .set('Cookie', cookie)
      .send(body);

  /** The stored row, whichever organization owns it. */
  async function storedRow(composeId: string) {
    const [row] = await ctx.db
      .select()
      .from(composeTable)
      .where(eq(composeTable.composeId, composeId));
    return row;
  }

  const columns = Object.keys(REFUSALS) as CredentialColumn[];

  describe('PATCH /compose/:id', () => {
    it.each(columns.map((column) => [column] as const))(
      "refuses another organization's %s, identically to an id that exists nowhere, and leaves the stored value alone",
      async (column) => {
        const { ours, theirs } = await setUpTwoOrganizations();

        // Attach our own first, so the assertion below is about a value being
        // *kept* rather than about a column that was null either way.
        const own = await patch(ours.cookie, ours.composeId, {
          [column]: ours.credentials[column],
        });
        expect(own.status).toBe(200);

        const foreign = await patch(ours.cookie, ours.composeId, {
          [column]: theirs.credentials[column],
        });
        const absent = await patch(ours.cookie, ours.composeId, {
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
        expect((await storedRow(ours.composeId))[column]).toBe(
          ours.credentials[column],
        );
      },
    );

    it.each(columns.map((column) => [column] as const))(
      "refuses the other organization's owner our %s, identically to an id that exists nowhere",
      async (column) => {
        const { ours, theirs } = await setUpTwoOrganizations();

        const foreign = await patch(theirs.cookie, theirs.composeId, {
          [column]: ours.credentials[column],
        });
        const absent = await patch(theirs.cookie, theirs.composeId, {
          [column]: NOWHERE,
        });

        expect(foreign.status).toBe(404);
        expect(withoutTimestamp(foreign.body)).toEqual(
          withoutTimestamp(absent.body),
        );
        expect(foreign.body).toMatchObject({ message: REFUSALS[column] });
        expect((await storedRow(theirs.composeId))[column]).toBeNull();
      },
    );

    it("attaches every credential of the caller's own organization", async () => {
      // The control that keeps the five refusals honest: a guard that refused
      // everything would pass every case above.
      const { ours } = await setUpTwoOrganizations();

      const attached = await patch(ours.cookie, ours.composeId, {
        ...ours.credentials,
      });

      expect(attached.status).toBe(200);
      expect(attached.body).toMatchObject(ours.credentials);
      expect(await storedRow(ours.composeId)).toMatchObject(ours.credentials);
    });

    it('disconnects a provider on an explicit null, and takes a PATCH that names none', async () => {
      const { ours } = await setUpTwoOrganizations();
      expect(
        (await patch(ours.cookie, ours.composeId, { ...ours.credentials }))
          .status,
      ).toBe(200);

      const renamed = await patch(ours.cookie, ours.composeId, {
        description: 'renamed',
      });
      expect(renamed.status).toBe(200);
      expect(renamed.body).toMatchObject({
        description: 'renamed',
        githubId: ours.credentials.githubId,
      });

      const detached = await patch(ours.cookie, ours.composeId, {
        githubId: null,
        customGitSSHKeyId: null,
      });
      expect(detached.status).toBe(200);
      const row = await storedRow(ours.composeId);
      expect(row.githubId).toBeNull();
      expect(row.customGitSSHKeyId).toBeNull();
    });

    it('refuses a body pairing a legitimate rename with their SSH key, and writes neither', async () => {
      // Nothing may ride in beside an id that was refused.
      const { ours, theirs } = await setUpTwoOrganizations();

      const mixed = await patch(ours.cookie, ours.composeId, {
        name: 'Renamed',
        customGitSSHKeyId: theirs.credentials.customGitSSHKeyId,
      });

      expect(mixed.status).toBe(404);
      expect(mixed.body).toMatchObject({ message: 'SSH key not found' });
      const row = await storedRow(ours.composeId);
      expect(row.customGitSSHKeyId).toBeNull();
      expect(row.name).toBe('Stack');
    });

    it('answers a foreign credential id before it asks whether the stack stays routable', async () => {
      // The guard order, at the HTTP level: the own-consistency refusal is a
      // 400 about the caller's own file, and a cross-organization attach must
      // not depend on whether that file happens to be poisoned. The unit half
      // is `compose-credential-refs.spec.ts`.
      const { ours, theirs } = await setUpTwoOrganizations();

      const both = await patch(ours.cookie, ours.composeId, {
        customGitSSHKeyId: theirs.credentials.customGitSSHKeyId,
        composeFile: `services:
  web:
    image: nginx:1
    labels:
      com.example.owner: platform
`,
      });

      expect(both.status).toBe(404);
      expect(both.body).toMatchObject({ message: 'SSH key not found' });
      expect((await storedRow(ours.composeId)).customGitSSHKeyId).toBeNull();
    });
  });

  /**
   * The consequence, at the last seam reachable without a network: the clone
   * command the build would run.
   *
   * This is obligatory: a sweep had concluded the
   * `customGitSSHKeyId` arm was latent because `grep -rn customGitSSHKeyId src`
   * finds only the schema, the DTOs and the service — and missed the consumer,
   * because the **relation is named `customGitSSHKey`, without the `Id`**:
   * `findDeployable` loads it and `DeploymentEngineService` passes the row to
   * `SourceCloneService.cloneProgram`, where `git.strategy.ts` writes the
   * decrypted private key to `/tmp/cloudgate/id_rsa` and exports a
   * `GIT_SSH_COMMAND` that uses it.
   *
   * Every comparison against key material is a **boolean**, because a failing
   * `expect` prints what it received.
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

    const cloneCommandFor = async (composeId: string) => {
      const composes = ctx.app.get(ComposeService);
      const clones = ctx.app.get(SourceCloneService);
      const deployable = await composes.findDeployable(composeId);
      // On a Server, so the clone's host is not the address check's question.
      return (
        await clones.cloneProgram(deployable, '/tmp/cloudgate-test-out', {
          on: { serverId: 'srv_any', serviceId: composeId },
        })
      ).command;
    };

    /** A `git`-source stack pointed at an ssh URL, the only source type that
     * reads `customGitSSHKey` at all. */
    async function asSshSourced(cookie: string, composeId: string) {
      const res = await patch(cookie, composeId, {
        sourceType: 'git',
        customGitUrl: 'git@github.com:neighbour/private.git',
        customGitBranch: 'main',
      });
      expect(res.status).toBe(200);
    }

    it("does not carry the other organization's private key after the PATCH that tried to attach it", async () => {
      const { ours, theirs } = await setUpTwoOrganizations();
      await asSshSourced(ours.cookie, ours.composeId);

      const refused = await patch(ours.cookie, ours.composeId, {
        customGitSSHKeyId: theirs.credentials.customGitSSHKeyId,
      });
      expect(refused.status).toBe(404);

      const command = await cloneCommandFor(ours.composeId);
      expect(carriesKey(command, theirs.sshPrivateKey)).toBe(false);
      // Not merely absent: the stack has no key at all, so the build stops at
      // the strategy's own refusal rather than cloning anonymously.
      expect(command).toContain(
        'You are trying to clone a ssh repository without a ssh key',
      );
    });

    it("carries the caller's own private key once their own key is attached", async () => {
      // The control that keeps the assertion above from passing on a command
      // that never carries any key. Before the fix, this same command carried
      // the *neighbour's* key.
      const { ours, theirs } = await setUpTwoOrganizations();
      await asSshSourced(ours.cookie, ours.composeId);

      const attached = await patch(ours.cookie, ours.composeId, {
        customGitSSHKeyId: ours.credentials.customGitSSHKeyId,
      });
      expect(attached.status).toBe(200);

      const command = await cloneCommandFor(ours.composeId);
      expect(carriesKey(command, ours.sshPrivateKey)).toBe(true);
      expect(carriesKey(command, theirs.sshPrivateKey)).toBe(false);
    });
  });
});
