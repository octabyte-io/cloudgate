import { idKey } from './definitions/names';

/**
 * The names of what a hosted cloud build on Google Cloud uses (ADR-0047), in
 * one place, because two writers must agree on them without
 * sharing a row: the setup script, which makes the **build identity** once
 * per Cloud account and scopes its grant to these names, and the
 * Environment network's definition, which makes the **standing piece** (the
 * source bucket) in each Environment of the Hosted instance. A cloud build
 * reads them here too. Pure. AWS's twin is
 * `aws/cloud-build-names.ts`.
 *
 * - **The build identity** is the service account
 *   `cloudgate-build-<Cloud account key>` (28 characters, inside Google's
 *   30), holding the custom role `cloudgate_build_<key>` on the project
 *   under one IAM condition ({@link buildIdentityNames}' `condition`), and
 *   `roles/logging.logWriter` on the project, which only the setup script
 *   can grant (ADR-0047). Cloudgate never makes or changes either.
 * - **The source bucket** is `cloudgate-build-<Cloud account key>-<Environment
 *   key>` (41 characters): Cloud Storage's names are global and lowercase,
 *   and the Cloud account's part is what lets the build identity read its
 *   own Cloud account's sources and no other's in the same project.
 * - **The repositories** a build pushes to are each Service's own,
 *   `cloudgate-<Service key>` (`definitions/names.ts`), but the condition
 *   cannot hold the build identity to them: Artifact Registry gives an IAM
 *   condition no `resource.name`, so any test of the name is false there
 *   and the push is refused (found on staging). The condition
 *   therefore scopes only Cloud Storage, the one service among the role's
 *   permissions that reads it, and the build identity may push to every
 *   repository in the project: the project is Cloudgate's own (the setup
 *   script says so), and one Service's build pushing to another's is
 *   ADR-0047's accepted consequence.
 *
 * Cloud Build itself needs nothing else standing: a build is one API call
 * naming its source, its steps and the identity it runs as.
 */

/** What a build identity's names are made of. */
export interface GoogleBuildIdentityIds {
  /** The Google Cloud project the Cloud account connects. */
  readonly projectId: string;
  readonly cloudAccountId: string;
}

/** And one Environment network's standing piece. */
export interface GoogleBuildPieceIds extends GoogleBuildIdentityIds {
  readonly environmentId: string;
}

/** The API a cloud build is started, watched and cancelled through. */
export const CLOUD_BUILD_API = 'cloudbuild.googleapis.com';

/** The project role that lets the build identity write its build's log lines. */
export const BUILD_LOG_WRITER_ROLE = 'roles/logging.logWriter';

/** How many days a source zip stays in the bucket if a build left it there. */
export const BUILD_SOURCE_MAX_AGE_DAYS = 1;

const BUILD_START = 'cloudgate-build';

/** The one service among the build role's permissions that gives an IAM condition a resource name. */
const STORAGE_SERVICE = 'storage.googleapis.com';

/** The build identity one Cloud account's setup makes, and what its grant is scoped to. */
export function buildIdentityNames({
  projectId,
  cloudAccountId,
}: GoogleBuildIdentityIds) {
  const key = idKey(cloudAccountId);
  const serviceAccount = `${BUILD_START}-${key}`;
  const sourceBucketStart = `${BUILD_START}-${key}-`;
  const sourceCondition = `resource.name.startsWith("projects/_/buckets/${sourceBucketStart}")`;
  return {
    /** The build identity's id, before `@`. */
    serviceAccount,
    serviceAccountEmail: `${serviceAccount}@${projectId}.iam.gserviceaccount.com`,
    /** Its custom role's id in the project. */
    role: `cloudgate_build_${key}`,
    /** What every source bucket of this Cloud account's name starts with. */
    sourceBucketStart,
    /**
     * The IAM condition on the build identity's role binding: in Cloud
     * Storage, its own Cloud account's source buckets and their objects
     * only; anywhere else (Artifact Registry, which gives a condition no
     * resource name to test), what the role grants in the project.
     */
    condition: {
      title: `Cloudgate builds of ${key}`,
      expression: `resource.service != "${STORAGE_SERVICE}" || ${sourceCondition}`,
    },
  };
}

/**
 * The Secret Manager secret one Deployment's copy build reads a private
 * registry's password from: named by its Cloud account and the
 * Deployment, so no two builds share one. Cloudgate makes it, grants the
 * build identity `roles/secretmanager.secretAccessor` on it alone, and
 * deletes it once the build has ended; a secret's id takes a Deployment's
 * `[A-Za-z0-9_-]` as it is.
 */
export function registryPasswordSecretId(input: {
  readonly cloudAccountId: string;
  readonly deploymentId: string;
}): string {
  return `${BUILD_START}-${idKey(input.cloudAccountId)}-${input.deploymentId}`;
}

/** One Environment network's standing piece for hosted cloud builds, and who builds there. */
export function buildPieceNames(ids: GoogleBuildPieceIds) {
  const identity = buildIdentityNames(ids);
  return {
    sourceBucketName: `${identity.sourceBucketStart}${idKey(ids.environmentId)}`,
    buildServiceAccountEmail: identity.serviceAccountEmail,
  };
}
