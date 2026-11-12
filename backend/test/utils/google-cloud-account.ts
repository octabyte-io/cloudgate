import { eq } from 'drizzle-orm';

import type { DrizzleDB } from '../../src/db/drizzle.module';
import { cloudAccount } from '../../src/db/schema';

/**
 * The Google columns of a `gcp` Cloud account row (slice 6, S12), made up,
 * for a spec that needs a connected one without running its connect check.
 */
export const GOOGLE_COLUMNS = {
  projectNumber: '123456789012',
  workloadIdentityProvider:
    'projects/123456789012/locations/global/workloadIdentityPools/cloudgate/providers/cloudgate',
  deployServiceAccount: 'cloudgate-deploy@shop-prod.iam.gserviceaccount.com',
  signingKey:
    '-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n',
  signingKeyId: 'key-1',
  signingPublicKey: '{"kty":"RSA","kid":"key-1","n":"AQAB","e":"AQAB"}',
  tokenIssuer: 'https://cloudgate.example.com/shop-prod',
} as const;

/** The AWS columns, emptied, as a `gcp` row holds them. */
const NO_AWS_COLUMNS = {
  accessKeyId: null,
  secretAccessKey: null,
  deployRoleArn: null,
  taskExecutionRoleArn: null,
  externalId: null,
} as const;

/**
 * Turns a Cloud account row into a Google Cloud one in place, so a spec whose
 * fixtures make an AWS one can ask what each AWS-shaped use does with a Google
 * row: refuse it, naming Google Cloud.
 */
export async function makeGoogleCloudAccount(
  db: DrizzleDB,
  cloudAccountId: string,
): Promise<void> {
  await db
    .update(cloudAccount)
    .set({
      cloud: 'gcp',
      cloudId: 'shop-prod',
      ...NO_AWS_COLUMNS,
      ...GOOGLE_COLUMNS,
    })
    .where(eq(cloudAccount.cloudAccountId, cloudAccountId));
}

/** The refusal every AWS-shaped use answers a Google row with, until its Google half lands. */
export const notOnGoogleCloudYet = (name: string) =>
  `Cloud account ${name} is a Google Cloud project, and this is not available on Google Cloud yet`;
