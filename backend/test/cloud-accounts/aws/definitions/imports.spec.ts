import {
  importId,
  joinedFinds,
  withImports,
  withNamespaceImportIds,
} from '../../../../src/cloud-accounts/aws/definitions/imports';

const ACCOUNT = '123456789012';
const REGION = 'eu-central-1';

describe('importId', () => {
  it.each([
    ['aws_vpc', `arn:aws:ec2:${REGION}:${ACCOUNT}:vpc/vpc-0a1b`, 'vpc-0a1b'],
    [
      'aws_subnet',
      `arn:aws:ec2:${REGION}:${ACCOUNT}:subnet/subnet-0aaa`,
      'subnet-0aaa',
    ],
    [
      'aws_internet_gateway',
      `arn:aws:ec2:${REGION}:${ACCOUNT}:internet-gateway/igw-1`,
      'igw-1',
    ],
    [
      'aws_route_table',
      `arn:aws:ec2:${REGION}:${ACCOUNT}:route-table/rtb-1`,
      'rtb-1',
    ],
    [
      'aws_security_group',
      `arn:aws:ec2:${REGION}:${ACCOUNT}:security-group/sg-1`,
      'sg-1',
    ],
    [
      'aws_ecs_cluster',
      `arn:aws:ecs:${REGION}:${ACCOUNT}:cluster/cg-env`,
      'cg-env',
    ],
    [
      'aws_ecs_service',
      `arn:aws:ecs:${REGION}:${ACCOUNT}:service/cg-env/web-svc_1`,
      'cg-env/web-svc_1',
    ],
    [
      'aws_ecr_repository',
      `arn:aws:ecr:${REGION}:${ACCOUNT}:repository/cloudgate-svc_1`,
      'cloudgate-svc_1',
    ],
    [
      'aws_ecr_lifecycle_policy',
      `arn:aws:ecr:${REGION}:${ACCOUNT}:repository/cloudgate/svc_1`,
      'cloudgate/svc_1',
    ],
    [
      'aws_iam_role',
      `arn:aws:iam::${ACCOUNT}:role/cloudgate/cloudgate-svc_1`,
      'cloudgate-svc_1',
    ],
    [
      'aws_ssm_parameter',
      `arn:aws:ssm:${REGION}:${ACCOUNT}:parameter/cloudgate/env_1/svc_1/API_KEY`,
      '/cloudgate/env_1/svc_1/API_KEY',
    ],
    [
      'aws_cloudwatch_log_group',
      `arn:aws:logs:${REGION}:${ACCOUNT}:log-group:/cloudgate/env/svc_1:*`,
      '/cloudgate/env/svc_1',
    ],
    [
      'aws_s3_bucket',
      `arn:aws:s3:::uploads-k3f9a2qd-${ACCOUNT}-${REGION}-an`,
      `uploads-k3f9a2qd-${ACCOUNT}-${REGION}-an`,
    ],
    [
      'aws_service_discovery_service',
      `arn:aws:servicediscovery:${REGION}:${ACCOUNT}:service/srv-0a1b2c3d4e5f`,
      'srv-0a1b2c3d4e5f',
    ],
  ])('imports %s by its own id', (type, arn, id) => {
    expect(importId(type, arn)).toBe(id);
  });

  it.each([
    'aws_lb',
    'aws_lb_listener',
    'aws_lb_listener_rule',
    'aws_lb_target_group',
    'aws_ecs_task_definition',
    'aws_acm_certificate',
  ])('imports %s by its ARN', (type) => {
    const arn = `arn:aws:elasticloadbalancing:${REGION}:${ACCOUNT}:targetgroup/cg/1`;
    expect(importId(type, arn)).toBe(arn);
  });
});

describe('joinedFinds', () => {
  const tagged = (address: string, arn: string) => ({
    arn,
    tags: { 'cloudgate:address': address, 'cloudgate:state': 'st_1' },
  });

  it('finds the internet route and the public associations beside the route table and subnets found', () => {
    const found = [
      tagged(
        'aws_route_table.public',
        `arn:aws:ec2:${REGION}:${ACCOUNT}:route-table/rtb-1`,
      ),
      tagged(
        'aws_subnet.public_a',
        `arn:aws:ec2:${REGION}:${ACCOUNT}:subnet/subnet-a`,
      ),
      tagged(
        'aws_subnet.public_b',
        `arn:aws:ec2:${REGION}:${ACCOUNT}:subnet/subnet-b`,
      ),
    ];

    expect(joinedFinds(found, 'st_1')).toEqual([
      tagged('aws_route.internet', 'rtb-1_0.0.0.0/0'),
      tagged('aws_route_table_association.public_a', 'subnet-a/rtb-1'),
      tagged('aws_route_table_association.public_b', 'subnet-b/rtb-1'),
    ]);
    expect(importId('aws_route', 'rtb-1_0.0.0.0/0')).toBe('rtb-1_0.0.0.0/0');
  });

  it('finds nothing joined to what was not found', () => {
    expect(joinedFinds([], 'st_1')).toEqual([]);
  });
});

describe('withImports', () => {
  it('adds an import block for each adoption, and leaves a definition with none as it is', () => {
    const definition = { resource: { aws_vpc: { network: {} } } };
    expect(withImports(definition, [])).toBe(definition);
    expect(
      withImports(definition, [
        {
          address: 'aws_vpc.network',
          resourceType: 'aws_vpc',
          arn: `arn:aws:ec2:${REGION}:${ACCOUNT}:vpc/vpc-0a1b`,
        },
      ]),
    ).toEqual({
      ...definition,
      import: [{ to: 'aws_vpc.network', id: 'vpc-0a1b' }],
    });
  });
});

describe('withNamespaceImportIds', () => {
  const NAMESPACE = 'aws_service_discovery_private_dns_namespace.network';
  const NAMESPACE_ARN = `arn:aws:servicediscovery:${REGION}:${ACCOUNT}:namespace/ns-0a1b2c3d`;
  const tagged = (address: string, arn: string) => ({
    arn,
    tags: { 'cloudgate:address': address, 'cloudgate:state': 'st_1' },
  });
  const vpc = tagged(
    'aws_vpc.network',
    `arn:aws:ec2:${REGION}:${ACCOUNT}:vpc/vpc-0a1b`,
  );
  const adoptNamespace = {
    address: NAMESPACE,
    resourceType: 'aws_service_discovery_private_dns_namespace',
    arn: NAMESPACE_ARN,
    line: "private DNS namespace: found in AWS, taken back into Cloudgate's record",
  };

  it("adopts the network's namespace by its id and the VPC's found beside it, which its Apply imports", () => {
    const [adopted] = withNamespaceImportIds([adoptNamespace], [vpc]);

    expect(adopted).toEqual({ ...adoptNamespace, arn: 'ns-0a1b2c3d:vpc-0a1b' });
    expect(withImports({}, [adopted]).import).toEqual([
      { to: NAMESPACE, id: 'ns-0a1b2c3d:vpc-0a1b' },
    ]);
  });

  it('leaves every other adoption, and the namespace when no VPC was found, as it was', () => {
    const route = {
      address: 'aws_route.internet',
      resourceType: 'aws_route',
      arn: 'rtb-1_0.0.0.0/0',
      line: 'route',
    };

    expect(withNamespaceImportIds([route], [vpc])).toEqual([route]);
    expect(withNamespaceImportIds([adoptNamespace], [])).toEqual([
      adoptNamespace,
    ]);
  });
});

/**
 * A Stack VM found by its mark is taken back, not made twice (ADR-0070,
 * #1359): what a tag search finds of it imports by its own id, and what no
 * tag search sees is implied by what it joins.
 */
describe('importId and joinedFinds, a Stack VM', () => {
  it.each([
    [
      'aws_instance',
      `arn:aws:ec2:${REGION}:${ACCOUNT}:instance/i-0abc`,
      'i-0abc',
    ],
    [
      'aws_ebs_volume',
      `arn:aws:ec2:${REGION}:${ACCOUNT}:volume/vol-0abc`,
      'vol-0abc',
    ],
    [
      'aws_dlm_lifecycle_policy',
      `arn:aws:dlm:${REGION}:${ACCOUNT}:policy/policy-0abc`,
      'policy-0abc',
    ],
  ])('imports a found %s by its id', (type, arn, id) => {
    expect(importId(type, arn)).toBe(id);
  });

  const tagged = (address: string, arn: string) => ({
    arn,
    tags: { 'cloudgate:address': address, 'cloudgate:state': 'st_1' },
  });

  it.each([
    [
      'aws_nat_gateway',
      `arn:aws:ec2:${REGION}:${ACCOUNT}:natgateway/nat-0abc`,
      'nat-0abc',
    ],
    [
      'aws_eip',
      `arn:aws:ec2:${REGION}:${ACCOUNT}:elastic-ip/eipalloc-0abc`,
      'eipalloc-0abc',
    ],
  ])("imports the network's found %s by its id", (type, arn, id) => {
    expect(importId(type, arn)).toBe(id);
  });

  it("takes back the network's private route through the NAT gateway with its route table", () => {
    const found = [
      tagged(
        'aws_route_table.private',
        `arn:aws:ec2:${REGION}:${ACCOUNT}:route-table/rtb-0priv`,
      ),
      tagged(
        'aws_subnet.private_a',
        `arn:aws:ec2:${REGION}:${ACCOUNT}:subnet/subnet-0pa`,
      ),
      tagged(
        'aws_subnet.private_b',
        `arn:aws:ec2:${REGION}:${ACCOUNT}:subnet/subnet-0pb`,
      ),
    ];
    expect(
      Object.fromEntries(
        joinedFinds(found, 'st_1').map((one) => [
          one.tags['cloudgate:address'],
          one.arn,
        ]),
      ),
    ).toEqual({
      'aws_route.private_internet': 'rtb-0priv_0.0.0.0/0',
      'aws_route_table_association.private_a': 'subnet-0pa/rtb-0priv',
      'aws_route_table_association.private_b': 'subnet-0pb/rtb-0priv',
    });
  });

  it('takes back its attachments and instance profile with what they join', () => {
    const found = [
      tagged(
        'aws_instance.stack_vm',
        `arn:aws:ec2:${REGION}:${ACCOUNT}:instance/i-0abc`,
      ),
      tagged(
        'aws_ebs_volume.data',
        `arn:aws:ec2:${REGION}:${ACCOUNT}:volume/vol-0abc`,
      ),
      tagged(
        'aws_iam_role.stack_vm',
        `arn:aws:iam::${ACCOUNT}:role/cloudgate/cloudgate-stack-vm-svc1`,
      ),
      tagged(
        'aws_iam_role.snapshots',
        `arn:aws:iam::${ACCOUNT}:role/cloudgate/cloudgate-stack-vm-snapshots-svc1`,
      ),
    ];

    expect(
      Object.fromEntries(
        joinedFinds(found, 'st_1').map((one) => [
          one.tags['cloudgate:address'],
          one.arn,
        ]),
      ),
    ).toEqual({
      'aws_volume_attachment.data': '/dev/sdf:vol-0abc:i-0abc',
      'aws_iam_instance_profile.stack_vm': 'cloudgate-stack-vm-svc1',
      'aws_iam_role_policy_attachment.session_manager':
        'cloudgate-stack-vm-svc1/arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore',
      'aws_iam_role_policy_attachment.snapshots':
        'cloudgate-stack-vm-snapshots-svc1/arn:aws:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole',
    });
  });
});
