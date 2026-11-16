import { asc } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { webServerSettings } from '../../src/settings/settings.schema';
import {
  PUBLIC_ADDRESS_UNVERIFIED_CODE,
  SettingsService,
} from '../../src/settings/settings.service';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

/**
 * Settings > Instance's public address, which sslip.io Domains are made from.
 *
 * `SettingsService.prefillServerIp`: the address `deploy/install.sh` found
 * for this host (`CLOUDGATE_PUBLIC_IP`) becomes Settings > Instance's public
 * address, which sslip.io Domains are made from, only while that has never
 * been set. Driven directly after each arrangement; boot runs it once too.
 */
const FOUND = '198.51.100.7';

describe('Public address (e2e)', () => {
  let ctx: TestAppContext;
  let settings: SettingsService;

  async function owner(): Promise<string> {
    const res = await request(ctx.app.getHttpServer() as App)
      .post('/api/auth/sign-up/email')
      .send({
        name: 'Grace Hopper',
        email: 'grace@example.com',
        password: 'super-secret-password',
      });
    expect(res.status).toBe(200);
    return res.headers['set-cookie'];
  }

  function save(cookie: string, body: Record<string, unknown>) {
    return request(ctx.app.getHttpServer() as App)
      .post('/settings/ip')
      .set('Cookie', cookie)
      .send(body);
  }

  async function rows() {
    return ctx.db
      .select({ serverIp: webServerSettings.serverIp })
      .from(webServerSettings)
      .orderBy(asc(webServerSettings.createdAt));
  }

  beforeAll(async () => {
    process.env.CLOUDGATE_PUBLIC_IP = FOUND;
    ctx = await createTestApp();
    settings = ctx.app.get(SettingsService);
  });

  afterAll(async () => {
    delete process.env.CLOUDGATE_PUBLIC_IP;
    await ctx.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
  });

  it('makes the settings row with the address when the instance has none', async () => {
    await ctx.db.delete(webServerSettings);

    await settings.prefillServerIp();

    expect(await rows()).toEqual([{ serverIp: FOUND }]);
  });

  it('fills in an address that was never set', async () => {
    await ctx.db.delete(webServerSettings);
    await ctx.db.insert(webServerSettings).values({});

    await settings.prefillServerIp();

    expect(await rows()).toEqual([{ serverIp: FOUND }]);
    expect(await settings.getIp()).toBe(FOUND);
  });

  it('keeps an address the owner set', async () => {
    await ctx.db.delete(webServerSettings);
    await ctx.db.insert(webServerSettings).values({ serverIp: '192.0.2.44' });

    await settings.prefillServerIp();

    expect(await rows()).toEqual([{ serverIp: '192.0.2.44' }]);
  });

  it('keeps an address the owner cleared, which is empty rather than never set', async () => {
    await ctx.db.delete(webServerSettings);
    await ctx.db.insert(webServerSettings).values({ serverIp: '' });

    await settings.prefillServerIp();

    expect(await rows()).toEqual([{ serverIp: '' }]);
  });

  describe('saving it', () => {
    it('saves the public IP the install found', async () => {
      const cookie = await owner();

      const res = await save(cookie, { serverIp: ` ${FOUND} ` });

      expect(res.status).toBe(200);
      expect(await settings.getIp()).toBe(FOUND);
    });

    it('saves an address on one of this host’s network interfaces', async () => {
      const cookie = await owner();

      const res = await save(cookie, { serverIp: '127.0.0.1' });

      expect(res.status).toBe(200);
      expect(await settings.getIp()).toBe('127.0.0.1');
    });

    it('refuses a hostname, pointing at Console domain', async () => {
      const cookie = await owner();

      const res = await save(cookie, { serverIp: 'cloud.example.com' });

      expect(res.status).toBe(400);
      expect((res.body as { message: string }).message).toContain(
        'Console domain',
      );
      expect(await settings.getIp()).not.toBe('cloud.example.com');
    });

    it('refuses a hostname even when confirmed', async () => {
      const cookie = await owner();

      const res = await save(cookie, {
        serverIp: 'cloud.example.com',
        confirmUnverified: true,
      });

      expect(res.status).toBe(400);
    });

    it('refuses an address this host does not know as its own, with a code', async () => {
      const cookie = await owner();
      await save(cookie, { serverIp: FOUND });

      const res = await save(cookie, { serverIp: '192.0.2.99' });

      expect(res.status).toBe(409);
      const body = res.body as { code: string; message: string };
      expect(body.code).toBe(PUBLIC_ADDRESS_UNVERIFIED_CODE);
      expect(body.message).toContain(FOUND);
      expect(await settings.getIp()).toBe(FOUND);
    });

    it('saves an unknown address once the caller confirms it', async () => {
      const cookie = await owner();

      const res = await save(cookie, {
        serverIp: '192.0.2.99',
        confirmUnverified: true,
      });

      expect(res.status).toBe(200);
      expect(await settings.getIp()).toBe('192.0.2.99');
    });

    it('clears it with an empty value, which the prefill then keeps', async () => {
      const cookie = await owner();
      await save(cookie, { serverIp: FOUND });

      const res = await save(cookie, { serverIp: '' });
      await settings.prefillServerIp();

      expect(res.status).toBe(200);
      expect(await rows()).toEqual([{ serverIp: '' }]);
    });
  });
});
