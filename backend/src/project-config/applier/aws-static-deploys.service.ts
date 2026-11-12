import { Inject, Injectable } from '@nestjs/common';
import { eq } from 'drizzle-orm';

import {
  STATIC_ORIGIN_ID,
  staticOriginPath,
} from '../../cloud-accounts/aws/definitions/static-definition';
import { CloudAccountsService } from '../../cloud-accounts/cloud-accounts.service';
import type { AwsCloudAccount } from '../../cloud-accounts/cloud-provider';
import { credentialOf } from '../../cloud-accounts/cloud-provider';
import { AWS_CLOUD_PORT } from '../../cloud-accounts/cloud.port';
import type {
  AwsCloudPort,
  AwsCredential,
} from '../../cloud-accounts/cloud.port';
import { DRIZZLE } from '../../db/drizzle.module';
import type { DrizzleDB } from '../../db/drizzle.module';
import { application } from '../../db/schema';
import type { CloudRunControl } from '../../deployment-queue/cloud-run-job.types';
import { OBJECT_STORAGE } from '../../object-storage/object-storage.port';
import type {
  ObjectStoragePort,
  ObjectStorageTarget,
} from '../../object-storage/object-storage.port';
import type { StaticHalf, StaticSite } from './static-place';
import {
  awaitSpread,
  DOMAIN_STILL_SPREADING,
  SPREAD_POLL_MS,
  STATIC_SPREAD_CLOCK,
  STILL_SPREADING,
} from './static-spread';
import type { SpreadClock, SpreadDeps } from './static-spread';

/** A deploy-role session is asked again after this long (STS gives 15 minutes). */
const SESSION_REFRESH_MS = 10 * 60_000;

/** The site's own bucket, as the object-storage port is handed it. */
function bucketTarget(
  region: string,
  bucket: string,
  credential: AwsCredential,
): ObjectStorageTarget {
  return { endpoint: null, region, bucket, credential, pathStyle: false };
}

/**
 * **AWS's half of a static site's Deployment** (split out per cloud): S3 +
 * CloudFront, on the platform host with the deploy role's
 * session, so no AWS credential reaches a Server. `CloudStaticDeploys` runs
 * the Deployment and hands it here for:
 *
 * - **the folders**: the site's own bucket, through the object-storage
 *   port;
 * - **going live**: the distribution's origin path is switched to the
 *   Deployment's folder, through the cloud port, never `tofu`: the switch is
 *   the Deployment's own change, like a new image tag on ECS. The folder is
 *   recorded as the Application's live folder, which the definition writes
 *   the origin path from, so it is never Drift and reopens no plan. Only the
 *   origin path moves; the distribution's settings stay as the Project
 *   config says;
 * - **settling**: one `/*` invalidation, then a wait until the distribution
 *   reads `Deployed` and the invalidation `Completed`, each logged with its
 *   time. At the cap the Deployment ends done with {@link STILL_SPREADING},
 *   never failed. The previous live folder is spared by the clean-up until
 *   the switch reads `Deployed`: while CloudFront still spreads, it may
 *   still serve it.
 *
 * It also holds a Domain run's wait for CloudFront.
 */
@Injectable()
export class AwsStaticDeploys {
  /** How often the wait asks CloudFront. */
  pollIntervalMs = SPREAD_POLL_MS;

  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    @Inject(AWS_CLOUD_PORT) private readonly cloud: AwsCloudPort,
    @Inject(OBJECT_STORAGE) private readonly objectStorage: ObjectStoragePort,
    @Inject(STATIC_SPREAD_CLOCK) private readonly clock: SpreadClock,
    private readonly cloudAccounts: CloudAccountsService,
  ) {}

  /** The site on S3 + CloudFront in `account`. */
  halfOf(site: StaticSite, account: AwsCloudAccount): StaticHalf {
    const { found, name, region, bucket } = site;
    const session = this.sessions(account);
    const target = async () => bucketTarget(region, bucket, await session());
    return {
      folders: {
        where: (prefix) => `s3://${bucket}/${prefix}`,
        upload: async (upload) =>
          this.objectStorage.uploadFolder(await target(), upload),
        list: async (prefix) =>
          this.objectStorage.listFolders(await target(), prefix),
        delete: async (prefix) =>
          this.objectStorage.deleteFolder(await target(), prefix),
      },
      serving: () => {
        const distributionId = found.cloudDistributionId;
        if (!distributionId) {
          throw new Error(
            `${name}'s CloudFront distribution is not made yet, so there is nowhere to serve its files. Check for changes, then apply the plan`,
          );
        }
        const previous = found.cloudLiveFolder;
        return {
          place: `S3 + CloudFront in Cloud account ${account.name} (${region})`,
          servedBy: `served by distribution ${distributionId}`,
          settings: "the distribution's settings",
          goLive: async ({ folder }) => {
            const switched = await this.cloud.cloudFrontSwitchOrigin(
              await session(),
              {
                distributionId,
                originId: STATIC_ORIGIN_ID,
                originPath: staticOriginPath(folder),
              },
            );
            if (!switched.ok) {
              throw new Error(
                `CloudFront refused the switch to this version: ${switched.code}: ${switched.message}. The site still serves its previous version`,
              );
            }
            await this.db
              .update(application)
              .set({ cloudLiveFolder: folder })
              .where(eq(application.applicationId, found.applicationId));
          },
          settle: async ({ deploymentId, folder, control, log }) => {
            const switchedAt = this.clock.now();
            await log('🔀 [Switch] Switched to this version, spreading…');
            const cleared = await this.cloud.cloudFrontCreateInvalidation(
              await session(),
              { distributionId, paths: ['/*'], callerReference: deploymentId },
            );
            if (!cleared.ok) {
              throw new Error(
                `CloudFront refused to clear its cache: ${cleared.code}: ${cleared.message}. The switch was made; some visitors may see the previous version until their copies expire`,
              );
            }
            await log(`🧽 [Clear] Clearing CloudFront's cache of /*`);
            const deployed = await awaitSpread(
              this.spreading(),
              {
                distributionId,
                invalidationId: cleared.value.invalidationId,
                since: switchedAt,
              },
              session,
              control,
              log,
            );
            if (!deployed) await log(STILL_SPREADING);
            return {
              live: folder,
              // CloudFront may still serve it from where it has not spread yet.
              previous:
                deployed || previous === null || previous === folder
                  ? null
                  : { folder: previous, while: 'while CloudFront spreads' },
            };
          },
        };
      },
    };
  }

  /**
   * A Domain run's wait (the AWS buckets spec): after its apply has
   * changed the distribution's alternate domain names or certificate, until
   * the distribution reads `Deployed`, at most the static Deployment's cap,
   * past which the Deployment ends done with {@link DOMAIN_STILL_SPREADING}.
   */
  async awaitDomainSpread(
    account: AwsCloudAccount,
    distributionId: string,
    control: CloudRunControl,
    log: (line: string) => Promise<void>,
  ): Promise<void> {
    await log('⏳ [Spread] Waiting for CloudFront to spread the change');
    const deployed = await awaitSpread(
      this.spreading(),
      { distributionId, invalidationId: null, since: this.clock.now() },
      this.sessions(account),
      control,
      log,
    );
    if (!deployed) await log(DOMAIN_STILL_SPREADING);
  }

  /** What the wait for CloudFront reaches: the cloud port, on this clock. */
  private spreading(): SpreadDeps {
    return {
      cloud: this.cloud,
      clock: this.clock,
      pollIntervalMs: this.pollIntervalMs,
    };
  }

  /**
   * A deploy-role session, asked once and again when it is near its end.
   * A refusal fails the run before any change, naming the Cloud account.
   */
  private sessions(account: AwsCloudAccount): () => Promise<AwsCredential> {
    const credential = credentialOf(account);
    let held: { session: AwsCredential; at: number } | null = null;
    return async () => {
      if (held && Date.now() - held.at < SESSION_REFRESH_MS) {
        return held.session;
      }
      const answer = await this.cloudAccounts.deployRoleSession(
        account,
        credential,
      );
      if (!answer.ok) throw new Error(answer.refusal);
      held = { session: answer.session, at: Date.now() };
      return answer.session;
    };
  }
}
