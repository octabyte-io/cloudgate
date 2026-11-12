import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { cloudgateDirectoryOn } from '../../src/common/config/cloudgate-directory';
import { patch } from '../../src/db/schema';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { withArgvExec } from '../utils/exec-double';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { secondOrganizationOwner } from '../utils/test-auth';

jest.setTimeout(120_000);

const instanceOwner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

/** Ids shaped like the real ones and naming nothing anywhere. */
const NO_SUCH_COMPOSE = 'no-such-compose-id';
const NO_SUCH_APPLICATION = 'no-such-application-id';

/** Every field of an error body except the wall clock. */
function withoutTimestamp(body: unknown): unknown {
  const rest = { ...(body as Record<string, unknown>) };
  delete rest.timestamp;
  return rest;
}

/**
 * `POST /patches` as a cross-tenant write, and the pair of refusals that keeps
 * it from becoming an existence oracle.
 *
 * `PatchService.create` resolved `data.applicationId ?? data.composeId`,
 * derived the entity type from whichever was present, validated **that one id**
 * correctly through the org-scoped `findParentService` plus
 * `checkServiceAccess` — and then inserted `{ ...data, enabled: true }`, which
 * writes *both* foreign keys. `??` short-circuits, so a body carrying the
 * caller's own `applicationId` beside another organization's `composeId` passed
 * the gate on the first and landed a `patch` row on the victim's Compose stack.
 * `generateApplyPatchesCommand` renders a patch as a `base64 -d >` into the
 * owning service's code directory, so that row is not a stray record: it is an
 * arbitrary file write into another organization's build, applied at their next
 * deploy. Before the fix the two paired tests below read **201** with a
 * `composeId`/`applicationId` belonging to the other organization.
 *
 * It is asserted here rather than in `patch.e2e-spec.ts` for the reason
 * `environment-tenancy.e2e-spec.ts` gives at length: this needs a second
 * *account*. That suite drives the service seam with a hand-built
 * `PermissionCtx` and could not express the caller at all; a second
 * organization owned by the *same* user carries that user's row-level grants
 * and privileged role with it, so it cannot tell "the service is in another
 * organization" from "the caller is the same person". `secondOrganizationOwner`
 * gives Mallory, a Member of exactly one organization and an owner of it — the
 * strongest caller this defect was reachable by (ADR-0013's fixture).
 *
 * **The pair is the point, not the status.** §2.2 and ADR-0008 both require
 * that a refusal disclose nothing about which ids exist elsewhere on the
 * instance, so each single-id direction asserts the foreign-service body
 * against the nothing-anywhere body field by field rather than asserting a
 * status twice.
 */
describe('Patch tenancy (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;

  type ExecResult = { stdout: string; stderr: string; exitCode: number };
  // `POST /patches` reaches no host at all; the double is here for
  // `POST /patches/repo/clean`, whose whole subject is the command it dispatches
  // — and a suite that left the real service in place would run an
  // `rm -rf` on the machine running the tests.
  const execMock = withArgvExec({
    execAsync: jest.fn<Promise<ExecResult>, [string]>(),
    execAsyncRemote: jest.fn<Promise<ExecResult>, [string, string]>(),
  });

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [{ provide: RemoteExecService, useValue: execMock }],
    });
    server = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    execMock.execAsync.mockReset();
    execMock.execAsyncRemote.mockReset();
    execMock.execAsync.mockResolvedValue({
      stdout: '',
      stderr: '',
      exitCode: 0,
    });
  });

  /** An Application and a Compose stack in one organization, via HTTP only. */
  async function servicesFor(cookie: string, slug: string) {
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
    const environmentId = (environment.body as { environmentId: string })
      .environmentId;

    // `appName` is unique across every Application row on the instance, so the
    // two organizations' services are named apart rather than by role.
    const application = await request(server)
      .post('/applications')
      .set('Cookie', cookie)
      .send({ name: 'Blog', appName: `${slug}-app`, environmentId });
    expect(application.status).toBe(201);

    const compose = await request(server)
      .post('/compose')
      .set('Cookie', cookie)
      .send({ name: 'Stack', appName: `${slug}-stack`, environmentId });
    expect(compose.status).toBe(201);

    return {
      applicationId: (application.body as { applicationId: string })
        .applicationId,
      composeId: (compose.body as { composeId: string }).composeId,
    };
  }

  /** Two organizations, an owner each, and an Application + Compose in both. */
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
      ownerCookie,
      mallory,
      ours: await servicesFor(ownerCookie, 'cloudgate'),
      theirs: await servicesFor(mallory.cookie, 'neighbour'),
    };
  }

  const createPatch = (cookie: string, body: Record<string, unknown>) =>
    request(server)
      .post('/patches')
      .set('Cookie', cookie)
      .send({
        filePath: 'src/config.ts',
        content: 'export const X = 1;\n',
        ...body,
      });

  /** Every patch row on the instance, whoever created it. */
  const allPatches = () => ctx.db.select().from(patch);

  const patchesOfCompose = (composeId: string) =>
    ctx.db.select().from(patch).where(eq(patch.composeId, composeId));

  const patchesOfApplication = (applicationId: string) =>
    ctx.db.select().from(patch).where(eq(patch.applicationId, applicationId));

  it("refuses a create pairing Mallory's own applicationId with a composeId of ours, and attaches nothing to it", async () => {
    const { mallory, ours, theirs } = await setUpTwoOrganizations();

    const paired = await createPatch(mallory.cookie, {
      applicationId: theirs.applicationId,
      composeId: ours.composeId,
    });

    expect(paired.status).toBe(400);
    expect(paired.body).toMatchObject({
      message: 'Validation failed',
      details: [
        {
          path: 'applicationId',
          message: 'Exactly one of applicationId or composeId must be provided',
        },
      ],
    });
    // Nothing was attached to our Compose stack on the way to being refused,
    // and nothing was written anywhere — before the fix this was a 201 and a row
    // whose `composeId` was ours, which our next deploy would have written to
    // disk as a file inside our own build.
    expect(await patchesOfCompose(ours.composeId)).toEqual([]);
    expect(await allPatches()).toEqual([]);
  });

  it("refuses a create pairing our own applicationId with a composeId of Mallory's, and attaches nothing to it", async () => {
    const { ownerCookie, ours, theirs } = await setUpTwoOrganizations();

    const paired = await createPatch(ownerCookie, {
      applicationId: ours.applicationId,
      composeId: theirs.composeId,
    });

    expect(paired.status).toBe(400);
    expect(paired.body).toMatchObject({ message: 'Validation failed' });
    // The direction is symmetric because the rule is about the body's shape,
    // not about who sent it: the instance owner is refused the same pair.
    expect(await patchesOfCompose(theirs.composeId)).toEqual([]);
    expect(await allPatches()).toEqual([]);
  });

  it('refuses Mallory a composeId of ours identically to a composeId that exists nowhere', async () => {
    const { mallory, ours } = await setUpTwoOrganizations();

    const foreign = await createPatch(mallory.cookie, {
      composeId: ours.composeId,
    });
    const absent = await createPatch(mallory.cookie, {
      composeId: NO_SUCH_COMPOSE,
    });

    expect(foreign.status).toBe(404);
    expect(withoutTimestamp(foreign.body)).toEqual(
      withoutTimestamp(absent.body),
    );
    expect(foreign.body).toMatchObject({ message: 'Service not found' });
    // Neither attempt left a row: the single-id path was already org-scoped,
    // and this pins the refusal it answers with as well as the write it skips.
    expect(await patchesOfCompose(ours.composeId)).toEqual([]);
    expect(await allPatches()).toEqual([]);
  });

  it('refuses Mallory an applicationId of ours identically to an applicationId that exists nowhere', async () => {
    const { mallory, ours } = await setUpTwoOrganizations();

    const foreign = await createPatch(mallory.cookie, {
      applicationId: ours.applicationId,
    });
    const absent = await createPatch(mallory.cookie, {
      applicationId: NO_SUCH_APPLICATION,
    });

    expect(foreign.status).toBe(404);
    expect(withoutTimestamp(foreign.body)).toEqual(
      withoutTimestamp(absent.body),
    );
    expect(foreign.body).toMatchObject({ message: 'Service not found' });
    expect(await patchesOfApplication(ours.applicationId)).toEqual([]);
    expect(await allPatches()).toEqual([]);
  });

  it("creates a patch owned by an Application and one owned by a Compose stack in the caller's own organization", async () => {
    const { ownerCookie, ours } = await setUpTwoOrganizations();

    const onApplication = await createPatch(ownerCookie, {
      applicationId: ours.applicationId,
    });
    expect(onApplication.status).toBe(201);
    expect(onApplication.body).toMatchObject({
      applicationId: ours.applicationId,
      composeId: null,
      // The create defaults, and the two the explicit insert has to keep
      // producing now that the body is no longer spread into it.
      type: 'update',
      enabled: true,
      filePath: 'src/config.ts',
    });

    const onCompose = await createPatch(ownerCookie, {
      filePath: 'docker-compose.yml',
      content: 'services: {}\n',
      composeId: ours.composeId,
    });
    expect(onCompose.status).toBe(201);
    expect(onCompose.body).toMatchObject({
      applicationId: null,
      composeId: ours.composeId,
      type: 'update',
      enabled: true,
    });

    // Each row hangs off exactly the one service its body named.
    expect(await patchesOfApplication(ours.applicationId)).toHaveLength(1);
    expect(await patchesOfCompose(ours.composeId)).toHaveLength(1);
  });

  it('refuses a create that names no owning service at all, and writes nothing', async () => {
    const { ownerCookie } = await setUpTwoOrganizations();

    const orphan = await createPatch(ownerCookie, {});

    // The same refinement, the other half of "exactly one": this used to reach
    // the service and answer 400 "Either applicationId or composeId must be
    // provided", which the seam still raises for an internal caller.
    expect(orphan.status).toBe(400);
    expect(orphan.body).toMatchObject({
      message: 'Validation failed',
      details: [
        {
          path: 'applicationId',
          message: 'Exactly one of applicationId or composeId must be provided',
        },
      ],
    });
    expect(await allPatches()).toEqual([]);
  });

  /**
   * `POST /patches/repo/clean` with no `serverId`, which is the platform host
   * (ADR-0013).
   *
   * The same file for the same reason as everything above it: this needs a
   * second *account*. `PatchRepoService.cleanRepos` gated on the caller's role
   * in their **own** organization, so Mallory — an owner, of her own
   * Organization — passed, and the command globs
   * `{patchReposDirectoryOn(…)}/*` on the machine every organization's services
   * run on. Before the fix both tests below answered **200** and ran the
   * `rm -rf`, deleting every other organization's clones.
   *
   * The order of the two checks is what makes the refusal here the *instance*
   * sentence rather than "Only owners and admins can clean patch repos", and
   * that distinction is the whole finding: the role check was passed, not
   * failed. `clean-repos-authority.spec.ts` carries the ordering and the
   * negative-assertion cases at the seam.
   */
  describe("the platform host's patch repos", () => {
    const clean = (cookie: string, body: Record<string, unknown> = {}) =>
      request(server)
        .post('/patches/repo/clean')
        .set('Cookie', cookie)
        .send(body);

    it("refuses Mallory the tree every organization's clones sit in, and deletes nothing", async () => {
      const { mallory } = await setUpTwoOrganizations();

      const refused = await clean(mallory.cookie);

      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({
        message:
          'Only an owner or admin of the instance organization can configure the platform host',
      });
      // Nothing ran on the way out — the assertion the status alone cannot
      // make, since the command deletes the tree before it could be refused.
      expect(execMock.execAsync).not.toHaveBeenCalled();
      expect(execMock.execAsyncRemote).not.toHaveBeenCalled();
    });

    it('refuses her an explicit null serverId the same way', async () => {
      const { mallory } = await setUpTwoOrganizations();

      // `.nullish()` — `null` is the value the API answers with for a row on
      // the platform host and the value a client sends back, so the two
      // spellings cannot be two different answers.
      const refused = await clean(mallory.cookie, { serverId: null });

      expect(refused.status).toBe(403);
      expect(execMock.execAsync).not.toHaveBeenCalled();
    });

    it('cleans the tree for an owner of the instance organization', async () => {
      const { ownerCookie } = await setUpTwoOrganizations();

      const cleaned = await clean(ownerCookie);

      expect(cleaned.status).toBe(200);
      // No `serverId`, so the platform host: its root is this process's
      // CLOUDGATE_DIRECTORY, and `/etc/cloudgate` only while that is unset —
      // taken from the machine rather than spelled.
      expect(execMock.execAsync).toHaveBeenCalledWith(
        `rm -rf "${cloudgateDirectoryOn(null)}/patch-repos"/* 2>/dev/null || true`,
      );
    });
  });
});
