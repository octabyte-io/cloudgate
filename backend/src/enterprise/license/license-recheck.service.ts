import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
} from '@nestjs/common';
import { and, eq, isNotNull } from 'drizzle-orm';
import { DRIZZLE } from '../../db/drizzle.module';
import type { DrizzleDB } from '../../db/drizzle.module';
import { InstanceMode } from '../../instance-mode/instance-mode.service';
import { SchedulingService } from '../../scheduling/scheduling.service';
import { LicenseExpiringService } from './license-expiring.service';
import { isDueForRecheck } from './license-expiry';
import { licenseKey } from './license.schema';
import { LicenseService } from './license.service';

/** The job id the daily pass runs under, so a test can run it as its timer would. */
export const LICENSE_RECHECK_JOB_ID = 'license-recheck';

/**
 * Daily, at 06:23 host time — clear of the unconfirmed-accounts sweep at
 * 04:41, the Hosted lapse clock at 05:17 and the hourly lapse check at :07.
 */
export const LICENSE_RECHECK_CRON = '23 6 * * *';

/** What one pass did, by organization id. */
export interface LicenseRecheckTick {
  /** Re-activated: the license server's answer is now stored. */
  rechecked: string[];
  /** The license server refused or could not be reached; nothing was written. */
  failed: string[];
}

/**
 * The daily pass over Self-hosted licenses near or past their `validUntil`.
 * A license about to lapse, or lapsed, has its stored key re-activated
 * with the license server — the same call the owner's "check now" makes — so a
 * renewal made with Octabyte reaches the instance, and lifts a lapse, without
 * anyone pasting the key again.
 *
 * **It only calls the license server inside the window** that
 * `license-expiry.ts` defines (the last 14 days before `validUntil`, or after
 * it). A license with months left, or no expiry at all, is not asked about.
 *
 * Only licenses that are in force on the instance's side are considered: the
 * opt-in on, a key stored, `status` active. A key the server refused stays
 * refused until its owner acts.
 *
 * **Self-hosted only.** Hosted has no license key (ADR-0048): the job is not
 * registered there and {@link tick} does nothing.
 */
@Injectable()
export class LicenseRecheckService implements OnApplicationBootstrap {
  private readonly logger = new Logger(LicenseRecheckService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly scheduling: SchedulingService,
    private readonly instanceMode: InstanceMode,
    private readonly license: LicenseService,
    private readonly expiring: LicenseExpiringService,
  ) {}

  onApplicationBootstrap(): void {
    if (this.instanceMode.isHosted) return;
    this.scheduling.register(
      LICENSE_RECHECK_JOB_ID,
      LICENSE_RECHECK_CRON,
      null,
      () => this.tick().then(() => undefined),
    );
  }

  /**
   * Re-activates every license due a re-check as of `now`, then sends the
   * 14- and 3-day `license-expiring` warnings owed — after, so a
   * renewal just picked up moves `validUntil` out of the window first.
   */
  async tick(now: Date = new Date()): Promise<LicenseRecheckTick> {
    const done: LicenseRecheckTick = { rechecked: [], failed: [] };
    if (this.instanceMode.isHosted) return done;

    const rows = await this.db
      .select({
        organizationId: licenseKey.organizationId,
        key: licenseKey.key,
        validUntil: licenseKey.validUntil,
      })
      .from(licenseKey)
      .where(
        and(
          eq(licenseKey.enableEnterpriseFeatures, true),
          eq(licenseKey.status, 'active'),
          isNotNull(licenseKey.key),
          isNotNull(licenseKey.validUntil),
        ),
      );

    for (const row of rows) {
      if (!row.key || !isDueForRecheck(row.validUntil, now)) continue;
      try {
        await this.license.reactivate(row.organizationId, row.key);
        done.rechecked.push(row.organizationId);
      } catch (error) {
        done.failed.push(row.organizationId);
        this.logger.warn(
          `License re-check failed for organization ${row.organizationId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    await this.expiring.tick(now);
    return done;
  }
}
