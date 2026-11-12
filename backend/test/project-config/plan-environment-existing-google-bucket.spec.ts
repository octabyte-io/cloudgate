import {
  bucketAccessGrant,
  bucketAccessRevoke,
  bucketReadGrant,
  judgeExistingGoogleBucket,
  locationHoldsRegion,
} from '../../src/cloud-accounts/gcp/plan-reader/existing-bucket';
import type {
  ExistingGoogleBucketContext,
  GoogleBucketLookup,
} from '../../src/cloud-accounts/gcp/plan-reader/existing-bucket';
import type { StorageBucketRead } from '../../src/cloud-accounts/google-cloud.port';
import { parseProjectConfig, planEnvironment } from '../../src/project-config';
import type {
  DeployTarget,
  PlanOutcome,
  SavedService,
} from '../../src/project-config';

const DEPLOY = 'cloudgate-deploy@shop-prod.iam.gserviceaccount.com';

/** A bucket the operator made in the Environment's own project and region. */
const BUCKET: StorageBucketRead = {
  location: 'EUROPE-WEST1',
  locationType: 'region',
  dataLocations: [],
  requesterPays: false,
  labels: { team: 'shop' },
  projectNumber: '123456789012',
};

const CONTEXT: ExistingGoogleBucketContext = {
  serviceName: 'uploads',
  bucketName: 'acme-prod-uploads',
  project: { projectId: 'shop-prod', projectNumber: '123456789012' },
  region: 'europe-west1',
  serviceAccount: DEPLOY,
};

function judged(bucket: Partial<StorageBucketRead>) {
  return judgeExistingGoogleBucket(
    { kind: 'found', bucket: { ...BUCKET, ...bucket } },
    CONTEXT,
  );
}

function refusal(lookup: GoogleBucketLookup): string {
  const verdict = judgeExistingGoogleBucket(lookup, CONTEXT);
  if (verdict.ok) throw new Error('it was not refused');
  return verdict.reason;
}

/**
 * Spec "Existing bucket on Google Cloud" (ADR-0033 as amended): each plan's
 * lookup of an existing Cloud Storage bucket, judged
 * with no database and no Google call. Each refusal names its fix; a
 * location that does not hold the Environment's region is a note.
 */
describe('judgeExistingGoogleBucket', () => {
  it('uses a bucket as given, at $0/month, naming what Cloudgate makes for it', () => {
    const verdict = judged({});
    expect(verdict).toEqual({
      ok: true,
      elsewhere: false,
      lines: [
        'uploads: existing bucket acme-prod-uploads in EUROPE-WEST1, used as given: Cloudgate changes nothing in it and makes only its own service account and HMAC key for it, $0/month',
      ],
    });
  });

  it('refuses a bucket Google Cloud cannot find, naming the name to check', () => {
    expect(refusal({ kind: 'missing' })).toBe(
      "uploads uses the existing bucket acme-prod-uploads, but Google Cloud cannot find it. Check its name on uploads's page",
    );
  });

  it('refuses a bucket Cloudgate may not read, with the legacyBucketReader grant that lets every plan look it up', () => {
    expect(
      refusal({
        kind: 'unreadable',
        message: 'caller does not have storage.buckets.get access',
      }),
    ).toBe(
      `uploads uses the existing bucket acme-prod-uploads, but Cloudgate may not read it (caller does not have storage.buckets.get access). A bucket in another project needs Cloudgate's service account to read it, so that every plan can look it up: \`gcloud storage buckets add-iam-policy-binding gs://acme-prod-uploads --member=serviceAccount:${DEPLOY} --role=roles/storage.legacyBucketReader\``,
    );
  });

  it('refuses a requester-pays bucket, with the command that turns it off', () => {
    const verdict = judged({ requesterPays: true });
    expect(verdict).toEqual({
      ok: false,
      reason:
        'uploads uses the existing bucket acme-prod-uploads, but it has requester pays on, and the S3 SDK its linked Services use cannot name a project to bill. Turn it off: `gcloud storage buckets update gs://acme-prod-uploads --no-requester-pays`',
    });
  });

  it("refuses a bucket carrying Cloudgate's labels: one Cloudgate made", () => {
    const verdict = judged({
      labels: {
        'cloudgate-state': 'abc',
        'cloudgate-environment': 'def',
        team: 'shop',
      },
    });
    expect(verdict).toEqual({
      ok: false,
      reason:
        "uploads uses the existing bucket acme-prod-uploads, but it carries Cloudgate's labels (cloudgate-environment, cloudgate-state), so Cloudgate made it for an Environment; an existing bucket must be one Cloudgate did not make",
    });
  });

  it("notes, never refuses, a location that does not hold the Environment's region", () => {
    const verdict = judged({ location: 'US-EAST1' });
    expect(verdict.ok).toBe(true);
    expect(verdict.ok && verdict.lines).toEqual([
      'uploads: existing bucket acme-prod-uploads in US-EAST1, used as given: Cloudgate changes nothing in it and makes only its own service account and HMAC key for it, $0/month',
      "uploads: acme-prod-uploads is in US-EAST1, which does not hold this Environment's region europe-west1: its linked Services reach it across regions, which is slower and charged between regions",
    ]);
  });

  it('says a bucket in another project is used as given there, with no note when its location holds the region', () => {
    const verdict = judged({
      projectNumber: '999999999999',
      location: 'EU',
      locationType: 'multi-region',
    });
    expect(verdict).toEqual({
      ok: true,
      elsewhere: true,
      lines: [
        'uploads: existing bucket acme-prod-uploads in EU, in another project, used as given: Cloudgate changes nothing in it and makes only its own service account and HMAC key for it, $0/month',
      ],
    });
  });
});

describe('planEnvironment, an existing bucket on Google Cloud', () => {
  const GOOGLE: DeployTarget = {
    kind: 'cloud',
    cloudAccountId: 'gca-1',
    region: 'europe-west1',
  };
  const TEXT = `version: 1
services:
  uploads:
    kind: bucket
  api:
    kind: web
    source: { image: nginx }
    env:
      - AWS_ACCESS_KEY_ID: uploads.access_key_id
      - AWS_SECRET_ACCESS_KEY: uploads.secret_access_key
`;
  const existing: SavedService = {
    serviceType: 'bucket',
    serviceId: 'bkt-id',
    name: 'uploads',
    configName: 'uploads',
    settings: { description: null, bucketName: 'acme-prod-uploads' },
    variables: { env: [] },
    existing: {
      cloudAccountId: 'gca-1',
      region: 'europe-west1',
      bucketName: 'acme-prod-uploads',
      cloud: 'gcp',
    },
  };

  function planned(): Extract<PlanOutcome, { ok: true }> {
    const parsed = parseProjectConfig(TEXT);
    if (!parsed.ok) throw new Error(parsed.refusal.message);
    const outcome = planEnvironment({
      config: parsed.config,
      saved: [existing],
      deployTarget: GOOGLE,
      cloud: 'gcp',
      context: { previous: null },
      networks: [{ cloudAccountId: 'gca-1', region: 'europe-west1' }],
    });
    if (!outcome.ok) {
      throw new Error(outcome.refusals.map((one) => one.message).join('; '));
    }
    return outcome;
  }

  it('looks it up on every plan as a change, creating no bucket', () => {
    const { steps } = planned();

    expect(steps.find((step) => step.action !== 'create')).toEqual({
      action: 'change',
      configName: 'uploads',
      kind: 'bucket',
      serviceType: 'bucket',
      serviceId: 'bkt-id',
      name: 'uploads',
      fields: [],
      existing: { identifier: 'acme-prod-uploads', version: null },
      cloudRead: { status: 'reading' },
    });
  });

  it('hands a linked web its key, leaving no variable unset as on AWS', () => {
    const { notes } = planned();

    expect(notes.map((note) => note.kind)).not.toContain('task-role-access');
  });
});

describe('locationHoldsRegion', () => {
  it('reads a region, a dual-region and a multi-region', () => {
    expect(locationHoldsRegion(BUCKET, 'europe-west1')).toBe(true);
    expect(locationHoldsRegion(BUCKET, 'europe-west4')).toBe(false);
    const eur4 = { ...BUCKET, location: 'EUR4', locationType: 'dual-region' };
    expect(locationHoldsRegion(eur4, 'europe-west4')).toBe(true);
    expect(locationHoldsRegion(eur4, 'europe-west1')).toBe(false);
    const custom = {
      ...BUCKET,
      location: 'EU',
      locationType: 'dual-region',
      dataLocations: ['EUROPE-WEST1', 'EUROPE-WEST3'],
    };
    expect(locationHoldsRegion(custom, 'europe-west3')).toBe(true);
    expect(locationHoldsRegion(custom, 'europe-west4')).toBe(false);
    const us = { ...BUCKET, location: 'US', locationType: 'multi-region' };
    expect(locationHoldsRegion(us, 'us-central1')).toBe(true);
    expect(locationHoldsRegion(us, 'europe-west1')).toBe(false);
  });
});

describe('bucketAccessGrant', () => {
  it('add and remove the key account’s objectUser on the bucket, and give Cloudgate read on it', () => {
    const account = 'cloudgate-abc@shop-prod.iam.gserviceaccount.com';
    expect(bucketAccessGrant('acme-prod-uploads', account)).toBe(
      `gcloud storage buckets add-iam-policy-binding gs://acme-prod-uploads --member=serviceAccount:${account} --role=roles/storage.objectUser`,
    );
    expect(bucketAccessRevoke('acme-prod-uploads', account)).toBe(
      `gcloud storage buckets get-iam-policy gs://acme-prod-uploads --flatten='bindings[].members' --format='value(bindings.members)' | grep -F 'serviceAccount:${account}' | sort -u | xargs -r -I{} gcloud storage buckets remove-iam-policy-binding gs://acme-prod-uploads --member={} --role=roles/storage.objectUser --format=none`,
    );
    expect(bucketReadGrant('acme-prod-uploads', DEPLOY)).toBe(
      `gcloud storage buckets add-iam-policy-binding gs://acme-prod-uploads --member=serviceAccount:${DEPLOY} --role=roles/storage.legacyBucketReader`,
    );
  });
});
