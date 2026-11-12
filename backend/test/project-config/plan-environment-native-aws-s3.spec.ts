import { parseProjectConfig, planEnvironment } from '../../src/project-config';
import type {
  DeployTarget,
  PlanInput,
  PlanOutcome,
  PlanStep,
  SavedService,
} from '../../src/project-config';
import type { NativeAwsBlock } from '../../src/native/aws-native';

/**
 * `native.aws` on a `bucket` on S3 and a `static` site on S3 and
 * CloudFront, per the spec's lists: checked on every plan, planned on AWS as
 * native lines of the step against the block its last Apply laid, and
 * carried on the step for its read to lay.
 */

const DOCKER: DeployTarget = { kind: 'platform-host' };
const AWS: DeployTarget = {
  kind: 'cloud',
  cloudAccountId: 'ca-1',
  region: 'eu-west-1',
};

type Entry = Record<string, unknown>;

function plan(
  services: Record<string, Entry>,
  deployTarget: DeployTarget,
  more: Partial<PlanInput> = {},
): PlanOutcome {
  const parsed = parseProjectConfig(JSON.stringify({ version: 1, services }));
  if (!parsed.ok) throw new Error(`refused: ${parsed.refusal.message}`);
  return planEnvironment({
    config: parsed.config,
    saved: [],
    deployTarget,
    context: { previous: null },
    ...more,
  });
}

function refusals(...args: Parameters<typeof plan>): string[] {
  const outcome = plan(...args);
  if (outcome.ok) throw new Error('planned, but a refusal was expected');
  return outcome.refusals.map((refusal) => refusal.message);
}

function stepOf(outcome: PlanOutcome, configName: string) {
  if (!outcome.ok) {
    throw new Error(outcome.refusals.map((r) => r.message).join('; '));
  }
  return outcome.steps.find(
    (step): step is Extract<PlanStep, { action: 'create' | 'change' }> =>
      'configName' in step &&
      step.configName === configName &&
      (step.action === 'create' || step.action === 'change'),
  );
}

function nativeLines(step: ReturnType<typeof stepOf>) {
  if (!step) throw new Error('no create or change');
  return step.fields.filter((field) => 'native' in field && field.native);
}

const bucket = (aws?: NativeAwsBlock): Entry => ({
  kind: 'bucket',
  ...(aws ? { native: { aws } } : {}),
});

const site = (aws?: NativeAwsBlock, spa?: boolean): Entry => ({
  kind: 'static',
  source: { github: 'acme/docs' },
  build: { publish: 'dist', ...(spa === undefined ? {} : { spa }) },
  ...(aws ? { native: { aws } } : {}),
});

/** A bucket already made on S3 in this Environment. */
function onS3(
  nativeAws?: NativeAwsBlock,
  origins: string[] = [],
): SavedService {
  return {
    serviceType: 'bucket',
    serviceId: 'bkt-id',
    name: 'files',
    configName: 'files',
    cloud: {
      cloudAccountId: 'ca-1',
      region: 'eu-west-1',
      linkedRegistries: [],
    },
    ...(nativeAws ? { nativeAws } : {}),
    settings: {
      description: null,
      bucketName: 'files-k3f9a2qd-123456789012-eu-west-1-an',
    },
    variables: { env: [] },
    cors: { origins, applied: origins },
  };
}

/** A static site already made on S3 + CloudFront. */
function onCloudFront(nativeAws?: NativeAwsBlock, spa = false): SavedService {
  return {
    serviceType: 'application',
    serviceId: 'app-docs',
    name: 'docs',
    configName: 'docs',
    cloud: {
      cloudAccountId: 'ca-1',
      region: 'eu-west-1',
      linkedRegistries: [],
    },
    ...(nativeAws ? { nativeAws } : {}),
    settings: {
      configKind: 'static',
      description: null,
      cpuLimit: null,
      memoryLimit: null,
      command: null,
      args: null,
      port: 3000,
      cronSchedule: null,
      cronTimezone: null,
      cronTimeoutSeconds: null,
      sourceType: 'github',
      owner: 'acme',
      repository: 'docs',
      buildPath: '/',
      gitlabOwner: null,
      gitlabRepository: null,
      gitlabPathNamespace: null,
      gitlabBuildPath: '/',
      giteaOwner: null,
      giteaRepository: null,
      giteaBuildPath: '/',
      bitbucketOwner: null,
      bitbucketRepository: null,
      bitbucketBuildPath: '/',
      customGitUrl: null,
      customGitBuildPath: null,
      dockerImage: null,
      buildType: 'static',
      railpackVersion: '0.15.4',
      herokuVersion: '24',
      dockerfile: 'Dockerfile',
      dockerContextPath: null,
      dockerBuildStage: null,
      publishDirectory: 'dist',
      isStaticSpa: spa,
      createEnvFile: true,
      enableSubmodules: false,
      watchPaths: null,
    },
    variables: { env: [], buildArgs: [], buildSecrets: [] },
  };
}

const KMS: NativeAwsBlock = {
  'aws_s3_bucket_server_side_encryption_configuration.bucket': {
    rule: [
      {
        apply_server_side_encryption_by_default: { sse_algorithm: 'aws:kms' },
        bucket_key_enabled: true,
      },
    ],
  },
};
const ENCRYPTION =
  'native.aws."aws_s3_bucket_server_side_encryption_configuration.bucket"';
/** The rule Cloudgate writes: SSE-S3. */
const SSE_S3 = [
  { apply_server_side_encryption_by_default: [{ sse_algorithm: 'AES256' }] },
];

const CDN: NativeAwsBlock = {
  'aws_cloudfront_distribution.site': {
    price_class: 'PriceClass_100',
    http_version: 'http2and3',
  },
};
const DISTRIBUTION = 'native.aws."aws_cloudfront_distribution.site"';

const BOTH = [
  ['a Docker Environment', DOCKER],
  ['an AWS Environment', AWS],
] as const;

describe('planEnvironment native.aws on a bucket and a static site', () => {
  describe.each(BOTH)('checked on %s', (_where, target) => {
    it('refuses a static site’s aliases with their reason', () => {
      expect(
        refusals(
          {
            docs: site({
              'aws_cloudfront_distribution.site': {
                aliases: ['docs.example.com'],
                price_class: 'PriceClass_100',
              },
            }),
          },
          target,
        ),
      ).toEqual([
        'docs.native.aws."aws_cloudfront_distribution.site".aliases: refused - locked: the site\'s Domain is set through the Service\'s Domains',
      ]);
    });

    it('refuses custom_error_response on a static site with spa set, and takes it without', () => {
      const errors = {
        'aws_cloudfront_distribution.site': {
          custom_error_response: [
            {
              error_code: 404,
              response_code: 404,
              response_page_path: '/not-found.html',
            },
          ],
        },
      };
      expect(refusals({ docs: site(errors, true) }, target)).toEqual([
        'docs.native.aws."aws_cloudfront_distribution.site".custom_error_response: refused - locked: the config\'s spa sets it',
      ]);
      expect(plan({ docs: site(errors, false) }, target).ok).toBe(true);
      expect(plan({ docs: site(errors) }, target).ok).toBe(true);
    });

    it('refuses the distribution’s origin and its cache behaviour’s origin, and takes the rest of the behaviour', () => {
      expect(
        refusals(
          {
            docs: site({
              'aws_cloudfront_distribution.site': {
                default_cache_behavior: {
                  target_origin_id: 'elsewhere',
                  compress: false,
                },
              },
            }),
          },
          target,
        ),
      ).toEqual([
        'docs.native.aws."aws_cloudfront_distribution.site".default_cache_behavior.target_origin_id: refused - locked: the site is served from its own bucket’s live Deployment',
      ]);
    });

    it('refuses a bucket’s inline policy, ACL and CORS, twins of what is locked', () => {
      expect(
        refusals(
          {
            files: bucket({
              'aws_s3_bucket.bucket': { policy: '{}', acl: 'public-read' },
            }),
          },
          target,
        ),
      ).toEqual([
        'files.native.aws."aws_s3_bucket.bucket".policy: refused - locked: a bucket has no policy of its own: a link is the access (ADR-0032)',
        'files.native.aws."aws_s3_bucket.bucket".acl: refused - locked: ACLs stay off, so no object can be opened to the world',
      ]);
    });

    it('refuses the bucket’s name and its public access block whole', () => {
      expect(
        refusals(
          {
            files: bucket({
              'aws_s3_bucket.bucket': { force_destroy: true },
              'aws_s3_bucket_public_access_block.bucket': {
                block_public_policy: false,
              },
            }),
          },
          target,
        ),
      ).toEqual([
        'files.native.aws."aws_s3_bucket.bucket".force_destroy: refused - locked: a destroy never empties a bucket; Delete asks before it does',
        'files.native.aws."aws_s3_bucket_public_access_block.bucket": refused - locked whole: Block Public Access keeps the bucket unreachable from outside',
      ]);
    });
  });

  describe('a bucket’s CORS', () => {
    const cors = (rule: Record<string, unknown>): Entry =>
      bucket({
        'aws_s3_bucket_cors_configuration.bucket': { cors_rule: [rule] },
      });
    const trusting = { saved: [onS3(undefined, ['https://app.example.com'])] };

    it('takes its rules with no origins, which stay the page’s', () => {
      const step = stepOf(
        plan({ files: cors({ allowed_methods: ['GET'] }) }, AWS, trusting),
        'files',
      );
      expect(nativeLines(step).map((line) => line.field)).toEqual([
        'native.aws."aws_s3_bucket_cors_configuration.bucket".cors_rule',
      ]);
    });

    it('refuses origins written in a rule, naming the rule', () => {
      expect(
        refusals(
          {
            files: cors({
              allowed_methods: ['GET'],
              allowed_origins: ['https://evil.example.com'],
            }),
          },
          AWS,
          trusting,
        ),
      ).toEqual([
        'files.native.aws."aws_s3_bucket_cors_configuration.bucket".cors_rule[0].allowed_origins: refused - locked: the trusted origins are the bucket page\'s; each item written gets Cloudgate\'s',
      ]);
    });
  });

  describe('planned on AWS', () => {
    it('plans a created bucket’s encryption as a native line, carried on its step for its read', () => {
      const step = stepOf(plan({ files: bucket(KMS) }, AWS), 'files');
      expect(nativeLines(step)).toEqual([
        {
          field: `${ENCRYPTION}.rule`,
          from: null,
          to: KMS['aws_s3_bucket_server_side_encryption_configuration.bucket']
            .rule,
          native: true,
          fromDefault: true,
        },
      ]);
      expect(step?.nativeAws).toEqual(KMS);
    });

    it('plans a made bucket’s encryption against Cloudgate’s SSE-S3, read from AWS with the block', () => {
      const step = stepOf(
        plan({ files: bucket(KMS) }, AWS, { saved: [onS3()] }),
        'files',
      );
      expect(nativeLines(step)).toEqual([
        {
          field: `${ENCRYPTION}.rule`,
          from: SSE_S3,
          to: KMS['aws_s3_bucket_server_side_encryption_configuration.bucket']
            .rule,
          native: true,
          fromDefault: true,
        },
      ]);
      expect(step?.action === 'change' && step.nativeAws).toEqual(KMS);
      expect(step?.cloudRead).toEqual({ status: 'reading' });
    });

    it('plans no change once the applied block is the entry’s', () => {
      expect(
        stepOf(
          plan({ files: bucket(KMS) }, AWS, { saved: [onS3(KMS)] }),
          'files',
        ),
      ).toBeUndefined();
    });

    it('plans a removed block back to Cloudgate’s value, its read laying none', () => {
      const step = stepOf(
        plan({ files: bucket() }, AWS, { saved: [onS3(KMS)] }),
        'files',
      );
      expect(nativeLines(step)).toEqual([
        {
          field: `${ENCRYPTION}.rule`,
          from: KMS['aws_s3_bucket_server_side_encryption_configuration.bucket']
            .rule,
          to: SSE_S3,
          native: true,
          toDefault: true,
        },
      ]);
      expect(step?.action === 'change' && step.nativeAws).toBeNull();
    });

    it('plans a static site’s price class and HTTP version from Cloudgate’s', () => {
      const step = stepOf(
        plan({ docs: site(CDN) }, AWS, { saved: [onCloudFront()] }),
        'docs',
      );
      expect(nativeLines(step)).toEqual([
        {
          field: `${DISTRIBUTION}.price_class`,
          from: 'PriceClass_All',
          to: 'PriceClass_100',
          native: true,
          fromDefault: true,
        },
        {
          field: `${DISTRIBUTION}.http_version`,
          from: 'http2',
          to: 'http2and3',
          native: true,
          fromDefault: true,
        },
      ]);
      expect(step?.action === 'change' && step.nativeAws).toEqual(CDN);
      expect(step?.cloudRead).toEqual({ status: 'reading' });
    });

    it('plans a created static site’s block, and none for one applied already', () => {
      const created = stepOf(plan({ docs: site(CDN) }, AWS), 'docs');
      expect(nativeLines(created).map((line) => line.field)).toEqual([
        `${DISTRIBUTION}.price_class`,
        `${DISTRIBUTION}.http_version`,
      ]);
      expect(created?.nativeAws).toEqual(CDN);
      expect(
        stepOf(
          plan({ docs: site(CDN) }, AWS, { saved: [onCloudFront(CDN)] }),
          'docs',
        ),
      ).toBeUndefined();
    });
  });

  it('plans no line on a Docker Environment, where the block is checked only', () => {
    const step = stepOf(plan({ files: bucket(KMS) }, DOCKER), 'files');
    expect(nativeLines(step)).toEqual([]);
    expect(step && 'nativeAws' in step).toBe(false);
  });
});
