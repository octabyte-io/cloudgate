import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readPlan } from '../../src/cloud-accounts/aws/plan-reader/read-plan';
import type { TofuShowJson } from '../../src/cloud-accounts/aws/plan-reader/tofu-show.types';

/**
 * A `static` site on S3 + CloudFront read from the stored real plans
 * the static moto lane saves (`static-lane.moto-spec.ts`): its create, a
 * `spa` change, and a change made by hand in the AWS console.
 */
function plan(name: string): TofuShowJson {
  return JSON.parse(
    readFileSync(join(__dirname, 'fixtures', 'plans', `${name}.json`), 'utf8'),
  ) as TofuShowJson;
}

const read = (name: string) =>
  readPlan({
    show: plan(name),
    tagSearch: [],
    context: { serviceName: 'docs' },
  });

describe('readPlan, a static site on S3 + CloudFront', () => {
  it('reads a create as its bucket, OAC, bucket policy, function and distribution with its error responses', () => {
    const reading = read('static-create');

    expect(reading.summary).toEqual([
      'CloudFront distribution: create, HTTPS only, error responses 403 → 404',
      'CloudFront function (index.html for a path ending in /): create',
      'Origin Access Control: create, CloudFront signs every request to the bucket',
      "S3 bucket `docs-p4x8m2rt-123456789012-eu-central-1-an`: create, versioning off, S3's default encryption, Block Public Access on",
      'Bucket policy: create, only its CloudFront distribution reads the bucket',
    ]);
    expect(reading.raw.map((line) => [line.address, line.action])).toEqual([
      ['aws_cloudfront_distribution.site', 'create'],
      ['aws_cloudfront_function.site', 'create'],
      ['aws_cloudfront_origin_access_control.site', 'create'],
      ['aws_s3_bucket.site', 'create'],
      ['aws_s3_bucket_ownership_controls.site', 'create'],
      ['aws_s3_bucket_policy.site', 'create'],
      ['aws_s3_bucket_public_access_block.site', 'create'],
      ['aws_s3_bucket_server_side_encryption_configuration.site', 'create'],
    ]);
    expect(reading.drift).toEqual([]);
    expect(reading.imageOnly).toBe(false);
  });

  it('reads a spa change as the distribution answering a missing path with /index.html', () => {
    const reading = read('static-spa-change');

    expect(reading.summary).toEqual([
      'CloudFront distribution: change, error responses 403 → 200 /index.html, 404 → 200 /index.html',
    ]);
    expect(reading.raw).toEqual([
      expect.objectContaining({
        address: 'aws_cloudfront_distribution.site',
        action: 'change',
        fields: ['custom_error_response'],
        drift: false,
      }),
    ]);
    expect(reading.drift).toEqual([]);
  });

  it('reads a hand change in the console as Drift the Apply puts back', () => {
    const reading = read('static-drift');

    // Only AWS differs: nothing of the config's changes.
    expect(reading.summary).toEqual([]);
    expect(reading.drift).toEqual([
      expect.objectContaining({
        address: 'aws_cloudfront_distribution.site',
        line: 'CloudFront distribution: changed outside Cloudgate, will be put back',
        fields: [
          {
            field: 'default_root_object',
            hand: 'home.html',
            cloudgate: 'index.html',
          },
        ],
      }),
      expect.objectContaining({
        address: 'aws_s3_bucket_policy.site',
        line: 'Bucket policy: will be made again',
        deleted: true,
      }),
    ]);
    // The origin path the lane switched by hand as a deploy would is not
    // among what the plan changes: it is the deploys'.
    expect(JSON.stringify(reading.raw)).not.toContain('origin');
  });

  // From a real account's plan: the origin's Origin access set to
  // Public by hand in the console, in the same plan as a `spa` change. The
  // OAC lies inside the `origin` block, which also holds a value AWS computes
  // (`response_completion_timeout`, known only after apply), so the hand
  // change is read field by field rather than as the whole block.
  it('reads the Origin Access Control taken off by hand as Drift the Apply puts back', () => {
    const reading = read('static-oac-drift');

    expect(reading.drift).toEqual([
      expect.objectContaining({
        address: 'aws_cloudfront_distribution.site',
        line: 'CloudFront distribution: changed outside Cloudgate, will be put back',
        fields: [
          {
            field: 'origin.0.origin_access_control_id',
            hand: '(none)',
            cloudgate: 'E1U43LZJIOMDE9',
          },
        ],
      }),
    ]);
    // The `spa` change in the same plan is still the config's own.
    expect(reading.summary).toEqual([
      'CloudFront distribution: change, error responses 403 → 200 /index.html, 404 → 200 /index.html',
    ]);
  });

  it('reads the Origin Access Control taken off by hand, with no config change, as Drift alone', () => {
    const show = plan('static-oac-drift');
    const [distribution] = show.resource_changes ?? [];
    const change = distribution.change as {
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    };
    // The same plan with the `spa` change taken out: the error responses
    // already as the config has them.
    change.before.custom_error_response = change.after.custom_error_response;

    const reading = readPlan({
      show,
      tagSearch: [],
      context: { serviceName: 'docs' },
    });

    expect(reading.summary).toEqual([]);
    expect(reading.counts).toMatchObject({ change: 0, drift: 1 });
    expect(reading.drift.map((entry) => entry.fields)).toEqual([
      [
        {
          field: 'origin.0.origin_access_control_id',
          hand: '(none)',
          cloudgate: 'E1U43LZJIOMDE9',
        },
      ],
    ]);
  });

  // A real account's tag search: the provider's default tags reach the
  // site's function, but it is made untagged, so it carries no address tag
  // to place it by. Its ARN is the state's own, so it is no stray.
  it("says nothing of the site's own function, found by the state's tag alone", () => {
    const reading = readPlan({
      show: plan('static-oac-drift'),
      tagSearch: [
        {
          arn: 'arn:aws:cloudfront::123456789012:function/cloudgate-R5Y5XiaNb1bpIqSr9DMHv',
          tags: { 'cloudgate:state': 'bl4WfTIqSglqaid8C64iY' },
        },
      ],
      context: { serviceName: 'docs' },
    });

    expect(reading.noState).toEqual([]);
  });

  it('reads a Domain as its own certificate, made in us-east-1 and nothing else', () => {
    const reading = read('static-domain-certificate');

    expect(reading.raw.map((line) => [line.address, line.action])).toEqual([
      ['aws_acm_certificate.domain["dom_1-1"]', 'create'],
    ]);
    const certificate = (
      plan('static-domain-certificate') as unknown as {
        resource_changes: { change: { after: Record<string, unknown> } }[];
      }
    ).resource_changes.find((c) => c.change.after?.domain_name);
    expect(certificate?.change.after).toMatchObject({
      domain_name: 'docs.example.com',
      region: 'us-east-1',
    });
    expect(reading.drift).toEqual([]);
  });

  it('reads the issued certificate put on the distribution as its alias, and nothing else', () => {
    const reading = read('static-domain-attach');

    expect(reading.raw).toEqual([
      expect.objectContaining({
        address: 'aws_cloudfront_distribution.site',
        action: 'change',
        fields: ['aliases', 'viewer_certificate'],
        drift: false,
      }),
    ]);
    expect(reading.drift).toEqual([]);
  });
});
