import { eq } from 'drizzle-orm';
import { quote } from 'shell-quote';

import type { CloudKind } from '../cloud-accounts/cloud-account.schema';
import { byCloud } from '../cloud-accounts/cloud-provider';
import type { PerCloud } from '../cloud-accounts/cloud-provider';
import type { DrizzleDB } from '../db/drizzle.module';
import { cloudAccount } from '../db/schema';
import type { DeployableApplication } from './deployment-engine.types';

/**
 * The build half of a cloud `web`'s Deployment ("Image and
 * ECR"). The build, or the pull of a ready-made image with the
 * Application's own source credential, runs as on a Server, in the build
 * slot on the platform host; nothing is released by the engine. The push
 * to the Service's own repository in its Cloud account (ECR on AWS,
 * Artifact Registry on Google Cloud) and the apply follow in the same
 * Deployment's Cloud run (`project-config/applier/cloud-service-deploys`),
 * once the queue has handed the row to the Cloud run pool and freed the
 * build slot.
 *
 * A cloud `static` site's (spec "Landing") builds nothing: the
 * build slot checks out, applies the patches and copies `publish` aside
 * ({@link stageStaticFilesCommand}); its upload, switch and wait are the
 * `static-deploy` Cloud run's (`project-config/applier/cloud-static-deploys`).
 */

/** Whether this Application runs in a Cloud account rather than on a Server. */
export function runsInCloud(
  application: Pick<DeployableApplication, 'cloudAccountId'>,
): boolean {
  return Boolean(application.cloudAccountId);
}

/**
 * Whether this Application is a `static` site on S3 + CloudFront:
 * its Deployment checks out and copies `publish` aside on the
 * platform host, then uploads it in a `static-deploy` Cloud run.
 */
export function runsAsCloudStatic(
  application: Pick<DeployableApplication, 'cloudAccountId' | 'configKind'>,
): boolean {
  return runsInCloud(application) && application.configKind === 'static';
}

/** The Cloud run a cloud Service's Deployment continues in, once built. */
export function cloudDeployKind(
  application: Pick<DeployableApplication, 'cloudAccountId' | 'configKind'>,
): 'deploy' | 'static-deploy' {
  return runsAsCloudStatic(application) ? 'static-deploy' : 'deploy';
}

/**
 * What a cloud Service's build refuses before it runs, naming it: a linked
 * Registry or build Registry, since the image always goes to the Service's
 * own repository in its Cloud account; and a build Server, since no cloud
 * credential ever reaches a Server. The console refuses linking either (`cloud-place.ts`);
 * this is the deploy's own word for a row that holds one anyway.
 *
 * A static site on S3 + CloudFront pushes no image, so a linked
 * Registry is never used and not refused; a ready-made image is, since it
 * has no `publish` folder to upload.
 */
export function assertCloudBuild(application: DeployableApplication): void {
  if (runsAsCloudStatic(application)) {
    if (application.sourceType === 'docker') {
      throw new Error(
        'Cannot deploy: this static site runs on S3 + CloudFront, which serves the files of its `publish` folder, and a ready-made image has none. Give it a git source, then deploy again.',
      );
    }
  } else {
    const linked = application.registry ?? application.buildRegistry;
    if (linked) {
      throw new Error(
        `Cannot deploy: Registry ${linked.name} is linked to this Service, which runs in a Cloud account. Its image always goes to the Service's own repository in its Cloud account; unlink the Registry, then deploy again.`,
      );
    }
  }
  if (application.buildServerId) {
    throw new Error(
      `Cannot deploy: this Service runs in a Cloud account and builds on the platform host only, so no cloud credential reaches a Server. Clear its build Server, then deploy again.`,
    );
  }
}

/**
 * The shell step that copies a static site's `publish` folder out of the
 * checkout into its Deployment's own upload folder on the platform host
 * so the next Deployment's checkout cannot change the files while
 * this one's Cloud run uploads them. A `publish` that is not in the
 * checkout fails the Deployment, naming it. `.git` and `.env` are never
 * uploaded, as the `.dockerignore` a Server's nginx image is built with.
 *
 * **The folder's real path must be inside the checkout's.** The
 * copy runs on the platform host and lands in the customer's bucket, so a
 * `publish` committed as a link to `/`, or a link anywhere on the build path,
 * copied the host's own files: other tenants' checkouts, `/etc`. `pwd -P`
 * resolves every link on the way, and the copy reads the resolved folder, so
 * what was checked is what is copied. A link to a folder inside the checkout
 * still works. The save refuses a `..` in the build path and `publish`; this
 * is the check a committed link and an earlier row cannot get past.
 */
export function stageStaticFilesCommand(input: {
  /** The checkout's root, which the folder must resolve inside. */
  readonly checkout: string;
  readonly from: string;
  readonly to: string;
  readonly publish: string;
  /** Where the site is served, as the line names it: {@link STATIC_SERVED}'s place. */
  readonly place: string;
}): string {
  const from = quote([input.from]);
  const to = quote([input.to]);
  const taking = `📁 [Files] Taking the publish folder '${input.publish}' from the checkout; nothing is built for ${input.place}`;
  const checkout = quote([input.checkout]);
  const missing = `❌ [Files] The publish folder '${input.publish}' is not in the checkout, so there is nothing to upload`;
  const outside = `❌ [Files] The publish folder '${input.publish}' leads outside the checkout, through a link or the build path, so nothing is uploaded. Point publish and the build path at a folder inside the repository`;
  return [
    `echo ${quote([taking])} ;`,
    `if [ ! -d ${from} ]; then echo ${quote([missing])} ; exit 1; fi ;`,
    `CG_PUBLISH_REAL=$(cd ${from} && pwd -P) || exit 1 ;`,
    `CG_CHECKOUT_REAL=$(cd ${checkout} && pwd -P) || exit 1 ;`,
    `case "$CG_PUBLISH_REAL/" in "$CG_CHECKOUT_REAL"/*) ;; *) echo ${quote([outside])} ; exit 1 ;; esac ;`,
    `rm -rf ${to} ;`,
    `mkdir -p ${to} ;`,
    `cp -a "$CG_PUBLISH_REAL"/. ${to}/ ;`,
    `rm -rf ${to}/.git ${to}/.env ;`,
  ].join('\n');
}

/**
 * The platform a Service on Cloud Run's image is pulled and checked for:
 * Cloud Run runs `linux/amd64` only, and Cloudgate never
 * builds or pulls for another CPU by emulation.
 */
export const CLOUD_RUN_PLATFORM = 'linux/amd64';

/** Which cloud a cloud Service's Cloud account is, or `null` if it is gone. */
export async function cloudOf(
  db: DrizzleDB,
  cloudAccountId: string,
): Promise<CloudKind | null> {
  const [found] = await db
    .select({ cloud: cloudAccount.cloud })
    .from(cloudAccount)
    .where(eq(cloudAccount.cloudAccountId, cloudAccountId));
  return found?.cloud ?? null;
}

/** What a git build for Cloud Run on an ARM platform host stops with. */
export const ARM_HOST_BUILD_LINE =
  "❌ [Build] Cloud Run runs x86 (amd64) images only, and Cloudgate's own host is not x86, so this Service cannot be built here: Cloudgate never builds for another CPU. Build an x86 image elsewhere and deploy it as a ready-made image (source: { image: … }).";

/**
 * The shell step a git build for Cloud Run runs first: on a
 * host that is not x86 it stops, before anything is built or pushed.
 */
export function x86HostOnlyCommand(): string {
  return `if [ "$(uname -m)" != x86_64 ]; then echo ${quote([ARM_HOST_BUILD_LINE])} ; exit 1; fi ;`;
}

/** The log's first line on a cloud Service: where it builds and runs. */
export async function cloudHostsLogLine(
  db: DrizzleDB,
  application: Pick<
    DeployableApplication,
    'cloudAccountId' | 'region' | 'configKind'
  >,
): Promise<string> {
  let name = application.cloudAccountId ?? '';
  let cloud: CloudKind | null = null;
  try {
    const [found] = await db
      .select({ name: cloudAccount.name, cloud: cloudAccount.cloud })
      .from(cloudAccount)
      .where(eq(cloudAccount.cloudAccountId, name));
    if (found) {
      name = found.name;
      cloud = found.cloud;
    }
  } catch {
    // The id names it well enough for a log line.
  }
  if (runsAsCloudStatic(application)) {
    const where = cloud ? byCloud(cloud, STATIC_SERVED).place : 'its cloud';
    return `🔧 [Build] Checking out on Cloudgate's own host; the site is served from ${where} in Cloud account ${name} (${application.region}).`;
  }
  return `🔧 [Build] Building on Cloudgate's own host; the service runs in Cloud account ${name} (${application.region}).`;
}

/** The Push phase's one line in the build: the push is the Cloud run's. */
export const CLOUD_PUSH_LINE =
  "📦 [Push] The image goes to the Service's own repository in its Cloud account, in its Cloud run, next.";

/** The build's last line, before the row waits in the Cloud run pool. */
export const CLOUD_BUILT_LINE =
  "☁️ [Cloud run] Built. Waiting for the Cloud run, which pushes the image to the Service's own repository and applies it";

/**
 * Where a cloud `static` site is served, what holds its files and how its
 * Cloud run makes them live, by its cloud (ADR-0043): S3 + CloudFront's
 * origin switch on AWS, a copy into the fixed `live/` folder behind
 * Cloud CDN on Google Cloud.
 */
export const STATIC_SERVED: PerCloud<{
  readonly place: string;
  readonly storage: string;
  readonly goesLive: string;
}> = {
  aws: {
    place: 'S3 + CloudFront',
    storage: 'S3',
    goesLive: 'switches CloudFront to them',
  },
  gcp: {
    place: 'Cloud Storage + Cloud CDN',
    storage: 'Cloud Storage',
    goesLive: "copies them into the site's live folder",
  },
};

/** A static site's Push phase line: no image, its files go to its own bucket. */
export function cloudStaticUploadLine(cloud: CloudKind): string {
  return `📦 [Push] No image: the files go to the site's own ${byCloud(cloud, STATIC_SERVED).storage} bucket in its Cloud run, next.`;
}

/** A static site's checkout's last line, before the row waits in the pool. */
export function cloudStaticStagedLine(cloud: CloudKind): string {
  const served = byCloud(cloud, STATIC_SERVED);
  return `☁️ [Cloud run] Checked out. Waiting for the Cloud run, which uploads the files to ${served.storage} and ${served.goesLive}`;
}
