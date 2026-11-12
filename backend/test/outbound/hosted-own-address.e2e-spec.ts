// The Hosted instance, with the box's public address as the Hosted install
// writes it. Set before the app module is imported: ConfigModule snapshots
// the environment on first load.
import { useHostedMode } from '../utils/hosted-mode';
useHostedMode();
const BOX_ADDRESS = '203.0.113.99';
process.env.CLOUDGATE_PUBLIC_HOST = BOX_ADDRESS;

import request from 'supertest';
import { App } from 'supertest/types';
import type { Dispatcher } from 'undici';

import { FETCH_CLIENT } from '../../src/git-providers/fetch.provider';
import { MailService } from '../../src/mail/mail.service';
import { ADDRESS_RESOLVER } from '../../src/outbound/outbound-address';
import { OUTBOUND_ADDRESS_REFUSED_CODE } from '../../src/outbound/outbound-address-guard';
import type { FetchClient } from '../../src/git-providers/fetch.provider';
import {
  MailRecorder,
  openHostedSignUp,
  signUpHostedCustomer,
} from '../utils/hosted-sign-up';
import type { HostedCustomer } from '../utils/hosted-sign-up';
import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(180_000);

/** A customer's provider on the internet, which is not the box. */
const PROVIDER_HOST = 'models.example.com';
const PROVIDER_ADDRESS = '198.51.100.7';

/** The guard's 400, naming the field the URL was set in. */
const REFUSED = {
  code: OUTBOUND_ADDRESS_REFUSED_CODE,
  message: expect.stringMatching(/^apiUrl must be a public address/) as unknown,
};

/** What the box's own backend answers when it is reached without Traefik. */
const BOX_ANSWER = '{"statusCode":404,"message":"Cannot GET /v1/models"}';

/** The href a fetch's `input` names. */
function hrefOf(input: Parameters<FetchClient>[0]): string {
  return typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : input.url;
}

/** Whether `error`, or anything it was caused by, carries the guard's code. */
function refusedByGuard(error: unknown): boolean {
  for (let at: unknown = error, depth = 0; at && depth < 5; depth += 1) {
    if ((at as { code?: unknown }).code === OUTBOUND_ADDRESS_REFUSED_CODE) {
      return true;
    }
    at = (at as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * On the Hosted instance the outbound guard refuses the box's own addresses,
 * as `ServerAddressGuard` does for a Server (ADR-0053): a customer's AI
 * provider URL, webhook or uptime check aimed at the box's public IP would
 * otherwise reach its backend, console or Swarm ports without Traefik.
 *
 * `FETCH_CLIENT` plays the network. A request to the box answers as the box's
 * backend does; the provider redirects to the box, and the hop is opened
 * through the dispatcher the guarded fetch carries, as `fetch` opens each
 * hop, so the refusal under test is the real connector's.
 */
describe('Outbound dials to the box itself on the Hosted instance (e2e)', () => {
  let ctx: TestAppContext;
  let http: App;
  let customer: HostedCustomer;
  const mail = new MailRecorder();

  const resolve = jest.fn<Promise<string[]>, [string]>();
  const network = jest.fn<ReturnType<FetchClient>, Parameters<FetchClient>>();

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: MailService, useValue: mail },
        { provide: ADDRESS_RESOLVER, useValue: resolve },
        { provide: FETCH_CLIENT, useValue: network },
      ],
    });
    http = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx?.teardown();
  });

  beforeEach(async () => {
    await ctx.resetDb();
    mail.clear();
    resolve
      .mockReset()
      .mockImplementation((host: string) =>
        host === PROVIDER_HOST
          ? Promise.resolve([PROVIDER_ADDRESS])
          : Promise.reject(new Error('ENOTFOUND')),
      );
    network.mockReset().mockImplementation(async (input, init) => {
      const url = new URL(hrefOf(input));
      if (url.hostname === BOX_ADDRESS) {
        return new Response(BOX_ANSWER, { status: 404 });
      }
      // The provider answers 302 → the box's backend port.
      const dispatcher = (init as { dispatcher?: Dispatcher } | undefined)
        ?.dispatcher;
      if (dispatcher) {
        try {
          await dispatcher.request({
            origin: `http://${BOX_ADDRESS}:4000`,
            path: '/v1/models',
            method: 'GET',
            signal: AbortSignal.timeout(2_000),
          });
        } catch (error) {
          // What `fetch` throws for a connection that failed.
          if (refusedByGuard(error)) {
            throw new TypeError('fetch failed', { cause: error });
          }
        }
      }
      // The connector let the hop through: the box answered it.
      return new Response(BOX_ANSWER, { status: 404 });
    });

    await openHostedSignUp(ctx.db);
    customer = await signUpHostedCustomer(http, mail, {
      name: 'Grace',
      email: 'grace@customer.test',
      password: 'customer-password-1',
      organizationName: 'Customer',
    });
  });

  const listModels = (apiUrl: string) =>
    request(http)
      .post('/ai/models')
      .set('Cookie', customer.cookie)
      .send({ apiUrl, apiKey: 'sk-customer' });

  it("refuses a customer's AI provider URL at the box's own public IP, dialling nothing", async () => {
    const res = await listModels(`http://${BOX_ADDRESS}:4000/v1`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject(REFUSED);
    expect(JSON.stringify(res.body)).not.toContain('Cannot GET');
    expect(network).not.toHaveBeenCalled();
  });

  it("refuses a 302 from a customer's provider to the box's own public IP", async () => {
    const res = await listModels(`https://${PROVIDER_HOST}/v1`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject(REFUSED);
    expect(JSON.stringify(res.body)).not.toContain('Cannot GET');
    expect(network).toHaveBeenCalledWith(
      `https://${PROVIDER_HOST}/v1/models`,
      expect.anything(),
    );
  });

  it('still dials a public provider that is not the box', async () => {
    network.mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: 'gpt-x' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const res = await listModels(`https://${PROVIDER_HOST}/v1`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual([expect.objectContaining({ id: 'gpt-x' })]);
  });
});
