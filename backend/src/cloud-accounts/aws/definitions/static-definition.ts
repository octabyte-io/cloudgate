import { privateBucket } from './bucket-definition';
import { addressTag, TAG_KEYS } from './tags';
import { frame, Resources } from './tofu-json';
import { ref } from '../../definitions/tofu-json';
import type { AwsAccountAccess } from './tofu-json';
import type { TofuDefinition } from '../../definitions/tofu-json';
import {
  DOMAIN_CERTIFICATES_OUTPUT,
  domainCertificateKey,
} from './web-definition';
import type { WebDomain } from './web-definition';
import { layNativeAws } from '../../../native/aws-lay';
import type { NativeAwsBlock } from '../../../native/aws-native';

export interface StaticDefinitionInput {
  readonly configName: string;
  /** The Application's id, which names its CloudFront function and OAC. */
  readonly serviceId: string;
  /**
   * Its own bucket's real name, minted once by the plan that created it, in
   * S3's account regional namespace (`awsBucketName`).
   */
  readonly bucketName: string;
  /** The entry's `build.spa`: a missing path answers `/index.html`. */
  readonly spa: boolean;
  readonly account: AwsAccountAccess & { readonly cloudAccountId: string };
  readonly region: string;
  readonly environmentId: string;
  /** The Service's Infrastructure state. */
  readonly stateId: string;
  /**
   * The folder its deploys last switched the origin to (the Application's
   * `cloudLiveFolder`), or `null` before its first: the origin path is
   * written from it, so the switch a deploy made is no change, and the rest
   * of the origin is Drift as usual.
   */
  readonly liveFolder: string | null;
  /**
   * The site's Domain, at most one ({@link ONE_DOMAIN_REFUSAL}):
   * its certificate and, once `attach`, its host on the distribution. Every
   * run of the site gives it, so no run takes off a Domain it does not know
   * of; none (or left out) is a site on its `*.cloudfront.net` name alone.
   * Its `path` means nothing to CloudFront and is not read.
   */
  readonly domains?: readonly WebDomain[];
  /**
   * Its `native.aws` (ADR-0044 rule 3), already checked: laid over
   * what this builder writes, field by field, before `main.tf.json` is
   * written. A plan read lays the entry's, a Cloud run and a read for Drift
   * the applied one its row holds. Absent or `null`: exactly Cloudgate's
   * definition.
   */
  readonly native?: NativeAwsBlock | null;
}

/**
 * CloudFront serves one certificate per distribution and each Domain has
 * its own, so a `static` site on AWS takes one Domain.
 */
export const ONE_DOMAIN_REFUSAL =
  "A static site on AWS takes one Domain: its CloudFront distribution serves one certificate, and each Domain has its own. Edit the site's Domain to the new host, or remove it first";

/**
 * Where a certificate CloudFront serves must be, whatever the Environment's
 * region. It is the resource's own `region` (AWS provider v6),
 * so the site's state needs no second provider.
 */
export const CLOUDFRONT_CERTIFICATE_REGION = 'us-east-1';

/**
 * The blocks a Domain's own Cloud run applies: its certificate, and
 * the distribution its host and certificate go on. The distribution's
 * origin is its deploys' and ignored, so the run changes only its aliases
 * and viewer certificate; a plan changing anything else is refused.
 */
export const STATIC_DOMAIN_ADDRESSES: readonly string[] = [
  'aws_acm_certificate.domain',
  'aws_cloudfront_distribution.site',
];

/** The outputs a run saves of the site, which its deploys read. */
export const STATIC_OUTPUTS = {
  bucketName: 'bucket_name',
  distributionId: 'distribution_id',
  distributionArn: 'distribution_arn',
  distributionDomain: 'distribution_domain',
} as const;

/**
 * What serves the site, by its address in the state: everything but its own
 * bucket and the bucket's settings. A Delete whose emptying stopped partway
 * destroys only these, so the bucket is left as it was, settings and
 * all, holding what is left of its files. A resource added to the
 * definition beside the bucket (a Domain's certificate) belongs here.
 */
export const STATIC_SERVING_ADDRESSES: readonly string[] = [
  'aws_cloudfront_distribution.site',
  'aws_cloudfront_origin_access_control.site',
  'aws_cloudfront_function.site',
  'aws_s3_bucket_policy.site',
  // The Domain's certificate, which serves only on the distribution.
  'aws_acm_certificate.domain',
];

/** The one origin the distribution has: the site's own bucket. */
export const STATIC_ORIGIN_ID = 'site-bucket';

/** CloudFront's managed `CachingOptimized` cache policy. */
export const CACHING_OPTIMIZED = '658327ea-f89d-4fab-a63d-7e88639e58f6';

/**
 * The viewer-request function (the AWS buckets spec "Serving"): a path ending in
 * `/` serves that folder's `index.html`, as nginx's `index` does on a
 * Server, so `/guide/` works on both.
 */
export const INDEX_FUNCTION_CODE = `function handler(event) {
  var request = event.request;
  if (request.uri.endsWith('/')) {
    request.uri += 'index.html';
  }
  return request;
}
`;

/** A name CloudFront holds once per AWS account: at most 64 characters. */
export function staticResourceName(serviceId: string): string {
  return `cloudgate-${serviceId}`.slice(0, 64);
}

/**
 * The custom error responses (the AWS buckets spec "Serving"). The bucket is
 * private and CloudFront may list it, so S3 answers a missing file 404, and
 * anything it refuses 403.
 *
 * - `spa: true`: a 403 or a 404 answers `/index.html` with 200, so the app's
 *   own routes load as they do with nginx's `try_files`.
 * - `spa: false`: a 403 answers 404, never "forbidden", so a private bucket
 *   does not show as one. CloudFront takes a response code only with a page,
 *   so it is the site's own `/404.html`; a site with none gets S3's 404.
 */
export function customErrorResponses(spa: boolean): Record<string, unknown>[] {
  if (spa) {
    return [403, 404].map((code) => ({
      error_code: code,
      response_code: 200,
      response_page_path: '/index.html',
      error_caching_min_ttl: 10,
    }));
  }
  return [
    {
      error_code: 403,
      response_code: 404,
      response_page_path: '/404.html',
      error_caching_min_ttl: 10,
    },
  ];
}

/**
 * The OpenTofu definition of a `static` site on AWS, its own Infrastructure
 * state (the AWS buckets spec "`static` on S3 + CloudFront"). Pure: no AWS call,
 * no `tofu`, no database. Of the config only `spa` reaches it: `source`,
 * `publish` and the rest are its deploys', and the container-only
 * fields have no meaning here.
 *
 * - **Its own bucket**, private: the same settings a `bucket` entry's has
 *   (`privateBucket`), with no CORS.
 * - **Origin Access Control** signs CloudFront's every request to it, and
 *   **the bucket policy** lets CloudFront read and list it only for this
 *   distribution (`AWS:SourceArn`), so nobody reaches the files around the
 *   CDN.
 * - **The CloudFront function** on viewer request adds `index.html` to a
 *   path ending in `/` ({@link INDEX_FUNCTION_CODE}).
 * - **The distribution**: HTTPS only (HTTP redirects), `index.html` at the
 *   root, the custom error responses `spa` picks, on CloudFront's own
 *   certificate until a Domain's is issued.
 * - **The Domain's certificate**, DNS-validated, in `us-east-1`
 *   ({@link CLOUDFRONT_CERTIFICATE_REGION}). Once it is issued (`attach`)
 *   the host is the distribution's alternate domain name, served with that
 *   certificate by SNI. No `aws_acm_certificate_validation`: an apply never
 *   waits on a certificate; Cloudgate polls ACM, as for a `web`.
 * - **The origin path is its deploys'.** Each deploy points it at its own
 *   folder (the AWS buckets spec "Landing" 3) and records that folder as live, and the
 *   definition writes the origin path from the live folder, so a deploy's
 *   switch is never a change. Nothing of the origin is in `ignore_changes`
 *   (the provider keeps origins as a set, which cannot be ignored one
 *   attribute at a time): a hand change to its bucket, its Origin Access
 *   Control or its path is Drift the Apply puts back (spec story 57).
 */
/** Where a static site's Deployments' folders are, in its own bucket. */
export const DEPLOYMENTS_PREFIX = 'deployments/';

/** The distribution's origin path that serves a Deployment's `folder`. */
export const staticOriginPath = (folder: string): string =>
  `/${DEPLOYMENTS_PREFIX}${folder}`;

export function staticDefinition(input: StaticDefinitionInput): TofuDefinition {
  const { account } = input;
  const domains = input.domains ?? [];
  if (domains.length > 1) throw new Error(ONE_DOMAIN_REFUSAL);
  const attached = domains.find((one) => one.attach) ?? null;
  const mark = {
    cloudAccountId: account.cloudAccountId,
    environmentId: input.environmentId,
    stateId: input.stateId,
  };
  const name = staticResourceName(input.serviceId);
  const r = new Resources();

  const bucket = privateBucket(r, 'site', input);
  const certificate = domainCertificate(r, domains, input.configName);

  const oac = r.untagged('aws_cloudfront_origin_access_control', 'site', {
    name,
    description: `cloudgate/${input.configName}`,
    origin_access_control_origin_type: 's3',
    signing_behavior: 'always',
    signing_protocol: 'sigv4',
  });

  const fn = r.untagged('aws_cloudfront_function', 'site', {
    name,
    comment: `cloudgate/${input.configName}: index.html for a path ending in /`,
    runtime: 'cloudfront-js-2.0',
    publish: true,
    code: INDEX_FUNCTION_CODE,
  });

  const distribution = r.tagged(
    'aws_cloudfront_distribution',
    'site',
    `cloudgate/${input.configName}/site`,
    {
      enabled: true,
      comment: `cloudgate/${input.configName}`,
      default_root_object: 'index.html',
      is_ipv6_enabled: true,
      http_version: 'http2',
      price_class: 'PriceClass_All',
      wait_for_deployment: false,
      origin: [
        {
          origin_id: STATIC_ORIGIN_ID,
          domain_name: ref(bucket, 'bucket_regional_domain_name'),
          origin_access_control_id: ref(oac, 'id'),
          origin_path:
            input.liveFolder === null ? '' : staticOriginPath(input.liveFolder),
        },
      ],
      default_cache_behavior: [
        {
          target_origin_id: STATIC_ORIGIN_ID,
          viewer_protocol_policy: 'redirect-to-https',
          allowed_methods: ['GET', 'HEAD'],
          cached_methods: ['GET', 'HEAD'],
          compress: true,
          cache_policy_id: CACHING_OPTIMIZED,
          function_association: [
            { event_type: 'viewer-request', function_arn: ref(fn, 'arn') },
          ],
        },
      ],
      custom_error_response: customErrorResponses(input.spa),
      restrictions: [
        { geo_restriction: [{ restriction_type: 'none', locations: [] }] },
      ],
      aliases: attached ? [attached.host] : [],
      viewer_certificate: [
        attached
          ? {
              acm_certificate_arn: `\${${certificate}["${domainCertificateKey(attached)}"].arn}`,
              ssl_support_method: 'sni-only',
              minimum_protocol_version: 'TLSv1.2_2021',
            }
          : { cloudfront_default_certificate: true },
      ],
    },
  );

  const bucketArn = ref(bucket, 'arn');
  r.untagged('aws_s3_bucket_policy', 'site', {
    bucket: ref(bucket, 'id'),
    policy: JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'CloudFrontReadsSite',
          Effect: 'Allow',
          Principal: { Service: 'cloudfront.amazonaws.com' },
          Action: ['s3:GetObject', 's3:ListBucket'],
          Resource: [bucketArn, `${bucketArn}/*`],
          Condition: {
            StringEquals: { 'AWS:SourceArn': ref(distribution, 'arn') },
          },
        },
      ],
    }),
  });

  const output = (value: unknown) => ({ value });
  return {
    ...frame(account, input.region, mark),
    // Native last, over everything Cloudgate wrote.
    resource: layNativeAws(r.all(), input.native),
    output: {
      [STATIC_OUTPUTS.bucketName]: output(ref(bucket, 'bucket')),
      [STATIC_OUTPUTS.distributionId]: output(ref(distribution, 'id')),
      [STATIC_OUTPUTS.distributionArn]: output(ref(distribution, 'arn')),
      [STATIC_OUTPUTS.distributionDomain]: output(
        ref(distribution, 'domain_name'),
      ),
      [DOMAIN_CERTIFICATES_OUTPUT]: output(
        '${ {for key, certificate in aws_acm_certificate.domain : key => { arn = certificate.arn, validation = [for option in certificate.domain_validation_options : { name = option.resource_record_name, type = option.resource_record_type, value = option.resource_record_value }] }} }',
      ),
    },
  };
}

/**
 * The Domain's ACM certificate, under the key a `web`'s has
 * (`domainCertificateKey`), so a Domain run reads it back the same way: one
 * block over the site's Domains (`for_each`, none or one), in `us-east-1`.
 * Ask again and a new host request a new one under a new key, made before
 * the old one goes.
 */
function domainCertificate(
  r: Resources,
  domains: readonly WebDomain[],
  configName: string,
): string {
  return r.untagged('aws_acm_certificate', 'domain', {
    for_each: Object.fromEntries(
      domains.map((domain) => [
        domainCertificateKey(domain),
        {
          host: domain.host,
          name: `cloudgate/${configName}/domain/${domain.host}`,
        },
      ]),
    ),
    region: CLOUDFRONT_CERTIFICATE_REGION,
    domain_name: '${each.value.host}',
    validation_method: 'DNS',
    lifecycle: { create_before_destroy: true },
    tags: {
      [TAG_KEYS.address]: addressTag(
        'aws_acm_certificate.domain["${each.key}"]',
      ),
      Name: '${each.value.name}',
    },
  });
}
