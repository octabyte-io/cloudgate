// The Hosted instance. Set before the app module is imported: ConfigModule
// snapshots the environment on first load.
import { useHostedMode } from '../utils/hosted-mode';
useHostedMode();

import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';

import { ADDRESS_RESOLVER } from '../../src/ai/ai-destination';
import { subscription } from '../../src/cloud/billing/billing.schema';
import { server, webServerSettings } from '../../src/db/schema';
import { InstanceMode } from '../../src/instance-mode/instance-mode.service';
import { SERVER_KEY_PROVIDER } from '../../src/remote/server-key.provider';
import type { ServerKeyProvider } from '../../src/remote/server-key.provider';
import {
  SERVER_ADDRESS_REFUSAL,
  SERVER_ADDRESS_REFUSED_CODE,
} from '../../src/servers/server-address-guard';
import { HOSTED_STAFF, openHostedSignUp } from '../utils/hosted-sign-up';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(180_000);

/** The 400 every refused Server address gets. */
const REFUSED = {
  statusCode: 400,
  code: SERVER_ADDRESS_REFUSED_CODE,
  message: SERVER_ADDRESS_REFUSAL,
};

/** The box's public address, as Settings > Web server holds it. */
const OWN_ADDRESS = '203.0.113.99';

/**
 * On the Hosted instance a Server cannot be the box itself (ADR-0053):
 * an address on loopback, link-local, a private range or one of the box's
 * own is refused when it is saved, and again at every SSH connect, so a
 * hostname whose records change after it was saved cannot reopen the host.
 * The Self-hosted counterparts at the end turn `isHosted` off on the same app
 * and show the same addresses saved and dialled as they are.
 */
describe('Server address refusal on the Hosted instance (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let cookie: string;
  let organizationId: string;
  let sshKeyId: string;

  // No test reaches real DNS: every name resolves to what the case says.
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
    jest.restoreAllMocks();
    // A Server's name resolves to 198.51.100.7; the instance's own names
    // (SITE_URL and the like, which the guard counts as the box) resolve to
    // an address of their own, as they would in real DNS.
    resolve
      .mockReset()
      .mockImplementation((host: string) =>
        Promise.resolve(
          host.endsWith('example.com') ? ['198.51.100.7'] : ['203.0.113.250'],
        ),
      );

    await openHostedSignUp(ctx.db);
    const res = await request(http)
      .post('/api/auth/sign-in/email')
      .send({ email: HOSTED_STAFF.email, password: HOSTED_STAFF.password });
    expect(res.status).toBe(200);
    cookie = (res.headers['set-cookie'] as unknown as string[])
      .map((entry) => entry.split(';')[0])
      .join('; ');
    const orgs = await request(http)
      .get('/organizations')
      .set('Cookie', cookie);
    organizationId = (orgs.body as { id: string }[])[0].id;

    // A Hosted Server create needs a plan with room.
    await ctx.db.insert(subscription).values({
      organizationId,
      stripeCustomerId: 'cus_1',
      stripeSubscriptionId: 'sub_1',
      plan: 'starter',
      status: 'active',
      addOns: 0,
    });

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

  const givenSelfHostedInstance = () =>
    jest
      .spyOn(ctx.app.get(InstanceMode), 'isHosted', 'get')
      .mockReturnValue(false);

  const createServer = (ipAddress: string) =>
    request(http).post('/servers').set('Cookie', cookie).send({
      name: 'vps',
      ipAddress,
      port: 22,
      username: 'root',
      sshKeyId,
    });

  const servers = async () =>
    ctx.db
      .select({ ipAddress: server.ipAddress })
      .from(server)
      .where(eq(server.organizationId, organizationId));

  const connectionFor = (serverId: string) =>
    ctx.app.get<ServerKeyProvider>(SERVER_KEY_PROVIDER).getConnection(serverId);

  describe('saving a Server', () => {
    it.each([
      ['loopback', '127.0.0.1'],
      ['loopback (IPv6)', '::1'],
      ['link-local', '169.254.169.254'],
      ['a private range', '10.0.0.5'],
      ["the box's own address", OWN_ADDRESS],
    ])('refuses an address on %s and saves nothing', async (_, address) => {
      const res = await createServer(address);

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject(REFUSED);
      expect(await servers()).toEqual([]);
    });

    it('refuses a hostname that resolves to a private range', async () => {
      resolve.mockResolvedValue(['198.51.100.7', '192.168.1.10']);

      const res = await createServer('vps.example.com');

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject(REFUSED);
      expect(resolve).toHaveBeenCalledWith('vps.example.com');
      expect(await servers()).toEqual([]);
    });

    it('refuses a hostname that does not resolve', async () => {
      resolve.mockRejectedValue(new Error('ENOTFOUND'));

      const res = await createServer('nowhere.example.com');

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject(REFUSED);
    });

    it('saves a public address and a hostname that resolves publicly', async () => {
      expect((await createServer('203.0.113.10')).status).toBe(201);
      expect((await createServer('vps.example.com')).status).toBe(201);
    });

    it('refuses changing a saved Server to a refused address', async () => {
      const created = await createServer('203.0.113.10');
      const serverId = (created.body as { serverId: string }).serverId;

      const res = await request(http)
        .patch(`/servers/${serverId}`)
        .set('Cookie', cookie)
        .send({ ipAddress: '172.16.0.4' });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject(REFUSED);
      expect(await servers()).toEqual([{ ipAddress: '203.0.113.10' }]);
    });
  });

  describe('connecting to a Server', () => {
    it('refuses at SSH connect once its hostname resolves to a refused range', async () => {
      const created = await createServer('vps.example.com');
      expect(created.status).toBe(201);
      const serverId = (created.body as { serverId: string }).serverId;

      // The records changed after it was saved.
      resolve.mockResolvedValue(['127.0.0.1']);

      await expect(connectionFor(serverId)).rejects.toMatchObject({
        response: { code: SERVER_ADDRESS_REFUSED_CODE },
      });
      // And through the console's Check, which reaches SSH this way, with
      // the code kept and the outcome stored.
      const res = await request(http)
        .get(`/servers/${serverId}/validate`)
        .set('Cookie', cookie);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject(REFUSED);
      const [row] = await ctx.db
        .select({ ok: server.reachOk, message: server.reachMessage })
        .from(server)
        .where(eq(server.serverId, serverId));
      expect(row).toEqual({ ok: false, message: SERVER_ADDRESS_REFUSAL });
    });

    it('refuses at SSH connect a refused address written before hosted mode', async () => {
      const [row] = await ctx.db
        .insert(server)
        .values({
          name: 'old',
          ipAddress: '10.1.2.3',
          port: 22,
          username: 'root',
          organizationId,
          sshKeyId,
        })
        .returning();

      await expect(connectionFor(row.serverId)).rejects.toMatchObject({
        response: { code: SERVER_ADDRESS_REFUSED_CODE },
      });
    });

    it('dials the address it checked, not the name again', async () => {
      const created = await createServer('vps.example.com');
      const serverId = (created.body as { serverId: string }).serverId;

      const connection = await connectionFor(serverId);

      expect(connection.host).toBe('198.51.100.7');
    });
  });

  describe('Self-hosted', () => {
    it.each([
      ['loopback', '127.0.0.1'],
      ['link-local', '169.254.169.254'],
      ['a private range', '10.0.0.5'],
      ["the box's own address", OWN_ADDRESS],
    ])('saves an address on %s', async (_, address) => {
      givenSelfHostedInstance();

      const res = await createServer(address);

      expect(res.status).toBe(201);
      expect(await servers()).toEqual([{ ipAddress: address }]);
    });

    it('dials the stored hostname as it is, without resolving it', async () => {
      givenSelfHostedInstance();
      resolve.mockResolvedValue(['127.0.0.1']);
      const created = await createServer('lan-box.internal');
      expect(created.status).toBe(201);
      const serverId = (created.body as { serverId: string }).serverId;

      const connection = await connectionFor(serverId);

      expect(connection.host).toBe('lan-box.internal');
      expect(resolve).not.toHaveBeenCalled();
    });
  });
});
