import type { CloudAccount } from '../../src/cloud-accounts/cloud-account.schema';
import { googleAccountOf } from '../../src/cloud-accounts/cloud-provider';
import { GOOGLE_COLUMNS } from '../utils/google-cloud-account';

const SHARED = {
  cloudAccountId: 'ca-1',
  organizationId: 'org-1',
  policyVersion: 1,
  lastCheckedAt: '2026-10-20T00:00:00.000Z',
  lastCheckResult: 'passed',
  lastCheckReason: null,
  createdAt: '2026-10-20T00:00:00.000Z',
} as const;

const GOOGLE_ROW: CloudAccount = {
  ...SHARED,
  name: 'Production Google',
  cloud: 'gcp',
  cloudId: 'shop-prod',
  accessKeyId: null,
  secretAccessKey: null,
  deployRoleArn: null,
  taskExecutionRoleArn: null,
  externalId: null,
  ...GOOGLE_COLUMNS,
  pendingSigningKey: null,
};

const AWS_ROW: CloudAccount = {
  ...SHARED,
  name: 'Production AWS',
  cloud: 'aws',
  cloudId: '123456789012',
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
  deployRoleArn: 'arn:aws:iam::123456789012:role/cloudgate-deploy',
  taskExecutionRoleArn:
    'arn:aws:iam::123456789012:role/cloudgate-task-execution',
  externalId: 'external-id-made-by-cloudgate',
  projectNumber: null,
  workloadIdentityProvider: null,
  deployServiceAccount: null,
  signingKey: null,
  signingKeyId: null,
  signingPublicKey: null,
  pendingSigningKey: null,
  tokenIssuer: null,
};

/**
 * Slice 6 review: every use that takes Google's columns from a Cloud
 * account row goes through `googleAccountOf`, which hands back a Google one
 * and refuses an AWS row — never one with no Google key to sign with.
 */
describe('googleAccountOf', () => {
  it('hands back a Google row as it is', () => {
    expect(googleAccountOf(GOOGLE_ROW)).toEqual(GOOGLE_ROW);
  });

  it('refuses an AWS row, naming the Cloud account', () => {
    expect(() => googleAccountOf(AWS_ROW)).toThrow(
      'Cloud account Production AWS is an AWS account, not a Google Cloud project',
    );
  });
});
