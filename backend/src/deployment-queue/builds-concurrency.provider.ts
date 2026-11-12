import type { Provider } from '@nestjs/common';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { LicenseService } from '../enterprise/license/license.service';
import { InstanceMode } from '../instance-mode/instance-mode.service';
import {
  BUILDS_CONCURRENCY,
  createBuildsConcurrencyResolver,
} from './concurrency';
import { LOCAL_PARTITION } from './job-types';

/**
 * The resolver the deployment queue runs on, wired to the real sources.
 *
 * The license gate is phase 22's: without a valid license every partition
 * builds one at a time. It asks `hasAnyValidLicense()` rather than naming an
 * organization — a partition is a server, and the local one belongs to no
 * organization, so parallel builds are an instance capability. This replaces
 * the `{ hasValidLicense: () => false }` stub phase 22 stood in.
 *
 * Configured values are read for the local partition only, from web-server
 * settings. A remote partition would read its `server` row, but
 * `server.buildsConcurrency` was not part of phase 13's server table, so remote
 * partitions still resolve to 1. Adding that column belongs with the server
 * surface, not here.
 */
/**
 * The license rule both pools share. On the Hosted instance parallel builds and
 * parallel cloud runs are Octabyte's install-wide settings, never sold, so
 * hosted mode unlocks them (ADR-0048); a Self-hosted instance still
 * needs a valid license on some Organization.
 */
export function instanceFeatureLicensed(
  mode: InstanceMode,
  license: LicenseService,
): Promise<boolean> | boolean {
  return mode.isHosted || license.hasAnyValidLicense();
}

export const buildsConcurrencyProvider: Provider = {
  provide: BUILDS_CONCURRENCY,
  inject: [LicenseService, InstanceMode, DRIZZLE],
  useFactory: (license: LicenseService, mode: InstanceMode, db: DrizzleDB) =>
    createBuildsConcurrencyResolver({
      license: {
        hasValidLicense: () => instanceFeatureLicensed(mode, license),
      },
      configuredConcurrency: async (partition) => {
        if (partition !== LOCAL_PARTITION) return 1;
        const settings = await db.query.webServerSettings.findFirst({
          columns: { buildsConcurrency: true },
        });
        return settings?.buildsConcurrency ?? 1;
      },
    }),
};
