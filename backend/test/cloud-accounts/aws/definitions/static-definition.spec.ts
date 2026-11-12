import { runInNewContext } from 'node:vm';

import {
  CLOUDFRONT_CERTIFICATE_REGION,
  INDEX_FUNCTION_CODE,
  ONE_DOMAIN_REFUSAL,
  STATIC_DOMAIN_ADDRESSES,
  STATIC_ORIGIN_ID,
  STATIC_SERVING_ADDRESSES,
  staticDefinition,
  staticOriginPath,
} from '../../../../src/cloud-accounts/aws/definitions/static-definition';
import { DOMAIN_CERTIFICATES_OUTPUT } from '../../../../src/cloud-accounts/aws/definitions/web-definition';
import type { StaticDefinitionInput } from '../../../../src/cloud-accounts/aws/definitions/static-definition';
import {
  addresses,
  defaultTags,
  effectiveTags,
  resource,
} from './definition-helpers';

const NAME = 'docs-p4x8m2rt-123456789012-eu-west-1-an';

function input(
  overrides: Partial<StaticDefinitionInput> = {},
): StaticDefinitionInput {
  return {
    configName: 'docs',
    serviceId: 'app_static_1',
    bucketName: NAME,
    spa: false,
    account: {
      cloudAccountId: 'cloud-acct-1',
      awsAccountId: '123456789012',
      deployRoleArn:
        'arn:aws:iam::123456789012:role/cloudgate/cloudgate-deploy',
      externalId: 'ext-abc',
    },
    region: 'eu-west-1',
    environmentId: 'env-prod',
    stateId: 'state-static-1',
    liveFolder: null,
    ...overrides,
  };
}

/** The site's Domain, its certificate requested and not yet issued. */
const DOMAIN = {
  domainId: 'dom_1',
  host: 'docs.example.com',
  path: '/',
  attempt: 1,
  attach: false,
};

const distribution = (overrides: Partial<StaticDefinitionInput> = {}) =>
  resource(
    staticDefinition(input(overrides)),
    'aws_cloudfront_distribution.site',
  );

/** Runs the viewer-request function's code on a request for `uri`. */
function viewerRequest(uri: string): string {
  const sandbox: { result?: { uri: string } } = {};
  runInNewContext(
    `${INDEX_FUNCTION_CODE}; result = handler({ request: { uri: ${JSON.stringify(uri)} } });`,
    sandbox,
  );
  return sandbox.result!.uri;
}

/**
 * A `static` site on AWS is its own private S3 bucket served by a
 * CloudFront distribution, in its own Infrastructure state: the bucket, the
 * Origin Access Control, a bucket policy for that distribution only, the
 * viewer-request function and the error responses `spa` picks.
 */
describe('staticDefinition', () => {
  it('holds the private bucket, the OAC, the bucket policy, the function and the distribution', () => {
    expect(addresses(staticDefinition(input()))).toEqual([
      'aws_acm_certificate.domain',
      'aws_cloudfront_distribution.site',
      'aws_cloudfront_function.site',
      'aws_cloudfront_origin_access_control.site',
      'aws_s3_bucket.site',
      'aws_s3_bucket_ownership_controls.site',
      'aws_s3_bucket_policy.site',
      'aws_s3_bucket_public_access_block.site',
      'aws_s3_bucket_server_side_encryption_configuration.site',
    ]);
  });

  it("makes its own bucket under its real name, private, as a bucket entry's is", () => {
    const definition = staticDefinition(input());

    expect(resource(definition, 'aws_s3_bucket.site')).toMatchObject({
      bucket: NAME,
      bucket_namespace: 'account-regional',
      force_destroy: false,
    });
    expect(
      resource(definition, 'aws_s3_bucket_public_access_block.site'),
    ).toMatchObject({
      block_public_acls: true,
      block_public_policy: true,
      ignore_public_acls: true,
      restrict_public_buckets: true,
    });
    expect(addresses(definition)).not.toContain(
      'aws_s3_bucket_cors_configuration.site',
    );
  });

  it('lets only this distribution read the bucket, through Origin Access Control', () => {
    const definition = staticDefinition(input());

    expect(
      resource(definition, 'aws_cloudfront_origin_access_control.site'),
    ).toMatchObject({
      origin_access_control_origin_type: 's3',
      signing_behavior: 'always',
      signing_protocol: 'sigv4',
    });
    const policy = resource(definition, 'aws_s3_bucket_policy.site');
    expect(JSON.parse(policy.policy as string)).toEqual({
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'CloudFrontReadsSite',
          Effect: 'Allow',
          Principal: { Service: 'cloudfront.amazonaws.com' },
          Action: ['s3:GetObject', 's3:ListBucket'],
          Resource: [
            '${aws_s3_bucket.site.arn}',
            '${aws_s3_bucket.site.arn}/*',
          ],
          Condition: {
            StringEquals: {
              'AWS:SourceArn': '${aws_cloudfront_distribution.site.arn}',
            },
          },
        },
      ],
    });
    expect(distribution().origin).toEqual([
      expect.objectContaining({
        origin_id: STATIC_ORIGIN_ID,
        domain_name: '${aws_s3_bucket.site.bucket_regional_domain_name}',
        origin_access_control_id:
          '${aws_cloudfront_origin_access_control.site.id}',
      }),
    ]);
  });

  it('serves over HTTPS only, index.html at the root, on CloudFront’s own certificate', () => {
    const site = distribution();

    expect(site).toMatchObject({
      enabled: true,
      default_root_object: 'index.html',
      aliases: [],
      viewer_certificate: [{ cloudfront_default_certificate: true }],
    });
    expect(site.default_cache_behavior).toEqual([
      expect.objectContaining({
        target_origin_id: STATIC_ORIGIN_ID,
        viewer_protocol_policy: 'redirect-to-https',
        allowed_methods: ['GET', 'HEAD'],
      }),
    ]);
  });

  it('runs the index function on every viewer request', () => {
    const [behaviour] = distribution().default_cache_behavior as {
      function_association: unknown[];
    }[];
    expect(behaviour.function_association).toEqual([
      {
        event_type: 'viewer-request',
        function_arn: '${aws_cloudfront_function.site.arn}',
      },
    ]);
    expect(
      resource(staticDefinition(input()), 'aws_cloudfront_function.site'),
    ).toMatchObject({
      runtime: 'cloudfront-js-2.0',
      publish: true,
      code: INDEX_FUNCTION_CODE,
    });
  });

  it('adds index.html to a path ending in /, and to nothing else', () => {
    expect(viewerRequest('/')).toBe('/index.html');
    expect(viewerRequest('/guide/')).toBe('/guide/index.html');
    expect(viewerRequest('/guide')).toBe('/guide');
    expect(viewerRequest('/app.js')).toBe('/app.js');
  });

  it('with spa: true, answers a 403 or a 404 with /index.html and 200', () => {
    expect(distribution({ spa: true }).custom_error_response).toEqual([
      {
        error_code: 403,
        response_code: 200,
        response_page_path: '/index.html',
        error_caching_min_ttl: 10,
      },
      {
        error_code: 404,
        response_code: 200,
        response_page_path: '/index.html',
        error_caching_min_ttl: 10,
      },
    ]);
  });

  it('with spa: false, answers a 403 as a 404 and leaves a 404 as it is', () => {
    expect(distribution({ spa: false }).custom_error_response).toEqual([
      {
        error_code: 403,
        response_code: 404,
        response_page_path: '/404.html',
        error_caching_min_ttl: 10,
      },
    ]);
  });

  it('points the origin at the live folder a deploy switched to, so that switch is never a change', () => {
    expect(distribution({ liveFolder: 'dep_7' }).origin).toEqual([
      expect.objectContaining({ origin_path: '/deployments/dep_7' }),
    ]);
    expect(distribution({ liveFolder: null }).origin).toEqual([
      expect.objectContaining({ origin_path: '' }),
    ]);
    expect(staticOriginPath('dep_7')).toBe('/deployments/dep_7');
  });

  it('ignores no part of the origin, so a hand change to its bucket or OAC is Drift the Apply puts back', () => {
    expect(distribution().lifecycle).toBeUndefined();
  });

  it("marks what it makes with Cloudgate's tags, and names the distribution", () => {
    const definition = staticDefinition(input());

    expect(defaultTags(definition)).toMatchObject({
      'cloudgate:state': 'state-static-1',
    });
    expect(
      effectiveTags(
        definition,
        resource(definition, 'aws_cloudfront_distribution.site'),
      ),
    ).toMatchObject({
      'cloudgate:address': 'aws_cloudfront_distribution.site',
      Name: 'cloudgate/docs/site',
    });
  });

  it('names its function and OAC after the Service, within 64 characters', () => {
    const definition = staticDefinition(input({ serviceId: 'x'.repeat(80) }));
    const fn = resource(definition, 'aws_cloudfront_function.site');
    expect((fn.name as string).length).toBe(64);
    expect(fn.name).toMatch(/^cloudgate-x+$/);
  });

  it('names everything that serves the site apart from its bucket and its settings, which a partly emptied Delete leaves', () => {
    const all = addresses(staticDefinition(input({ domains: [DOMAIN] })));

    expect(all).toEqual(expect.arrayContaining([...STATIC_SERVING_ADDRESSES]));
    // What is not serving is the bucket itself and its settings: anything
    // else added beside the bucket (a certificate) must be listed.
    expect(
      all.filter((address) => !STATIC_SERVING_ADDRESSES.includes(address)),
    ).toEqual([
      'aws_s3_bucket.site',
      'aws_s3_bucket_ownership_controls.site',
      'aws_s3_bucket_public_access_block.site',
      'aws_s3_bucket_server_side_encryption_configuration.site',
    ]);
  });

  describe('with a Domain', () => {
    const certificate = (domain = DOMAIN) =>
      resource(
        staticDefinition(input({ domains: [domain] })),
        'aws_acm_certificate.domain',
      );

    it('requests its certificate in us-east-1, whatever the region, DNS-validated, keyed by its attempt', () => {
      expect(CLOUDFRONT_CERTIFICATE_REGION).toBe('us-east-1');
      expect(certificate()).toMatchObject({
        for_each: {
          'dom_1-1': {
            host: 'docs.example.com',
            name: 'cloudgate/docs/domain/docs.example.com',
          },
        },
        region: 'us-east-1',
        domain_name: '${each.value.host}',
        validation_method: 'DNS',
        lifecycle: { create_before_destroy: true },
      });
      // The site's own provider stays in the Environment's region.
      const { provider } = staticDefinition(input({ domains: [DOMAIN] })) as {
        provider: { aws: { region: string } };
      };
      expect(provider.aws.region).toBe('eu-west-1');
    });

    it('waits on no certificate: no validation resource', () => {
      expect(
        addresses(staticDefinition(input({ domains: [DOMAIN] }))),
      ).not.toContain('aws_acm_certificate_validation.domain');
    });

    it('tags each certificate with its own address', () => {
      const definition = staticDefinition(input({ domains: [DOMAIN] }));
      expect(
        effectiveTags(
          definition,
          resource(definition, 'aws_acm_certificate.domain'),
        ),
      ).toMatchObject({
        'cloudgate:address': 'aws_acm_certificate.domain/${each.key}',
        'cloudgate:state': 'state-static-1',
        Name: '${each.value.name}',
      });
    });

    it('keeps the distribution on its own certificate and name until the certificate is issued', () => {
      expect(distribution({ domains: [DOMAIN] })).toMatchObject({
        aliases: [],
        viewer_certificate: [{ cloudfront_default_certificate: true }],
      });
    });

    it('once issued, serves the host as an alternate domain name with that certificate, by SNI', () => {
      expect(
        distribution({ domains: [{ ...DOMAIN, attempt: 2, attach: true }] }),
      ).toMatchObject({
        aliases: ['docs.example.com'],
        viewer_certificate: [
          {
            acm_certificate_arn: '${aws_acm_certificate.domain["dom_1-2"].arn}',
            ssl_support_method: 'sni-only',
            minimum_protocol_version: 'TLSv1.2_2021',
          },
        ],
      });
    });

    it('answers each certificate as a web Domain run reads it', () => {
      const definition = staticDefinition(input({ domains: [DOMAIN] }));
      const output = definition.output as Record<string, { value: string }>;
      expect(output[DOMAIN_CERTIFICATES_OUTPUT].value).toContain(
        'aws_acm_certificate.domain',
      );
    });

    it('takes one Domain: CloudFront serves one certificate', () => {
      expect(() =>
        staticDefinition(
          input({
            domains: [DOMAIN, { ...DOMAIN, domainId: 'dom_2', host: 'b.io' }],
          }),
        ),
      ).toThrow(ONE_DOMAIN_REFUSAL);
    });

    it("applies a Domain run's certificate and distribution, both of which a partly emptied Delete destroys", () => {
      expect([...STATIC_DOMAIN_ADDRESSES].sort()).toEqual([
        'aws_acm_certificate.domain',
        'aws_cloudfront_distribution.site',
      ]);
      for (const address of STATIC_DOMAIN_ADDRESSES) {
        expect(STATIC_SERVING_ADDRESSES).toContain(address);
      }
    });
  });
});
