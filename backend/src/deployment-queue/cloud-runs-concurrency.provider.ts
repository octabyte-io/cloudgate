import type { Provider } from '@nestjs/common';
import { asc } from 'drizzle-orm';
import { DRIZZLE } from '../db/drizzle.module';
import type { DrizzleDB } from '../db/drizzle.module';
import { LicenseService } from '../enterprise/license/license.service';
import { InstanceMode } from '../instance-mode/instance-mode.service';
import { instanceFeatureLicensed } from './builds-concurrency.provider';
import {
  CLOUD_RUN_TIME_LIMIT_DEFAULT_MINUTES,
  CLOUD_RUNS_CONCURRENCY_DEFAULT,
  webServerSettings,
} from '../settings/settings.schema';
import {
  CLOUD_RUN_KILL_GRACE_MS,
  CLOUD_RUN_SHUTDOWN_GRACE_MS,
} from './cloud-run-pool';
import { createBuildsConcurrencyResolver } from './concurrency';

/** DI token for {@link CloudRunSettings}. */
export const CLOUD_RUN_SETTINGS = Symbol('CLOUD_RUN_SETTINGS');

/**
 * DI token for {@link CloudRunTiming}: the clock lengths the pool runs on. A
 * spec overrides it to make a minute of time limit a few milliseconds, rather
 * than faking timers under Testcontainers.
 */
export const CLOUD_RUN_TIMING = Symbol('CLOUD_RUN_TIMING');

export interface CloudRunTiming {
  minuteMs: number;
  killGraceMs: number;
  shutdownGraceMs: number;
}

export const cloudRunTimingProvider: Provider = {
  provide: CLOUD_RUN_TIMING,
  useValue: {
    minuteMs: 60_000,
    killGraceMs: CLOUD_RUN_KILL_GRACE_MS,
    shutdownGraceMs: CLOUD_RUN_SHUTDOWN_GRACE_MS,
  } satisfies CloudRunTiming,
};

/** The two install-wide settings the Cloud run pool reads. */
export interface CloudRunSettings {
  /** Runs at once: the configured limit under the builds' licence rule. */
  resolveLimit(): Promise<number>;
  /** The time limit, in minutes. */
  timeLimitMinutes(): Promise<number>;
}

/**
 * The Cloud run pool's settings, wired to the real sources.
 *
 * **The licence rule is the builds' own, reused rather than restated**:
 * `createBuildsConcurrencyResolver` answers `UNLICENSED_BUILDS_CONCURRENCY`
 * without a valid licence before it reads the configured value, so "more than
 * one at a time is an enterprise feature" is one rule for both pools. Like
 * builds on the platform host it asks `hasAnyValidLicense()`: the pool belongs
 * to no Organization.
 *
 * A plain select on the settings row, for the reason
 * `builds-concurrency.provider.ts` and `requested-preview-max-ttl.ts` give: no
 * row yet reads as the columns' defaults, and reading never creates one.
 */
export const cloudRunSettingsProvider: Provider = {
  provide: CLOUD_RUN_SETTINGS,
  inject: [LicenseService, InstanceMode, DRIZZLE],
  useFactory: (
    license: LicenseService,
    mode: InstanceMode,
    db: DrizzleDB,
  ): CloudRunSettings => {
    const read = async () => {
      const [row] = await db
        .select({
          concurrency: webServerSettings.cloudRunsConcurrency,
          minutes: webServerSettings.cloudRunTimeLimitMinutes,
        })
        .from(webServerSettings)
        .orderBy(asc(webServerSettings.createdAt))
        .limit(1);
      return {
        concurrency: row?.concurrency ?? CLOUD_RUNS_CONCURRENCY_DEFAULT,
        minutes: row?.minutes ?? CLOUD_RUN_TIME_LIMIT_DEFAULT_MINUTES,
      };
    };
    const limit = createBuildsConcurrencyResolver({
      license: {
        hasValidLicense: () => instanceFeatureLicensed(mode, license),
      },
      configuredConcurrency: async () => (await read()).concurrency,
    });
    return {
      resolveLimit: () => limit('cloud-runs'),
      timeLimitMinutes: async () => (await read()).minutes,
    };
  },
};
