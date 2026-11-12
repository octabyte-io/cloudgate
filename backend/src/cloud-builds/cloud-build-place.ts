import { quote } from 'shell-quote';

import {
  BUILD_IDENTITY_FROM as AWS_BUILD_IDENTITY_FROM,
  makesBuildIdentity as awsMakesBuildIdentity,
} from '../cloud-accounts/aws/setup-template';
import type { CloudKind } from '../cloud-accounts/cloud-account.schema';
import {
  BUILD_IDENTITY_FROM as GOOGLE_BUILD_IDENTITY_FROM,
  makesBuildIdentity as googleMakesBuildIdentity,
} from '../cloud-accounts/gcp/deploy-role';
import { byCloud, CLOUD_NAMES } from '../cloud-accounts/cloud-provider';
import type { PerCloud } from '../cloud-accounts/cloud-provider';
import type { DeployableApplication } from '../deployment-engine/deployment-engine.types';

/**
 * **Where a cloud Service's image is built** (ADR-0047): the one question
 * the build slot (`DeploymentEngineService`) and the Cloud run
 * (`CloudServiceDeploys`) must answer alike, since the first checks the
 * source out for the second to build. Read per instance, through the
 * instance-mode module, and never per Service.
 *
 * - **Self-hosted**: on the platform host, in the build slot, as before.
 * - **Hosted**: in the cloud's own build service in the customer's account,
 *   in the Deployment's Cloud run (CodeBuild, Cloud Build): the build slot only
 *   checks the source out and copies it aside. A ready-made image is copied there by a
 *   short build of its own, so the build slot pulls nothing. A
 *   `static` site builds nothing, so it is never a cloud build.
 */

/**
 * Each cloud's first permissions version whose setup makes the build
 * identity a hosted cloud build runs as: AWS's policy version 3,
 * Google's role version 6.
 */
export const BUILD_IDENTITY_VERSION: PerCloud<number> = {
  aws: AWS_BUILD_IDENTITY_FROM,
  gcp: GOOGLE_BUILD_IDENTITY_FROM,
};

/**
 * Whether a permissions version's setup made the build identity: only the
 * Hosted instance's versions do (AWS 3 and 5, Google 6 and 8), so a newer
 * Self-hosted version (AWS 4, Google 7) does not, and a `>=` on the number
 * would be wrong.
 */
export const MAKES_BUILD_IDENTITY: PerCloud<(version: number) => boolean> = {
  aws: awsMakesBuildIdentity,
  gcp: googleMakesBuildIdentity,
};

/** Each cloud's build service, as a Deployment log names it. */
export const CLOUD_BUILD_SERVICE: PerCloud<string> = {
  aws: 'CodeBuild',
  gcp: 'Cloud Build',
};

type BuildPlaceApplication = Pick<
  DeployableApplication,
  'cloudAccountId' | 'configKind' | 'sourceType'
>;

/**
 * Whether this Deployment's image is made in its cloud's build service:
 * CodeBuild on AWS, Cloud Build on Google Cloud, every
 * cloud alike. Built from the checkout, or, for a ready-made image,
 * copied ({@link copiesInItsCloud}).
 */
export function buildsInItsCloud(
  hosted: boolean,
  application: BuildPlaceApplication,
): boolean {
  return (
    hosted &&
    Boolean(application.cloudAccountId) &&
    application.configKind !== 'static'
  );
}

/**
 * Whether that cloud build copies a ready-made image rather than building
 * one: pulled in the build, never on the platform host, and pushed
 * to the Service's own repository.
 */
export function copiesInItsCloud(
  hosted: boolean,
  application: BuildPlaceApplication,
): boolean {
  return (
    buildsInItsCloud(hosted, application) && application.sourceType === 'docker'
  );
}

/** The log's first line when the image is built (or copied) in the cloud. */
export function cloudBuildHostsLine(input: {
  readonly cloud: CloudKind;
  readonly accountName: string;
  readonly region: string | null;
  /** A ready-made image, copied rather than built. */
  readonly copies?: boolean;
}): string {
  const service = byCloud(input.cloud, CLOUD_BUILD_SERVICE);
  const runs = `the service runs in Cloud account ${input.accountName} (${input.region})`;
  return input.copies
    ? `🔧 [Build] Nothing is pulled on Cloudgate's own host; the ready-made image is copied in ${service} and ${runs}.`
    : `🔧 [Build] Checking out on Cloudgate's own host; the image is built in ${service} and ${runs}.`;
}

/** The Build phase's line in the build slot: the build is the Cloud run's. */
export function cloudBuildNextLine(cloud: CloudKind, copies = false): string {
  const service = byCloud(cloud, CLOUD_BUILD_SERVICE);
  return copies
    ? `📦 [Build] The ready-made image is copied in ${service} in the Service's Cloud account, in its Cloud run, next.`
    : `📦 [Build] The image is built in ${service} in the Service's Cloud account, in its Cloud run, next.`;
}

/** The build slot's last line, before the row waits in the Cloud run pool. */
export function cloudBuildCheckedOutLine(
  cloud: CloudKind,
  copies = false,
): string {
  const service = byCloud(cloud, CLOUD_BUILD_SERVICE);
  return copies
    ? `☁️ [Cloud run] Waiting for the Cloud run, which copies the image in ${service} to the Service's own repository and applies it`
    : `☁️ [Cloud run] Checked out. Waiting for the Cloud run, which builds the image in ${service}, pushes it to the Service's own repository and applies it`;
}

/**
 * The shell step that copies the checkout aside into this Deployment's own
 * folder on the platform host, so the next Deployment's checkout cannot
 * change it while this one's Cloud run zips it. Its `.git` is dropped here
 * already: the remote's URL in it carries a git provider's token.
 */
export function stageCloudBuildSourceCommand(input: {
  readonly from: string;
  /** The Deployment's folder; the checkout goes to its `code/`. */
  readonly to: string;
  readonly cloud: CloudKind;
}): string {
  const from = quote([input.from]);
  const to = quote([input.to]);
  const code = quote([`${input.to}/code`]);
  const service = byCloud(input.cloud, CLOUD_BUILD_SERVICE);
  const taking = `📁 [Source] Taking the checkout for ${service}: it is zipped without its .git and uploaded to the ${byCloud(input.cloud, CLOUD_NAMES)} Cloud account`;
  return [
    `echo ${quote([taking])} ;`,
    `rm -rf ${to} ;`,
    `mkdir -p ${to} ;`,
    `cp -a ${from} ${code} ;`,
    `rm -rf ${code}/.git ;`,
  ].join('\n');
}

/**
 * Why a hosted cloud build is refused before anything runs, or `null`: a
 * Cloud account whose setup predates the build identity
 * ({@link BUILD_IDENTITY_VERSION}: AWS's version 3; Google's 6)
 * has no build identity and no permission to start a build.
 */
export function cloudBuildSetupRefusal(input: {
  readonly accountName: string;
  readonly policyVersion: number | null;
  /** The first version whose setup makes the build identity. */
  readonly needs: number;
  /** Whether a version's setup made it ({@link MAKES_BUILD_IDENTITY}). */
  readonly madeBy: (version: number) => boolean;
}): string | null {
  const version = input.policyVersion ?? 0;
  if (input.policyVersion !== null && input.madeBy(version)) return null;
  return `Cannot deploy: Cloud account ${input.accountName} was set up at permissions version ${version}, and a cloud build on this instance needs version ${input.needs}, whose setup makes the build identity the build runs as. Re-run the Cloud account's setup, then deploy again.`;
}
