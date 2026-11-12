import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
  Req,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import type Stripe from 'stripe';
import { Public } from '../../auth/decorators/public.decorator';
import { BillingWebhookService } from './billing-webhook.service';
import { BillingConfig } from './billing.config';
import { STRIPE_API } from './stripe-api';
import { isHandledEvent } from './stripe-webhook-events';
import type { StripeApi } from './stripe-api';
import { Inject } from '@nestjs/common';

/**
 * Receives Stripe's billing events. Unauthenticated — trust
 * comes from the `stripe-signature` HMAC over the raw body, keyed with
 * STRIPE_WEBHOOK_SECRET, exactly as the GitHub webhook trusts its own signature.
 *
 * The raw body reaches here because the app is created with `rawBody: true`;
 * Stripe signs the bytes it sent, so the re-serialization the GitHub webhook
 * gets away with would fail every verification.
 */
@Controller('billing')
export class BillingWebhookController {
  private readonly logger = new Logger(BillingWebhookController.name);

  constructor(
    @Inject(STRIPE_API) private readonly stripe: StripeApi,
    private readonly config: BillingConfig,
    private readonly webhooks: BillingWebhookService,
  ) {}

  @Public()
  @Post('webhook')
  @HttpCode(200)
  async handle(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string | undefined,
  ): Promise<{ received: true }> {
    if (!this.config.webhookSecret) {
      throw new BadRequestException('Webhook Error: Missing Stripe Secret Key');
    }
    // A missing header is refused here before constructEvent, so an unsigned
    // request never reaches the SDK.
    if (!signature) {
      throw new BadRequestException('Webhook Error: Missing signature');
    }

    const payload = req.rawBody ?? Buffer.alloc(0);

    let event: Stripe.Event;
    try {
      event = this.stripe.constructEvent(payload, signature);
    } catch (error) {
      // The SDK's reason is logged, and the 400 names the failure.
      this.logger.error(
        `Webhook signature verification failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      throw new BadRequestException(
        'Webhook Error: Signature verification failed',
      );
    }

    // Any other type is refused rather than ignored, so an endpoint
    // subscribed to more than HANDLED_EVENT_TYPES shows at Stripe instead of
    // silently succeeding.
    if (!isHandledEvent(event)) {
      throw new BadRequestException('Webhook Error: Invalid Event Type');
    }

    await this.webhooks.handle(event);

    return { received: true };
  }
}
