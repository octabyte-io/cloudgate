import { NAT_GATEWAY_LINK } from './nat-gateway';
import { CLOUD_BUILDER_IMAGE } from '../../../builders/cloud-builder-image';
import { DEFAULT_CERTIFICATE_VARIABLES } from '../../definitions/default-certificate';
import {
  BUILD_LOG_RETENTION_DAYS,
  buildPieceNames,
} from '../cloud-build-names';
import { frame, Resources, rule } from './tofu-json';
import { ref } from '../../definitions/tofu-json';
import type { AwsAccountAccess } from './tofu-json';
import type { TofuDefinition } from '../../definitions/tofu-json';
import type { NetworkLinkKind } from '../../definitions/network-links';
import { PRIVATE_DNS_NAMESPACE } from './private-dns';

/**
 * The fixed address range of every Environment network: the VPC is
 * `10.80.0.0/16`, the public subnets the first two `/20`s and the private ones
 * the two `/20`s from the middle (`10.80.128.0/20`, `10.80.144.0/20`), leaving
 * the rest free for later slices.
 *
 * Fixed rather than chosen per Environment: each Environment has its own VPC
 * and nothing peers them, so two never need distinct ranges, and an operator
 * who later peers one with their own network reads the range here. `10.80`
 * rather than `10.0` because the operator's own VPCs, which a later peering
 * would meet, most often start at `10.0`.
 */
export const NETWORK_ADDRESS_RANGE = {
  vpc: '10.80.0.0/16',
  publicSubnets: ['10.80.0.0/20', '10.80.16.0/20'],
  privateSubnets: ['10.80.128.0/20', '10.80.144.0/20'],
} as const;

/**
 * The outputs the network's Apply saves and a Service's definition
 * reads back as its {@link NetworkIds}, plus what the console shows (the load
 * balancer's DNS name for the operator's record) and what a Domain needs
 * later (the private subnets for slice 4, the default certificate).
 */
export const NETWORK_OUTPUTS = {
  vpcId: 'vpc_id',
  publicSubnetIds: 'public_subnet_ids',
  privateSubnetIds: 'private_subnet_ids',
  clusterArn: 'cluster_arn',
  albArn: 'alb_arn',
  albDnsName: 'alb_dns_name',
  albZoneId: 'alb_zone_id',
  albSecurityGroupId: 'alb_security_group_id',
  httpsListenerArn: 'https_listener_arn',
  defaultCertificateArn: 'default_certificate_arn',
  /** Only once a Private web service has needed it. */
  privateDnsNamespaceId: 'private_dns_namespace_id',
} as const;

export interface NetworkDefinitionInput {
  /** Cloudgate's id of the Cloud account, for the mark. */
  readonly cloudAccountId: string;
  readonly account: AwsAccountAccess;
  readonly region: string;
  readonly environmentId: string;
  /** The network's Infrastructure state. */
  readonly stateId: string;
  /**
   * The parts the network holds once a Service has needed them:
   * the row's, and those a plan's network step adds. On AWS the one kind
   * is `private-dns`, the namespace its Private web services are listed
   * in; another cloud's kinds are not written here. Absent or empty: none.
   */
  readonly privateLinks?: readonly NetworkLinkKind[];
  /**
   * The standing pieces of a hosted cloud build (ADR-0047): true on
   * the Hosted instance, whose cloud Services build in CodeBuild in the
   * Cloud account, and false or absent on a Self-hosted one, which builds
   * on its platform host and makes none of them.
   */
  readonly cloudBuilds?: boolean;
}

/**
 * The buildspec a build project keeps when a build names none. Every cloud
 * build starts with its own, so a build that reaches this one is
 * started by something other than Cloudgate, and fails saying so.
 */
export const BUILD_PROJECT_DEFAULT_BUILDSPEC = [
  'version: 0.2',
  'phases:',
  '  build:',
  '    commands:',
  '      - echo "Cloudgate starts each build with its own buildspec" && exit 1',
  '',
].join('\n');

/** Where in the source bucket a build's zip goes, unless the build names its own. */
export const BUILD_SOURCE_DEFAULT_KEY = 'source.zip';

/**
 * The TLS policy on the HTTPS listener: TLS 1.3 and 1.2 only, AWS's current
 * recommended policy for a new ALB.
 */
const TLS_POLICY = 'ELBSecurityPolicy-TLS13-1-2-2021-06';

const ANYWHERE = '0.0.0.0/0';

/**
 * The OpenTofu definition of an Environment network's state (the AWS spec, "The
 * Environment network"). Pure: no AWS call, no `tofu`.
 *
 * It holds one VPC across two zones with an internet gateway, a public subnet
 * in each zone, two private subnets left empty for slice 4's databases, and
 * one ALB with its security group: port 80 redirects to 443, and the HTTPS
 * listener's default certificate is self-signed, made by Cloudgate
 * (`default-certificate.ts`) and imported into ACM, since a listener needs
 * one before any Domain has its own. A request no Service's rule takes gets
 * a 404.
 *
 * **No NAT gateway and no interface endpoints** until a Stack VM needs one:
 * tasks run on public IPs that only the ALB's security group can reach,
 * which keeps the idle cost at its floor. The first Stack VM adds a NAT
 * gateway (`nat-gateway` among `privateLinks`, `nat-gateway.ts`), its
 * Elastic IP and the private subnets' route through it. A route table and its two associations are here too, because
 * without them the internet gateway routes nothing; they are part of "an
 * internet gateway" rather than an addition to the shape.
 *
 * **The ECS cluster is here as well**, which the spec's list does not name:
 * every ECS service needs one, a cluster costs nothing, and one per
 * Environment is the grouping an operator expects in the ECS console. The
 * other places were worse: AWS's `default` cluster does not exist in a fresh
 * account, and a cluster per Service would add a resource to every Service's
 * state for nothing it does.
 *
 * **The private DNS namespace**, once a Private web service has
 * needed it: a Cloud Map private DNS namespace, `cloudgate.internal`, on
 * the network's VPC, which each `web-private` lists its tasks in. Kept
 * after the last one goes, until the network does. A network with none has
 * none of it.
 *
 * The two zones are the region's first two that need no opt-in, by name,
 * read when `tofu` plans; filtering on a zone's current health instead would
 * move the subnets when a zone has a bad day.
 */
export function networkDefinition(
  input: NetworkDefinitionInput,
): TofuDefinition {
  const mark = {
    cloudAccountId: input.cloudAccountId,
    environmentId: input.environmentId,
    stateId: input.stateId,
  };
  const label = (part: string) =>
    `cloudgate/env-${input.environmentId}/${part}`;
  const zone = (index: number) =>
    `\${data.aws_availability_zones.zones.names[${index}]}`;
  const r = new Resources();

  const vpc = r.tagged('aws_vpc', 'network', label('vpc'), {
    cidr_block: NETWORK_ADDRESS_RANGE.vpc,
    enable_dns_support: true,
    enable_dns_hostnames: true,
  });
  const gateway = r.tagged(
    'aws_internet_gateway',
    'network',
    label('internet-gateway'),
    { vpc_id: ref(vpc, 'id') },
  );

  const subnet = (local: string, cidr: string, index: number, part: string) =>
    r.tagged('aws_subnet', local, label(part), {
      vpc_id: ref(vpc, 'id'),
      cidr_block: cidr,
      availability_zone: zone(index),
    });
  const publicA = subnet(
    'public_a',
    NETWORK_ADDRESS_RANGE.publicSubnets[0],
    0,
    'public-a',
  );
  const publicB = subnet(
    'public_b',
    NETWORK_ADDRESS_RANGE.publicSubnets[1],
    1,
    'public-b',
  );
  const privateA = subnet(
    'private_a',
    NETWORK_ADDRESS_RANGE.privateSubnets[0],
    0,
    'private-a',
  );
  const privateB = subnet(
    'private_b',
    NETWORK_ADDRESS_RANGE.privateSubnets[1],
    1,
    'private-b',
  );

  const routes = r.tagged('aws_route_table', 'public', label('public-routes'), {
    vpc_id: ref(vpc, 'id'),
  });
  r.untagged('aws_route', 'internet', {
    route_table_id: ref(routes, 'id'),
    destination_cidr_block: ANYWHERE,
    gateway_id: ref(gateway, 'id'),
  });
  for (const [local, id] of [
    ['public_a', publicA],
    ['public_b', publicB],
  ] as const) {
    r.untagged('aws_route_table_association', local, {
      subnet_id: ref(id, 'id'),
      route_table_id: ref(routes, 'id'),
    });
  }

  const albGroup = r.tagged(
    'aws_security_group',
    'alb',
    label('load-balancer'),
    {
      name: 'cloudgate-load-balancer',
      description: 'Cloudgate: the Environment load balancer',
      vpc_id: ref(vpc, 'id'),
      ingress: [80, 443].map((port) =>
        rule({ port, protocol: 'tcp', cidr: ANYWHERE }),
      ),
      // Only into the VPC: the load balancer's one job is reaching tasks.
      egress: [
        rule({ port: 0, protocol: '-1', cidr: NETWORK_ADDRESS_RANGE.vpc }),
      ],
    },
  );

  const balancer = r.tagged('aws_lb', 'network', label('load-balancer'), {
    name_prefix: 'cg-',
    load_balancer_type: 'application',
    internal: false,
    security_groups: [ref(albGroup, 'id')],
    subnets: [ref(publicA, 'id'), ref(publicB, 'id')],
    drop_invalid_header_fields: true,
  });

  // Made by Cloudgate (`default-certificate.ts`) and handed in as variables;
  // a new one comes with every run, so after the first import they are
  // ignored rather than re-imported each time.
  const certificate = r.tagged(
    'aws_acm_certificate',
    'default',
    label('default-certificate'),
    {
      private_key: `\${var.${DEFAULT_CERTIFICATE_VARIABLES.privateKey}}`,
      certificate_body: `\${var.${DEFAULT_CERTIFICATE_VARIABLES.certificate}}`,
      lifecycle: { ignore_changes: ['private_key', 'certificate_body'] },
    },
  );

  r.tagged('aws_lb_listener', 'http', label('http'), {
    load_balancer_arn: ref(balancer, 'arn'),
    port: 80,
    protocol: 'HTTP',
    default_action: {
      type: 'redirect',
      redirect: { port: '443', protocol: 'HTTPS', status_code: 'HTTP_301' },
    },
  });
  const https = r.tagged('aws_lb_listener', 'https', label('https'), {
    load_balancer_arn: ref(balancer, 'arn'),
    port: 443,
    protocol: 'HTTPS',
    ssl_policy: TLS_POLICY,
    certificate_arn: ref(certificate, 'arn'),
    default_action: {
      type: 'fixed-response',
      fixed_response: {
        content_type: 'text/plain',
        status_code: '404',
        message_body: 'No Service answers on this address',
      },
    },
  });

  const cluster = r.tagged('aws_ecs_cluster', 'network', label('cluster'), {
    name: `cloudgate-${input.environmentId}`,
  });

  // A Private web service's address resolves in it.
  const namespace = (input.privateLinks ?? []).includes('private-dns')
    ? r.tagged(
        'aws_service_discovery_private_dns_namespace',
        'network',
        label('private-dns'),
        {
          name: PRIVATE_DNS_NAMESPACE,
          description:
            "Cloudgate: this Environment's Private web services, by Config name",
          vpc: ref(vpc, 'id'),
        },
      )
    : null;

  // A Stack VM's way out (`nat-gateway.ts`): the private subnets'
  // default route through a NAT gateway in the first public subnet.
  if ((input.privateLinks ?? []).includes(NAT_GATEWAY_LINK)) {
    const address = r.tagged('aws_eip', 'nat', label('nat-address'), {
      domain: 'vpc',
    });
    const nat = r.tagged('aws_nat_gateway', 'nat', label('nat-gateway'), {
      allocation_id: ref(address, 'id'),
      subnet_id: ref(publicA, 'id'),
      depends_on: [gateway],
    });
    const privateRoutes = r.tagged(
      'aws_route_table',
      'private',
      label('private-routes'),
      { vpc_id: ref(vpc, 'id') },
    );
    r.untagged('aws_route', 'private_internet', {
      route_table_id: ref(privateRoutes, 'id'),
      destination_cidr_block: ANYWHERE,
      nat_gateway_id: ref(nat, 'id'),
    });
    for (const [local, id] of [
      ['private_a', privateA],
      ['private_b', privateB],
    ] as const) {
      r.untagged('aws_route_table_association', local, {
        subnet_id: ref(id, 'id'),
        route_table_id: ref(privateRoutes, 'id'),
      });
    }
  }

  if (input.cloudBuilds) buildPieces(r, input, label);

  const output = (value: unknown) => ({ value });
  return {
    ...frame(input.account, input.region, mark),
    variable: {
      [DEFAULT_CERTIFICATE_VARIABLES.certificate]: { type: 'string' },
      [DEFAULT_CERTIFICATE_VARIABLES.privateKey]: {
        type: 'string',
        sensitive: true,
      },
    },
    data: {
      aws_availability_zones: {
        zones: {
          filter: {
            name: 'opt-in-status',
            values: ['opt-in-not-required'],
          },
        },
      },
    },
    resource: r.all(),
    output: {
      [NETWORK_OUTPUTS.vpcId]: output(ref(vpc, 'id')),
      [NETWORK_OUTPUTS.publicSubnetIds]: output([
        ref(publicA, 'id'),
        ref(publicB, 'id'),
      ]),
      [NETWORK_OUTPUTS.privateSubnetIds]: output([
        ref(privateA, 'id'),
        ref(privateB, 'id'),
      ]),
      [NETWORK_OUTPUTS.clusterArn]: output(ref(cluster, 'arn')),
      [NETWORK_OUTPUTS.albArn]: output(ref(balancer, 'arn')),
      [NETWORK_OUTPUTS.albDnsName]: output(ref(balancer, 'dns_name')),
      [NETWORK_OUTPUTS.albZoneId]: output(ref(balancer, 'zone_id')),
      [NETWORK_OUTPUTS.albSecurityGroupId]: output(ref(albGroup, 'id')),
      [NETWORK_OUTPUTS.httpsListenerArn]: output(ref(https, 'arn')),
      [NETWORK_OUTPUTS.defaultCertificateArn]: output(ref(certificate, 'arn')),
      ...(namespace
        ? {
            [NETWORK_OUTPUTS.privateDnsNamespaceId]: output(
              ref(namespace, 'id'),
            ),
          }
        : {}),
    },
  };
}

/**
 * The standing pieces of a hosted cloud build in this Environment (ADR-0047),
 * the only part of a cloud build OpenTofu makes (ADR-0030): starting,
 * watching and stopping a build are API calls.
 *
 * - **The source bucket**, where the platform host uploads each build's zip:
 *   private as every bucket Cloudgate makes (Block Public Access, ACLs off,
 *   SSE-S3), in the account regional namespace, and `force_destroy` on,
 *   since it holds nothing but Cloudgate's own zips and must not keep the
 *   network from going.
 * - **The log group** the builds write to, as the build identity may.
 * - **The CodeBuild project**, run as the Cloud account's build identity
 *   (made by its setup, never here), starting from the pinned Cloudgate
 *   builder image with its own Docker daemon (`privileged_mode`) and
 *   CodeBuild's local layer cache, writing only to the log group.
 *
 * Their names are `cloud-build-names.ts`'s, which the build identity's
 * policy is scoped to.
 */
function buildPieces(
  r: Resources,
  input: NetworkDefinitionInput,
  label: (part: string) => string,
): void {
  const names = buildPieceNames({
    accountId: input.account.awsAccountId,
    tagValue: input.cloudAccountId,
    environmentId: input.environmentId,
    region: input.region,
  });

  const bucket = r.tagged(
    'aws_s3_bucket',
    'build_source',
    label('build-source'),
    {
      bucket: names.sourceBucketName,
      bucket_namespace: 'account-regional',
      force_destroy: true,
    },
  );
  const id = ref(bucket, 'id');
  r.untagged('aws_s3_bucket_public_access_block', 'build_source', {
    bucket: id,
    block_public_acls: true,
    block_public_policy: true,
    ignore_public_acls: true,
    restrict_public_buckets: true,
  });
  r.untagged('aws_s3_bucket_ownership_controls', 'build_source', {
    bucket: id,
    rule: [{ object_ownership: 'BucketOwnerEnforced' }],
  });
  r.untagged(
    'aws_s3_bucket_server_side_encryption_configuration',
    'build_source',
    {
      bucket: id,
      rule: [
        {
          apply_server_side_encryption_by_default: [
            { sse_algorithm: 'AES256' },
          ],
        },
      ],
    },
  );

  const logs = r.tagged(
    'aws_cloudwatch_log_group',
    'build',
    label('build-logs'),
    {
      name: names.logGroupName,
      retention_in_days: BUILD_LOG_RETENTION_DAYS,
    },
  );

  r.tagged('aws_codebuild_project', 'build', label('build'), {
    name: names.projectName,
    description: "Cloudgate: this Environment's cloud Service builds",
    service_role: names.buildRoleArn,
    artifacts: [{ type: 'NO_ARTIFACTS' }],
    source: [
      {
        type: 'S3',
        location: `${ref(bucket, 'bucket')}/${BUILD_SOURCE_DEFAULT_KEY}`,
        buildspec: BUILD_PROJECT_DEFAULT_BUILDSPEC,
      },
    ],
    environment: [
      {
        type: 'LINUX_CONTAINER',
        compute_type: 'BUILD_GENERAL1_MEDIUM',
        image: CLOUD_BUILDER_IMAGE,
        // A public image: CodeBuild pulls it with no credential of the
        // build identity's.
        image_pull_credentials_type: 'CODEBUILD',
        privileged_mode: true,
      },
    ],
    cache: [{ type: 'LOCAL', modes: ['LOCAL_DOCKER_LAYER_CACHE'] }],
    logs_config: [
      {
        cloudwatch_logs: [{ status: 'ENABLED', group_name: ref(logs, 'name') }],
        s3_logs: [{ status: 'DISABLED' }],
      },
    ],
  });
}
