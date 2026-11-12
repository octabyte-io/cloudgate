import { Inject, Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import {
  BOUGHT_SERVER_SETTINGS_ID,
  DEFAULT_MARGIN_FLOOR_PERCENT,
  boughtServerSettings,
} from './bought-server-settings.schema';
import { DEFAULT_SERVER_MARKUP_PERCENT } from './pricing';

/** The Server markup and the margin floor, as they stand. */
export interface BoughtServerPricingSettings {
  markupPercent: number;
  marginFloorPercent: number;
}

/** One setting an Operator changed: from what, to what. */
export interface SettingChange {
  setting: keyof BoughtServerPricingSettings;
  from: number;
  to: number;
}

/**
 * The instance's **Server markup** and margin floor (ADR-0071), stored in
 * one row and read on every price made, so a change prices the next
 * purchase at once. Who may change them is the Operator page's to decide
 * (`OperatorBoughtServers`), and so is the audit.
 */
@Injectable()
export class BoughtServerSettings {
  constructor(@Inject(DRIZZLE) private readonly db: DrizzleDB) {}

  /** The settings now: the defaults until an Operator first changes one. */
  async get(): Promise<BoughtServerPricingSettings> {
    const [row] = await this.db
      .select({
        markupPercent: boughtServerSettings.markupPercent,
        marginFloorPercent: boughtServerSettings.marginFloorPercent,
      })
      .from(boughtServerSettings)
      .where(eq(boughtServerSettings.id, BOUGHT_SERVER_SETTINGS_ID))
      .limit(1);
    return (
      row ?? {
        markupPercent: DEFAULT_SERVER_MARKUP_PERCENT,
        marginFloorPercent: DEFAULT_MARGIN_FLOOR_PERCENT,
      }
    );
  }

  /**
   * Writes the settings given, and answers each one that changed with its
   * old value. The row is locked while it is read and written, so two
   * Operators saving at once each record the value they really replaced.
   */
  async set(change: Partial<BoughtServerPricingSettings>): Promise<{
    settings: BoughtServerPricingSettings;
    changed: SettingChange[];
  }> {
    return this.db.transaction(async (tx) => {
      await tx
        .insert(boughtServerSettings)
        .values({ id: BOUGHT_SERVER_SETTINGS_ID })
        .onConflictDoNothing();
      const [before] = await tx
        .select({
          markupPercent: boughtServerSettings.markupPercent,
          marginFloorPercent: boughtServerSettings.marginFloorPercent,
        })
        .from(boughtServerSettings)
        .where(eq(boughtServerSettings.id, BOUGHT_SERVER_SETTINGS_ID))
        .for('update');

      const changed = (
        ['markupPercent', 'marginFloorPercent'] as const
      ).flatMap((setting): SettingChange[] => {
        const to = change[setting];
        return to === undefined || to === before[setting]
          ? []
          : [{ setting, from: before[setting], to }];
      });
      const settings = { ...before };
      for (const { setting, to } of changed) settings[setting] = to;

      if (changed.length > 0) {
        await tx
          .update(boughtServerSettings)
          .set({ ...settings, updatedAt: sql`now()` })
          .where(eq(boughtServerSettings.id, BOUGHT_SERVER_SETTINGS_ID));
      }
      return { settings, changed };
    });
  }
}
