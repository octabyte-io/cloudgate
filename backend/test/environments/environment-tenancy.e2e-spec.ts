import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { environment } from '../../src/db/schema';
import { createTestApp, TestAppContext } from '../utils/test-app';
import { secondOrganizationOwner } from '../utils/test-auth';

jest.setTimeout(120_000);

const instanceOwner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

/** An id shaped like a Project id and naming nothing anywhere. */
const NOWHERE = 'no-such-project-id';

/** Every field of an error body except the wall clock. */
function withoutTimestamp(body: unknown): unknown {
  const rest = { ...(body as Record<string, unknown>) };
  delete rest.timestamp;
  return rest;
}

/**
 * `POST /environments` as a cross-tenant write, and the pair of refusals that
 * keeps it from becoming an existence oracle.
 *
 * `EnvironmentsService.create` took `projectId` off the body and inserted it.
 * `createEnvironmentSchema` binds that field to nothing, the foreign key only
 * requires the Project to *exist*, and `checkEnvironmentAccess`'s `'create'`
 * branch skips the row-level check by design because there is no Environment
 * row yet to check — so nothing on the path constrained the Project to the
 * caller's own organization. Before the fix every assertion in the first two
 * tests below read **201** with the created row's `environmentId` in the body:
 * an owner of one organization writing a row into another organization's
 * Project, granted access to it by `addNewEnvironment`, and listed by that
 * organization's own `GET /environments?projectId=`.
 *
 * It is asserted here rather than in `environments.e2e-spec.ts` because it
 * needs a second *account*: `secondOrganizationOwner` is the caller the
 * neighbouring suite has no way to spell — it builds its second organization
 * out of the same user, whose row-level grants and privileged role travel with
 * them, so it cannot tell "the Project is in another organization" from "the
 * caller is the same person". Mallory is a Member of exactly one organization
 * and an owner of it, which is the strongest form of the caller this defect
 * was reachable by (ADR-0013's fixture, for the same reason).
 *
 * **The pair is the point, not the 404.** §2.2 and ADR-0008 both require that a
 * refusal disclose nothing about which ids exist elsewhere on the instance, so
 * each direction asserts the foreign-Project body against the
 * nothing-anywhere body field by field rather than asserting a status twice —
 * a 404 saying *"Project not found"* beside a 404 saying *"Project belongs to
 * another organization"* would pass a status check and be the oracle ADR-0008
 * names.
 */
describe('Environment tenancy (e2e)', () => {
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

  /** A Project in each of two organizations, and an owner of each. */
  async function setUpTwoOrganizations() {
    const signUp = await request(server)
      .post('/api/auth/sign-up/email')
      .send(instanceOwner);
    expect(signUp.status).toBe(200);
    const ownerCookie: string = signUp.headers['set-cookie'];

    const mallory = await secondOrganizationOwner(server, ctx.db, ownerCookie, {
      organizationName: 'Neighbour Org',
    });

    const ours = await request(server)
      .post('/projects')
      .set('Cookie', ownerCookie)
      .send({ name: 'cloudgate' });
    expect(ours.status).toBe(201);

    const theirs = await request(server)
      .post('/projects')
      .set('Cookie', mallory.cookie)
      .send({ name: 'neighbour' });
    expect(theirs.status).toBe(201);

    return {
      ownerCookie,
      mallory,
      ourProjectId: (ours.body as { projectId: string }).projectId,
      theirProjectId: (theirs.body as { projectId: string }).projectId,
    };
  }

  const createEnvironment = (cookie: string, projectId: string) =>
    request(server)
      .post('/environments')
      .set('Cookie', cookie)
      .send({ name: 'production', projectId });

  /** Every Environment row hanging off a Project, whoever created it. */
  async function environmentsOf(projectId: string) {
    return ctx.db
      .select()
      .from(environment)
      .where(eq(environment.projectId, projectId));
  }

  it("refuses another organization's owner a Project of ours, identically to an id that exists nowhere", async () => {
    const { mallory, ourProjectId } = await setUpTwoOrganizations();

    const foreign = await createEnvironment(mallory.cookie, ourProjectId);
    const absent = await createEnvironment(mallory.cookie, NOWHERE);

    expect(foreign.status).toBe(404);
    expect(withoutTimestamp(foreign.body)).toEqual(
      withoutTimestamp(absent.body),
    );
    expect(foreign.body).toMatchObject({ message: 'Project not found' });
    // Nothing was written into our organization on the way to being refused —
    // before the fix this was a 201 and a row in `ourProjectId`.
    expect(await environmentsOf(ourProjectId)).toEqual([]);
  });

  it("refuses our owner a Project of another organization's, identically to an id that exists nowhere", async () => {
    const { ownerCookie, theirProjectId } = await setUpTwoOrganizations();

    const foreign = await createEnvironment(ownerCookie, theirProjectId);
    const absent = await createEnvironment(ownerCookie, NOWHERE);

    expect(foreign.status).toBe(404);
    expect(withoutTimestamp(foreign.body)).toEqual(
      withoutTimestamp(absent.body),
    );
    expect(foreign.body).toMatchObject({ message: 'Project not found' });
    expect(await environmentsOf(theirProjectId)).toEqual([]);
  });

  it("creates an Environment in a Project of the caller's own organization", async () => {
    const { ownerCookie, ourProjectId } = await setUpTwoOrganizations();

    const created = await createEnvironment(ownerCookie, ourProjectId);

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      name: 'production',
      projectId: ourProjectId,
    });

    const listed = await request(server)
      .get(`/environments?projectId=${ourProjectId}`)
      .set('Cookie', ownerCookie);
    expect(listed.status).toBe(200);
    expect(
      (listed.body as { environmentId: string }[]).map((e) => e.environmentId),
    ).toEqual([(created.body as { environmentId: string }).environmentId]);
  });

  it('creates an Environment for each organization in its own Project, and neither sees the other', async () => {
    const { ownerCookie, mallory, ourProjectId, theirProjectId } =
      await setUpTwoOrganizations();

    expect((await createEnvironment(ownerCookie, ourProjectId)).status).toBe(
      201,
    );
    expect(
      (await createEnvironment(mallory.cookie, theirProjectId)).status,
    ).toBe(201);

    // Each Project carries exactly the one Environment its own owner made.
    expect(await environmentsOf(ourProjectId)).toHaveLength(1);
    expect(await environmentsOf(theirProjectId)).toHaveLength(1);

    // And the list route stays scoped: asking about the neighbour's Project
    // from our session answers nothing rather than their Environment.
    const crossList = await request(server)
      .get(`/environments?projectId=${theirProjectId}`)
      .set('Cookie', ownerCookie);
    expect(crossList.status).toBe(200);
    expect(crossList.body).toEqual([]);
  });
});
