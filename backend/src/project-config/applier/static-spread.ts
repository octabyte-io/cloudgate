import type {
  AwsCloudPort,
  AwsCredential,
} from '../../cloud-accounts/cloud.port';
import type { CloudRunControl } from '../../deployment-queue/cloud-run-job.types';
import { STATIC_DEPLOY_CAP_MS } from './static-place';

// The wait for CloudFront to spread a change (the AWS buckets spec "Landing" 4
// and 5), shared by a static site's Deployment, its Rollback and
// its Domain runs on AWS: what it reaches is handed in (§1.5's
// extracted-helper pattern), so `AwsStaticDeploys` keeps AWS's half.

/**
 * How long a Deployment waits for CloudFront: the static Deployment's cap
 * (the AWS buckets spec "Landing" 5), past which it ends done with
 * {@link STILL_SPREADING}, never failed.
 */
export const SPREAD_CAP_MS = STATIC_DEPLOY_CAP_MS;

/** How often the wait asks CloudFront. */
export const SPREAD_POLL_MS = 15_000;

/**
 * The clock the wait for CloudFront reads and sleeps on: the system's in
 * production, one a suite moves by hand so the 30-minute cap is reached
 * without waiting (the AWS buckets spec seam 4).
 */
export interface SpreadClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const STATIC_SPREAD_CLOCK = Symbol('STATIC_SPREAD_CLOCK');

export const systemSpreadClock: SpreadClock = {
  now: () => Date.now(),
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
};

/** "4m12s", "38s": how long a step took, as the Deployment log says it. */
export function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes > 0
    ? `${minutes}m${String(rest).padStart(2, '0')}s`
    : `${rest}s`;
}

/** The ⚠️ line of a Deployment CloudFront had not finished spreading at the cap. */
export const STILL_SPREADING =
  '⚠️ [Spread] Still spreading after 30m: CloudFront finishes on its own, and some visitors may see the previous version until it has. The Deployment is done; nothing failed';

/** The same line for a Domain's change, which has no version. */
export const DOMAIN_STILL_SPREADING =
  '⚠️ [Spread] Still spreading after 30m: CloudFront finishes on its own, and some visitors may not see the Domain change until it has. The Deployment is done; nothing failed';

/** What the wait reaches: the cloud port, and the clock it reads and sleeps on. */
export interface SpreadDeps {
  readonly cloud: AwsCloudPort;
  readonly clock: SpreadClock;
  readonly pollIntervalMs: number;
}

/**
 * Polls CloudFront until the distribution reads `Deployed` and the
 * invalidation, if any, `Completed`, logging each with its time since the
 * change. Answers whether the change spread before the cap.
 */
export async function awaitSpread(
  deps: SpreadDeps,
  request: {
    distributionId: string;
    invalidationId: string | null;
    since: number;
  },
  session: () => Promise<AwsCredential>,
  control: CloudRunControl,
  log: (line: string) => Promise<void>,
): Promise<boolean> {
  let deployed = false;
  let completed = request.invalidationId === null;
  const interrupted = new Promise<void>((resolve) =>
    control.signal.onInterrupt(resolve),
  );
  for (;;) {
    if (control.signal.interrupted) {
      throw new Error(
        request.invalidationId === null
          ? 'The run was ended while CloudFront spread the change; it takes effect once it has'
          : 'The run was ended while CloudFront spread the switch; the site serves this version once it has',
      );
    }
    if (!deployed) {
      const status = await deps.cloud.cloudFrontDistributionStatus(
        await session(),
        request.distributionId,
      );
      if (!status.ok) {
        throw new Error(
          `CloudFront could not be asked how far the change has spread: ${status.code}: ${status.message}`,
        );
      }
      if (status.value === 'Deployed') {
        deployed = true;
        await log(
          `✅ [Spread] Deployed after ${elapsed(deps.clock.now() - request.since)}`,
        );
      }
    }
    if (!completed && request.invalidationId !== null) {
      const status = await deps.cloud.cloudFrontInvalidationStatus(
        await session(),
        {
          distributionId: request.distributionId,
          invalidationId: request.invalidationId,
        },
      );
      if (!status.ok) {
        throw new Error(
          `CloudFront could not be asked about the cache clear: ${status.code}: ${status.message}`,
        );
      }
      if (status.value === 'Completed') {
        completed = true;
        await log(
          `✅ [Clear] Cache cleared after ${elapsed(deps.clock.now() - request.since)}`,
        );
      }
    }
    if (deployed && completed) return true;
    if (deps.clock.now() - request.since >= SPREAD_CAP_MS) return deployed;
    await Promise.race([deps.clock.sleep(deps.pollIntervalMs), interrupted]);
  }
}
