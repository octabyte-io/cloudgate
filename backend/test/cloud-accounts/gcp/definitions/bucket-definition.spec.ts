import {
  gcpBucketDefinition,
  gcpBucketKeyAddress,
} from '../../../../src/cloud-accounts/gcp/definitions/bucket-definition';
import { idKey } from '../../../../src/cloud-accounts/gcp/definitions/names';
import { addresses, resource } from '../../aws/definitions/definition-helpers';

const INPUT = {
  serviceId: 'Svc_Bucket',
  bucketName: `cloudgate-${idKey('Svc_Bucket')}-a1b2c3d4`,
  cloudAccountId: 'Cloud_Acct-1',
  projectId: 'acme-prod-123',
  region: 'europe-west1',
  environmentId: 'Env_Prod',
  stateId: 'State_Bucket-1',
  origins: [],
};

/**
 * Spec "Bucket on Cloud Storage" (ADR-0032 as amended):
 * where a generated setting is itself the decision, it is read here — soft
 * delete 0, uniform access, the bucket-only `objectUser` binding and the
 * bucket's one HMAC key.
 */
describe('gcpBucketDefinition', () => {
  const definition = gcpBucketDefinition(INPUT);
  const bucket = resource(definition, 'google_storage_bucket.bucket');

  it('holds the bucket, its own service account, that account’s binding on it and its one HMAC key, and nothing else', () => {
    expect(addresses(definition)).toEqual([
      'google_service_account.bucket',
      'google_storage_bucket.bucket',
      'google_storage_bucket_iam_member.object_user',
      'google_storage_hmac_key.key',
    ]);
  });

  it('makes the bucket under the real name the plan minted, in the region, and never empties it on a destroy', () => {
    expect(bucket.name).toBe(INPUT.bucketName);
    expect(bucket.location).toBe('EUROPE-WEST1');
    expect(bucket.force_destroy).toBe(false);
  });

  it('empties it on a destroy only for the apply before a Delete that asked for its files to go', () => {
    const forced = gcpBucketDefinition({ ...INPUT, forceDestroy: true });
    expect(resource(forced, 'google_storage_bucket.bucket').force_destroy).toBe(
      true,
    );
  });

  it('turns soft delete off, so a deleted file is gone', () => {
    expect(bucket.soft_delete_policy).toEqual([
      { retention_duration_seconds: 0 },
    ]);
  });

  it('has uniform access and public access prevented, and never manages versioning', () => {
    expect(bucket.uniform_bucket_level_access).toBe(true);
    expect(bucket.public_access_prevention).toBe('enforced');
    expect(bucket).not.toHaveProperty('versioning');
  });

  it('carries the mark as its labels', () => {
    expect(bucket.labels).toEqual({
      'cloudgate-cloud-account': idKey('Cloud_Acct-1'),
      'cloudgate-environment': idKey('Env_Prod'),
      'cloudgate-state': idKey('State_Bucket-1'),
    });
  });

  it('gives its own service account objectUser on this bucket only, never on the project', () => {
    const account = resource(definition, 'google_service_account.bucket');
    expect(account.account_id).toBe(`cloudgate-${idKey('Svc_Bucket')}`);
    expect(account.description).toBe(
      'Cloudgate cloud-account=Cloud_Acct-1 environment=Env_Prod state=State_Bucket-1',
    );

    expect(
      resource(definition, 'google_storage_bucket_iam_member.object_user'),
    ).toEqual({
      bucket: '${google_storage_bucket.bucket.name}',
      role: 'roles/storage.objectUser',
      member: '${google_service_account.bucket.member}',
    });
    // No project-wide grant: the binding is the bucket's alone.
    expect(JSON.stringify(definition)).not.toMatch(/google_project_iam/);
  });

  it('makes one HMAC key for that account, its secret a sensitive output', () => {
    expect(resource(definition, 'google_storage_hmac_key.key')).toEqual({
      service_account_email: '${google_service_account.bucket.email}',
      state: 'ACTIVE',
    });
    const output = definition.output as Record<
      string,
      { value: string; sensitive?: boolean }
    >;
    expect(Object.keys(output).sort()).toEqual([
      'access_key_id',
      'bucket_name',
      'secret_access_key',
    ]);
    expect(output.access_key_id).toEqual({
      value: '${google_storage_hmac_key.key.access_id}',
    });
    expect(output.secret_access_key).toEqual({
      value: '${google_storage_hmac_key.key.secret}',
      sensitive: true,
    });
  });

  it('has no CORS with no origin trusted, and one rule naming every trusted origin', () => {
    expect(bucket).not.toHaveProperty('cors');

    const trusted = resource(
      gcpBucketDefinition({
        ...INPUT,
        origins: ['https://app.example.com', 'http://localhost:3000'],
      }),
      'google_storage_bucket.bucket',
    );
    expect(trusted.cors).toEqual([
      {
        origin: ['https://app.example.com', 'http://localhost:3000'],
        method: ['GET', 'PUT', 'POST', 'HEAD'],
        response_header: ['Content-Type', 'ETag'],
        max_age_seconds: 3600,
      },
    ]);
  });

  describe('its key slots, as a Rotate key moves the key between them', () => {
    const outputs = (keys: Parameters<typeof gcpBucketDefinition>[0]['keys']) =>
      gcpBucketDefinition({ ...INPUT, keys }).output as Record<
        string,
        { value: string; sensitive?: boolean }
      >;

    it('names each slot by its own address', () => {
      expect(gcpBucketKeyAddress('key')).toBe('google_storage_hmac_key.key');
      expect(gcpBucketKeyAddress('key_b')).toBe(
        'google_storage_hmac_key.key_b',
      );
    });

    it('holds only the live key, in the second slot once a rotation moved it there', () => {
      const moved = gcpBucketDefinition({
        ...INPUT,
        keys: { live: 'key_b', spare: false },
      });
      expect(
        addresses(moved).filter((one) => one.startsWith('google_storage_hmac')),
      ).toEqual(['google_storage_hmac_key.key_b']);
      expect(outputs({ live: 'key_b', spare: false })).toEqual({
        bucket_name: { value: '${google_storage_bucket.bucket.name}' },
        access_key_id: { value: '${google_storage_hmac_key.key_b.access_id}' },
        secret_access_key: {
          value: '${google_storage_hmac_key.key_b.secret}',
          sensitive: true,
        },
      });
    });

    it('holds a spare key beside the live one while a rotation has one, answering both, the live one still the key', () => {
      const rotating = gcpBucketDefinition({
        ...INPUT,
        keys: { live: 'key', spare: true },
      });
      expect(resource(rotating, 'google_storage_hmac_key.key_b')).toEqual({
        service_account_email: '${google_service_account.bucket.email}',
        state: 'ACTIVE',
      });
      expect(outputs({ live: 'key', spare: true })).toMatchObject({
        access_key_id: { value: '${google_storage_hmac_key.key.access_id}' },
        spare_access_key_id: {
          value: '${google_storage_hmac_key.key_b.access_id}',
        },
        spare_secret_access_key: {
          value: '${google_storage_hmac_key.key_b.secret}',
          sensitive: true,
        },
      });
    });

    it('is the one key in the first slot when no layout is given', () => {
      expect(gcpBucketDefinition(INPUT)).toEqual(
        gcpBucketDefinition({ ...INPUT, keys: { live: 'key', spare: false } }),
      );
    });
  });

  describe('for an existing bucket (ADR-0033 as amended)', () => {
    const existing = gcpBucketDefinition({
      ...INPUT,
      bucketName: 'acme-prod-uploads',
      origins: ['https://shop.example.com'],
      existing: true,
    });

    it('holds only its own service account and its HMAC key: the bucket, its settings and any grant on it are the operator’s', () => {
      expect(addresses(existing)).toEqual([
        'google_service_account.bucket',
        'google_storage_hmac_key.key',
      ]);
    });

    it('names the bucket as given and hands out the key as a made one does', () => {
      expect(existing.output).toEqual({
        bucket_name: { value: 'acme-prod-uploads' },
        access_key_id: { value: '${google_storage_hmac_key.key.access_id}' },
        secret_access_key: {
          value: '${google_storage_hmac_key.key.secret}',
          sensitive: true,
        },
      });
    });

    it('holds a rotation’s spare key beside the live one, as a made bucket does', () => {
      const rotating = gcpBucketDefinition({
        ...INPUT,
        existing: true,
        keys: { live: 'key_b', spare: true },
      });
      expect(addresses(rotating)).toEqual([
        'google_service_account.bucket',
        'google_storage_hmac_key.key',
        'google_storage_hmac_key.key_b',
      ]);
    });
  });

  it('is framed for the project and region, with no credential in it', () => {
    expect(definition.provider).toEqual({
      google: {
        project: 'acme-prod-123',
        region: 'europe-west1',
        add_terraform_attribution_label: false,
      },
    });
  });
});
