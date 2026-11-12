import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import type Stripe from 'stripe';
import { InstanceMode } from '../../instance-mode/instance-mode.service';
import { STRIPE_API } from './stripe-api';
import type { StripeApi } from './stripe-api';
import { HANDLED_EVENT_TYPES } from './stripe-webhook-events';

/**
 * The path `BillingWebhookController` answers on (`@Controller('billing')`,
 * `@Post('webhook')`). An endpoint is matched by its URL ending in it, so one
 * pointed at the console's `/backend` rewrite and one at the API itself both
 * count.
 */
const WEBHOOK_PATH = '/billing/webhook';

/** Where the list an endpoint must be subscribed to is written for people. */
const DOC = 'docs/deploy.md';

/**
 * On start, the Hosted instance reads its Stripe webhook endpoints and warns
 * about one that is not subscribed to exactly HANDLED_EVENT_TYPES (#1414).
 * The endpoint is set up by hand in the Stripe Dashboard, and an event it
 * lacks is never sent: staging ran without `charge.dispute.created`, so no
 * dispute reached the Operators, and nothing said so.
 *
 * A warning, never a refusal to start: Stripe being unreachable, or a key
 * without read access to webhook endpoints, must not take billing down with
 * it. The read is not awaited by the start for the same reason.
 */
@Injectable()
export class StripeWebhookEndpointCheck implements OnApplicationBootstrap {
  private readonly logger = new Logger(StripeWebhookEndpointCheck.name);

  constructor(
    @Inject(STRIPE_API) private readonly stripe: StripeApi,
    private readonly instanceMode: InstanceMode,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.instanceMode.isHosted) return;
    void this.check();
  }

  /** Logs each warning, and returns them. Never throws. */
  async check(): Promise<string[]> {
    let warnings: string[];
    try {
      warnings = endpointWarnings(await this.stripe.listWebhookEndpoints());
    } catch (error) {
      warnings = [
        `Could not read the Stripe webhook endpoints to check their events: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ];
    }
    for (const warning of warnings) this.logger.warn(warning);
    return warnings;
  }
}

function pointsAtWebhook(endpoint: Stripe.WebhookEndpoint): boolean {
  try {
    return new URL(endpoint.url).pathname
      .replace(/\/+$/, '')
      .endsWith(WEBHOOK_PATH);
  } catch {
    return false;
  }
}

function endpointWarnings(endpoints: Stripe.WebhookEndpoint[]): string[] {
  const ours = endpoints.filter(pointsAtWebhook);
  if (ours.length === 0) {
    return [
      `No Stripe webhook endpoint points at ${WEBHOOK_PATH}, so Stripe sends ` +
        `this instance no billing events. Add one subscribed to every event ` +
        `${DOC} lists.`,
    ];
  }
  return ours.flatMap((endpoint) => warningsFor(endpoint));
}

function warningsFor(endpoint: Stripe.WebhookEndpoint): string[] {
  const name = `Stripe webhook endpoint ${endpoint.id} (${endpoint.url})`;
  if (endpoint.status !== 'enabled') {
    return [`${name} is disabled, so Stripe sends it no events.`];
  }
  const subscribed = endpoint.enabled_events;
  const retried =
    'Stripe retries each one and eventually disables the endpoint.';
  if (subscribed.includes('*')) {
    return [
      `${name} is subscribed to every event, and the webhook refuses all but ` +
        `the ones ${DOC} lists with a 400; ${retried}`,
    ];
  }
  const handled: readonly string[] = HANDLED_EVENT_TYPES;
  const missing = handled.filter((type) => !subscribed.includes(type));
  const extra = subscribed.filter((type) => !handled.includes(type));
  const warnings: string[] = [];
  if (missing.length > 0) {
    warnings.push(
      `${name} is not subscribed to ${missing.join(', ')}: Stripe never ` +
        `sends them, so Cloudgate never acts on them. Subscribe it to every ` +
        `event ${DOC} lists.`,
    );
  }
  if (extra.length > 0) {
    warnings.push(
      `${name} is subscribed to ${extra.join(', ')}, which the webhook ` +
        `refuses with a 400; ${retried}`,
    );
  }
  return warnings;
}
