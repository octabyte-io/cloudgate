import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { ADDRESS_RESOLVER } from '../../src/ai/ai-destination';
import { webServerSettings } from '../../src/db/schema';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

/** The box's public address, as Settings > Web server holds it. */
const OWN_ADDRESS = '203.0.113.99';

/**
 * A Server's `sameMachine`, worked out when its address is saved and
 * answered on every Server read, on a Self-hosted instance (spec #146). The
 * classification itself, and the Hosted instance's always-false, are
 * `same-machine.spec.ts`'s.
 */
describe('Server same machine (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let sshKeyId: string;

  // No test reaches real DNS: the instance's own names resolve to an address
  // of their own, and `box.example.com` to the box's public address.
  const resolve = jest.fn<Promise<string[]>, [string]>();

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [{ provide: ADDRESS_RESOLVER, useValue: resolve }],
    });
    http = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    resolve
      .mockReset()
      .mockImplementation((host: string) =>
        Promise.resolve(
          host === 'box.example.com' ? [OWN_ADDRESS] : ['203.0.113.250'],
        ),
      );

    const signUp = await request(http).post('/api/auth/sign-up/email').send({
      name: 'Grace Hopper',
      email: 'grace@example.com',
      password: 'super-secret-password',
    });
    expect(signUp.status).toBe(200);
    cookie = signUp.headers['set-cookie'];

    const [settings] = await ctx.db
      .select({ id: webServerSettings.id })
      .from(webServerSettings)
      .limit(1);
    if (settings) {
      await ctx.db
        .update(webServerSettings)
        .set({ serverIp: OWN_ADDRESS })
        .where(eq(webServerSettings.id, settings.id));
    } else {
      await ctx.db.insert(webServerSettings).values({ serverIp: OWN_ADDRESS });
    }

    const key = await request(http)
      .post('/ssh-keys')
      .set('Cookie', cookie)
      .send({ name: 'deploy key' });
    expect(key.status).toBe(201);
    sshKeyId = (key.body as { sshKeyId: string }).sshKeyId;
  });

  const createServer = (ipAddress: string, extra: object = {}) =>
    request(http)
      .post('/servers')
      .set('Cookie', cookie)
      .send({
        name: 'vps',
        ipAddress,
        port: 22,
        username: 'root',
        sshKeyId,
        ...extra,
      });

  const updateServer = (serverId: string, body: object) =>
    request(http)
      .patch(`/servers/${serverId}`)
      .set('Cookie', cookie)
      .send(body);

  const readServer = async (serverId: string) =>
    (await request(http).get(`/servers/${serverId}`).set('Cookie', cookie))
      .body as { sameMachine: boolean };

  it.each([
    ['loopback', '127.0.0.1'],
    ['IPv6 loopback', '::1'],
    ['localhost', 'localhost'],
    ["the box's own address", OWN_ADDRESS],
    ["a name for the box's own address", 'box.example.com'],
  ])('a Server saved at %s is on the same machine', async (_, address) => {
    const created = await createServer(address);

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ sameMachine: true });
    const serverId = (created.body as { serverId: string }).serverId;
    expect(await readServer(serverId)).toMatchObject({ sameMachine: true });
  });

  it.each([
    ['a 192.168 address', '192.168.77.123'],
    ['a 10. address', '10.200.0.7'],
    ['another public address', '198.51.100.7'],
  ])('a Server saved at %s is not on the same machine', async (_, address) => {
    const created = await createServer(address);

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ sameMachine: false });
  });

  it('ignores a sameMachine sent in the body', async () => {
    const created = await createServer('198.51.100.7', { sameMachine: true });

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ sameMachine: false });
  });

  it('changing the address works it out again', async () => {
    const created = await createServer('127.0.0.1');
    const serverId = (created.body as { serverId: string }).serverId;

    const moved = await updateServer(serverId, { ipAddress: '198.51.100.7' });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ sameMachine: false });
    expect(await readServer(serverId)).toMatchObject({ sameMachine: false });

    const back = await updateServer(serverId, { ipAddress: OWN_ADDRESS });
    expect(back.body).toMatchObject({ sameMachine: true });
  });

  it('an update that names no address keeps it', async () => {
    const created = await createServer('127.0.0.1');
    const serverId = (created.body as { serverId: string }).serverId;

    const renamed = await updateServer(serverId, { name: 'renamed' });

    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({ name: 'renamed', sameMachine: true });
  });
});
