import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CloudFrontClient,
  CreateDistributionCommand,
  GetDistributionConfigCommand,
} from '@aws-sdk/client-cloudfront';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { ConfigService } from '@nestjs/config';
import { GenericContainer, Wait } from 'testcontainers';
import type { StartedTestContainer } from 'testcontainers';

import { AwsCloudAdapter } from '../../src/cloud-accounts/aws/aws-cloud.adapter';
import { STATIC_ORIGIN_ID } from '../../src/cloud-accounts/aws/definitions/static-definition';
import type { Env } from '../../src/common/config/env.schema';
import type { ObjectStorageTarget } from '../../src/object-storage/object-storage.port';
import { S3ObjectStorage } from '../../src/object-storage/s3-object-storage.adapter';

/**
 * Seam 4: the object-storage port's real adapter
 * (`S3ObjectStorage`) and the cloud port's CloudFront calls
 * (`AwsCloudAdapter.cloudFront*`), which every e2e spec fakes, run against
 * moto's S3 and CloudFront as they would against AWS's.
 *
 * It proves a static site's deploy calls — a folder's upload with its
 * content types, listing and deleting folders, the origin switch, the `/*`
 * invalidation and both status reads — and a Delete's — whether a bucket
 * holds files, old versions and delete markers counted, and emptying one
 * of them all.
 *
 * The adapter is AWS's own, unchanged: moto is reached through the SDK's
 * own `AWS_ENDPOINT_URL_CLOUDFRONT` and, for S3, the target's `endpoint`, as
 * a Garage is. moto is no proof of how long an invalidation or a
 * distribution's spread takes on AWS; that is the walk by hand's
 * (`docs/aws-walk-by-hand.md`, 5d). Needs Docker. Run with `pnpm test:moto`.
 */

const MOTO_IMAGE = 'motoserver/moto:5.2.3';
const REGION = 'eu-central-1';
const CREDENTIAL = { accessKeyId: 'moto', secretAccessKey: 'moto' };
const BUCKET = 'docs-p4x8m2rt-123456789012-eu-central-1-an';

let moto: StartedTestContainer;
let target: ObjectStorageTarget;
let s3: S3Client;
const storage = new S3ObjectStorage();
const scratch = mkdtempSync(join(tmpdir(), 'cloudgate-object-storage-'));

/** A folder on the platform host holding `files`, by their path in it. */
function folder(name: string, files: Record<string, string>): string {
  const directory = join(scratch, name);
  for (const [path, body] of Object.entries(files)) {
    const file = join(directory, path);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, body);
  }
  return directory;
}

beforeAll(async () => {
  moto = await new GenericContainer(MOTO_IMAGE)
    .withExposedPorts(5000)
    .withWaitStrategy(Wait.forHttp('/moto-api/', 5000))
    .start();
  const motoUrl = `http://${moto.getHost()}:${moto.getMappedPort(5000)}`;
  process.env.AWS_ENDPOINT_URL_CLOUDFRONT = motoUrl;
  target = {
    endpoint: motoUrl,
    region: REGION,
    bucket: BUCKET,
    credential: CREDENTIAL,
    pathStyle: true,
  };
  s3 = new S3Client({
    region: REGION,
    endpoint: motoUrl,
    forcePathStyle: true,
    credentials: CREDENTIAL,
  });
  await s3.send(
    new CreateBucketCommand({
      Bucket: BUCKET,
      CreateBucketConfiguration: { LocationConstraint: REGION },
    }),
  );
}, 300_000);

afterAll(async () => {
  delete process.env.AWS_ENDPOINT_URL_CLOUDFRONT;
  s3?.destroy();
  rmSync(scratch, { recursive: true, force: true });
  await moto?.stop();
});

describe("a static site's deploy, through the real adapters", () => {
  it('uploads a folder at its prefix, each file with its content type', async () => {
    const directory = folder('dist', {
      'index.html': '<h1>docs</h1>',
      'guide/index.html': '<h1>guide</h1>',
      'assets/app.js': 'console.log(1)',
      'assets/app.css': 'body{}',
    });

    await expect(
      storage.uploadFolder(target, {
        directory,
        prefix: 'deployments/dep_1/',
      }),
    ).resolves.toEqual({ ok: true, files: 4, bytes: 47 });

    const type = async (key: string) =>
      (await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key })))
        .ContentType;
    expect(await type('deployments/dep_1/index.html')).toMatch(/^text\/html/);
    expect(await type('deployments/dep_1/guide/index.html')).toMatch(
      /^text\/html/,
    );
    expect(await type('deployments/dep_1/assets/app.js')).toMatch(
      /^text\/javascript|^application\/javascript/,
    );
    expect(await type('deployments/dep_1/assets/app.css')).toMatch(
      /^text\/css/,
    );
  });

  it('lists the Deployments’ folders, and deletes one of them whole', async () => {
    await storage.uploadFolder(target, {
      directory: folder('dist-2', { 'index.html': 'two' }),
      prefix: 'deployments/dep_2/',
    });

    const listed = await storage.listFolders(target, 'deployments/');
    expect(listed.ok && [...listed.folders].sort()).toEqual(['dep_1', 'dep_2']);

    await expect(
      storage.deleteFolder(target, 'deployments/dep_1/'),
    ).resolves.toEqual({ ok: true });
    await expect(storage.listFolders(target, 'deployments/')).resolves.toEqual({
      ok: true,
      folders: ['dep_2'],
    });
  });

  it("switches the distribution's origin, invalidates it and reads both statuses", async () => {
    const cloud = new AwsCloudAdapter({
      get: () => '',
    } as unknown as ConfigService<Env, true>);
    const made = await new CloudFrontClient({
      region: 'us-east-1',
      credentials: CREDENTIAL,
    }).send(
      new CreateDistributionCommand({
        DistributionConfig: {
          CallerReference: 'object-storage-moto-spec',
          Comment: 'cloudgate/docs',
          Enabled: true,
          DefaultRootObject: 'index.html',
          Origins: {
            Quantity: 1,
            Items: [
              {
                Id: STATIC_ORIGIN_ID,
                DomainName: `${BUCKET}.s3.${REGION}.amazonaws.com`,
                OriginPath: '',
                S3OriginConfig: { OriginAccessIdentity: '' },
              },
            ],
          },
          DefaultCacheBehavior: {
            TargetOriginId: STATIC_ORIGIN_ID,
            ViewerProtocolPolicy: 'redirect-to-https',
            MinTTL: 0,
            ForwardedValues: {
              QueryString: false,
              Cookies: { Forward: 'none' },
            },
            TrustedSigners: { Enabled: false, Quantity: 0 },
          },
        },
      }),
    );
    const distributionId = made.Distribution?.Id ?? '';

    await expect(
      cloud.cloudFrontSwitchOrigin(CREDENTIAL, {
        distributionId,
        originId: STATIC_ORIGIN_ID,
        originPath: '/deployments/dep_2',
      }),
    ).resolves.toEqual({ ok: true, value: true });
    const config = await new CloudFrontClient({
      region: 'us-east-1',
      credentials: CREDENTIAL,
    }).send(new GetDistributionConfigCommand({ Id: distributionId }));
    expect(config.DistributionConfig?.Origins?.Items?.[0].OriginPath).toBe(
      '/deployments/dep_2',
    );

    const invalidation = await cloud.cloudFrontCreateInvalidation(CREDENTIAL, {
      distributionId,
      paths: ['/*'],
      callerReference: 'dep_2',
    });
    const invalidationId = invalidation.ok
      ? invalidation.value.invalidationId
      : '';
    expect(invalidation.ok).toBe(true);
    expect(invalidationId).not.toBe('');

    // moto finishes both at once: AWS's minutes are the walk's to time.
    // It words a finished invalidation `COMPLETED` where AWS says
    // `Completed` (MOTO_MISSING), so the adapter, reading AWS's word, reads
    // moto's as still going: what this proves is the call and its answer.
    await expect(
      cloud.cloudFrontInvalidationStatus(CREDENTIAL, {
        distributionId,
        invalidationId,
      }),
    ).resolves.toEqual({ ok: true, value: 'InProgress' });
    await expect(
      cloud.cloudFrontDistributionStatus(CREDENTIAL, distributionId),
    ).resolves.toEqual({ ok: true, value: 'Deployed' });
  });

  it("answers a distribution AWS does not have as AWS's refusal", async () => {
    const cloud = new AwsCloudAdapter({
      get: () => '',
    } as unknown as ConfigService<Env, true>);

    await expect(
      cloud.cloudFrontDistributionStatus(CREDENTIAL, 'E0000000000000'),
    ).resolves.toMatchObject({ ok: false, code: 'NoSuchDistribution' });
  });
});

describe("a bucket's Delete, through the real adapter", () => {
  it('reads a bucket holding only old versions and delete markers as holding files, and empties it', async () => {
    await s3.send(
      new PutBucketVersioningCommand({
        Bucket: BUCKET,
        VersioningConfiguration: { Status: 'Enabled' },
      }),
    );
    for (const body of ['one', 'two']) {
      await s3.send(
        new PutObjectCommand({ Bucket: BUCKET, Key: 'kept.txt', Body: body }),
      );
    }
    // Every current object deleted: what is left is two old versions of
    // kept.txt, dep_2's, and a delete marker on each.
    await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: 'kept.txt' }));
    await storage.deleteFolder(target, 'deployments/');
    const left = await s3.send(
      new ListObjectVersionsCommand({ Bucket: BUCKET }),
    );
    expect(left.DeleteMarkers?.length).toBeGreaterThan(0);
    expect(left.Versions?.length).toBeGreaterThan(0);

    await expect(storage.contentsOf(target)).resolves.toBe('holds-files');
    await expect(storage.empty(target)).resolves.toEqual({ ok: true });

    const after = await s3.send(
      new ListObjectVersionsCommand({ Bucket: BUCKET }),
    );
    expect(after.Versions ?? []).toEqual([]);
    expect(after.DeleteMarkers ?? []).toEqual([]);
    await expect(storage.contentsOf(target)).resolves.toBe('empty');
  });

  it('reads a bucket it cannot reach as unknown, and empties one that is not there', async () => {
    const missing = { ...target, bucket: 'not-a-bucket-of-this-account' };

    await expect(storage.contentsOf(missing)).resolves.toBe('unknown');
    await expect(storage.empty(missing)).resolves.toEqual({ ok: true });
  });
});
