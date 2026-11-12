import { api } from "../client";

/** What every Cloud account carries, whichever cloud it is at. */
interface CloudAccountBase {
  cloudAccountId: string;
  organizationId: string;
  name: string;
  /** The cloud's own id for the account: an AWS account id, a Google Cloud project id. Never changes. */
  cloudId: string;
  /** The policy (or role) version the last passing check held the account to. */
  policyVersion: number;
  lastCheckedAt: string;
  lastCheckResult: "passed" | "failed";
  /** Why the last check, or the last use, failed; null after a pass. */
  lastCheckReason: string | null;
  createdAt: string;
  /** The policy version this Cloudgate checks against. */
  currentPolicyVersion: number;
  /** The role was last held to an older version than this Cloudgate needs. */
  permissionsOutOfDate: boolean;
  /** What the current version adds over `policyVersion`; empty when up to date. */
  missingActions: string[];
}

/**
 * Cloud accounts: an Organization's link to an AWS account, connected
 * through a setup template and a connect check that must pass before anything
 * is saved.
 *
 * **The secret access key never comes back**, only `hasSecretAccessKey`
 * (ADR-0019). The external id does: it is not a secret, and an operator
 * rebuilding the role's trust policy needs it.
 */
export interface AwsCloudAccount extends CloudAccountBase {
  cloud: "aws";
  accessKeyId: string;
  hasSecretAccessKey: boolean;
  deployRoleArn: string;
  taskExecutionRoleArn: string;
  externalId: string;
}

/**
 * A Google Cloud project as a Cloud account (slice 6). Cloudgate signs its
 * own short-lived proof with a key pair of the Cloud account's own: the
 * public half is shown, since the operator uploads it to Google, and the
 * private halves never come back, only whether one is on file (ADR-0019).
 */
export interface GcpCloudAccount extends CloudAccountBase {
  cloud: "gcp";
  /** The project's number, read at connect. Never changes. */
  projectNumber: string;
  /** The OIDC provider's full resource name. */
  workloadIdentityProvider: string;
  /** The email of the deploy service account Cloudgate steps into. */
  deployServiceAccount: string;
  signingKeyId: string;
  signingPublicKey: string;
  hasSigningKey: boolean;
  /** A key change is waiting for a check to pass with its new key. */
  hasPendingSigningKey: boolean;
  /** The issuer every token names, fixed when the setup script was handed out. */
  tokenIssuer: string;
}

/** A Cloud account, by its cloud. */
export type CloudAccount = AwsCloudAccount | GcpCloudAccount;

/** A Cloud account's cloud. */
export type Cloud = CloudAccount["cloud"];

/** Each cloud's name, as the console writes it. */
export const CLOUD_NAMES: Record<Cloud, string> = {
  aws: "AWS",
  gcp: "Google Cloud",
};

/** A cloud's name; no cloud is an older API's answer, which meant AWS. */
export function cloudName(cloud: Cloud | undefined): string {
  return CLOUD_NAMES[cloud ?? "aws"];
}

/** What `GET /cloud-accounts/:id/template` answers. */
export interface CloudAccountTemplate {
  policyVersion: number;
  /** A CloudFormation template, as JSON text. */
  cloudFormation: string;
  /** The same documents, to paste by hand. */
  json: unknown;
}

/**
 * An edit: every field optional, one left out keeps its stored value.
 * The AWS account id and the external id never change, so they are not here.
 */
export interface UpdateCloudAccountInput {
  name?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  deployRoleArn?: string;
  taskExecutionRoleArn?: string;
}

/**
 * A Google Cloud account's edit, by the same rules. The
 * project, its number, the key and the issuer never change here.
 */
export interface UpdateGoogleCloudAccountInput {
  cloud: "gcp";
  name?: string;
  workloadIdentityProvider?: string;
  deployServiceAccount?: string;
}

/** What "New key" answers: the new key's public half and the setup trusting both keys. */
export interface GoogleNewKey {
  signingKeyId: string;
  signingPublicKey: string;
  template: GoogleSetupTemplate;
}

/** What the new key's check answers once it passed and signs. */
export interface GoogleKeyChanged {
  cloudAccount: GcpCloudAccount;
  /** The JWKS holding the new key only, as JSON text. */
  jwks: string;
  /** The reminder to upload it. */
  message: string;
}

/** What a Delete answers: the sentence naming what stays in the cloud. */
export interface CloudAccountRemoved {
  cloudAccountId: string;
  name: string;
  message: string;
}

/** What `POST /cloud-accounts/setup` answers: the template and the ids it carries. */
export interface CloudAccountSetup {
  /** Sent back on connect, so the account is saved under the template's ids. */
  setupToken: string;
  cloudAccountId: string;
  externalId: string;
  template: CloudAccountTemplate;
}

export interface ConnectCloudAccountInput {
  setupToken: string;
  name: string;
  cloudId: string;
  accessKeyId: string;
  secretAccessKey: string;
  deployRoleArn: string;
  taskExecutionRoleArn: string;
}

/**
 * The setup of a Google Cloud project (slice 6): one `gcloud` script for
 * Cloud Shell, with the JWKS and the role definition beside it as files, and
 * the names of what the script makes.
 */
export interface GoogleSetupTemplate {
  /** The role version the script makes. */
  policyVersion: number;
  script: string;
  /** The JWKS to upload to the provider, as JSON text. */
  jwks: string;
  /** The custom role, as `gcloud iam roles create --file` reads it. */
  roleDefinition: string;
  names: {
    pool: string;
    provider: string;
    role: string;
    serviceAccount: string;
    serviceAccountEmail: string;
  };
}

/**
 * What `POST /cloud-accounts/setup` answers for a Google Cloud project. The
 * token carries the key pair the script's JWKS holds, sealed; only the public
 * half is ever shown.
 */
export interface GoogleCloudAccountSetup {
  cloud: "gcp";
  setupToken: string;
  cloudAccountId: string;
  signingKeyId: string;
  signingPublicKey: string;
  template: GoogleSetupTemplate;
}

export interface ConnectGoogleCloudAccountInput {
  cloud: "gcp";
  setupToken: string;
  name: string;
  /** The project id. */
  cloudId: string;
  /** `projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>`, as the script prints it. */
  workloadIdentityProvider: string;
  deployServiceAccount: string;
}

export const cloudAccountsApi = {
  list: () => api.get<CloudAccount[]>("/cloud-accounts"),

  /** Calls nothing in AWS and keeps nothing. Pass a previous token to keep its external id. */
  setup: (body: { cloudId: string; setupToken?: string }) =>
    api.post<CloudAccountSetup>("/cloud-accounts/setup", body),

  /** Calls nothing in Google and keeps nothing. Pass a previous token to keep its key pair. */
  setupGoogle: (body: { cloudId: string; setupToken?: string }) =>
    api.post<GoogleCloudAccountSetup>("/cloud-accounts/setup", {
      cloud: "gcp",
      ...body,
    }),

  /** Runs the connect check; a refusal is a `400` naming what to fix. */
  create: (body: ConnectCloudAccountInput | ConnectGoogleCloudAccountInput) =>
    api.post<CloudAccount>("/cloud-accounts", body),

  /**
   * A change to the key or a role ARN reruns the connect check and saves
   * nothing unless it passes; a refusal is a `400` naming what to fix.
   */
  update: (
    id: string,
    body: UpdateCloudAccountInput | UpdateGoogleCloudAccountInput,
  ) => api.patch<CloudAccount>(`/cloud-accounts/${id}`, body),

  /** "Check now": a failed check is recorded and answered, not thrown. */
  check: (id: string) => api.post<CloudAccount>(`/cloud-accounts/${id}/check`),

  /** The setup template at the current policy version, with the account's own ids. */
  template: (id: string) =>
    api.get<CloudAccountTemplate>(`/cloud-accounts/${id}/template`),

  /**
   * A Google Cloud account's setup script at the current role version, with
   * its own issuer and every key the provider should trust.
   */
  googleTemplate: (id: string) =>
    api.get<GoogleSetupTemplate>(`/cloud-accounts/${id}/template`),

  /** "New key": a pending key pair, and the setup with both public halves. Nothing signs with it yet. */
  newKey: (id: string) => api.post<GoogleNewKey>(`/cloud-accounts/${id}/key`),

  /** The check signed with the pending key: a pass switches to it; a refusal is a `400` that changes nothing. */
  checkNewKey: (id: string) =>
    api.post<GoogleKeyChanged>(`/cloud-accounts/${id}/key/check`),

  /** Removes Cloudgate's row only; nothing in the cloud is touched. */
  remove: (id: string) =>
    api.delete<CloudAccountRemoved>(`/cloud-accounts/${id}`),
};
