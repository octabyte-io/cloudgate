import { Logger } from '@nestjs/common';
import type Stripe from 'stripe';
import { StripeWebhookEndpointCheck } from '../../../src/cloud/billing/stripe-webhook-endpoint-check';
import { HANDLED_EVENT_TYPES } from '../../../src/cloud/billing/stripe-webhook-events';
import { fakeStripe } from '../../utils/fake-stripe';
import { instanceModeDouble } from '../../utils/instance-mode-double';

// #1414: on start, the Hosted instance reads its webhook endpoint from Stripe
// and warns about any handled event it is not subscribed to, so an endpoint
// set up by hand from a stale list shows in the log rather than as a dispute
// nobody is told about.

const URL = 'https://cloudgate.test/backend/billing/webhook';

/** The events staging's endpoint had in #1414: every one but these two. */
const STAGING_GAP = [
  'customer.subscription.pending_update_expired',
  'charge.dispute.created',
];

const endpoint = (
  over: Partial<Stripe.WebhookEndpoint> = {},
): Stripe.WebhookEndpoint =>
  ({
    id: 'we_staging',
    object: 'webhook_endpoint',
    url: URL,
    status: 'enabled',
    enabled_events: [...HANDLED_EVENT_TYPES],
    ...over,
  }) as Stripe.WebhookEndpoint;

function checkWith(endpoints: Stripe.WebhookEndpoint[] | Error, hosted = true) {
  const listWebhookEndpoints = jest.fn(() =>
    endpoints instanceof Error
      ? Promise.reject(endpoints)
      : Promise.resolve(endpoints),
  );
  const check = new StripeWebhookEndpointCheck(
    fakeStripe({ listWebhookEndpoints }),
    instanceModeDouble(hosted),
  );
  return { check, listWebhookEndpoints };
}

describe('StripeWebhookEndpointCheck', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });
  afterEach(() => warn.mockRestore());

  it('warns naming each handled event the endpoint is not subscribed to', async () => {
    const { check } = checkWith([
      endpoint({
        enabled_events: HANDLED_EVENT_TYPES.filter(
          (type) => !STAGING_GAP.includes(type),
        ),
      }),
    ]);

    const warnings = await check.check();

    expect(warnings).toEqual([
      `Stripe webhook endpoint we_staging (${URL}) is not subscribed to ` +
        `${STAGING_GAP.join(', ')}: Stripe never sends them, so Cloudgate ` +
        'never acts on them. Subscribe it to every event docs/deploy.md lists.',
    ]);
    expect(warn).toHaveBeenCalledWith(warnings[0]);
  });

  it('says nothing for an endpoint subscribed to exactly the handled events', async () => {
    const { check } = checkWith([endpoint()]);

    expect(await check.check()).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('warns about an event the endpoint sends that the webhook refuses', async () => {
    const { check } = checkWith([
      endpoint({
        enabled_events: [...HANDLED_EVENT_TYPES, 'invoice.created'],
      }),
    ]);

    expect(await check.check()).toEqual([
      `Stripe webhook endpoint we_staging (${URL}) is subscribed to ` +
        'invoice.created, which the webhook refuses with a 400; Stripe ' +
        'retries each one and eventually disables the endpoint.',
    ]);
  });

  it('warns about an endpoint subscribed to every event', async () => {
    const { check } = checkWith([endpoint({ enabled_events: ['*'] })]);

    expect(await check.check()).toEqual([
      `Stripe webhook endpoint we_staging (${URL}) is subscribed to every ` +
        'event, and the webhook refuses all but the ones docs/deploy.md ' +
        'lists with a 400; Stripe retries each one and eventually disables ' +
        'the endpoint.',
    ]);
  });

  it('warns about a disabled endpoint', async () => {
    const { check } = checkWith([endpoint({ status: 'disabled' })]);

    expect(await check.check()).toEqual([
      `Stripe webhook endpoint we_staging (${URL}) is disabled, so Stripe ` +
        'sends it no events.',
    ]);
  });

  it('checks only the endpoints that point at the billing webhook', async () => {
    const { check } = checkWith([
      endpoint(),
      endpoint({
        id: 'we_other',
        url: 'https://elsewhere.test/hooks/stripe',
        enabled_events: ['invoice.created'],
      }),
    ]);

    expect(await check.check()).toEqual([]);
  });

  it('warns when no endpoint points at the billing webhook', async () => {
    const { check } = checkWith([]);

    expect(await check.check()).toEqual([
      'No Stripe webhook endpoint points at /billing/webhook, so Stripe ' +
        'sends this instance no billing events. Add one subscribed to every ' +
        'event docs/deploy.md lists.',
    ]);
  });

  it('warns, and does not throw, when Stripe cannot be read', async () => {
    const { check } = checkWith(new Error('Invalid API Key provided'));

    expect(await check.check()).toEqual([
      'Could not read the Stripe webhook endpoints to check their events: ' +
        'Invalid API Key provided',
    ]);
  });

  describe('on start', () => {
    it('reads the endpoints on the Hosted instance', async () => {
      const { check, listWebhookEndpoints } = checkWith([endpoint()]);

      check.onApplicationBootstrap();
      await Promise.resolve();

      expect(listWebhookEndpoints).toHaveBeenCalledTimes(1);
    });

    it('never asks Stripe on a Self-hosted instance', async () => {
      const { check, listWebhookEndpoints } = checkWith([], false);

      check.onApplicationBootstrap();
      await Promise.resolve();

      expect(listWebhookEndpoints).not.toHaveBeenCalled();
    });
  });
});
