import { BUILD_LOG_WRITER_ROLE, buildIdentityNames } from './cloud-build-names';
import { idKey } from './definitions/names';
import { makesBuildIdentity } from './deploy-role';
import type { GoogleRole } from './deploy-role';
import { jwksOf, tokenSubject } from './id-token';
import type { PublicJwk } from './id-token';

/**
 * The setup a Google Cloud account is connected with (the Google Cloud spec, "Setup
 * script"): one `gcloud` script for Cloud Shell, filled in
 * with the Cloud account's public key, its pool and provider names and the
 * role, plus the JWKS and the role definition as files for an operator who
 * would rather run each step by hand. **Cloudgate never runs it.**
 *
 * What it makes, each named for this Cloud account so two Organizations can
 * connect one project without meeting:
 * - the APIs the role's version needs, turned on first, since the pool needs
 *   IAM's and STS's (Cloudgate never turns on an API itself);
 * - a workload identity pool, and an OIDC provider in it trusting the
 *   uploaded JWKS — so no public issuer is needed — with
 *   `google.subject=assertion.sub` and a condition holding every token to
 *   this Cloud account's subject (S16);
 * - the custom role at its version, created or, on a newer version, updated;
 * - the deploy service account, granted the role on the project, and the
 *   federated principal granted only `roles/iam.workloadIdentityUser` on that
 *   one service account;
 * - in the Hosted instance's versions, 6 and 8 (ADR-0047), the **build identity** a hosted
 *   cloud build runs as: its own service account, a custom role of exactly
 *   {@link BUILD_ROLE_PERMISSIONS} held on the project under the condition
 *   `cloud-build-names.ts` scopes it with, and `roles/logging.logWriter`,
 *   which only this script can grant. Never the deploy service account: the
 *   customer's own build steps run with its credentials.
 */

/**
 * The build identity's permissions (ADR-0047), exactly: read its
 * source zip, and push an image to a repository (upload its layers, read
 * back the ones it already holds, and set its tag). Logs are
 * {@link BUILD_LOG_WRITER_ROLE}'s. The role binding's condition holds its
 * Cloud Storage reads to this Cloud account's source buckets; its pushes
 * reach the project's repositories, which a condition cannot name.
 */
export const BUILD_ROLE_PERMISSIONS: readonly string[] = [
  'storage.objects.get',
  'artifactregistry.repositories.uploadArtifacts',
  'artifactregistry.repositories.downloadArtifacts',
  'artifactregistry.tags.create',
  'artifactregistry.tags.update',
];

/**
 * The build identity's custom role, as `gcloud iam roles create --file` reads
 * it. Its values are plain YAML scalars, so none may hold `: ` or start with a
 * YAML indicator: gcloud refuses the file otherwise.
 */
export function buildRoleDefinition(): string {
  return [
    'title: Cloudgate build',
    'description: Cloudgate build identity, reads its source and pushes to its repositories',
    'stage: GA',
    'includedPermissions:',
    ...BUILD_ROLE_PERMISSIONS.map((permission) => `  - ${permission}`),
    '',
  ].join('\n');
}

/** What each thing the script makes is called. */
export interface GoogleSetupNames {
  pool: string;
  provider: string;
  /** The custom role's id in the project. */
  role: string;
  /** The deploy service account's id, before `@`. */
  serviceAccount: string;
  /** Its email in the project. */
  serviceAccountEmail: string;
  /**
   * The build identity, from version 6 on: its service account, its
   * email and its custom role's id.
   */
  build?: {
    serviceAccount: string;
    serviceAccountEmail: string;
    role: string;
  };
}

/** What `POST /cloud-accounts/setup` and the template route hand out for a Google one. */
export interface GoogleSetupTemplate {
  /** The role version the script makes. */
  policyVersion: number;
  /** The `gcloud` script, for Cloud Shell. */
  script: string;
  /** The JWKS to upload to the provider, as JSON text. */
  jwks: string;
  /** The role, as `gcloud iam roles create --file` reads it. */
  roleDefinition: string;
  /** The build identity's role, from version 6 on. */
  buildRoleDefinition?: string;
  names: GoogleSetupNames;
}

export interface GoogleSetupInput {
  projectId: string;
  cloudAccountId: string;
  /** The issuer every token names (S16). */
  issuer: string;
  /** Every public half the provider should trust. */
  publicKeys: readonly PublicJwk[];
}

/**
 * The names of a Cloud account's setup, from its id's key (S4): a pool and a
 * provider id are 4–32 characters, a service account's 6–30, a role's
 * letters, digits, `_` and `.`.
 */
export function googleSetupNames(
  projectId: string,
  cloudAccountId: string,
): GoogleSetupNames {
  const key = idKey(cloudAccountId);
  const serviceAccount = `cloudgate-deploy-${key}`;
  return {
    pool: `cloudgate-${key}`,
    provider: `cloudgate-${key}`,
    role: `cloudgate_deploy_${key}`,
    serviceAccount,
    serviceAccountEmail: `${serviceAccount}@${projectId}.iam.gserviceaccount.com`,
  };
}

/** The setup of one Google Cloud account at the role's current version. */
export function googleSetupTemplate(
  input: GoogleSetupInput,
  role: Pick<GoogleRole, 'version' | 'requiredApis' | 'roleDefinition'>,
): GoogleSetupTemplate {
  const withBuild = makesBuildIdentity(role.version);
  const names: GoogleSetupNames = {
    ...googleSetupNames(input.projectId, input.cloudAccountId),
    ...(withBuild ? { build: buildNames(input) } : {}),
  };
  const jwks = `${JSON.stringify(jwksOf(input.publicKeys), null, 2)}\n`;
  const roleDefinition = role.roleDefinition(role.version);
  const subject = tokenSubject(input.cloudAccountId);
  const script = [
    '#!/usr/bin/env bash',
    `# Cloudgate setup for Cloud account ${input.cloudAccountId}, role version ${role.version}.`,
    '# Run it in Cloud Shell in the project Cloudgate deploys to. Use a project',
    "# of Cloudgate's own: Cloudgate can act as any service account in it.",
    'set -euo pipefail',
    '',
    `PROJECT_ID='${input.projectId}'`,
    `POOL='${names.pool}'`,
    `PROVIDER='${names.provider}'`,
    `ROLE='${names.role}'`,
    `SERVICE_ACCOUNT='${names.serviceAccount}'`,
    `ISSUER='${input.issuer}'`,
    `SUBJECT='${subject}'`,
    '',
    'gcloud config set project "$PROJECT_ID"',
    '',
    '# 1. The APIs Cloudgate uses. Cloudgate never turns on an API itself.',
    '# First, since reading the project number below needs Cloud Resource Manager.',
    `gcloud services enable ${role.requiredApis(role.version).join(' ')}`,
    '',
    'PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format=\'value(projectNumber)\')"',
    'SERVICE_ACCOUNT_EMAIL="${SERVICE_ACCOUNT}@${PROJECT_ID}.iam.gserviceaccount.com"',
    'PROVIDER_NAME="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/providers/${PROVIDER}"',
    '',
    "# 2. Cloudgate's public key, which the provider trusts instead of fetching an issuer.",
    "cat > cloudgate-jwks.json <<'JWKS'",
    jwks.trimEnd(),
    'JWKS',
    '',
    '# 3. The workload identity pool and its OIDC provider.',
    'gcloud iam workload-identity-pools describe "$POOL" --location=global >/dev/null 2>&1 \\',
    '  || gcloud iam workload-identity-pools create "$POOL" --location=global \\',
    '    --display-name="Cloudgate"',
    'PROVIDER_FLAGS=(',
    '  --location=global',
    '  --workload-identity-pool="$POOL"',
    '  --issuer-uri="$ISSUER"',
    '  --allowed-audiences="//iam.googleapis.com/${PROVIDER_NAME}"',
    '  --attribute-mapping="google.subject=assertion.sub"',
    '  --attribute-condition="assertion.sub == \'${SUBJECT}\'"',
    '  --jwk-json-path=cloudgate-jwks.json',
    ')',
    'if gcloud iam workload-identity-pools providers describe "$PROVIDER" --location=global --workload-identity-pool="$POOL" >/dev/null 2>&1; then',
    '  gcloud iam workload-identity-pools providers update-oidc "$PROVIDER" "${PROVIDER_FLAGS[@]}"',
    'else',
    '  gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" "${PROVIDER_FLAGS[@]}"',
    'fi',
    '',
    `# 4. The custom role, version ${role.version}.`,
    "cat > cloudgate-role.yaml <<'ROLE'",
    roleDefinition.trimEnd(),
    'ROLE',
    'if gcloud iam roles describe "$ROLE" --project="$PROJECT_ID" >/dev/null 2>&1; then',
    '  gcloud iam roles update "$ROLE" --project="$PROJECT_ID" --file=cloudgate-role.yaml --quiet',
    'else',
    '  gcloud iam roles create "$ROLE" --project="$PROJECT_ID" --file=cloudgate-role.yaml',
    'fi',
    '',
    '# 5. The deploy service account, holding the role on the project.',
    'gcloud iam service-accounts describe "$SERVICE_ACCOUNT_EMAIL" >/dev/null 2>&1 \\',
    '  || gcloud iam service-accounts create "$SERVICE_ACCOUNT" --display-name="Cloudgate deploy"',
    'gcloud projects add-iam-policy-binding "$PROJECT_ID" \\',
    '  --member="serviceAccount:${SERVICE_ACCOUNT_EMAIL}" \\',
    '  --role="projects/${PROJECT_ID}/roles/${ROLE}" --condition=None',
    '',
    '# 6. Cloudgate may step into that one service account, and nothing else.',
    'gcloud iam service-accounts add-iam-policy-binding "$SERVICE_ACCOUNT_EMAIL" \\',
    '  --role=roles/iam.workloadIdentityUser \\',
    '  --member="principal://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/subject/${SUBJECT}"',
    '',
    ...(withBuild ? buildIdentitySteps(input) : []),
    'echo',
    'echo "Enter these in Cloudgate:"',
    'echo "  Workload identity provider: ${PROVIDER_NAME}"',
    'echo "  Deploy service account:     ${SERVICE_ACCOUNT_EMAIL}"',
    '',
  ].join('\n');
  return {
    policyVersion: role.version,
    script,
    jwks,
    roleDefinition,
    ...(withBuild ? { buildRoleDefinition: buildRoleDefinition() } : {}),
    names,
  };
}

function buildNames(input: GoogleSetupInput) {
  const build = buildIdentityNames(input);
  return {
    serviceAccount: build.serviceAccount,
    serviceAccountEmail: build.serviceAccountEmail,
    role: build.role,
  };
}

/**
 * Step 7, from version 6 on: the build identity, its role on the
 * project under its condition, and its log writing.
 */
function buildIdentitySteps(input: GoogleSetupInput): string[] {
  const build = buildIdentityNames(input);
  return [
    '# 7. The build identity a hosted cloud build runs as. Never the deploy service account:',
    '# your build steps run with its credentials. It reads only its own source buckets,',
    "# pushes to this project's image repositories, and writes its build logs.",
    `BUILD_SERVICE_ACCOUNT='${build.serviceAccount}'`,
    `BUILD_ROLE='${build.role}'`,
    'BUILD_SERVICE_ACCOUNT_EMAIL="${BUILD_SERVICE_ACCOUNT}@${PROJECT_ID}.iam.gserviceaccount.com"',
    'gcloud iam service-accounts describe "$BUILD_SERVICE_ACCOUNT_EMAIL" >/dev/null 2>&1 \\',
    '  || gcloud iam service-accounts create "$BUILD_SERVICE_ACCOUNT" --display-name="Cloudgate build"',
    "cat > cloudgate-build-role.yaml <<'ROLE'",
    buildRoleDefinition().trimEnd(),
    'ROLE',
    'if gcloud iam roles describe "$BUILD_ROLE" --project="$PROJECT_ID" >/dev/null 2>&1; then',
    '  gcloud iam roles update "$BUILD_ROLE" --project="$PROJECT_ID" --file=cloudgate-build-role.yaml --quiet',
    'else',
    '  gcloud iam roles create "$BUILD_ROLE" --project="$PROJECT_ID" --file=cloudgate-build-role.yaml',
    'fi',
    "cat > cloudgate-build-condition.yaml <<'CONDITION'",
    `title: ${build.condition.title}`,
    // A YAML single-quoted scalar: a `'` in it is written twice.
    `expression: '${build.condition.expression.replaceAll("'", "''")}'`,
    'CONDITION',
    'gcloud projects add-iam-policy-binding "$PROJECT_ID" \\',
    '  --member="serviceAccount:${BUILD_SERVICE_ACCOUNT_EMAIL}" \\',
    '  --role="projects/${PROJECT_ID}/roles/${BUILD_ROLE}" \\',
    '  --condition-from-file=cloudgate-build-condition.yaml',
    'gcloud projects add-iam-policy-binding "$PROJECT_ID" \\',
    '  --member="serviceAccount:${BUILD_SERVICE_ACCOUNT_EMAIL}" \\',
    `  --role=${BUILD_LOG_WRITER_ROLE} --condition=None`,
    '',
  ];
}
