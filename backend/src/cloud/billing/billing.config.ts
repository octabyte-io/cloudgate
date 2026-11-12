import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InstanceMode } from '../../instance-mode/instance-mode.service';
import type { StripePriceCatalogue } from './billing.plans';

/**
 * The instance's billing configuration, read off ConfigService rather than
 * `process.env` at module load, so the env schema validates these and tests
 * can set them.
 */
@Injectable()
export class BillingConfig {
  constructor(
    private readonly config: ConfigService,
    private readonly instanceMode: InstanceMode,
  ) {}

  /**
   * The console's base URL for Stripe's return links: SITE_URL when set,
   * localhost:3000 otherwise. A fallback rather than an environment branch, so
   * an instance that sets SITE_URL is believed whatever NODE_ENV says.
   */
  get siteUrl(): string {
    return this.config.get<string>('SITE_URL') ?? 'http://localhost:3000';
  }

  /**
   * Undefined on a Self-hosted instance whatever the environment says, so a
   * left-over Stripe setting there accepts no webhook (ADR-0049: Stripe
   * settings are ignored when self-hosted).
   */
  get webhookSecret(): string | undefined {
    if (!this.instanceMode.isHosted) return undefined;
    return this.config.get<string>('STRIPE_WEBHOOK_SECRET');
  }

  /**
   * The Starter and Business prices and the Add-on's (ADR-0054). The hosted
   * boot check already refuses to start without them; checkout still checks,
   * so an unset price is a sentence rather than a Stripe error.
   */
  get prices(): StripePriceCatalogue {
    return {
      starterPriceId: this.config.get<string>('STARTER_PLAN_PRICE_ID'),
      businessPriceId: this.config.get<string>('BUSINESS_PLAN_PRICE_ID'),
      addOnPriceId: this.config.get<string>('ADD_ON_PRICE_ID'),
    };
  }

  /**
   * The secret the free-trial history's email keys are derived from
   * (`trialEmailKey`, free-trial.ts): the Instance's own
   * `APP_ENCRYPTION_SECRET`, under a label of its own, rather than a setting
   * more to keep.
   */
  get trialHistorySecret(): string {
    return this.config.get<string>('APP_ENCRYPTION_SECRET') ?? '';
  }
}
