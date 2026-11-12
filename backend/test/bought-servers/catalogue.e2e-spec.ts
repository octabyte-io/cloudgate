// The Hosted instance with both provider tokens. Set before the app module
// is imported: ConfigModule snapshots the environment on first load.
import { useHostedMode } from '../utils/hosted-mode';
useHostedMode();
process.env.HETZNER_EUR_API_TOKEN = 'eur-token-for-the-fake';
process.env.HETZNER_USD_API_TOKEN = 'usd-token-for-the-fake';

import request from 'supertest';
import { App } from 'supertest/types';

import { MailService } from '../../src/mail/mail.service';
import {
  MailRecorder,
  openHostedSignUp,
  signUpHostedCustomer,
} from '../utils/hosted-sign-up';
import type { HostedCustomer } from '../utils/hosted-sign-up';
import { signUpMember } from '../utils/test-auth';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(180_000);

interface Offer {
  locationId: string;
  available: boolean;
  monthly: number;
  backupsMonthly: number;
}
interface Catalogue {
  locations: Array<{
    id: string;
    city: string;
    country: string;
    latitude: number;
    longitude: number;
  }>;
  sizes: Array<{
    id: string;
    family: string;
    vcpus: number;
    memoryGb: number;
    diskGb: number;
    offers: Offer[];
  }>;
  storage: { minGb: number; maxGb: number; perGbMonthly: number };
}

/**
 * *Buy a Server*'s prices (ADR-0071, #1388): on the Hosted instance with
 * both tokens, an owner reads every Location and every size with its tidy
 * monthly price and availability, read from the USD account and never the
 * machines one. The expected prices are worked by hand from the fake's
 * seeded USD list (`test/utils/fake-hetzner-cloud.ts`).
 */
describe('Bought Server catalogue (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let owner: HostedCustomer;
  const mail = new MailRecorder();

  beforeAll(async () => {
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

  beforeEach(() => {
    ctx.hetzner.prices.calls.length = 0;
    ctx.hetzner.machines.calls.length = 0;
  });

  // First in the file on purpose: a good read is kept for a few minutes, so
  // the refusal has to come before any read succeeds.
  it('answers 503 in words that name no provider while the prices account refuses', async () => {
    ctx.hetzner.prices.refuse('listServerTypes', 'unavailable');

    const res = await request(http)
      .get('/bought-servers/catalogue')
      .set('Cookie', owner.cookie);

    expect(res.status).toBe(503);
    expect((res.body as { message: string }).message).toBe(
      'Server prices cannot be read right now',
    );
    expect(JSON.stringify(res.body)).not.toMatch(/hetzner/i);
  });

  it('offers Buy a Server', async () => {
    const res = await request(http)
      .get('/bought-servers/offer')
      .set('Cookie', owner.cookie);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ offered: true });
  });

  it('returns every Location with its coordinates', async () => {
    const res = await request(http)
      .get('/bought-servers/catalogue')
      .set('Cookie', owner.cookie);

    expect(res.status).toBe(200);
    const catalogue = res.body as Catalogue;
    expect(catalogue.locations.map((location) => location.id)).toEqual([
      'fsn1',
      'nbg1',
      'hel1',
      'ash',
      'hil',
      'sin',
    ]);
    expect(catalogue.locations[0]).toEqual({
      id: 'fsn1',
      city: 'Falkenstein',
      country: 'DE',
      latitude: 50.47612,
      longitude: 12.370071,
    });
  });

  it('prices every size per Location from the USD list, with its availability', async () => {
    const res = await request(http)
      .get('/bought-servers/catalogue')
      .set('Cookie', owner.cookie);
    const catalogue = res.body as Catalogue;
    const offer = (size: string, location: string) =>
      catalogue.sizes
        .find((entry) => entry.id === size)
        ?.offers.find((entry) => entry.locationId === location);

    // (22.99 + 0.60) × 1.2 = 28.308 → $29; backups 22.99 × 20% × 1.2 = 5.52 → $6
    expect(offer('cpx22', 'fsn1')).toEqual({
      locationId: 'fsn1',
      available: true,
      monthly: 29,
      backupsMonthly: 6,
    });
    // (100.49 + 0.60) × 1.2 = 121.308 → the $5 step above $100: $125
    expect(offer('ccx23', 'fsn1')?.monthly).toBe(125);
    // Sold in Falkenstein, sold out there right now.
    expect(offer('cx23', 'fsn1')?.available).toBe(false);
    // Not sold in Singapore at all.
    expect(offer('cx23', 'sin')).toBeUndefined();
    expect(catalogue.storage).toEqual({
      minGb: 10,
      maxGb: 10240,
      perGbMonthly: 0.09204,
    });
    // Read from the prices account only; nothing asked the machines account.
    expect(ctx.hetzner.machines.calls).toEqual([]);
  });

  it('names no provider anywhere in what it answers', async () => {
    const res = await request(http)
      .get('/bought-servers/catalogue')
      .set('Cookie', owner.cookie);

    expect(JSON.stringify(res.body)).not.toMatch(/hetzner/i);
  });

  it('keeps one read for a while rather than asking the provider on every visit', async () => {
    for (let visit = 0; visit < 3; visit++) {
      const res = await request(http)
        .get('/bought-servers/catalogue')
        .set('Cookie', owner.cookie);
      expect(res.status).toBe(200);
    }

    expect(ctx.hetzner.prices.callsTo('listServerTypes')).toEqual([]);
  });

  it('refuses a base member, who may neither read nor add a Server', async () => {
    const member = await signUpMember(http, owner.cookie, {
      email: 'ida@example.com',
    });

    const catalogue = await request(http)
      .get('/bought-servers/catalogue')
      .set('Cookie', member.cookie);
    const offer = await request(http)
      .get('/bought-servers/offer')
      .set('Cookie', member.cookie);

    expect(catalogue.status).toBe(403);
    expect(offer.status).toBe(403);
    // Refused at the gate: the provider was not asked on their behalf.
    expect(ctx.hetzner.prices.calls).toEqual([]);
  });

  it('lets an admin, who may add a Server, read the prices', async () => {
    const admin = await signUpMember(http, owner.cookie, {
      email: 'ada@example.com',
      role: 'admin',
    });

    const res = await request(http)
      .get('/bought-servers/catalogue')
      .set('Cookie', admin.cookie);

    expect(res.status).toBe(200);
  });

  it('refuses a caller with no session', async () => {
    const res = await request(http).get('/bought-servers/catalogue');

    expect(res.status).toBe(401);
  });
});
