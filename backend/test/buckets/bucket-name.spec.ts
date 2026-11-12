import {
  awsBucketName,
  bucketName,
  googleBucketName,
  mintAwsBucketName,
  mintBucketName,
  mintGoogleBucketName,
} from '../../src/buckets/bucket-name';
import { AWS_REGIONS } from '../../src/cloud-accounts/aws/regions';

/** S3's bucket-name rules, written out here rather than read from the code. */
const S3_BUCKET_NAME = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

describe('bucketName', () => {
  it('is the Config name, a hyphen and the random part', () => {
    expect(bucketName('uploads', 'a1b2c3d4')).toBe('uploads-a1b2c3d4');
  });

  it('cuts a long Config name so the whole name is at most 63 characters', () => {
    const configName = `u${'x'.repeat(62)}`;
    const name = bucketName(configName, 'a1b2c3d4');
    expect(name).toHaveLength(63);
    expect(name).toBe(`u${'x'.repeat(53)}-a1b2c3d4`);
    expect(name).toMatch(S3_BUCKET_NAME);
  });

  it('drops the hyphens a cut leaves at the end of the Config name', () => {
    const configName = `${'a'.repeat(53)}--rest`;
    expect(bucketName(configName, 'a1b2c3d4')).toBe(
      `${'a'.repeat(53)}-a1b2c3d4`,
    );
  });

  it('makes room for a suffix when given a smaller length', () => {
    expect(bucketName('uploads-for-the-shop', 'a1b2c3d4', 20)).toBe(
      'uploads-for-a1b2c3d4',
    );
  });

  it('refuses a random part that is not eight lowercase letters or digits', () => {
    expect(() => bucketName('uploads', 'A1B2C3D4')).toThrow();
    expect(() => bucketName('uploads', 'a1b2')).toThrow();
  });
});

describe('mintBucketName', () => {
  it('mints a different S3-valid name each time for one Config name', () => {
    const names = new Set(
      Array.from({ length: 20 }, () => mintBucketName('uploads')),
    );
    expect(names.size).toBe(20);
    for (const name of names) {
      expect(name).toMatch(/^uploads-[a-z0-9]{8}$/);
      expect(name).toMatch(S3_BUCKET_NAME);
    }
  });
});

/**
 * On AWS the name is made in S3's account regional namespace, which
 * ends `-<account-id>-<region>-an` and which no other AWS account can take.
 */
describe('awsBucketName', () => {
  const ACCOUNT = '123456789012';

  it('is the Config name, the random part, the account, the region and -an', () => {
    expect(awsBucketName('uploads', 'k3f9a2qd', ACCOUNT, 'eu-west-1')).toBe(
      'uploads-k3f9a2qd-123456789012-eu-west-1-an',
    );
  });

  it('always ends with the account regional suffix', () => {
    const name = awsBucketName(
      `u${'x'.repeat(62)}`,
      'a1b2c3d4',
      ACCOUNT,
      'ap-southeast-5',
    );
    expect(name.endsWith('-123456789012-ap-southeast-5-an')).toBe(true);
  });

  it('cuts the Config name so the whole name is at most 63 characters, in the longest region', () => {
    const longest = [...AWS_REGIONS].sort((a, b) => b.length - a.length)[0];
    const name = awsBucketName(
      `u${'x'.repeat(62)}`,
      'a1b2c3d4',
      ACCOUNT,
      longest,
    );
    expect(name).toHaveLength(63);
    expect(name).toMatch(S3_BUCKET_NAME);
    // 63 - 8 random - 3 hyphens - 12 digits - region - 3 for `-an`.
    expect(name.indexOf('-a1b2c3d4-')).toBe(
      63 - 8 - 2 - 12 - 1 - longest.length - 3,
    );
  });

  it('never leaves a hyphen where the cut falls', () => {
    // eu-central-1 leaves the Config name 25 characters: the cut ends on a hyphen.
    const configName = `${'a'.repeat(24)}-rest-of-it`;
    const name = awsBucketName(configName, 'a1b2c3d4', ACCOUNT, 'eu-central-1');
    expect(name).toBe(
      `${'a'.repeat(24)}-a1b2c3d4-123456789012-eu-central-1-an`,
    );
    expect(name).toMatch(S3_BUCKET_NAME);
  });

  it("keeps every region of the list within S3's rules", () => {
    for (const region of AWS_REGIONS) {
      const name = awsBucketName(
        `uploads-${'y'.repeat(60)}`,
        'a1b2c3d4',
        ACCOUNT,
        region,
      );
      expect(name.length).toBeLessThanOrEqual(63);
      expect(name).toMatch(S3_BUCKET_NAME);
      expect(name.endsWith(`-${ACCOUNT}-${region}-an`)).toBe(true);
    }
  });

  it('refuses an account id that is not twelve digits', () => {
    expect(() =>
      awsBucketName('uploads', 'a1b2c3d4', '1234', 'eu-west-1'),
    ).toThrow();
  });
});

describe('mintAwsBucketName', () => {
  it('mints a different name in the namespace each time', () => {
    const names = new Set(
      Array.from({ length: 20 }, () =>
        mintAwsBucketName('uploads', '123456789012', 'eu-west-1'),
      ),
    );
    expect(names.size).toBe(20);
    for (const name of names) {
      expect(name).toMatch(/^uploads-[a-z0-9]{8}-123456789012-eu-west-1-an$/);
    }
  });
});

/**
 * On Google Cloud a bucket is named by its Service's key and
 * eight random characters, `cloudgate-<service key>-<8 random>`, inside
 * Cloud Storage's rules: 3 to 63 lowercase letters, digits, `-`, `_` and
 * `.`, starting and ending with a letter or digit.
 */
describe('googleBucketName', () => {
  /** Cloud Storage's bucket-name rules, written out here. */
  const GCS_BUCKET_NAME = /^[a-z0-9][a-z0-9_.-]{1,61}[a-z0-9]$/;

  it("is the Service's key and the random part, 31 characters", () => {
    // `abc`'s key, as names.spec reads it from an independent source.
    const name = googleBucketName('abc', 'a1b2c3d4');

    expect(name).toBe('cloudgate-xj4bnp4pahh6-a1b2c3d4');
    expect(name).toHaveLength(31);
    expect(name).toMatch(GCS_BUCKET_NAME);
  });

  it('refuses a random part that is not eight lowercase letters or digits', () => {
    expect(() => googleBucketName('abc', 'ABCDEFGH')).toThrow();
    expect(() => googleBucketName('abc', 'a1b2')).toThrow();
  });
});

describe('mintGoogleBucketName', () => {
  it('mints a different name for one Service each time, every one starting with its key', () => {
    const names = new Set(
      Array.from({ length: 20 }, () => mintGoogleBucketName('abc')),
    );
    expect(names.size).toBe(20);
    for (const name of names) {
      expect(name).toMatch(/^cloudgate-xj4bnp4pahh6-[a-z0-9]{8}$/);
    }
  });
});
