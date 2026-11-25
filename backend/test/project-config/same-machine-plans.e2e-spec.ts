import request from 'supertest';
import { App } from 'supertest/types';

import { server as serverTable } from '../../src/db/schema';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

interface PlanBody {
  environmentId: string;
  notes: { kind: string; configName: string; message: string }[];
}

const CACHE = `version: 1
services:
  cache:
    kind: redis
`;

/**
 * A plan's create on Cloudgate's own machine carries the Same-machine
 * warning (spec #146), on a Self-hosted instance: the platform host, or a
 * Server saved as `sameMachine`. What the note says, once per create and
 * never for a Service that exists, is `plan-environment-same-machine.spec.ts`'s;
 * the Hosted instance's never is `same-machine-target.spec.ts`'s.
 */
describe('Same-machine plans (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let organizationId: string;
  let projectId: string;

  beforeAll(async () => {
    ctx = await createTestApp();
    http = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    const res = await request(http).post('/api/auth/sign-up/email').send({
      name: 'Grace Hopper',
      email: 'grace@example.com',
      password: 'super-secret-password',
    });
    expect(res.status).toBe(200);
    cookie = (res.headers['set-cookie'] as unknown as string[])
      .map((entry) => entry.split(';')[0])
      .join('; ');
    const orgs = await request(http)
      .get('/organizations')
      .set('Cookie', cookie);
    organizationId = (orgs.body as { id: string }[])[0].id;
    const project = await request(http)
      .post('/projects')
      .set('Cookie', cookie)
      .send({ name: 'blog' });
    expect(project.status).toBe(201);
    projectId = (project.body as { projectId: string }).projectId;
  });

  async function createEnvironment(name: string, body: object = {}) {
    const created = await request(http)
      .post('/environments')
      .set('Cookie', cookie)
      .send({ name, projectId, ...body });
    expect(created.status).toBe(201);
    return (created.body as { environmentId: string }).environmentId;
  }

  async function onServer(name: string, sameMachine: boolean) {
    const [made] = await ctx.db
      .insert(serverTable)
      .values({
        name,
        ipAddress: sameMachine ? '127.0.0.1' : '203.0.113.10',
        port: 22,
        serverType: 'deploy',
        organizationId,
        sameMachine,
      })
      .returning();
    return createEnvironment(name, {
      deployTarget: { kind: 'server', serverId: made.serverId },
    });
  }

  /** The `same-machine` notes of the plan stored for `environmentId`. */
  async function sameMachineNotes(environmentId: string) {
    const saved = await request(http)
      .post(`/projects/${projectId}/config/plans`)
      .set('Cookie', cookie)
      .send({ text: CACHE });
    expect(saved.status).toBe(201);
    const found = (saved.body as { plans: PlanBody[] }).plans.find(
      (one) => one.environmentId === environmentId,
    );
    expect(found).toBeDefined();
    return (found as PlanBody).notes.filter(
      (note) => note.kind === 'same-machine',
    );
  }

  it('notes a create on This Cloudgate host', async () => {
    const production = await createEnvironment('production', {
      deployTarget: { kind: 'platform-host' },
    });

    expect(await sameMachineNotes(production)).toEqual([
      {
        kind: 'same-machine',
        configName: 'cache',
        message:
          "cache will run on the machine Cloudgate itself runs on. If it is lost, so are this Service and Cloudgate's records. Add a Server, or use Cloudgate Hosted: https://cloudgate.octabyte.app",
      },
    ]);
  });

  it('notes a create on a Server that is the box itself', async () => {
    const local = await onServer('local', true);

    expect(
      (await sameMachineNotes(local)).map((note) => note.configName),
    ).toEqual(['cache']);
  });

  it('notes nothing for a create on another machine', async () => {
    const edge = await onServer('edge', false);

    expect(await sameMachineNotes(edge)).toEqual([]);
  });
});
