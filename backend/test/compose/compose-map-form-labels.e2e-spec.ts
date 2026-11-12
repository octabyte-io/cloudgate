import request from 'supertest';
import { App } from 'supertest/types';
import { decryptValue } from '../../src/common/encryption/encryption';
import { ComposeService } from '../../src/compose/compose.service';
import { DomainsService } from '../../src/domains/domains.service';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

/**
 * `PATCH /compose/:id` was the one seam that could still *create* the
 * state the map-form labels rule made a refusal everywhere else.
 *
 * `ComposeService.assertComposeContentClaimable` reads the compose file and has
 * no idea which of its services carry Domain rows, so a PATCH rewriting a
 * routed service's `labels:` from a list into a map was accepted, and the
 * Domain row went on pointing at a service Cloudgate can no longer add routing
 * to. After that rule the outcome was no longer silent — the Converted tab and
 * the next deploy both refuse, naming the service, and the next edit of that
 * Domain refuses — so what was left is that the operator learned about it later
 * than they need to, from a different screen than the one they broke it on. The
 * negative assertion in the first case below is the defect: the PATCH answered
 * 200 and stored the map.
 *
 * The unit half is `compose-update-routable.spec.ts` (which content and which
 * `composeType` the guard is asked about, over every Domain row of the stack)
 * and `compose-domains.spec.ts` (the predicate). What is pinned here
 * is the HTTP shape: a 400 carrying the one sentence all three seams answer
 * with, an unwritten row behind it, and every remediation still getting
 * through.
 *
 * Everything here is a `raw` stack, whose file lives in the `composeFile`
 * column. A git-sourced stack's file is not what this column holds, and its
 * refusal lands at `GET /compose/:id/converted` instead —
 * `compose-converted.e2e-spec.ts` pins that.
 */

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

/** `wordpress` routed and list-labelled; `db` carries no labels at all. */
const LIST_LABELLED = `services:
  wordpress:
    image: wordpress:6
    labels:
      - com.example.owner=platform
  db:
    image: mariadb:11
`;

/** The same file with `wordpress`' own labels rewritten as a map. */
const MAP_LABELLED = `services:
  wordpress:
    image: wordpress:6
    labels:
      com.example.owner: platform
  db:
    image: mariadb:11
`;

/** The map in the block a `stack` kept its labels in before the file provider routed it. */
const MAP_LABELLED_DEPLOY = `services:
  wordpress:
    image: wordpress:6
    deploy:
      labels:
        com.example.owner: platform
  db:
    image: mariadb:11
`;

const refusal = (host: string, service: string, block = 'labels') =>
  `Domain "${host}" is attached to service "${service}", which declares "${block}" as a map — Cloudgate adds Traefik routing labels only to the list form. Rewrite that service's labels as a list of "key=value" entries, or attach this domain to a service that already uses one`;

const REFUSAL = refusal('shop.example.com', 'wordpress');

async function signUp(
  server: App,
  body: { name: string; email: string; password: string },
): Promise<{ cookie: string; id: string }> {
  const res = await request(server).post('/api/auth/sign-up/email').send(body);
  expect(res.status).toBe(200);
  const { user } = res.body as { user: { id: string } };
  return { cookie: res.headers['set-cookie'], id: user.id };
}

const permissionCtx = (userId: string, organizationId: string) => ({
  user: { id: userId },
  session: { activeOrganizationId: organizationId },
});

describe('Compose map-form labels on update (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let compose: ComposeService;
  let domains: DomainsService;

  const execMock = {
    execAsync: jest.fn(),
    execAsyncRemote: jest.fn(),
    execRemote: jest.fn(),
    execFileAsync: jest.fn(),
  };

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [{ provide: RemoteExecService, useValue: execMock }],
    });
    server = ctx.app.getHttpServer() as App;
    projects = ctx.app.get(ProjectsService);
    environments = ctx.app.get(EnvironmentsService);
    compose = ctx.app.get(ComposeService);
    domains = ctx.app.get(DomainsService);
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    for (const fn of [
      execMock.execAsync,
      execMock.execAsyncRemote,
      execMock.execRemote,
      execMock.execFileAsync,
    ]) {
      fn.mockReset().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
    }
  });

  /** A raw-source stack with `composeFile` on it, plus the owner's session. */
  async function setUpRawStack(composeFile = LIST_LABELLED) {
    const ownerSession = await signUp(server, owner);
    const orgs = await request(server)
      .get('/organizations')
      .set('Cookie', ownerSession.cookie);
    const organizationId = (orgs.body as { id: string }[])[0].id;
    const ownerCtx = permissionCtx(ownerSession.id, organizationId);

    const project = await projects.create(ownerCtx, { name: 'cloudgate' });
    const environment = await environments.create(ownerCtx, {
      name: 'production',
      projectId: project.projectId,
    });
    const stack = await compose.create(ownerCtx, {
      name: 'Wordpress',
      appName: 'wp-stack',
      environmentId: environment.environmentId,
      composeFile,
    });
    await compose.update(ownerCtx, stack.composeId, { sourceType: 'raw' });
    return { ownerSession, ownerCtx, environment, stack };
  }

  /**
   * The stored file, read past every service-layer guard.
   *
   * `decryptValue` is what this driver read costs since `composeFile` became
   * `encryptedText` — the column holds `enc:v1:…` now, and the question this
   * helper answers is still about content. It passes a legacy plaintext row
   * through (ADR 0006), which is what keeps the seeded-past-the-guard fixture
   * below writing one.
   */
  const storedFile = async (composeId: string) =>
    decryptValue(
      (
        await ctx.db.$client.query<{ compose_file: string }>(
          'select compose_file from compose where compose_id = $1',
          [composeId],
        )
      ).rows[0].compose_file,
    );

  /**
   * A stack already in the refused state, seeded the only way it can be reached
   * now: past the guard, exactly as a row stored before this rule existed (the
   * rule's no-backfill residual). `compose-label-claims.e2e-spec.ts` seeds its
   * H-83 equivalent the same way and for the same reason.
   */
  async function seedPoisoned(composeId: string, file = MAP_LABELLED) {
    await ctx.db.$client.query(
      'update compose set compose_file = $1 where compose_id = $2',
      [file, composeId],
    );
  }

  it('refuses a PATCH that rewrites a routed service’s labels into a map', async () => {
    const { ownerSession, ownerCtx, stack } = await setUpRawStack();
    await domains.create(ownerCtx, {
      host: 'shop.example.com',
      composeId: stack.composeId,
      serviceName: 'wordpress',
      domainType: 'compose',
    });

    const res = await request(server)
      .patch(`/compose/${stack.composeId}`)
      .set('Cookie', ownerSession.cookie)
      .send({ composeFile: MAP_LABELLED });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ message: REFUSAL });
    // The defect: this answered 200 and stored the map, leaving the Domain row
    // aimed at a service the platform can no longer route to — with the
    // refusal deferred to the Converted tab and the next deploy.
    expect(await storedFile(stack.composeId)).toBe(LIST_LABELLED);
  });

  it('refuses a PATCH that carries no composeFile while the stored file is a map', async () => {
    // The `.partial()` hole `update` already closed for H-83, applied to this
    // rule: what is checked is the row's resulting state,
    // `data.composeFile ?? row.composeFile`, so a body naming only `name` is
    // held against the stored file rather than going unexamined.
    const { ownerSession, ownerCtx, stack } = await setUpRawStack();
    await domains.create(ownerCtx, {
      host: 'shop.example.com',
      composeId: stack.composeId,
      serviceName: 'wordpress',
      domainType: 'compose',
    });
    await seedPoisoned(stack.composeId);

    const res = await request(server)
      .patch(`/compose/${stack.composeId}`)
      .set('Cookie', ownerSession.cookie)
      .send({ name: 'Renamed' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ message: REFUSAL });
    // The unrelated column did not change either: the refusal is the whole
    // request, not the compose file half of it.
    const rows = await ctx.db.$client.query<{ name: string }>(
      'select name from compose where compose_id = $1',
      [stack.composeId],
    );
    expect(rows.rows[0].name).toBe('Wordpress');
  });

  it('reads the block the resulting composeType names', async () => {
    // H-87's shape: `composeType` is a column this very PATCH may rewrite, and
    // it decides whether the question is asked at all — a `stack` gets no
    // labels, its Domains being routed by the file provider. The
    // same stored file is therefore two different answers, and the one that
    // matters is the one the row will carry afterwards.
    const { ownerSession, ownerCtx, stack } =
      await setUpRawStack(MAP_LABELLED_DEPLOY);
    await domains.create(ownerCtx, {
      host: 'shop.example.com',
      composeId: stack.composeId,
      serviceName: 'wordpress',
      domainType: 'compose',
    });

    // A `deploy.labels` map was refused for a stack before the file provider;
    // nothing is written into it any more, so moving to Swarm is taken.
    const toStack = await request(server)
      .patch(`/compose/${stack.composeId}`)
      .set('Cookie', ownerSession.cookie)
      .send({ composeType: 'stack' });
    expect(toStack.status).toBe(200);

    // As a stack, a top-level `labels` map is nobody's business either.
    const mapWhileStack = await request(server)
      .patch(`/compose/${stack.composeId}`)
      .set('Cookie', ownerSession.cookie)
      .send({ composeFile: MAP_LABELLED });
    expect(mapWhileStack.status).toBe(200);

    // Moving it back to Docker Compose puts the map in the block the injector
    // appends to, and that is refused.
    const refused = await request(server)
      .patch(`/compose/${stack.composeId}`)
      .set('Cookie', ownerSession.cookie)
      .send({ composeType: 'docker-compose' });

    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({
      message: refusal('shop.example.com', 'wordpress'),
    });
    const stored = await ctx.db.$client.query<{ compose_type: string }>(
      'select compose_type from compose where compose_id = $1',
      [stack.composeId],
    );
    expect(stored.rows[0].compose_type).toBe('stack');
  });

  it('takes a PATCH whose map-form service carries no Domain row', async () => {
    // Whole-parent means every Domain row of *this* stack, not every service in
    // the file: a service nothing routes to may be shaped however its author
    // likes.
    const { ownerSession, ownerCtx, stack } = await setUpRawStack();
    await domains.create(ownerCtx, {
      host: 'admin.example.com',
      composeId: stack.composeId,
      serviceName: 'db',
      domainType: 'compose',
    });

    const res = await request(server)
      .patch(`/compose/${stack.composeId}`)
      .set('Cookie', ownerSession.cookie)
      .send({ composeFile: MAP_LABELLED });

    expect(res.status).toBe(200);
    expect(await storedFile(stack.composeId)).toBe(MAP_LABELLED);
  });

  it('takes the PATCH that rewrites the map back into a list', async () => {
    // Remediation always gets through, and that is the property to preserve
    // when editing the guard — `DomainsService.assertParentRowsRoutable`'s own
    // rule. Nothing here may refuse the write that fixes what it is refusing.
    const { ownerSession, ownerCtx, stack } = await setUpRawStack();
    await domains.create(ownerCtx, {
      host: 'shop.example.com',
      composeId: stack.composeId,
      serviceName: 'wordpress',
      domainType: 'compose',
    });
    await seedPoisoned(stack.composeId);

    const res = await request(server)
      .patch(`/compose/${stack.composeId}`)
      .set('Cookie', ownerSession.cookie)
      .send({ composeFile: LIST_LABELLED });

    expect(res.status).toBe(200);
    expect(await storedFile(stack.composeId)).toBe(LIST_LABELLED);
  });

  it('still takes the removal of the Domain, which is the other way out', async () => {
    const { ownerSession, ownerCtx, stack } = await setUpRawStack();
    const created = await domains.create(ownerCtx, {
      host: 'shop.example.com',
      composeId: stack.composeId,
      serviceName: 'wordpress',
      domainType: 'compose',
    });
    await seedPoisoned(stack.composeId);

    const removed = await request(server)
      .delete(`/domains/${created.domainId}`)
      .set('Cookie', ownerSession.cookie);
    expect(removed.status).toBe(200);

    // …and with the row gone, the PATCH the map-form file was blocking is
    // taken: the set this guard reads is the set the injector reads, and it is
    // now empty.
    const res = await request(server)
      .patch(`/compose/${stack.composeId}`)
      .set('Cookie', ownerSession.cookie)
      .send({ name: 'Renamed' });
    expect(res.status).toBe(200);
  });

  describe('the fail-open cases', () => {
    /**
     * `composeServiceUsesMapFormLabels` answers `false` for everything it
     * cannot read, deliberately: each is already some other guard's refusal —
     * `getConverted`'s empty-file 400, its unknown-service 400 — and none of
     * them is a refusal `PATCH /compose/:id` has ever made. A seam that grew
     * new refusals while it was here for one would be a second rule riding
     * inside this one.
     *
     * The third case the predicate covers, YAML that does not parse, is not
     * reachable at this seam and so is not asserted here: `composeFileSchema`
     * refuses the body before the route's handler is entered, and for a body
     * carrying no `composeFile` the claimable check reaches the stored column
     * first. The parse there was once **unguarded** — a 500 out
     * of a documented-400/409 guard — and is now a 400 at both seams;
     * `compose-unparseable-file.e2e-spec.ts` pins the HTTP shapes and
     * `compose-update-routable.spec.ts` pins that this rule is not the thing
     * answering.
     */
    it.each([
      ['an empty file', ''],
      [
        'a service the incoming content does not declare',
        `services:
  ghost:
    image: ghost:5
    labels:
      com.example.owner: platform
`,
      ],
    ])('takes a PATCH carrying %s', async (_case, composeFile) => {
      const { ownerSession, ownerCtx, stack } = await setUpRawStack();
      await domains.create(ownerCtx, {
        host: 'shop.example.com',
        composeId: stack.composeId,
        serviceName: 'wordpress',
        domainType: 'compose',
      });

      const res = await request(server)
        .patch(`/compose/${stack.composeId}`)
        .set('Cookie', ownerSession.cookie)
        .send({ composeFile });

      expect(res.status).toBe(200);
      expect(await storedFile(stack.composeId)).toBe(composeFile);
    });
  });
});
