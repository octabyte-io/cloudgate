// The Hosted instance with neither provider token. Set before the app module
// is imported: ConfigModule snapshots the environment on first load.
import { useHostedMode } from '../utils/hosted-mode';
useHostedMode();
delete process.env.HETZNER_EUR_API_TOKEN;
delete process.env.HETZNER_USD_API_TOKEN;

import request from 'supertest';
import { App } from 'supertest/types';

import { MailService } from '../../src/mail/mail.service';
import {
  MailRecorder,
  openHostedSignUp,
  signUpHostedCustomer,
} from '../utils/hosted-sign-up';
import type { HostedCustomer } from '../utils/hosted-sign-up';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(180_000);

/**
 * The provider tokens are optional (ADR-0071, #1388): the Hosted instance
 * boots without them, says *Buy a Server* is not offered, and refuses the
 * catalogue without asking the provider anything.
 */
describe('Bought Servers without the provider tokens (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let owner: HostedCustomer;
  const mail = new MailRecorder();

  beforeAll(async () => {
    // The boot itself is the first assertion: this resolves only if the
    // hosted boot check and every module accepted an environment with no
    // token in it.
    ctx = await createTestApp({
      overrideProviders: [{ provide: MailService, useValue: mail }],
    });
    http = ctx.app.getHttpServer() as App;
    await ctx.resetDb();
    await openHostedSignUp(ctx.db);
    owner = await signUpHostedCustomer(http, mail, {
      name: 'Grace Hopper',
      email: 'grace@example.com',
      password: 'super-secret-password',
      organizationName: 'Hopper Labs',
    });
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  it('says Buy a Server is not offered', async () => {
    const res = await request(http)
      .get('/bought-servers/offer')
      .set('Cookie', owner.cookie);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ offered: false });
  });

  it('refuses the catalogue, asking the provider nothing', async () => {
    const res = await request(http)
      .get('/bought-servers/catalogue')
      .set('Cookie', owner.cookie);

    expect(res.status).toBe(404);
    expect((res.body as { message: string }).message).toBe(
      'Buying a Server is not offered on this instance',
    );
    expect(ctx.hetzner.prices.calls).toEqual([]);
    expect(ctx.hetzner.machines.calls).toEqual([]);
  });
});
