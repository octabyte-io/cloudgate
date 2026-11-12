// The Hosted instance. Set before the app module is imported: ConfigModule
// snapshots the environment on first load.
import { useHostedMode } from '../utils/hosted-mode';
useHostedMode();

import request from 'supertest';
import { App } from 'supertest/types';
import { InstanceMode } from '../../src/instance-mode/instance-mode.service';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

/**
 * An Instance booted with `HOSTED_MODE=true` (ADR-0049) says so: on
 * the public `GET /settings/about`, and through `InstanceMode`, which every
 * hosted rule asks. The self-hosted counterpart is the `GET /settings/about`
 * case in `test/settings/settings.e2e-spec.ts`.
 */
describe('Hosted mode (e2e)', () => {
  let ctx: TestAppContext;
  let httpServer: App;

  beforeAll(async () => {
    ctx = await createTestApp();
    httpServer = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx.teardown();
  });

  it('GET /settings/about says hosted, with no credential', async () => {
    const res = await request(httpServer).get('/settings/about');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({ product: 'cloudgate', mode: 'hosted' }),
    );
  });

  it('InstanceMode answers hosted to the code that asks it', () => {
    const instanceMode = ctx.app.get(InstanceMode);
    expect(instanceMode.isHosted).toBe(true);
    expect(instanceMode.mode).toBe('hosted');
  });
});
