import { createHash } from 'node:crypto';

/**
 * The names of what a hosted cloud build on AWS uses (ADR-0047), in
 * one place, because two writers must agree on them without sharing a row:
 * the setup template, which makes the **build identity** once per Cloud
 * account and scopes it to these names, and the Environment network's
 * definition, which makes the **standing pieces** (the CodeBuild project,
 * the source bucket and the build log group) in each Environment of the
 * Hosted instance. A cloud build reads them here too. Pure.
 *
 * - **The build identity** is `cloudgate-build-<tag value>`, at IAM's root
 *   path: never under `/cloudgate/`, where the deploy role's task-role
 *   statements could change it, and never tagged with the Cloud account's
 *   tag, so nothing Cloudgate's role may touch reaches it.
 * - **The source bucket** is in S3's account regional namespace
 *   (`-<account-id>-<region>-an`, like every bucket Cloudgate makes),
 *   named `cgsrc-<Cloud account>-<Environment>-…`, each part a short hash:
 *   ids are mixed-case and a bucket name is not, and the Cloud account's part
 *   is what lets the build identity's policy read its own Cloud account's
 *   sources and no other's in the same AWS account.
 * - **The log group** is `/cloudgate/build/<tag value>/<Environment id>`,
 *   which log group names allow as they are.
 * - **The CodeBuild project** is `cloudgate-build-<Environment id>`, held
 *   to its Cloud account by the tag every network resource carries.
 * - **A private registry's password**, for the build that copies a
 *   ready-made image, is the SecureString parameter
 *   `/cloudgate/build/<tag value>/<Deployment id>/registry-password`, made
 *   by the deploy role before the build and deleted after it: under the
 *   deploy role's `parameter/cloudgate/*`, and the only parameters the build
 *   identity may read are its own Cloud account's under `/cloudgate/build/`.
 */

/** What a build identity's names are made of: the AWS account and the Cloud account's tag value. */
export interface BuildIdentityIds {
  accountId: string;
  tagValue: string;
}

/** And one Environment network's standing pieces, in its region. */
export interface BuildPieceIds extends BuildIdentityIds {
  environmentId: string;
  region: string;
}

/** The service a build identity is trusted by and passed to. */
export const CODEBUILD_SERVICE = 'codebuild.amazonaws.com';

/** How long a build log group keeps its lines. */
export const BUILD_LOG_RETENTION_DAYS = 30;

const SOURCE_BUCKET_START = 'cgsrc';

/** A short lowercase stand-in for an id in a bucket name. */
function short(id: string): string {
  return createHash('sha256').update(id).digest('hex').slice(0, 10);
}

/** Where every build parameter of one Cloud account is. */
const parameterStartOf = (tagValue: string) => `/cloudgate/build/${tagValue}/`;

/** The build identity one Cloud account's setup makes. */
export function buildIdentityNames({ accountId, tagValue }: BuildIdentityIds) {
  const roleName = `cloudgate-build-${tagValue}`;
  const sourceBucketStart = `${SOURCE_BUCKET_START}-${short(tagValue)}-`;
  const logGroupStart = `/cloudgate/build/${tagValue}/`;
  const parameterStart = parameterStartOf(tagValue);
  return {
    roleName,
    roleArn: `arn:aws:iam::${accountId}:role/${roleName}`,
    /** Every source bucket of this Cloud account, in any region. */
    sourceBucketPattern: `arn:aws:s3:::${sourceBucketStart}*-${accountId}-*-an`,
    /** Every build log group of this Cloud account, and their streams. */
    logGroupPatterns: [
      `arn:aws:logs:*:${accountId}:log-group:${logGroupStart}*`,
      `arn:aws:logs:*:${accountId}:log-group:${logGroupStart}*:log-stream:*`,
    ],
    /** Every repository in the AWS account; the policy holds it to the tag. */
    repositoryPattern: `arn:aws:ecr:*:${accountId}:repository/*`,
    /** Every CodeBuild project in the AWS account; the policy holds it to the tag. */
    projectPattern: `arn:aws:codebuild:*:${accountId}:project/*`,
    /** Every build parameter of this Cloud account, in any region. */
    parameterPattern: `arn:aws:ssm:*:${accountId}:parameter${parameterStart}*`,
    sourceBucketStart,
    logGroupStart,
    parameterStart,
  };
}

/**
 * The SecureString parameter one Deployment's copy build reads a private
 * registry's password from: named by the Deployment, so no two
 * builds share one and none is ever overwritten.
 */
export function registryPasswordParameterName(input: {
  readonly tagValue: string;
  readonly deploymentId: string;
}): string {
  return `${parameterStartOf(input.tagValue)}${input.deploymentId}/registry-password`;
}

/** One Environment network's standing pieces for hosted cloud builds. */
export function buildPieceNames(ids: BuildPieceIds) {
  const identity = buildIdentityNames(ids);
  const projectName = `cloudgate-build-${ids.environmentId}`;
  return {
    projectName,
    projectArn: `arn:aws:codebuild:${ids.region}:${ids.accountId}:project/${projectName}`,
    sourceBucketName: `${identity.sourceBucketStart}${short(ids.environmentId)}-${ids.accountId}-${ids.region}-an`,
    logGroupName: `${identity.logGroupStart}${ids.environmentId}`,
    buildRoleArn: identity.roleArn,
  };
}
