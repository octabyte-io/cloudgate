import request from 'supertest';
import { App } from 'supertest/types';
import { decryptValue } from '../../src/common/encryption/encryption';
import { ComposeService } from '../../src/compose/compose.service';
import { EnvironmentsService } from '../../src/environments/environments.service';
import { ProjectsService } from '../../src/projects/projects.service';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

/**
 * A compose file that is not valid YAML answered **500**.
 *
 * `ComposeService.assertComposeContentClaimable` documents a 400 and a 409 and
 * converts only `ComposeLabelRefusal`, so the `YAMLParseError` its
 * `readComposeHostClaims` → `parseComposeFile` chain raises escaped a guard as
 * an unhandled error and `AllExceptionsFilter` rendered it as
 * `Internal server error` — on `POST /compose`, on `PATCH /compose/:id`, and on
 * the deployment engine's own pre-flight. `composeFile` was a bare `z.string()`
 * on both DTOs, so nothing upstream had refused it either.
 *
 * The two halves of the answer are pinned here because both are reachable from
 * HTTP and they answer in different shapes:
 *
 * - the **DTO** half (`composeFileSchema`) refuses the *request body*, so the
 *   filter's zod branch answers `Validation failed` with the sentence at
 *   `details[].path === 'composeFile'`;
 * - the **service** half (`assertComposeContentClaimable`, and `loadServices`
 *   for `GET /compose/:id/services`, which has no claimable guard at all)
 *   refuses content that reached no DTO — the stored column on a `.partial()` PATCH that names other
 *   fields, and the cloned repository the deployment engine reads — so it
 *   answers a plain 400 carrying the sentence as `message`.
 *
 * `parse` does not raise one class, which is what the first cut of this fix got
 * wrong: a **`ReferenceError`** out of `Alias.resolve` is how `maxAliasCount` and
 * an unset anchor are enforced, and it is not a `YAMLError` at all — so an
 * `instanceof YAMLParseError` arm left the deliberately hostile input class
 * answering 500 while a mere typo answered 400. Both classes are pinned below,
 * at both seams.
 *
 * The sentence carries the YAML library's own words but **not its source
 * snippet**, which is the part that echoes the compose file back: `error.message`
 * from this guard reaches a Deployment log and a build-failure notification, so a
 * caret diagram quoting the line that failed to parse would put a compose file's
 * own bytes — an inline password among them — into a webhook payload. The
 * `line`/`column` survive, which is what an operator navigates by.
 *
 * The unit halves are `compose-file-parseable.spec.ts` (the schemas and the
 * bounding) and `compose-update-routable.spec.ts` (which of `update`'s three
 * guards answers).
 */

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const VALID = `services:
  wordpress:
    image: wordpress:6
  db:
    image: mariadb:11
`;

/**
 * Not YAML: a flow sequence opened at `services:` and never closed, with block
 * mappings inside it. The library answers `BLOCK_AS_IMPLICIT_KEY` for this one.
 */
const UNPARSEABLE = 'services: [oh: no: :';

/**
 * The same, with a secret on the line the parse fails on — the input that says
 * whether the refusal echoes the file. The parse error's own snippet would quote
 * this line.
 */
const UNPARSEABLE_WITH_SECRET = `services:
  db:
    environment:
      - MARIADB_ROOT_PASSWORD=hunter2-in-the-clear
     - BROKEN_INDENT=yes
`;

/**
 * Valid YAML the parser still refuses: nested anchors multiply, so ten aliases
 * four levels deep is 10^4 expansions past `parseComposeFile`'s
 * `maxAliasCount: 10_000`. 229 bytes, because the billion-laughs shape is
 * compact by construction.
 *
 * This is the payload that mattered most and was missed by the first cut of
 * the fix: `maxAliasCount` is enforced by a **`ReferenceError`** out of
 * `Alias.resolve`, not a `YAMLParseError`, so an `instanceof YAMLParseError`
 * arm re-threw it and the one deliberately hostile input class kept its 500 on
 * all five routes.
 */
const ALIAS_BOMB = `services:
  a: &a { image: alpine }
  b: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]
  c: &c [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]
  d: &d [*c, *c, *c, *c, *c, *c, *c, *c, *c, *c]
  e: [*d, *d, *d, *d, *d, *d, *d, *d, *d, *d]
`;

/** What the guard and the DTO both say, ahead of the library's words. */
const UNPARSEABLE_PREFIX = 'Compose file is not valid YAML';

/**
 * The alias cases get their own sentence, because they are not syntax errors —
 * `yamllint` passes `ALIAS_BOMB`. Telling an operator their file is not valid
 * YAML would send them looking for a typo that is not there.
 */
const ALIAS_PREFIX = "Compose file's YAML aliases cannot be resolved";

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

describe('Compose unparseable file (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let projects: ProjectsService;
  let environments: EnvironmentsService;
  let compose: ComposeService;

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

  /** An organization, a project, an environment and the owner's session. */
  async function setUp() {
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
    return { ownerSession, ownerCtx, environment };
  }

  /** A `raw` stack carrying a file that parses. */
  async function setUpRawStack() {
    const { ownerSession, ownerCtx, environment } = await setUp();
    const stack = await compose.create(ownerCtx, {
      name: 'Wordpress',
      appName: 'wp-stack',
      environmentId: environment.environmentId,
      composeFile: VALID,
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
   * through (ADR 0006), which is what keeps {@link seedUnparseable} below
   * writing one: a row an install created before either rule shipped is
   * plaintext, and this file's whole subject is that row.
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
   * A row whose stored file does not parse — the state a stack imported,
   * restored, or created before this rule shipped can be in, and the only way
   * to reach the service-side half now that the DTO refuses the request paths.
   * `compose-map-form-labels.e2e-spec.ts` seeds the map-form equivalent the
   * same way.
   */
  async function seedUnparseable(composeId: string, file = UNPARSEABLE) {
    await ctx.db.$client.query(
      'update compose set compose_file = $1 where compose_id = $2',
      [file, composeId],
    );
  }

  const rowCount = async () =>
    (
      await ctx.db.$client.query<{ count: string }>(
        'select count(*)::text as count from compose',
      )
    ).rows[0].count;

  it('refuses a POST whose compose file is not valid YAML', async () => {
    const { ownerSession, environment } = await setUp();

    const res = await request(server)
      .post('/compose')
      .set('Cookie', ownerSession.cookie)
      .send({
        name: 'Wordpress',
        appName: 'wp-stack',
        environmentId: environment.environmentId,
        composeFile: UNPARSEABLE,
      });

    // The defect: 500 `Internal server error`, out of a guard whose docblock
    // documents a 400 and a 409.
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      message: 'Validation failed',
      details: [
        {
          path: 'composeFile',
          message: expect.stringContaining(UNPARSEABLE_PREFIX) as string,
        },
      ],
    });
    // Nothing was inserted on the way to being refused.
    expect(await rowCount()).toBe('0');
  });

  it('refuses a PATCH whose compose file is not valid YAML', async () => {
    const { ownerSession, stack } = await setUpRawStack();

    const res = await request(server)
      .patch(`/compose/${stack.composeId}`)
      .set('Cookie', ownerSession.cookie)
      .send({ composeFile: UNPARSEABLE });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      message: 'Validation failed',
      details: [
        {
          path: 'composeFile',
          message: expect.stringContaining(UNPARSEABLE_PREFIX) as string,
        },
      ],
    });
    // The stored file is the one that parses, unchanged.
    expect(await storedFile(stack.composeId)).toBe(VALID);
  });

  it('names the line the parse failed on', async () => {
    // The library's words are kept for the reason earlier fixes kept a
    // provider's: a caller who pasted broken YAML acts on *where* it broke.
    const { ownerSession, stack } = await setUpRawStack();

    const res = await request(server)
      .patch(`/compose/${stack.composeId}`)
      .set('Cookie', ownerSession.cookie)
      .send({ composeFile: UNPARSEABLE });

    const [issue] = (res.body as { details: { message: string }[] }).details;
    expect(issue.message).toContain('at line 1, column 20');
  });

  it('does not echo the compose file that failed to parse', async () => {
    // `error.message` out of this guard reaches a Deployment log and a
    // build-failure notification, so the library's caret diagram — which quotes
    // the failing line verbatim — would carry an inline password outward.
    const { ownerSession, stack } = await setUpRawStack();

    const res = await request(server)
      .patch(`/compose/${stack.composeId}`)
      .set('Cookie', ownerSession.cookie)
      .send({ composeFile: UNPARSEABLE_WITH_SECRET });

    expect(res.status).toBe(400);
    const body = JSON.stringify(res.body);
    expect(body).toContain(UNPARSEABLE_PREFIX);
    expect(body).not.toContain('hunter2-in-the-clear');
    // Nor the library's own class name, which is an internal §2.5 keeps off the
    // wire.
    expect(body).not.toContain('YAMLParseError');
  });

  it('refuses a PATCH naming other fields while the stored file does not parse', async () => {
    // The service-side half, and the reason the DTO cannot be the only one:
    // `updateComposeSchema` is `.partial()`, so this body carries no
    // `composeFile` at all and `update` holds the rule against the *resulting*
    // row — `data.composeFile ?? row.composeFile` — exactly as it does for the
    // map-form labels and H-83.
    const { ownerSession, stack } = await setUpRawStack();
    await seedUnparseable(stack.composeId);

    const res = await request(server)
      .patch(`/compose/${stack.composeId}`)
      .set('Cookie', ownerSession.cookie)
      .send({ name: 'Renamed' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      message: expect.stringContaining(UNPARSEABLE_PREFIX) as string,
    });
    // A plain 400, not the zod branch: no DTO was involved in reading the
    // stored column.
    expect(res.body).not.toHaveProperty('details');
    // The unrelated column did not change: the refusal is the whole request.
    const rows = await ctx.db.$client.query<{ name: string }>(
      'select name from compose where compose_id = $1',
      [stack.composeId],
    );
    expect(rows.rows[0].name).toBe('Wordpress');
  });

  it('takes a PATCH that repairs the stored file', async () => {
    // The remediation has to get through, or the rule strands every row it
    // refuses: the same PATCH that would be refused for its stored file is
    // taken when it carries a file that parses.
    const { ownerSession, stack } = await setUpRawStack();
    await seedUnparseable(stack.composeId);

    const res = await request(server)
      .patch(`/compose/${stack.composeId}`)
      .set('Cookie', ownerSession.cookie)
      .send({ composeFile: VALID });

    expect(res.status).toBe(200);
    expect(await storedFile(stack.composeId)).toBe(VALID);
  });

  it('refuses a POST whose compose file is an alias bomb', async () => {
    // The resource-exhaustion payload, and the case the `instanceof
    // YAMLParseError` arm alone did not catch: `maxAliasCount` is enforced with
    // a `ReferenceError`, so this answered 500 while a plain syntax error
    // answered 400.
    const { ownerSession, environment } = await setUp();

    const res = await request(server)
      .post('/compose')
      .set('Cookie', ownerSession.cookie)
      .send({
        name: 'Wordpress',
        appName: 'wp-stack',
        environmentId: environment.environmentId,
        composeFile: ALIAS_BOMB,
      });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      message: 'Validation failed',
      details: [
        {
          path: 'composeFile',
          message: `${ALIAS_PREFIX}: Excessive alias count indicates a resource exhaustion attack`,
        },
      ],
    });
    expect(await rowCount()).toBe('0');
  });

  it('refuses a PATCH naming other fields while the stored file is an alias bomb', async () => {
    // The service-side half of the same class. A stored bomb is not
    // hypothetical: every row created before this refusal got here through a
    // DTO that examined nothing.
    const { ownerSession, stack } = await setUpRawStack();
    await seedUnparseable(stack.composeId, ALIAS_BOMB);

    const res = await request(server)
      .patch(`/compose/${stack.composeId}`)
      .set('Cookie', ownerSession.cookie)
      .send({ name: 'Renamed' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      message: `${ALIAS_PREFIX}: Excessive alias count indicates a resource exhaustion attack`,
    });
    expect(res.body).not.toHaveProperty('details');
  });

  it('refuses a PATCH whose compose file names an anchor that is not set', async () => {
    // The ordinary member of the same class — a `*base` whose `&base` was
    // edited away — which is likelier than the bomb and was the same 500.
    const { ownerSession, stack } = await setUpRawStack();

    const res = await request(server)
      .patch(`/compose/${stack.composeId}`)
      .set('Cookie', ownerSession.cookie)
      .send({ composeFile: 'services:\n  app: *base\n' });

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      message: 'Validation failed',
      details: [
        {
          path: 'composeFile',
          message: `${ALIAS_PREFIX}: Unresolved alias (the anchor must be set before the alias): base`,
        },
      ],
    });
    expect(await storedFile(stack.composeId)).toBe(VALID);
  });

  it('refuses GET /compose/:id/services for a stored file that does not parse', async () => {
    // The sixth route, and the one with **no guard of any kind** in front of it:
    // `loadServices` reads the file and hands it straight to
    // `listComposeServices`, whose `parseComposeFile` is unguarded. Reachable
    // for a `raw` stack whose stored column predates this refusal.
    const { ownerSession, stack } = await setUpRawStack();
    await seedUnparseable(stack.composeId, ALIAS_BOMB);

    const res = await request(server)
      .get(`/compose/${stack.composeId}/services`)
      .set('Cookie', ownerSession.cookie);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      message: `${ALIAS_PREFIX}: Excessive alias count indicates a resource exhaustion attack`,
    });
  });

  it('refuses GET /compose/:id/services for a cloned file that does not parse', async () => {
    // The same route for a **git** source, which is the case that matters: the
    // file lives in the repository, reaches no DTO and no claimable guard, and
    // `readComposeFile` `cat`s it off the Server one line before the parse. A
    // repo with a broken compose file is an ordinary Tuesday, and this answered
    // 500 for it.
    //
    // The console already tells an operator this route is where a bad file shows
    // up — `declared-services.tsx` says so — so what was missing is the answer
    // being a sentence rather than `Internal server error`.
    const { ownerSession, ownerCtx, stack } = await setUpRawStack();
    await compose.update(ownerCtx, stack.composeId, {
      sourceType: 'github',
      repository: 'cloudgate',
      owner: 'octabyte-io',
      branch: 'main',
    });
    execMock.execFileAsync.mockResolvedValue({
      stdout: UNPARSEABLE,
      stderr: '',
      exitCode: 0,
    });

    const res = await request(server)
      .get(`/compose/${stack.composeId}/services`)
      .set('Cookie', ownerSession.cookie);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      message: expect.stringContaining(UNPARSEABLE_PREFIX) as string,
    });
    // The clone really was what was read: the stored column still parses.
    expect(await storedFile(stack.composeId)).toBe(VALID);
  });

  it('lists the services of a file that parses', async () => {
    // The remediation half, so the refusal above is not just "this route is
    // broken": the same route on the same stack answers normally.
    const { ownerSession, stack } = await setUpRawStack();

    const res = await request(server)
      .get(`/compose/${stack.composeId}/services`)
      .set('Cookie', ownerSession.cookie);

    expect(res.status).toBe(200);
    expect(res.body).toEqual(['wordpress', 'db']);
  });

  it('takes a POST that carries no compose file at all', async () => {
    // `composeFile` is optional on create and empty is what the column
    // defaults to; the empty-file refusal belongs to `parseComposeFileOrThrow`
    // at deploy time, and this rule does not move it forward.
    const { ownerSession, environment } = await setUp();

    const res = await request(server)
      .post('/compose')
      .set('Cookie', ownerSession.cookie)
      .send({
        name: 'Wordpress',
        appName: 'wp-stack',
        environmentId: environment.environmentId,
      });

    expect(res.status).toBe(201);
    expect(await rowCount()).toBe('1');
  });
});
