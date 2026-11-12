import type { GoogleCloudPort, GoogleLocationsApi } from '../google-cloud.port';
import {
  CHECK_TOKEN_SECONDS,
  signIdToken,
  tokenAudience,
  tokenSubject,
} from './id-token';
import type { SigningKey } from './id-token';
import { NETWORKS_PER_PROJECT, NETWORKS_WARNING_AT } from './regions';

/** What the Google region check is given: a saved Cloud account's values and the region chosen. */
export interface GoogleRegionCheckInput {
  projectId: string;
  cloudAccountId: string;
  workloadIdentityProvider: string;
  deployServiceAccount: string;
  /** The key the Cloud account signs with now. */
  signingKey: Pick<SigningKey, 'privateKey' | 'keyId'>;
  issuer: string;
  region: string;
}

export type GoogleRegionCheckResult =
  | {
      ok: true;
      /** Sentences to show beside the saved choice; it is kept either way. */
      warnings: string[];
    }
  | {
      ok: false;
      /** One sentence naming the region and what to fix. */
      message: string;
    };

/** The APIs a `web` needs in its region, by the name the operator knows. */
const REGIONAL_APIS: readonly { api: GoogleLocationsApi; name: string }[] = [
  { api: 'run.googleapis.com', name: 'Cloud Run' },
  { api: 'artifactregistry.googleapis.com', name: 'Artifact Registry' },
];

/**
 * The Google region check (the Google Cloud spec, "Region check"),
 * run when an Environment's Deploy target is set to a Google Cloud account
 * and a region. Creates nothing:
 *
 * 1. sign in as the deploy service account, as the connect check does;
 * 2. Cloud Run and Artifact Registry must both be offered in the region,
 *    naming the region and each one that is not;
 * 3. count the project's VPC networks, warning at
 *    {@link NETWORKS_WARNING_AT} or more of Google's default
 *    {@link NETWORKS_PER_PROJECT} (S7), since the Environment network takes
 *    one.
 *
 * Permissions are project-wide, so they are not checked again here: the
 * connect check and "Check now" hold them. Pure over the port.
 */
export async function runGoogleRegionCheck(
  port: GoogleCloudPort,
  input: GoogleRegionCheckInput,
): Promise<GoogleRegionCheckResult> {
  const { region, projectId } = input;
  const federated = await port.exchangeToken({
    audience: tokenAudience(input.workloadIdentityProvider),
    subjectToken: signIdToken(input.signingKey, {
      issuer: input.issuer,
      subject: tokenSubject(input.cloudAccountId),
      workloadIdentityProvider: input.workloadIdentityProvider,
      lifetimeSeconds: CHECK_TOKEN_SECONDS,
    }),
  });
  if (!federated.ok) {
    return {
      ok: false,
      message: `Google's STS refused this Cloud account's token at ${input.workloadIdentityProvider} to check ${region}: ${said(federated.message)}. Run Check now on the Cloud account`,
    };
  }
  const impersonated = await port.impersonate(federated.value, {
    serviceAccount: input.deployServiceAccount,
    lifetimeSeconds: CHECK_TOKEN_SECONDS,
  });
  if (!impersonated.ok) {
    return {
      ok: false,
      message: `Cloudgate cannot act as the deploy service account ${input.deployServiceAccount} to check ${region}: ${said(impersonated.message)}. Run Check now on the Cloud account`,
    };
  }
  const session = impersonated.value;

  const notOffered: string[] = [];
  for (const { api, name } of REGIONAL_APIS) {
    const locations = await port.listLocations(session, projectId, api);
    if (!locations.ok) {
      return {
        ok: false,
        message: `Google refused to list where ${name} is offered to project ${projectId}, so ${region} cannot be checked: ${said(locations.message)}`,
      };
    }
    if (!locations.value.includes(region)) notOffered.push(name);
  }
  if (notOffered.length > 0) {
    return {
      ok: false,
      message: `${notOffered.join(' and ')} ${notOffered.length === 1 ? 'is' : 'are'} not offered in ${region} to project ${projectId}. Choose a region where Cloud Run and Artifact Registry are both offered`,
    };
  }

  const warnings: string[] = [];
  const networks = await port.countNetworks(session, projectId);
  if (!networks.ok) {
    warnings.push(
      `Cloudgate could not count the VPC networks in project ${projectId} (${said(networks.message)}), so it cannot say whether the project has room for the Environment network`,
    );
  } else if (networks.value >= NETWORKS_WARNING_AT) {
    warnings.push(
      `Google Cloud project ${projectId} has ${networks.value} VPC networks, and Google allows ${NETWORKS_PER_PROJECT} per project unless the quota is raised. ` +
        (networks.value >= NETWORKS_PER_PROJECT
          ? 'The Environment network will not fit: raise the quota or remove a network before the first deploy here'
          : `The Environment network takes one of the ${NETWORKS_PER_PROJECT - networks.value} left`),
    );
  }
  return { ok: true, warnings };
}

/** Google's words without their closing full stop, for a sentence that goes on. */
function said(message: string): string {
  return message.trim().replace(/\.+$/, '');
}
