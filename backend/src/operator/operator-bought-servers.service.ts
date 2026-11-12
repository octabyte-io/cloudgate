import { Inject, Injectable, Logger } from '@nestjs/common';
import { asc, eq, sql } from 'drizzle-orm';
import {
  boughtServer,
  boughtServerLine,
} from '../bought-servers/bought-server.schema';
import type { BoughtServerStage } from '../bought-servers/bought-server.schema';
import { BoughtServerSettings } from '../bought-servers/bought-server-settings.service';
import type { BoughtServerPricingSettings } from '../bought-servers/bought-server-settings.service';
import { BoughtServersConfig } from '../bought-servers/bought-servers.config';
import { DayRates } from '../bought-servers/exchange-rate/day-rates.service';
import type { DayRate } from '../bought-servers/exchange-rate/exchange-rate.port';
import { HETZNER_MACHINES } from '../bought-servers/hetzner/hetzner-cloud.port';
import type { HetznerCloudPort } from '../bought-servers/hetzner/hetzner-cloud.port';
import { belowFloor, eurMonthlyCost, marginOf } from '../bought-servers/margin';
import type { EurPriceList, Margin } from '../bought-servers/margin';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import type { NamedOrganization } from '../organizations/organization-name';
import { organization } from '../organizations/organizations.schema';
import { PermissionService } from '../rbac/permission.service';
import type { SetBoughtServerSettings } from './dto/set-bought-server-settings.dto';
import { OperatorService } from './operator.service';
import type { OperatorCtx } from './operator.service';

/**
 * Stages in which nothing is billed by the provider any more: no margin to
 * show, and nothing to flag.
 */
const UNBILLED_STAGES: readonly BoughtServerStage[] = ['deleted', 'failed'];

/** The audit's name for each setting. */
const SETTING_WRITES: Record<keyof BoughtServerPricingSettings, string> = {
  markupPercent: 'setServerMarkup',
  marginFloorPercent: 'setMarginFloor',
};

/**
 * One Bought Server as the Operator page lists it: account facts only
 * (ADR-0050), and the provider's codes, which an Operator may see.
 */
export interface OperatorBoughtServerView {
  id: string;
  name: string;
  organization: NamedOrganization;
  /** The provider's size code, `cpx22`. */
  serverType: string;
  /** The provider's Location code, `hel1`. */
  location: string;
  stage: BoughtServerStage;
  /** Every line's current price together, in US cents a month. */
  monthlyCents: number;
  /** The machine's id at the provider, once it has one. */
  providerServerId: number | null;
  /** Null while it cannot be worked out: no rate, no EUR price, or nothing billed. */
  margin: Margin | null;
  belowFloor: boolean;
  /** An Operator's power-off for abuse and its reason (#1401), or null. */
  poweredOff: { at: Date; reason: string } | null;
  createdAt: Date;
}

export interface OperatorBoughtServersView {
  /** The one rate every margin on the page uses, or null when it cannot be read. */
  exchangeRate: DayRate | null;
  /** Whether the provider's EUR price list could be read. */
  costsRead: boolean;
  marginFloorPercent: number;
  /** Newest first. */
  servers: OperatorBoughtServerView[];
}

export interface OperatorBoughtServerSettingsView extends BoughtServerPricingSettings {
  /**
   * The domain each machine's reverse DNS is named under, or null: then the
   * provider's default name stays, and the page warns.
   */
  reverseDnsDomain: string | null;
}

/**
 * The Operator page's **Bought Servers** section (spec #1387, #1399): every
 * Bought Server with its real margin, and the Server markup and margin floor.
 * Operators only, Hosted only (`OperatorService.assertOperator`); it reads
 * account facts and the provider's prices, never anything on a machine.
 */
@Injectable()
export class OperatorBoughtServers {
  private readonly logger = new Logger(OperatorBoughtServers.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(HETZNER_MACHINES) private readonly machines: HetznerCloudPort,
    private readonly operator: OperatorService,
    private readonly permissions: PermissionService,
    private readonly settings: BoughtServerSettings,
    private readonly config: BoughtServersConfig,
    private readonly dayRates: DayRates,
  ) {}

  /**
   * Every Bought Server, newest first, with its margin: its price less the
   * EUR account's cost for it at the day's rate, one rate for the whole page.
   */
  async list(ctx: OperatorCtx): Promise<OperatorBoughtServersView> {
    await this.operator.assertOperator(ctx);

    const prices = this.db
      .select({
        boughtServerId: boughtServerLine.boughtServerId,
        monthlyCents:
          sql<number>`sum(${boughtServerLine.monthlyCents})::int`.as(
            'monthly_cents',
          ),
      })
      .from(boughtServerLine)
      .groupBy(boughtServerLine.boughtServerId)
      .as('prices');

    const [rows, { marginFloorPercent }, exchangeRate] = await Promise.all([
      this.db
        .select({
          id: boughtServer.id,
          name: boughtServer.name,
          organizationId: organization.id,
          organizationName: organization.name,
          serverType: boughtServer.serverType,
          location: boughtServer.location,
          backups: boughtServer.backups,
          storageGb: boughtServer.storageGb,
          stage: boughtServer.stage,
          monthlyCents: prices.monthlyCents,
          providerServerId: boughtServer.providerServerId,
          poweredOffAt: boughtServer.poweredOffAt,
          poweredOffReason: boughtServer.poweredOffReason,
          createdAt: boughtServer.createdAt,
        })
        .from(boughtServer)
        .innerJoin(
          organization,
          eq(organization.id, boughtServer.organizationId),
        )
        .leftJoin(prices, eq(prices.boughtServerId, boughtServer.id))
        .orderBy(sql`${boughtServer.createdAt} desc`, asc(boughtServer.id)),
      this.settings.get(),
      this.dayRates.today(),
    ]);
    const costs = rows.length > 0 ? await this.eurPriceList() : null;

    const servers = rows.map((row): OperatorBoughtServerView => {
      const monthlyCents = row.monthlyCents ?? 0;
      const costEur =
        costs && !UNBILLED_STAGES.includes(row.stage)
          ? eurMonthlyCost(row, costs)
          : null;
      const margin =
        exchangeRate && costEur !== null && monthlyCents > 0
          ? marginOf({
              priceCents: monthlyCents,
              costEur,
              usdPerEur: exchangeRate.usdPerEur,
            })
          : null;
      return {
        id: row.id,
        name: row.name,
        organization: { id: row.organizationId, name: row.organizationName },
        serverType: row.serverType,
        location: row.location,
        stage: row.stage,
        monthlyCents,
        providerServerId: row.providerServerId,
        margin,
        belowFloor: margin
          ? belowFloor(
              { priceCents: monthlyCents, marginCents: margin.marginCents },
              marginFloorPercent,
            )
          : false,
        poweredOff: row.poweredOffAt
          ? { at: row.poweredOffAt, reason: row.poweredOffReason ?? '' }
          : null,
        createdAt: row.createdAt,
      };
    });

    return {
      exchangeRate,
      costsRead: rows.length === 0 || costs !== null,
      marginFloorPercent,
      servers,
    };
  }

  /** The Server markup, the margin floor, and the reverse-DNS domain. */
  async getSettings(
    ctx: OperatorCtx,
  ): Promise<OperatorBoughtServerSettingsView> {
    await this.operator.assertOperator(ctx);
    return this.settingsView(await this.settings.get());
  }

  /**
   * Sets the Server markup, the margin floor, or both. A markup prices new
   * purchases and new lines only: every line already sold keeps its price.
   * Each setting that changed is audited in the Instance organization's log,
   * through the Operator write path, with its old and new value.
   */
  async setSettings(
    ctx: OperatorCtx,
    change: SetBoughtServerSettings,
  ): Promise<OperatorBoughtServerSettingsView> {
    await this.operator.assertOperator(ctx);
    const instanceOrganizationId =
      await this.permissions.instanceOrganizationId();
    const { settings, changed } = await this.settings.set(change);

    if (instanceOrganizationId && changed.length > 0) {
      const instance = await this.operator.targetOf(instanceOrganizationId);
      for (const { setting, from, to } of changed) {
        await this.operator.recordWrite(ctx, instance, {
          type: SETTING_WRITES[setting],
          from,
          to,
        });
      }
    }
    return this.settingsView(settings);
  }

  private settingsView(
    settings: BoughtServerPricingSettings,
  ): OperatorBoughtServerSettingsView {
    return {
      ...settings,
      reverseDnsDomain: this.config.reverseDnsDomain ?? null,
    };
  }

  /**
   * The EUR account's price list, or null when it cannot be read: the page
   * still lists every Bought Server, with its margin unknown.
   */
  private async eurPriceList(): Promise<EurPriceList | null> {
    try {
      const [serverTypes, pricing] = await Promise.all([
        this.machines.listServerTypes(),
        this.machines.getPricing(),
      ]);
      if (serverTypes.ok && pricing.ok) {
        return { serverTypes: serverTypes.value, pricing: pricing.value };
      }
      for (const answer of [serverTypes, pricing]) {
        if (!answer.ok) {
          this.logger.error(
            `The machines account refused a price read: ${answer.code}: ${answer.message}`,
          );
        }
      }
    } catch (error) {
      this.logger.error(
        `The machines account's prices could not be read: ${(error as Error).message}`,
      );
    }
    return null;
  }
}
