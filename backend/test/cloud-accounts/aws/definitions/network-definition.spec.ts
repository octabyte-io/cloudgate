import { CLOUD_BUILDER_IMAGE } from '../../../../src/builders/cloud-builder-image';
import { buildIdentityNames } from '../../../../src/cloud-accounts/aws/cloud-build-names';
import { networkDefinition } from '../../../../src/cloud-accounts/aws/definitions/network-definition';
import {
  actionMatches,
  setupNames,
} from '../../../../src/cloud-accounts/aws/setup-template';
import { renderDefinition } from '../../../../src/cloud-accounts/definitions/tofu-json';
import {
  addresses,
  defaultTags,
  effectiveTags,
  resource,
  resources,
  taggableResources,
} from './definition-helpers';

const INPUT = {
  cloudAccountId: 'cloud-acct-1',
  account: {
    awsAccountId: '123456789012',
    deployRoleArn: 'arn:aws:iam::123456789012:role/cloudgate/cloudgate-deploy',
    externalId: 'ext-abc',
  },
  region: 'eu-west-1',
  environmentId: 'env-prod',
  stateId: 'state-network-1',
};

describe('networkDefinition', () => {
  const definition = networkDefinition(INPUT);

  describe('shape', () => {
    it('holds exactly the VPC, gateway, four subnets, load balancer, default certificate and cluster', () => {
      expect(addresses(definition)).toEqual(
        [
          'aws_vpc.network',
          'aws_internet_gateway.network',
          'aws_subnet.public_a',
          'aws_subnet.public_b',
          'aws_subnet.private_a',
          'aws_subnet.private_b',
          'aws_route_table.public',
          'aws_route.internet',
          'aws_route_table_association.public_a',
          'aws_route_table_association.public_b',
          'aws_security_group.alb',
          'aws_lb.network',
          'aws_lb_listener.http',
          'aws_lb_listener.https',
          'aws_acm_certificate.default',
          'aws_ecs_cluster.network',
        ].sort(),
      );
      // No NAT gateway, no address for one, and no interface endpoints.
      const types = resources(definition).map((r) => r.type);
      expect(types).not.toContain('aws_nat_gateway');
      expect(types).not.toContain('aws_eip');
      expect(types).not.toContain('aws_vpc_endpoint');
      // One provider per checkout: the certificate is Cloudgate's own.
      expect(types.every((type) => type.startsWith('aws_'))).toBe(true);
    });

    it('puts the VPC in the fixed range, with a public and a private subnet in each of two zones', () => {
      expect(resource(definition, 'aws_vpc.network').cidr_block).toBe(
        '10.80.0.0/16',
      );
      const zoneOf = (address: string) =>
        resource(definition, address).availability_zone;
      expect(zoneOf('aws_subnet.public_a')).toBe(
        zoneOf('aws_subnet.private_a'),
      );
      expect(zoneOf('aws_subnet.public_b')).toBe(
        zoneOf('aws_subnet.private_b'),
      );
      expect(zoneOf('aws_subnet.public_a')).not.toBe(
        zoneOf('aws_subnet.public_b'),
      );
      expect(
        ['public_a', 'public_b', 'private_a', 'private_b'].map(
          (name) => resource(definition, `aws_subnet.${name}`).cidr_block,
        ),
      ).toEqual([
        '10.80.0.0/20',
        '10.80.16.0/20',
        '10.80.128.0/20',
        '10.80.144.0/20',
      ]);
    });

    it('routes only the public subnets to the internet gateway, leaving the private ones empty', () => {
      expect(resource(definition, 'aws_route.internet')).toMatchObject({
        destination_cidr_block: '0.0.0.0/0',
        gateway_id: '${aws_internet_gateway.network.id}',
      });
      const associated = resources(definition)
        .filter((r) => r.type === 'aws_route_table_association')
        .map((r) => r.body.subnet_id);
      expect(associated.sort()).toEqual([
        '${aws_subnet.public_a.id}',
        '${aws_subnet.public_b.id}',
      ]);
    });

    it('opens the load balancer on 80 and 443 and lets it reach only the VPC', () => {
      const group = resource(definition, 'aws_security_group.alb');
      expect(
        (group.ingress as { from_port: number; cidr_blocks: string[] }[]).map(
          (rule) => [rule.from_port, rule.cidr_blocks],
        ),
      ).toEqual([
        [80, ['0.0.0.0/0']],
        [443, ['0.0.0.0/0']],
      ]);
      expect(group.egress).toEqual([
        expect.objectContaining({
          protocol: '-1',
          cidr_blocks: ['10.80.0.0/16'],
        }),
      ]);
      expect(resource(definition, 'aws_lb.network')).toMatchObject({
        load_balancer_type: 'application',
        internal: false,
        security_groups: ['${aws_security_group.alb.id}'],
        subnets: ['${aws_subnet.public_a.id}', '${aws_subnet.public_b.id}'],
      });
    });

    it('redirects port 80 to 443', () => {
      expect(resource(definition, 'aws_lb_listener.http')).toMatchObject({
        port: 80,
        protocol: 'HTTP',
        default_action: {
          type: 'redirect',
          redirect: { port: '443', protocol: 'HTTPS', status_code: 'HTTP_301' },
        },
      });
    });

    it('serves HTTPS with a self-signed certificate Cloudgate makes and imports into ACM', () => {
      expect(resource(definition, 'aws_lb_listener.https')).toMatchObject({
        port: 443,
        protocol: 'HTTPS',
        certificate_arn: '${aws_acm_certificate.default.arn}',
      });
      expect(resource(definition, 'aws_acm_certificate.default')).toMatchObject(
        {
          private_key: '${var.default_certificate_private_key}',
          certificate_body: '${var.default_certificate_body}',
          // A new certificate comes with every run; only the first is imported.
          lifecycle: { ignore_changes: ['private_key', 'certificate_body'] },
        },
      );
      // Passed by the run through the environment, the key marked sensitive.
      expect(definition.variable).toEqual({
        default_certificate_body: { type: 'string' },
        default_certificate_private_key: { type: 'string', sensitive: true },
      });
      // Imported, not requested: nothing waits on DNS validation.
      expect(
        resource(definition, 'aws_acm_certificate.default'),
      ).not.toHaveProperty('validation_method');
    });

    it('outputs every id a Service and the Apply read back', () => {
      expect(Object.keys(definition.output as object).sort()).toEqual(
        [
          'alb_arn',
          'alb_dns_name',
          'alb_security_group_id',
          'alb_zone_id',
          'cluster_arn',
          'default_certificate_arn',
          'https_listener_arn',
          'private_subnet_ids',
          'public_subnet_ids',
          'vpc_id',
        ].sort(),
      );
    });
  });

  describe('tags', () => {
    it("sets the Cloud account, Environment and state ids as the provider's default tags", () => {
      expect(defaultTags(definition)).toEqual({
        'cloudgate:cloud-account': 'cloud-acct-1',
        'cloudgate:environment': 'env-prod',
        'cloudgate:state': 'state-network-1',
      });
    });

    it('leaves every taggable resource with all four tags, its own address among them, and a Name', () => {
      const taggable = taggableResources(definition);
      expect(taggable.length).toBeGreaterThan(10);
      for (const { address, body } of taggable) {
        expect([address, effectiveTags(definition, body)]).toEqual([
          address,
          {
            'cloudgate:cloud-account': 'cloud-acct-1',
            'cloudgate:environment': 'env-prod',
            'cloudgate:state': 'state-network-1',
            'cloudgate:address': address,
            Name: expect.stringMatching(/\S/) as string,
          },
        ]);
      }
    });
  });

  describe('provider', () => {
    it('acts only in the Cloud account, through its deploy role and external id', () => {
      expect((definition.provider as { aws: unknown }).aws).toMatchObject({
        region: 'eu-west-1',
        allowed_account_ids: ['123456789012'],
        assume_role: {
          role_arn: INPUT.account.deployRoleArn,
          external_id: 'ext-abc',
        },
      });
    });

    it('keeps its state in the pg backend without creating anything there', () => {
      expect(definition.terraform).toEqual({
        backend: {
          pg: {
            schema_name: 'infrastructure_state',
            skip_schema_creation: true,
            skip_table_creation: true,
            skip_index_creation: true,
          },
        },
      });
    });
  });

  /**
   * The private DNS namespace a Private web service is listed in:
   * one per network, written once the first `web-private` has needed it.
   */
  describe('private DNS namespace', () => {
    const withDns = networkDefinition({
      ...INPUT,
      privateLinks: ['private-dns'],
    });

    it('is not there until a Private web service needs it', () => {
      expect(JSON.stringify(definition)).not.toContain('service_discovery');
      expect(definition.output).not.toHaveProperty('private_dns_namespace_id');
    });

    it("holds one namespace named cloudgate.internal on the network's own VPC", () => {
      expect(
        resource(
          withDns,
          'aws_service_discovery_private_dns_namespace.network',
        ),
      ).toMatchObject({
        name: 'cloudgate.internal',
        vpc: '${aws_vpc.network.id}',
      });
      expect(addresses(withDns)).toEqual(
        [
          ...addresses(definition),
          'aws_service_discovery_private_dns_namespace.network',
        ].sort(),
      );
    });

    it('outputs its id for the Services listed in it, and is tagged as the rest are', () => {
      expect(withDns.output).toHaveProperty('private_dns_namespace_id', {
        value: '${aws_service_discovery_private_dns_namespace.network.id}',
      });
      expect(taggableResources(withDns).map((one) => one.address)).toContain(
        'aws_service_discovery_private_dns_namespace.network',
      );
    });

    it('ignores the private links of another cloud', () => {
      expect(
        renderDefinition(
          networkDefinition({ ...INPUT, privateLinks: ['cloud-sql'] }),
        ),
      ).toBe(renderDefinition(definition));
    });
  });

  /**
   * A Stack VM's way out (ADR-0070, as the owner amended it on #1359):
   * a NAT gateway the first Stack VM adds, and that a network with none
   * never pays for.
   */
  describe('NAT gateway', () => {
    const withNat = networkDefinition({
      ...INPUT,
      privateLinks: ['nat-gateway'],
    });

    it('is not there until a Stack VM needs it', () => {
      expect(JSON.stringify(definition)).not.toContain('aws_nat_gateway');
    });

    it('adds the NAT gateway, its address, and the private subnets’ route through it', () => {
      expect(addresses(withNat)).toEqual(
        [
          ...addresses(definition),
          'aws_eip.nat',
          'aws_nat_gateway.nat',
          'aws_route_table.private',
          'aws_route.private_internet',
          'aws_route_table_association.private_a',
          'aws_route_table_association.private_b',
        ].sort(),
      );
      expect(resource(withNat, 'aws_nat_gateway.nat')).toMatchObject({
        allocation_id: '${aws_eip.nat.id}',
        subnet_id: '${aws_subnet.public_a.id}',
      });
      expect(resource(withNat, 'aws_route.private_internet')).toEqual({
        route_table_id: '${aws_route_table.private.id}',
        destination_cidr_block: '0.0.0.0/0',
        nat_gateway_id: '${aws_nat_gateway.nat.id}',
      });
      expect(
        resource(withNat, 'aws_route_table_association.private_b'),
      ).toEqual({
        subnet_id: '${aws_subnet.private_b.id}',
        route_table_id: '${aws_route_table.private.id}',
      });
    });

    it('carries the mark on its address, gateway and route table', () => {
      expect(taggableResources(withNat).map((one) => one.address)).toEqual(
        expect.arrayContaining([
          'aws_eip.nat',
          'aws_nat_gateway.nat',
          'aws_route_table.private',
        ]),
      );
    });
  });

  /**
   * A hosted cloud build's standing pieces (ADR-0047): the CodeBuild
   * project, its source bucket and its log group, made by the network's own
   * runs on the Hosted instance only.
   */
  describe("a hosted cloud build's standing pieces", () => {
    const hosted = networkDefinition({ ...INPUT, cloudBuilds: true });
    const BUILD_PIECES = [
      'aws_s3_bucket.build_source',
      'aws_s3_bucket_public_access_block.build_source',
      'aws_s3_bucket_ownership_controls.build_source',
      'aws_s3_bucket_server_side_encryption_configuration.build_source',
      'aws_cloudwatch_log_group.build',
      'aws_codebuild_project.build',
    ];
    const identity = buildIdentityNames({
      accountId: '123456789012',
      tagValue: 'cloud-acct-1',
    });
    const bucketName = resource(hosted, 'aws_s3_bucket.build_source')
      .bucket as string;

    it('are not there on a Self-hosted instance, which builds on its platform host', () => {
      expect(addresses(definition)).toEqual(
        addresses(networkDefinition({ ...INPUT, cloudBuilds: false })),
      );
      expect(JSON.stringify(definition)).not.toContain('codebuild');
    });

    it('add exactly the project, the source bucket with its settings and the log group', () => {
      expect(addresses(hosted)).toEqual(
        [...addresses(definition), ...BUILD_PIECES].sort(),
      );
      for (const address of BUILD_PIECES.filter(
        (one) => !one.startsWith('aws_s3_bucket_'),
      )) {
        expect(taggableResources(hosted).map((one) => one.address)).toContain(
          address,
        );
      }
    });

    it('make the source bucket private in the account regional namespace, emptied with the network', () => {
      expect(resource(hosted, 'aws_s3_bucket.build_source')).toMatchObject({
        bucket_namespace: 'account-regional',
        force_destroy: true,
      });
      expect(bucketName).toMatch(/^[a-z0-9-]{3,63}$/);
      expect(bucketName.endsWith('-123456789012-eu-west-1-an')).toBe(true);
      expect(
        resource(hosted, 'aws_s3_bucket_public_access_block.build_source'),
      ).toMatchObject({
        block_public_acls: true,
        block_public_policy: true,
        ignore_public_acls: true,
        restrict_public_buckets: true,
      });
    });

    it("name the bucket and the log group inside what the build identity reads and writes, and the deploy role's buckets", () => {
      const deployRoleBuckets = setupNames({
        accountId: '123456789012',
        tagValue: 'cloud-acct-1',
      }).bucketPattern;
      const arn = `arn:aws:s3:::${bucketName}`;
      expect(actionMatches(identity.sourceBucketPattern, arn)).toBe(true);
      expect(actionMatches(deployRoleBuckets, arn)).toBe(true);
      const logGroup = resource(hosted, 'aws_cloudwatch_log_group.build')
        .name as string;
      expect(logGroup).toBe('/cloudgate/build/cloud-acct-1/env-prod');
      expect(
        actionMatches(
          identity.logGroupPatterns[1],
          `arn:aws:logs:eu-west-1:123456789012:log-group:${logGroup}:log-stream:build-1`,
        ),
      ).toBe(true);
    });

    it("keep another Cloud account's build identity out of this one's sources", () => {
      const other = buildIdentityNames({
        accountId: '123456789012',
        tagValue: 'cloud-acct-2',
      });
      expect(
        actionMatches(other.sourceBucketPattern, `arn:aws:s3:::${bucketName}`),
      ).toBe(false);
    });

    it('run the project as the build identity, from the pinned builder image, logging only to the log group', () => {
      expect(resource(hosted, 'aws_codebuild_project.build')).toMatchObject({
        name: 'cloudgate-build-env-prod',
        service_role: identity.roleArn,
        artifacts: [{ type: 'NO_ARTIFACTS' }],
        source: [
          {
            type: 'S3',
            location: '${aws_s3_bucket.build_source.bucket}/source.zip',
          },
        ],
        environment: [
          {
            image: CLOUD_BUILDER_IMAGE,
            image_pull_credentials_type: 'CODEBUILD',
            privileged_mode: true,
          },
        ],
        cache: [{ type: 'LOCAL', modes: ['LOCAL_DOCKER_LAYER_CACHE'] }],
        logs_config: [
          {
            cloudwatch_logs: [
              {
                status: 'ENABLED',
                group_name: '${aws_cloudwatch_log_group.build.name}',
              },
            ],
            s3_logs: [{ status: 'DISABLED' }],
          },
        ],
      });
    });
  });

  it('writes the same text for the same input', () => {
    expect(renderDefinition(networkDefinition(INPUT))).toBe(
      renderDefinition(networkDefinition({ ...INPUT })),
    );
  });
});
