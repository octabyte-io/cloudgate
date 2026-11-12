import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InstanceMode } from '../instance-mode/instance-mode.service';

/** Whether this instance sells Bought Servers, and if not, why. */
export type BoughtServersOffer =
  /** A Self-hosted instance: the feature does not exist (ADR-0071). */
  | 'absent'
  /** The Hosted instance without both provider tokens: nothing to sell with. */
  | 'not-offered'
  | 'offered';

/**
 * The one decision, pure: hosted mode first, so a Self-hosted instance with
 * a left-over token still has no such feature, then both tokens, since the
 * page needs the USD account's prices and a purchase needs the EUR account.
 */
export function boughtServersOffer(
  isHosted: boolean,
  tokens: { eur: string | undefined; usd: string | undefined },
): BoughtServersOffer {
  if (!isHosted) return 'absent';
  return tokens.eur?.trim() && tokens.usd?.trim() ? 'offered' : 'not-offered';
}

/**
 * The instance's Bought Server settings (ADR-0071), read off ConfigService
 * so the env schema validates them and the hosted boot check never asks for
 * them: unlike Stripe's, they are optional.
 */
@Injectable()
export class BoughtServersConfig {
  constructor(
    private readonly config: ConfigService,
    private readonly instanceMode: InstanceMode,
  ) {}

  /** The EUR account's token: the account every machine is made in. */
  get machinesToken(): string | undefined {
    return this.instanceMode.isHosted
      ? this.config.get<string>('HETZNER_EUR_API_TOKEN')?.trim() || undefined
      : undefined;
  }

  /** The empty USD account's token: only ever asked for prices. */
  get pricesToken(): string | undefined {
    return this.instanceMode.isHosted
      ? this.config.get<string>('HETZNER_USD_API_TOKEN')?.trim() || undefined
      : undefined;
  }

  /** The domain reverse DNS is named under, or undefined to leave the provider's default. */
  get reverseDnsDomain(): string | undefined {
    return (
      this.config.get<string>('BOUGHT_SERVER_REVERSE_DNS_DOMAIN')?.trim() ||
      undefined
    );
  }

  get offer(): BoughtServersOffer {
    return boughtServersOffer(this.instanceMode.isHosted, {
      eur: this.config.get<string>('HETZNER_EUR_API_TOKEN'),
      usd: this.config.get<string>('HETZNER_USD_API_TOKEN'),
    });
  }
}
