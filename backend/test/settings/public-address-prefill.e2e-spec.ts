import { asc } from 'drizzle-orm';
import { webServerSettings } from '../../src/settings/settings.schema';
import { SettingsService } from '../../src/settings/settings.service';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

/**
 * `SettingsService.prefillServerIp`: the address `deploy/install.sh` found
 * for this host (`CLOUDGATE_PUBLIC_IP`) becomes Settings > Instance's public
 * address, which sslip.io Domains are made from, only while that has never
 * been set. Driven directly after each arrangement; boot runs it once too.
 */
const FOUND = '198.51.100.7';

describe('Public address prefill (e2e)', () => {
  let ctx: TestAppContext;
  let settings: SettingsService;

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
});
