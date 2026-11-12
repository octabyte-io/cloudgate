import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { BoughtServersConfig } from './bought-servers.config';
import { BoughtServerSettings } from './bought-server-settings.service';
import { shapeCatalogue } from './catalogue';
import type { BoughtServerCatalogue } from './catalogue';
import { HETZNER_PRICES } from './hetzner/hetzner-cloud.port';
import type {
  HetznerCloudPort,
  HetznerLocation,
  HetznerPricing,
  HetznerServerType,
} from './hetzner/hetzner-cloud.port';

/** The USD account's answers a catalogue is shaped from. */
export interface PriceList {
  serverTypes: HetznerServerType[];
  locations: HetznerLocation[];
  pricing: HetznerPricing;
}

/**
 * How long one read of the price list serves the page. Briefly, because
 * availability moves (a size sells out), and it is only a hint anyway; long
 * enough that the page's visitors do not spend the provider's 3,600 calls an
 * hour.
 */
export const CATALOGUE_TTL_MS = 5 * 60_000;

/** Said to a customer, so it names no provider. */
const PRICES_UNREADABLE = 'Server prices cannot be read right now';
const NOT_OFFERED = 'Buying a Server is not offered on this instance';

/**
 * **Bought Servers** (ADR-0071): what *Buy a Server* offers. Hosted only:
 * on a Self-hosted instance every route answers a bare 404, as the Operator
 * page's do, and on the Hosted instance without both provider tokens the
 * catalogue is a 404 that says buying is not offered.
 */
@Injectable()
export class BoughtServersService {
  private readonly logger = new Logger(BoughtServersService.name);
  private cached: {
    at: number;
    list: Promise<PriceList>;
  } | null = null;

  constructor(
    @Inject(HETZNER_PRICES) private readonly prices: HetznerCloudPort,
    private readonly config: BoughtServersConfig,
    private readonly settings: BoughtServerSettings,
  ) {}

  /** Whether *Buy a Server* is offered here; any member who can read Servers may ask. */
  offer(): { offered: boolean } {
    const offer = this.config.offer;
    if (offer === 'absent') throw new NotFoundException();
    return { offered: offer === 'offered' };
  }

  /**
   * Every Location and every size with its tidy price there, from the USD
   * account's list (kept {@link CATALOGUE_TTL_MS}) and the Server markup as
   * it stands now, so an Operator's change prices the next purchase at once
   * (#1399); a member who may add a Server may read it, the role rule
   * buying follows.
   */
  async catalogue(): Promise<BoughtServerCatalogue> {
    const offer = this.config.offer;
    if (offer === 'absent') throw new NotFoundException();
    if (offer === 'not-offered') throw new NotFoundException(NOT_OFFERED);

    const now = Date.now();
    const [list, { markupPercent }] = await Promise.all([
      this.priceList(now),
      this.settings.get(),
    ]);
    return shapeCatalogue({ ...list, markupPercent, now: new Date(now) });
  }

  /**
   * The USD account's price list read now, never the cached one: an
   * Operator's reprice follows the provider's latest prices (#1400).
   */
  freshPriceList(): Promise<PriceList> {
    return this.read();
  }

  private priceList(now: number): Promise<PriceList> {
    if (this.cached && now - this.cached.at < CATALOGUE_TTL_MS) {
      return this.cached.list;
    }
    const list = this.read();
    this.cached = { at: now, list };
    // A failed read is not kept: the next visitor asks again.
    list.catch(() => {
      if (this.cached?.list === list) this.cached = null;
    });
    return list;
  }

  private async read(): Promise<PriceList> {
    const [serverTypes, locations, pricing] = await Promise.all([
      this.prices.listServerTypes(),
      this.prices.listLocations(),
      this.prices.getPricing(),
    ]);
    for (const answer of [serverTypes, locations, pricing]) {
      if (!answer.ok) {
        this.logger.error(
          `The prices account refused a catalogue read: ${answer.code}: ${answer.message}`,
        );
        throw new ServiceUnavailableException(PRICES_UNREADABLE);
      }
    }
    if (!serverTypes.ok || !locations.ok || !pricing.ok) {
      throw new ServiceUnavailableException(PRICES_UNREADABLE);
    }
    // A token for the wrong account would sell at EUR figures as dollars.
    if (pricing.value.currency !== 'USD') {
      this.logger.error(
        `The prices account answers in ${pricing.value.currency}, not USD: HETZNER_USD_API_TOKEN must be the USD account's`,
      );
      throw new ServiceUnavailableException(PRICES_UNREADABLE);
    }
    return {
      serverTypes: serverTypes.value,
      locations: locations.value,
      pricing: pricing.value,
    };
  }
}
