import type { CloudAccount } from '../../src/cloud-accounts/cloud-account.schema';
import {
  awsAccountOf,
  credentialOf,
} from '../../src/cloud-accounts/cloud-provider';
import {
  GOOGLE_COLUMNS,
  notOnGoogleCloudYet,
} from '../utils/google-cloud-account';

const SHARED = {
  cloudAccountId: 'ca-1',
  organizationId: 'org-1',
  policyVersion: 1,
  lastCheckedAt: '2026-10-20T00:00:00.000Z',
  lastCheckResult: 'passed',
  lastCheckReason: null,
  createdAt: '2026-10-20T00:00:00.000Z',
} as const;

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

/**
 * Slice 6, S12: a Cloud account row can be Google's, and every use that takes
 * AWS's credential from one goes through `awsAccountOf`, which hands back an
 * AWS one or a refusal naming Google Cloud — never a row with no key to sign
 * with.
 */
describe('awsAccountOf', () => {
  it('hands back an AWS row as it is, with its credential', () => {
    const answer = awsAccountOf(AWS_ROW);

    expect(answer).toEqual({ ok: true, account: AWS_ROW });
    if (!answer.ok) throw new Error('refused');
    expect(credentialOf(answer.account)).toEqual({
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    });
  });

  it('refuses a Google row, naming the Cloud account and Google Cloud', () => {
    expect(awsAccountOf(GOOGLE_ROW)).toEqual({
      ok: false,
      refusal: notOnGoogleCloudYet('Production Google'),
    });
  });
});
