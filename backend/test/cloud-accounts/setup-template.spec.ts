import {
  actionMatches,
  AWS_POLICY_VERSION,
  awsPolicyVersion,
  makesBuildIdentity,
  SELF_HOSTED_AWS_POLICY_VERSION,
  setupNames,
  CLOUD_ACCOUNT_TAG_KEY,
  deployRoleManagedPolicy,
  deployRolePolicy,
  deployRoleStackVmPolicy,
  requiredActions,
  UNSIMULATED_ACTIONS,
  setupTemplate,
  simulationChecks,
} from '../../src/cloud-accounts/aws/setup-template';
import type { PolicyStatement } from '../../src/cloud-accounts/aws/setup-template';
import { registryPasswordParameterName } from '../../src/cloud-accounts/aws/cloud-build-names';

const ACCOUNT = '123456789012';
const TAG = 'cloud-account-id-1';
const EXTERNAL_ID = 'external-id-abc';

/**
 * Every statement of the deploy role's policies, its inline one and its
 * managed one, that grants `action`, by name or by a wildcard.
 */
function grants(action: string): PolicyStatement[] {
  const ids = { accountId: ACCOUNT, tagValue: TAG };
  return [
    ...deployRolePolicy(ids).Statement,
    ...(deployRoleManagedPolicy(ids)?.Statement ?? []),
    ...(deployRoleStackVmPolicy(ids)?.Statement ?? []),
  ].filter((statement) =>
    statement.Action.some((granted) => actionMatches(granted, action)),
  );
}

describe('requiredActions', () => {
  it('lists every action once, from the policy table and the spec additions', () => {
    const actions = requiredActions(AWS_POLICY_VERSION);

    expect(new Set(actions).size).toBe(actions.length);
    for (const action of [
      // One per service the table covers.
      'ecr:GetAuthorizationToken',
      'ecr:CreateRepository',
      'ecs:CreateService',
      'ecs:RegisterTaskDefinition',
      // The Environment network's own ECS cluster: a fresh account has none.
      'ecs:CreateCluster',
      'ecs:DescribeClusters',
      'ecs:DeleteCluster',
      'ecs:TagResource',
      'elasticloadbalancing:CreateLoadBalancer',
      'ec2:CreateVpc',
      'logs:CreateLogGroup',
      'tag:GetResources',
      'iam:CreateServiceLinkedRole',
      // The spec's additions.
      'acm:ImportCertificate',
      'acm:RequestCertificate',
      'ssm:PutParameter',
      'ssm:DescribeParameters',
      'iam:SimulatePrincipalPolicy',
      'iam:PassRole',
      'iam:CreateRole',
      'iam:PutRolePolicy',
      'iam:DeleteRolePolicy',
      'iam:DeleteRole',
      'iam:TagRole',
    ]) {
      expect(actions).toContain(action);
    }
  });

  it('refuses a policy version it does not know', () => {
    expect(() => requiredActions(AWS_POLICY_VERSION + 1)).toThrow(
      `No AWS policy version ${AWS_POLICY_VERSION + 1}`,
    );
  });
});

describe('deployRolePolicy', () => {
  it('scopes every create by aws:RequestTag with this Cloud account tag value', () => {
    for (const action of [
      'ecr:CreateRepository',
      'ecs:CreateCluster',
      'elasticloadbalancing:CreateTargetGroup',
      'ec2:CreateVpc',
      'logs:CreateLogGroup',
      'acm:RequestCertificate',
      'acm:ImportCertificate',
    ]) {
      const [statement, ...others] = grants(action);
      expect(others).toEqual([]);
      expect(statement.Condition).toEqual({
        StringEquals: { 'aws:RequestTag/cloudgate:cloud-account': TAG },
      });
    }
  });

  it('scopes every change and delete by aws:ResourceTag with the same value', () => {
    for (const action of [
      'ecr:DeleteRepository',
      'ecr:PutImage',
      'ecs:UpdateService',
      'ecs:DeleteService',
      'ecs:DeleteCluster',
      'elasticloadbalancing:DeleteLoadBalancer',
      'elasticloadbalancing:ModifyRule',
      'ec2:DeleteVpc',
      'ec2:AuthorizeSecurityGroupIngress',
      'logs:DeleteLogGroup',
      'acm:DeleteCertificate',
    ]) {
      const [statement, ...others] = grants(action);
      expect(others).toEqual([]);
      expect(statement.Condition).toEqual({
        StringEquals: { 'aws:ResourceTag/cloudgate:cloud-account': TAG },
      });
    }
  });

  it('lets a create tag what it makes only as part of that create', () => {
    const [ec2Create] = grants('ec2:CreateTags').filter(
      (statement) => statement.Condition?.StringEquals?.['ec2:CreateAction'],
    );
    expect(ec2Create.Condition?.StringEquals).toMatchObject({
      'aws:RequestTag/cloudgate:cloud-account': TAG,
    });
    expect(ec2Create.Condition?.StringEquals?.['ec2:CreateAction']).toContain(
      'CreateVpc',
    );
  });

  it('holds SSM to parameter/cloudgate/* and lists parameters anywhere', () => {
    const [put] = grants('ssm:PutParameter');
    expect(put.Resource).toEqual([
      `arn:aws:ssm:*:${ACCOUNT}:parameter/cloudgate/*`,
    ]);
    expect(grants('ssm:DescribeParameters')[0].Resource).toEqual(['*']);
  });

  it("holds S3 to buckets in the account's own regional namespace", () => {
    for (const action of [
      's3:CreateBucket',
      's3:PutBucketCORS',
      's3:PutBucketPublicAccessBlock',
      's3:PutEncryptionConfiguration',
      's3:PutBucketTagging',
      's3:DeleteBucket',
    ]) {
      const [statement, ...others] = grants(action);
      expect(others).toEqual([]);
      expect(statement.Resource).toEqual([`arn:aws:s3:::*-${ACCOUNT}-*-an`]);
    }
  });

  it("lists the account's buckets for an existing bucket's lookup, and reaches none of their settings", () => {
    expect(grants('s3:ListAllMyBuckets')[0].Resource).toEqual(['*']);
    expect(grants('s3:PutBucketCORS')[0].Resource).toEqual([
      `arn:aws:s3:::*-${ACCOUNT}-*-an`,
    ]);
  });

  it("reads and empties only its own buckets' files, for a bucket's Delete", () => {
    expect(grants('s3:ListBucketVersions')[0].Resource).toEqual([
      `arn:aws:s3:::*-${ACCOUNT}-*-an`,
    ]);
    for (const action of ['s3:DeleteObject', 's3:DeleteObjectVersion']) {
      const [statement, ...others] = grants(action);
      expect(others).toEqual([]);
      expect(statement.Resource).toEqual([`arn:aws:s3:::*-${ACCOUNT}-*-an/*`]);
    }
  });

  it("lets a static site's bucket take its policy, and holds CloudFront to this AWS account", () => {
    for (const action of ['s3:PutBucketPolicy', 's3:DeleteBucketPolicy']) {
      const [statement, ...others] = grants(action);
      expect(others).toEqual([]);
      expect(statement.Resource).toEqual([`arn:aws:s3:::*-${ACCOUNT}-*-an`]);
    }
    for (const action of [
      'cloudfront:CreateDistribution',
      'cloudfront:UpdateDistribution',
      'cloudfront:DeleteDistribution',
      'cloudfront:CreateOriginAccessControl',
      'cloudfront:CreateFunction',
      'cloudfront:PublishFunction',
    ]) {
      const [statement, ...others] = grants(action);
      expect(others).toEqual([]);
      expect(statement.Resource).toEqual([
        `arn:aws:cloudfront::${ACCOUNT}:distribution/*`,
        `arn:aws:cloudfront::${ACCOUNT}:origin-access-control/*`,
        `arn:aws:cloudfront::${ACCOUNT}:function/*`,
      ]);
    }
  });

  it("uploads a static site's files to its own bucket, and clears and reads its distribution, in this AWS account only", () => {
    const [put, ...others] = grants('s3:PutObject');
    expect(others).toEqual([]);
    expect(put.Resource).toEqual([`arn:aws:s3:::*-${ACCOUNT}-*-an/*`]);
    for (const action of [
      'cloudfront:CreateInvalidation',
      'cloudfront:GetInvalidation',
      'cloudfront:GetDistribution',
    ]) {
      const [statement, ...rest] = grants(action);
      expect(rest).toEqual([]);
      expect(statement.Resource).toContain(
        `arn:aws:cloudfront::${ACCOUNT}:distribution/*`,
      );
    }
  });

  it('lets the role simulate only its own policy', () => {
    expect(grants('iam:SimulatePrincipalPolicy')[0].Resource).toEqual([
      `arn:aws:iam::${ACCOUNT}:role/cloudgate-deploy-${TAG}`,
    ]);
  });

  it("passes roles only to ECS tasks, the build identity only to CodeBuild, and a Stack VM's roles only to EC2 and DLM", () => {
    const [passRole, toBuilds, toStackVms, ...more] = grants('iam:PassRole');
    expect(more).toEqual([]);
    expect(toStackVms.Sid).toBe('StackVmPassRoles');
    expect(passRole.Resource).toEqual([
      `arn:aws:iam::${ACCOUNT}:role/cloudgate-task-execution-${TAG}`,
      `arn:aws:iam::${ACCOUNT}:role/cloudgate/cloudgate-*`,
    ]);
    expect(passRole.Condition).toEqual({
      StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' },
    });
    expect(toBuilds.Resource).toEqual([
      `arn:aws:iam::${ACCOUNT}:role/cloudgate-build-${TAG}`,
    ]);
    expect(toBuilds.Condition).toEqual({
      StringEquals: { 'iam:PassedToService': 'codebuild.amazonaws.com' },
    });
  });

  it('makes task roles only under /cloudgate/, named cloudgate-, inside the boundary', () => {
    const [createRole] = grants('iam:CreateRole');
    expect(createRole.Resource).toEqual([
      `arn:aws:iam::${ACCOUNT}:role/cloudgate/cloudgate-*`,
    ]);
    expect(createRole.Condition).toEqual({
      StringEquals: {
        'aws:RequestTag/cloudgate:cloud-account': TAG,
        'iam:PermissionsBoundary': `arn:aws:iam::${ACCOUNT}:policy/cloudgate-boundary-${TAG}`,
      },
    });
    for (const action of ['iam:DeleteRole', 'iam:TagRole']) {
      const [statement] = grants(action);
      expect(statement.Resource).toEqual([
        `arn:aws:iam::${ACCOUNT}:role/cloudgate/cloudgate-*`,
      ]);
      expect(statement.Condition?.StringEquals).toMatchObject({
        'aws:ResourceTag/cloudgate:cloud-account': TAG,
      });
    }
  });

  it('grants every required action, and through a wildcard only reads on *', () => {
    const policy = deployRolePolicy({ accountId: ACCOUNT, tagValue: TAG });
    for (const action of requiredActions(AWS_POLICY_VERSION)) {
      expect(grants(action).length).toBeGreaterThan(0);
    }
    for (const statement of policy.Statement) {
      for (const wildcard of statement.Action.filter((a) => a.includes('*'))) {
        expect(wildcard).toMatch(/^[a-z0-9-]+:Describe\*$/);
        expect(statement.Resource).toEqual(['*']);
        expect(statement.Condition).toBeUndefined();
      }
    }
  });

  describe('a postgres on RDS and a redis on ElastiCache', () => {
    it('creates an instance, a replication group and their groups only with this Cloud account tag', () => {
      for (const action of [
        'rds:CreateDBInstance',
        'rds:CreateDBSubnetGroup',
        'elasticache:CreateCacheSubnetGroup',
        'elasticache:CreateCacheParameterGroup',
      ]) {
        const [statement, ...others] = grants(action);
        expect(others).toEqual([]);
        expect(statement.Condition).toEqual({
          StringEquals: { 'aws:RequestTag/cloudgate:cloud-account': TAG },
        });
      }
    });

    it('creates a replication group with this tag, in groups that carry it', () => {
      const [onCreate, inGroups, ...others] = grants(
        'elasticache:CreateReplicationGroup',
      );
      expect(others).toEqual([]);
      expect(onCreate.Condition).toEqual({
        StringEquals: { 'aws:RequestTag/cloudgate:cloud-account': TAG },
      });
      expect(inGroups.Resource).toEqual([
        `arn:aws:elasticache:*:${ACCOUNT}:parametergroup:*`,
        `arn:aws:elasticache:*:${ACCOUNT}:subnetgroup:*`,
      ]);
      expect(inGroups.Condition).toEqual({
        StringEquals: { 'aws:ResourceTag/cloudgate:cloud-account': TAG },
      });
    });

    it('changes, stops, starts and deletes only what carries the tag', () => {
      for (const action of [
        'rds:ModifyDBInstance',
        'rds:StopDBInstance',
        'rds:StartDBInstance',
        'rds:DeleteDBSubnetGroup',
        'rds:RemoveTagsFromResource',
        'elasticache:ModifyReplicationGroup',
        'elasticache:IncreaseReplicaCount',
        'elasticache:DecreaseReplicaCount',
        'elasticache:ModifyCacheParameterGroup',
        'elasticache:DeleteCacheParameterGroup',
        'elasticache:DeleteCacheSubnetGroup',
      ]) {
        const [statement, ...others] = grants(action);
        expect(others).toEqual([]);
        expect(statement.Condition).toEqual({
          StringEquals: { 'aws:ResourceTag/cloudgate:cloud-account': TAG },
        });
      }
    });

    it('tags one as it is made, and never one another Cloud account tagged', () => {
      for (const action of [
        'rds:AddTagsToResource',
        'elasticache:AddTagsToResource',
      ]) {
        const onCreate = grants(action).find(
          (statement) => statement.Condition?.Null,
        );
        expect(onCreate?.Resource).toEqual(['*']);
        expect(onCreate?.Condition).toEqual({
          StringEquals: { 'aws:RequestTag/cloudgate:cloud-account': TAG },
          Null: { 'aws:ResourceTag/cloudgate:cloud-account': 'true' },
        });
      }
    });

    it("deletes one leaving its final snapshot, held to the snapshot's name", () => {
      const snapshots = [
        `arn:aws:rds:*:${ACCOUNT}:snapshot:*-final-*`,
        `arn:aws:elasticache:*:${ACCOUNT}:snapshot:*-final-*`,
      ];
      for (const action of [
        'rds:DeleteDBInstance',
        'rds:CreateDBSnapshot',
        'elasticache:DeleteReplicationGroup',
        'elasticache:CreateSnapshot',
      ]) {
        const [tagged, ...named] = grants(action);
        expect(tagged.Condition).toEqual({
          StringEquals: { 'aws:ResourceTag/cloudgate:cloud-account': TAG },
        });
        for (const statement of named) {
          expect(statement.Condition).toBeUndefined();
          expect(statement.Resource).toEqual(snapshots);
        }
      }
      expect(grants('rds:CreateDBSnapshot')).toHaveLength(2);
      expect(grants('elasticache:DeleteReplicationGroup')).toHaveLength(2);
    });

    it('reads them, their snapshots and an Existing database anywhere', () => {
      for (const action of [
        'rds:DescribeDBInstances',
        'rds:DescribeDBSubnetGroups',
        'rds:DescribeDBSnapshots',
        'rds:DescribeDBInstanceAutomatedBackups',
        'rds:ListTagsForResource',
        'elasticache:DescribeReplicationGroups',
        'elasticache:DescribeCacheClusters',
        'elasticache:DescribeCacheParameters',
        'elasticache:DescribeSnapshots',
        'elasticache:DescribeServerlessCaches',
        'elasticache:ListTagsForResource',
      ]) {
        const [statement, ...others] = grants(action);
        expect(others).toEqual([]);
        expect(statement.Resource).toEqual(['*']);
        expect(statement.Condition).toBeUndefined();
      }
    });

    it('lets RDS and ElastiCache make their service-linked roles in a fresh account', () => {
      const [statement] = grants('iam:CreateServiceLinkedRole');
      expect(statement.Condition?.StringEquals?.['iam:AWSServiceName']).toEqual(
        expect.arrayContaining([
          'rds.amazonaws.com',
          'elasticache.amazonaws.com',
        ]),
      );
    });
  });

  it('carries a tag value of another Cloud account nowhere', () => {
    const policy = JSON.stringify(
      deployRolePolicy({ accountId: ACCOUNT, tagValue: 'other' }),
    );
    expect(policy).not.toContain(TAG);
  });

  it('fits the 10,240 characters AWS allows a role inline policies', () => {
    const policy = JSON.stringify(
      deployRolePolicy({ accountId: ACCOUNT, tagValue: 'x'.repeat(21) }),
    );
    expect(policy.length).toBeLessThanOrEqual(10_240);
  });

  it('fits its managed policy in the 6,144 characters AWS allows one', () => {
    const policy = JSON.stringify(
      deployRoleManagedPolicy({ accountId: ACCOUNT, tagValue: 'x'.repeat(21) }),
    );
    expect(policy.length).toBeLessThanOrEqual(6_144);
  });

  describe("a Private web service's private DNS", () => {
    it('makes a namespace and a discovery service only with this Cloud account tag', () => {
      for (const action of [
        'servicediscovery:CreatePrivateDnsNamespace',
        'servicediscovery:CreateService',
      ]) {
        const [statement, ...more] = grants(action);
        expect(more).toEqual([]);
        expect(statement.Condition?.StringEquals).toMatchObject({
          'aws:RequestTag/cloudgate:cloud-account': TAG,
        });
      }
    });

    it('changes and deletes them only where they carry the tag, the records ECS left included', () => {
      for (const action of [
        'servicediscovery:UpdateService',
        'servicediscovery:DeleteService',
        'servicediscovery:DeleteNamespace',
        'servicediscovery:DeregisterInstance',
        'servicediscovery:TagResource',
        'servicediscovery:UntagResource',
      ]) {
        const [statement, ...more] = grants(action);
        expect(more).toEqual([]);
        expect(statement.Condition?.StringEquals).toMatchObject({
          'aws:ResourceTag/cloudgate:cloud-account': TAG,
        });
      }
    });

    it("lets Cloud Map make a private namespace's hosted zone, and only Cloud Map", () => {
      const [statement, ...more] = grants('route53:CreateHostedZone');
      expect(more).toEqual([]);
      expect(statement.Action).toEqual(['route53:CreateHostedZone']);
      expect(statement.Resource).toEqual(['*']);
      expect(statement.Condition).toEqual({
        Bool: { 'aws:ViaAWSService': 'true' },
      });
    });

    it("grants no hosted zone's delete: Cloud Map's namespace Delete removes its zone without it", () => {
      expect(grants('route53:DeleteHostedZone')).toEqual([]);
      expect(requiredActions(2)).not.toContain('route53:DeleteHostedZone');
    });

    it("reads the hosted zone, the VPC and the region a private namespace's create needs", () => {
      for (const action of [
        'route53:GetHostedZone',
        'route53:ListHostedZonesByName',
        'ec2:DescribeVpcs',
        'ec2:DescribeRegions',
        'servicediscovery:GetOperation',
        'servicediscovery:GetNamespace',
        'servicediscovery:GetService',
      ]) {
        // Named with the action, so a missing one says which.
        expect([action, grants(action).length > 0]).toEqual([action, true]);
      }
    });

    it('is what version 2 adds over version 1, which never held it, with a Cron service’s RunTask', () => {
      const added = requiredActions(2).filter(
        (action) => !requiredActions(1).includes(action),
      );
      expect(added.sort()).toEqual(
        [
          'ec2:DescribeRegions',
          'ecs:RunTask',
          'route53:CreateHostedZone',
          'route53:GetHostedZone',
          'route53:ListHostedZonesByName',
          'servicediscovery:CreatePrivateDnsNamespace',
          'servicediscovery:CreateService',
          'servicediscovery:DeleteNamespace',
          'servicediscovery:DeleteService',
          'servicediscovery:DeregisterInstance',
          'servicediscovery:GetNamespace',
          'servicediscovery:GetOperation',
          'servicediscovery:GetService',
          'servicediscovery:ListInstances',
          'servicediscovery:ListNamespaces',
          'servicediscovery:ListOperations',
          'servicediscovery:ListServices',
          'servicediscovery:ListTagsForResource',
          'servicediscovery:TagResource',
          'servicediscovery:UntagResource',
          'servicediscovery:UpdateService',
        ].sort(),
      );
      expect(
        deployRoleManagedPolicy({ accountId: ACCOUNT, tagValue: TAG }, 1),
      ).toBeNull();
    });
  });

  describe("a Cron service's runs", () => {
    it('starts a task only of what carries this Cloud account tag, as the ECS writes are scoped', () => {
      const [statement, ...more] = grants('ecs:RunTask');
      expect(more).toEqual([]);
      expect(statement.Condition?.StringEquals).toMatchObject({
        'aws:ResourceTag/cloudgate:cloud-account': TAG,
      });
      expect(
        deployRoleManagedPolicy({ accountId: ACCOUNT, tagValue: TAG })
          ?.Statement,
      ).toContainEqual(statement);
    });

    it('tags the task it starts only inside RunTask and only with the tag, so StopTask can stop it', () => {
      const tagging = grants('ecs:TagResource').find(
        (statement) =>
          (
            statement.Condition?.StringEquals as
              Record<string, unknown> | undefined
          )?.['ecs:CreateAction'] !== undefined &&
          JSON.stringify(statement.Condition).includes('RunTask'),
      );
      expect(tagging?.Condition?.StringEquals).toEqual({
        'aws:RequestTag/cloudgate:cloud-account': TAG,
        'ecs:CreateAction': ['RunTask'],
      });
      const [stop] = grants('ecs:StopTask');
      expect(stop.Condition?.StringEquals).toMatchObject({
        'aws:ResourceTag/cloudgate:cloud-account': TAG,
      });
    });
  });
});

/**
 * A hosted cloud build (ADR-0047): version 3 gives Cloudgate's role
 * CodeBuild on its own tagged projects and the build identity to pass, and
 * nothing else.
 */
describe('awsPolicyVersion: version 3, a hosted cloud build', () => {
  const ids = { accountId: ACCOUNT, tagValue: TAG };
  const statementsOf = (version: number) => [
    ...deployRolePolicy(ids, version).Statement,
    ...(deployRoleManagedPolicy(ids, version)?.Statement ?? []),
  ];

  it('is a version only the Hosted instance ever needed', () => {
    expect(makesBuildIdentity(3)).toBe(true);
    expect(makesBuildIdentity(2)).toBe(false);
  });

  it('adds over version 2 only CodeBuild and a PassRole, in statements of their own', () => {
    const added = requiredActions(3).filter(
      (action) => !requiredActions(2).includes(action),
    );
    expect(added.sort()).toEqual(
      [
        'codebuild:BatchGetBuilds',
        'codebuild:BatchGetProjects',
        'codebuild:CreateProject',
        'codebuild:DeleteProject',
        'codebuild:ListBuildsForProject',
        'codebuild:StartBuild',
        'codebuild:StopBuild',
        'codebuild:UpdateProject',
      ].sort(),
    );
    const before = JSON.stringify(statementsOf(2));
    const newStatements = statementsOf(3).filter(
      (statement) => !before.includes(JSON.stringify(statement)),
    );
    expect(newStatements.map((statement) => statement.Sid)).toEqual([
      'CloudBuildProjectCreate',
      'CloudBuildProjects',
      'PassRoleToBuilds',
    ]);
    for (const statement of newStatements) {
      expect(
        statement.Action.every(
          (action) =>
            action.startsWith('codebuild:') || action === 'iam:PassRole',
        ),
      ).toBe(true);
    }
    // Every statement version 2 had is there unchanged.
    expect(statementsOf(3)).toEqual(expect.arrayContaining(statementsOf(2)));
    expect(deployRolePolicy(ids, 3)).toEqual(deployRolePolicy(ids, 2));
  });

  it('holds codebuild:* to projects that carry this Cloud account tag, and makes one only with it', () => {
    const projects = `arn:aws:codebuild:*:${ACCOUNT}:project/*`;
    const [create] = grants('codebuild:CreateProject').filter(
      (statement) => statement.Sid === 'CloudBuildProjectCreate',
    );
    expect(create).toMatchObject({
      Action: ['codebuild:CreateProject'],
      Resource: [projects],
      Condition: {
        StringEquals: { 'aws:RequestTag/cloudgate:cloud-account': TAG },
      },
    });
    const [tagged, ...more] = grants('codebuild:StartBuild');
    expect(more).toEqual([]);
    expect(tagged).toMatchObject({
      Action: ['codebuild:*'],
      Resource: [projects],
      Condition: {
        StringEquals: { 'aws:ResourceTag/cloudgate:cloud-account': TAG },
      },
    });
  });

  it('leaves the permissions boundary as narrow as version 2 had it', () => {
    const input = { ...ids, externalId: EXTERNAL_ID };
    expect(setupTemplate(input, 3).json.permissionsBoundary).toEqual(
      setupTemplate(input, 2).json.permissionsBoundary,
    );
  });
});

describe('buildIdentityPolicy: the build identity', () => {
  const template = setupTemplate({
    accountId: ACCOUNT,
    externalId: EXTERNAL_ID,
    tagValue: TAG,
  });
  const stack = JSON.parse(template.cloudFormation) as {
    Resources: Record<
      string,
      { Type: string; Properties: Record<string, unknown> }
    >;
    Outputs: Record<string, { Value: string }>;
  };
  const role = template.json.buildRole;
  const roleArn = `arn:aws:iam::${ACCOUNT}:role/cloudgate-build-${TAG}`;

  it('is made by the setup template, one per Cloud account, trusted only by CodeBuild for this AWS account', () => {
    expect(role?.name).toBe(`cloudgate-build-${TAG}`);
    expect(role?.trustPolicy.Statement).toEqual([
      {
        Effect: 'Allow',
        Principal: { Service: 'codebuild.amazonaws.com' },
        Action: 'sts:AssumeRole',
        Condition: { StringEquals: { 'aws:SourceAccount': ACCOUNT } },
      },
    ]);
    expect(stack.Resources.CloudgateBuildRole).toEqual({
      Type: 'AWS::IAM::Role',
      Properties: {
        RoleName: role?.name,
        AssumeRolePolicyDocument: role?.trustPolicy,
        Policies: [
          { PolicyName: 'cloudgate-build', PolicyDocument: role?.policy },
        ],
      },
    });
    expect(stack.Outputs.BuildRoleArn).toEqual({ Value: roleArn });
  });

  it('can do exactly this: read its source, push to tagged repositories, write build logs, read its build parameters', () => {
    expect(role?.policy).toEqual({
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'ReadItsSource',
          Effect: 'Allow',
          Action: ['s3:GetObject', 's3:GetObjectVersion'],
          Resource: [
            expect.stringMatching(
              new RegExp(
                `^arn:aws:s3:::cgsrc-[0-9a-f]{10}-\\*-${ACCOUNT}-\\*-an/\\*$`,
              ),
            ),
          ],
        },
        {
          Sid: 'FindItsSource',
          Effect: 'Allow',
          Action: ['s3:GetBucketAcl', 's3:GetBucketLocation'],
          Resource: [
            expect.stringMatching(
              new RegExp(
                `^arn:aws:s3:::cgsrc-[0-9a-f]{10}-\\*-${ACCOUNT}-\\*-an$`,
              ),
            ),
          ],
        },
        {
          Sid: 'SignInToRegistry',
          Effect: 'Allow',
          Action: ['ecr:GetAuthorizationToken'],
          Resource: ['*'],
        },
        {
          Sid: 'PushToTaggedRepositories',
          Effect: 'Allow',
          Action: [
            'ecr:BatchCheckLayerAvailability',
            'ecr:BatchGetImage',
            'ecr:GetDownloadUrlForLayer',
            'ecr:InitiateLayerUpload',
            'ecr:UploadLayerPart',
            'ecr:CompleteLayerUpload',
            'ecr:PutImage',
          ],
          Resource: [`arn:aws:ecr:*:${ACCOUNT}:repository/*`],
          Condition: {
            StringEquals: { 'aws:ResourceTag/cloudgate:cloud-account': TAG },
          },
        },
        {
          Sid: 'WriteBuildLogs',
          Effect: 'Allow',
          Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
          Resource: [
            `arn:aws:logs:*:${ACCOUNT}:log-group:/cloudgate/build/${TAG}/*`,
            `arn:aws:logs:*:${ACCOUNT}:log-group:/cloudgate/build/${TAG}/*:log-stream:*`,
          ],
        },
        {
          Sid: 'ReadItsBuildParameters',
          Effect: 'Allow',
          Action: ['ssm:GetParameters'],
          Resource: [
            `arn:aws:ssm:*:${ACCOUNT}:parameter/cloudgate/build/${TAG}/*`,
          ],
        },
      ],
    });
  });

  it("reads only its own Cloud account's build parameters, where a copy build's registry password is", () => {
    const pattern = role?.policy.Statement.find(
      (statement) => statement.Sid === 'ReadItsBuildParameters',
    )?.Resource as string[];
    const arnOf = (tagValue: string) =>
      `arn:aws:ssm:eu-central-1:${ACCOUNT}:parameter${registryPasswordParameterName({ tagValue, deploymentId: 'dep_1' })}`;
    expect(actionMatches(pattern[0], arnOf(TAG))).toBe(true);
    expect(actionMatches(pattern[0], arnOf('another-cloud-account'))).toBe(
      false,
    );
    // A Service's own variables are the deploy role's, never the build's.
    expect(
      actionMatches(
        pattern[0],
        `arn:aws:ssm:eu-central-1:${ACCOUNT}:parameter/cloudgate/${TAG}/web/DATABASE_URL`,
      ),
    ).toBe(false);
  });

  it("is out of reach of the deploy role's own role statements: not under /cloudgate/, and untagged", () => {
    const names = setupNames({ accountId: ACCOUNT, tagValue: TAG });
    expect(actionMatches(names.taskRolePattern, roleArn)).toBe(false);
    expect(stack.Resources.CloudgateBuildRole.Properties).not.toHaveProperty(
      'Tags',
    );
    for (const action of [
      'iam:PutRolePolicy',
      'iam:DeleteRole',
      'iam:TagRole',
    ]) {
      for (const statement of grants(action)) {
        expect(
          statement.Resource.some((pattern) => actionMatches(pattern, roleArn)),
        ).toBe(false);
      }
    }
  });

  it("is not in version 2's template, a Self-hosted instance's", () => {
    const selfHosted = setupTemplate(
      { accountId: ACCOUNT, externalId: EXTERNAL_ID, tagValue: TAG },
      2,
    );
    expect(selfHosted.json.buildRole).toBeUndefined();
    expect(selfHosted.cloudFormation).not.toContain('CloudgateBuildRole');
    expect(selfHosted.cloudFormation).not.toContain('codebuild');
  });
});

describe('setupTemplate', () => {
  const template = setupTemplate({
    accountId: ACCOUNT,
    externalId: EXTERNAL_ID,
    tagValue: TAG,
  });
  const stack = JSON.parse(template.cloudFormation) as {
    Description: string;
    Resources: Record<
      string,
      { Type: string; Properties: Record<string, unknown> }
    >;
  };

  it('names its policy version', () => {
    expect(template.policyVersion).toBe(AWS_POLICY_VERSION);
    expect(stack.Description).toContain(`policy version ${AWS_POLICY_VERSION}`);
  });

  it('makes the deploy role and its Stack VM policy, the task execution role, the build identity, the boundary and the user', () => {
    expect(
      Object.values(stack.Resources)
        .map((resource) => resource.Type)
        .sort(),
    ).toEqual([
      'AWS::IAM::ManagedPolicy',
      'AWS::IAM::ManagedPolicy',
      'AWS::IAM::ManagedPolicy',
      'AWS::IAM::Role',
      'AWS::IAM::Role',
      'AWS::IAM::Role',
      'AWS::IAM::User',
    ]);
  });

  it("attaches the deploy role's managed policies to it", () => {
    expect(stack.Resources.CloudgateDeployRole.Properties).toMatchObject({
      ManagedPolicyArns: [
        { Ref: 'CloudgateDeployManagedPolicy' },
        { Ref: 'CloudgateDeployStackVmPolicy' },
      ],
    });
    expect(
      stack.Resources.CloudgateDeployManagedPolicy.Properties,
    ).toMatchObject({
      ManagedPolicyName: `cloudgate-deploy-managed-${TAG}`,
      PolicyDocument: template.json.deployRole.managedPolicy?.policy,
    });
  });

  it('trusts only the user, and only with the external id', () => {
    expect(template.json.deployRole.trustPolicy.Statement).toEqual([
      {
        Effect: 'Allow',
        Principal: { AWS: `arn:aws:iam::${ACCOUNT}:user/cloudgate-${TAG}` },
        Action: 'sts:AssumeRole',
        Condition: { StringEquals: { 'sts:ExternalId': EXTERNAL_ID } },
      },
    ]);
  });

  it('lets the user do nothing but take on the deploy role', () => {
    expect(template.json.user.policy.Statement).toEqual([
      {
        Effect: 'Allow',
        Action: 'sts:AssumeRole',
        Resource: `arn:aws:iam::${ACCOUNT}:role/cloudgate-deploy-${TAG}`,
      },
    ]);
  });

  it('gives the task execution role SSM reads on parameter/cloudgate/* and the managed execution policy', () => {
    expect(template.json.taskExecutionRole.managedPolicyArns).toEqual([
      'arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy',
    ]);
    expect(template.json.taskExecutionRole.policy.Statement).toEqual([
      {
        Effect: 'Allow',
        Action: ['ssm:GetParameters'],
        Resource: [`arn:aws:ssm:*:${ACCOUNT}:parameter/cloudgate/*`],
      },
    ]);
  });

  it("bounds every task role to the objects of this account's buckets, Cloudgate's namespace and an existing one's, never their settings", () => {
    const objectActions = [
      's3:GetObject',
      's3:PutObject',
      's3:DeleteObject',
      's3:AbortMultipartUpload',
      's3:ListMultipartUploadParts',
    ];
    const listActions = ['s3:ListBucket', 's3:ListBucketMultipartUploads'];
    const thisAccount = { StringEquals: { 's3:ResourceAccount': ACCOUNT } };
    expect(template.json.permissionsBoundary.policy.Statement).toEqual([
      {
        Effect: 'Allow',
        Action: objectActions,
        Resource: [`arn:aws:s3:::*-${ACCOUNT}-*-an/*`],
      },
      {
        Effect: 'Allow',
        Action: listActions,
        Resource: [`arn:aws:s3:::*-${ACCOUNT}-*-an`],
      },
      {
        Effect: 'Allow',
        Action: objectActions,
        Resource: ['arn:aws:s3:::*/*'],
        Condition: thisAccount,
      },
      {
        Effect: 'Allow',
        Action: listActions,
        Resource: ['arn:aws:s3:::*'],
        Condition: thisAccount,
      },
    ]);
  });

  it("lets a task role reach no bucket of another account's, whatever its name", () => {
    const statements: readonly {
      Resource: readonly string[];
      Condition?: unknown;
    }[] = template.json.permissionsBoundary.policy.Statement;
    for (const statement of statements) {
      const inNamespace = statement.Resource.every((resource) =>
        resource.startsWith(`arn:aws:s3:::*-${ACCOUNT}-*-an`),
      );
      if (!inNamespace) {
        expect(statement.Condition).toEqual({
          StringEquals: { 's3:ResourceAccount': ACCOUNT },
        });
      }
    }
  });

  it('is the same content in the CloudFormation template and the plain JSON', () => {
    const deployRole = Object.values(stack.Resources).find(
      (resource) => resource.Properties.RoleName === `cloudgate-deploy-${TAG}`,
    );
    expect(deployRole?.Properties.AssumeRolePolicyDocument).toEqual(
      template.json.deployRole.trustPolicy,
    );
    expect(deployRole?.Properties.Policies).toEqual([
      {
        PolicyName: template.json.deployRole.policyName,
        PolicyDocument: template.json.deployRole.policy,
      },
    ]);
  });
});

describe('simulationChecks', () => {
  const checks = simulationChecks({
    accountId: ACCOUNT,
    tagValue: TAG,
    deployRoleArn: `arn:aws:iam::${ACCOUNT}:role/cloudgate-deploy-${TAG}`,
    taskExecutionRoleArn: `arn:aws:iam::${ACCOUNT}:role/cloudgate-task-execution-${TAG}`,
  });

  it('simulates every required action', () => {
    const simulated = new Set(checks.flatMap((check) => check.actions));
    expect([...simulated].sort()).toEqual(
      [...requiredActions(AWS_POLICY_VERSION)]
        .filter((action) => !UNSIMULATED_ACTIONS.includes(action))
        .sort(),
    );
  });

  it('simulates each CloudFront action on an ARN of its own resource type', () => {
    const typeOf = (action: string) =>
      checks
        .find((check) => check.actions.includes(action))
        ?.resourceArn.split(':')[5]
        ?.split('/')[0];
    expect(typeOf('cloudfront:GetDistribution')).toBe('distribution');
    expect(typeOf('cloudfront:CreateInvalidation')).toBe('distribution');
    expect(typeOf('cloudfront:GetOriginAccessControl')).toBe(
      'origin-access-control',
    );
    expect(typeOf('cloudfront:PublishFunction')).toBe('function');
    expect(typeOf('cloudfront:CreateDistributionWithTags')).toBeUndefined();
  });

  it('passes the Cloud account tag as context to the tag-scoped checks', () => {
    const create = checks.find((check) =>
      check.actions.includes('ec2:CreateVpc'),
    );
    expect(create?.context).toContainEqual({
      key: `aws:RequestTag/${CLOUD_ACCOUNT_TAG_KEY}`,
      values: [TAG],
      type: 'string',
    });
    const change = checks.find((check) =>
      check.actions.includes('ec2:DeleteVpc'),
    );
    expect(change?.context).toContainEqual({
      key: `aws:ResourceTag/${CLOUD_ACCOUNT_TAG_KEY}`,
      values: [TAG],
      type: 'string',
    });
  });

  it("simulates a hosted zone's create as Cloud Map makes it, through an AWS service", () => {
    const create = checks.find((check) =>
      check.actions.includes('route53:CreateHostedZone'),
    );
    expect(create?.actions).toEqual(['route53:CreateHostedZone']);
    expect(create?.context).toEqual([
      { key: 'aws:ViaAWSService', values: ['true'], type: 'boolean' },
    ]);
  });

  it("simulates each final snapshot action on a snapshot of its own service's", () => {
    const rds = checks.find((check) =>
      check.resourceArn.startsWith('arn:aws:rds:'),
    );
    const cache = checks.find(
      (check) =>
        check.resourceArn.startsWith('arn:aws:elasticache:') &&
        check.resourceArn.includes(':snapshot:'),
    );
    expect(rds?.actions).toEqual([
      'rds:CreateDBSnapshot',
      'rds:AddTagsToResource',
    ]);
    expect(rds?.resourceArn).toBe(
      `arn:aws:rds:us-east-1:${ACCOUNT}:snapshot:cloudgate-check-final-2026-01-01`,
    );
    expect(cache?.actions).toEqual([
      'elasticache:CreateSnapshot',
      'elasticache:DeleteReplicationGroup',
    ]);
  });

  it('simulates the self-check on the role ARN the operator typed', () => {
    const self = checks.find((check) =>
      check.actions.includes('iam:SimulatePrincipalPolicy'),
    );
    expect(self?.resourceArn).toBe(
      `arn:aws:iam::${ACCOUNT}:role/cloudgate-deploy-${TAG}`,
    );
  });
});

/**
 * Stack VMs (ADR-0070, #1366): versions 4 and 5 give Cloudgate's role
 * what a Stack VM needs, on both instances alike. The versions fork by
 * mode (ADR-0047): a Self-hosted instance's 4 is version 2 with the Stack
 * VM statements, the Hosted instance's 5 is version 3 with the same, so a
 * Self-hosted Cloud account is never asked for CodeBuild.
 */
describe('awsPolicyVersion: versions 4 and 5, Stack VMs', () => {
  const ids = { accountId: ACCOUNT, tagValue: TAG };
  const statementsOf = (version: number) => [
    ...deployRolePolicy(ids, version).Statement,
    ...(deployRoleManagedPolicy(ids, version)?.Statement ?? []),
    ...(deployRoleStackVmPolicy(ids, version)?.Statement ?? []),
  ];
  const added = (to: number, over: number) =>
    requiredActions(to).filter(
      (action) => !requiredActions(over).includes(action),
    );
  /** Every statement of `version` granting `action`, by name or wildcard. */
  const grantsAt = (version: number, action: string) =>
    statementsOf(version).filter((statement) =>
      statement.Action.some((granted) => actionMatches(granted, action)),
    );
  /** The one Stack VM statement granting `action`. */
  const stackVmStatement = (action: string) => {
    const found = grantsAt(AWS_POLICY_VERSION, action).filter((statement) =>
      statement.Sid?.startsWith('StackVm'),
    );
    expect([action, found.length]).toEqual([action, 1]);
    return found[0];
  };
  const tagged = (key: 'RequestTag' | 'ResourceTag') => ({
    StringEquals: { [`aws:${key}/cloudgate:cloud-account`]: TAG },
  });

  it('is 5 on the Hosted instance and 4 on a Self-hosted one', () => {
    expect(AWS_POLICY_VERSION).toBe(5);
    expect(SELF_HOSTED_AWS_POLICY_VERSION).toBe(4);
    expect(awsPolicyVersion(true)).toBe(5);
    expect(awsPolicyVersion(false)).toBe(4);
  });

  it('adds the same actions over version 2 for a Self-hosted instance as over version 3 for the Hosted one', () => {
    expect(added(4, 2).sort()).toEqual(added(5, 3).sort());
    expect(added(4, 2)).toEqual(
      expect.arrayContaining([
        'ssm:StartSession',
        'ssm:TerminateSession',
        'ec2:RunInstances',
        'ec2:TerminateInstances',
        'ec2:CreateVolume',
        'ec2:DeleteVolume',
        'ec2:AttachVolume',
        'dlm:CreateLifecyclePolicy',
        'dlm:DeleteLifecyclePolicy',
        'iam:CreateInstanceProfile',
        'iam:DeleteInstanceProfile',
        'iam:AddRoleToInstanceProfile',
        'iam:AttachRolePolicy',
      ]),
    );
    // Version 4 asks a Self-hosted Cloud account for no CodeBuild (ADR-0047).
    expect(
      requiredActions(4).filter((action) => action.startsWith('codebuild:')),
    ).toEqual([]);
    expect(statementsOf(4)).toEqual(expect.arrayContaining(statementsOf(2)));
    expect(statementsOf(5)).toEqual(expect.arrayContaining(statementsOf(3)));
  });

  it('makes the build identity only in the Hosted template', () => {
    const input = { ...ids, externalId: EXTERNAL_ID };
    expect(makesBuildIdentity(4)).toBe(false);
    expect(makesBuildIdentity(5)).toBe(true);
    expect(setupTemplate(input, 4).json.buildRole).toBeUndefined();
    expect(setupTemplate(input, 5).json.buildRole).toBeDefined();
  });

  it('starts Session Manager sessions only to instances that carry this Cloud account tag, and ends only its own', () => {
    const start = grantsAt(AWS_POLICY_VERSION, 'ssm:StartSession').find(
      (statement) => statement.Resource.includes('arn:aws:ec2:*:*:instance/*'),
    );
    expect(start?.Condition).toEqual({
      StringEquals: { 'ssm:resourceTag/cloudgate:cloud-account': TAG },
    });
    expect(stackVmStatement('ssm:TerminateSession').Resource).toEqual([
      `arn:aws:ssm:*:${ACCOUNT}:session/cloudgate-*`,
    ]);
  });

  it('makes instances and volumes only with the tag, and changes or removes only what carries it', () => {
    expect(stackVmStatement('ec2:CreateVolume').Condition).toEqual(
      tagged('RequestTag'),
    );
    const launch = grantsAt(AWS_POLICY_VERSION, 'ec2:RunInstances').find(
      (statement) =>
        statement.Resource.some((arn) => arn.endsWith(':instance/*')),
    );
    expect(launch?.Condition).toEqual(tagged('RequestTag'));
    expect(stackVmStatement('dlm:CreateLifecyclePolicy').Condition).toEqual(
      tagged('RequestTag'),
    );
    for (const action of [
      'ec2:TerminateInstances',
      'ec2:StopInstances',
      'ec2:StartInstances',
      'ec2:ModifyInstanceAttribute',
      'ec2:AttachVolume',
      'ec2:DetachVolume',
      'ec2:DeleteVolume',
      'ec2:ModifyVolume',
      'dlm:DeleteLifecyclePolicy',
    ]) {
      expect([action, stackVmStatement(action).Condition]).toEqual([
        action,
        tagged('ResourceTag'),
      ]);
    }
  });

  it("holds the Stack VM's roles and profile to a path of their own, attaching only the two AWS policies they hold", () => {
    const roles = `arn:aws:iam::${ACCOUNT}:role/cloudgate/stack-vm/cloudgate-stack-vm-*`;
    expect(
      grantsAt(AWS_POLICY_VERSION, 'iam:CreateRole').find((statement) =>
        statement.Resource.includes(roles),
      )?.Condition,
    ).toEqual(tagged('RequestTag'));
    const attach = stackVmStatement('iam:AttachRolePolicy');
    expect(attach.Resource).toEqual([roles]);
    expect(attach.Condition).toEqual({
      ...tagged('ResourceTag'),
      ArnEquals: {
        'iam:PolicyARN': [
          'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore',
          'arn:aws:iam::aws:policy/service-role/AWSDataLifecycleManagerServiceRole',
        ],
      },
    });
    // No inline policy on a Stack VM's role: those two are its ceiling.
    expect(
      grantsAt(AWS_POLICY_VERSION, 'iam:PutRolePolicy').flatMap(
        (statement) => statement.Resource,
      ),
    ).not.toContain(roles);
    const pass = grantsAt(AWS_POLICY_VERSION, 'iam:PassRole').find(
      (statement) => statement.Resource.includes(roles),
    );
    expect(pass?.Condition).toEqual({
      StringEquals: {
        'iam:PassedToService': ['ec2.amazonaws.com', 'dlm.amazonaws.com'],
      },
    });
    expect(stackVmStatement('iam:CreateInstanceProfile').Resource).toEqual([
      roles,
      `arn:aws:iam::${ACCOUNT}:instance-profile/cloudgate/stack-vm/cloudgate-stack-vm-*`,
    ]);
  });

  it("reads Canonical's public Ubuntu image parameter, and no other parameter outside Cloudgate's", () => {
    const read = grantsAt(AWS_POLICY_VERSION, 'ssm:GetParameter').find(
      (statement) => statement.Sid?.startsWith('StackVm'),
    );
    expect(read?.Resource).toEqual([
      'arn:aws:ssm:*::parameter/aws/service/canonical/ubuntu/*',
    ]);
  });

  it('puts them in a managed policy of their own, which the deploy role holds', () => {
    const input = { ...ids, externalId: EXTERNAL_ID };
    expect(deployRoleStackVmPolicy(ids, 3)).toBeNull();
    for (const version of [4, 5]) {
      const template = setupTemplate(input, version);
      expect(template.json.deployRole.stackVmPolicy?.name).toBe(
        `cloudgate-deploy-stack-vm-${TAG}`,
      );
      const stack = JSON.parse(template.cloudFormation) as {
        Resources: Record<string, { Properties: Record<string, unknown> }>;
      };
      expect(
        stack.Resources.CloudgateDeployRole.Properties.ManagedPolicyArns,
      ).toEqual([
        { Ref: 'CloudgateDeployManagedPolicy' },
        { Ref: 'CloudgateDeployStackVmPolicy' },
      ]);
      expect(
        stack.Resources.CloudgateDeployStackVmPolicy.Properties.PolicyDocument,
      ).toEqual(deployRoleStackVmPolicy(ids, version));
    }
    // The managed policy versions 2 and 3 had is unchanged.
    expect(deployRoleManagedPolicy(ids, 4)).toEqual(
      deployRoleManagedPolicy(ids, 2),
    );
    expect(deployRoleManagedPolicy(ids, 5)).toEqual(
      deployRoleManagedPolicy(ids, 3),
    );
  });

  it('leaves the permissions boundary as narrow as version 2 had it', () => {
    const input = { ...ids, externalId: EXTERNAL_ID };
    expect(setupTemplate(input, 4).json.permissionsBoundary).toEqual(
      setupTemplate(input, 2).json.permissionsBoundary,
    );
  });

  it('fits both versions in the sizes AWS allows', () => {
    const wide = { accountId: ACCOUNT, tagValue: 'x'.repeat(21) };
    for (const version of [4, 5]) {
      expect(
        JSON.stringify(deployRolePolicy(wide, version)).length,
      ).toBeLessThanOrEqual(10_240);
      for (const managed of [
        deployRoleManagedPolicy(wide, version),
        deployRoleStackVmPolicy(wide, version),
      ]) {
        expect(JSON.stringify(managed).length).toBeLessThanOrEqual(6_144);
      }
    }
  });

  it('simulates every Stack VM action the version requires', () => {
    const simulated = new Set(
      simulationChecks(
        {
          ...ids,
          deployRoleArn: `arn:aws:iam::${ACCOUNT}:role/cloudgate-deploy-${TAG}`,
          taskExecutionRoleArn: `arn:aws:iam::${ACCOUNT}:role/cloudgate-task-execution-${TAG}`,
        },
        4,
      ).flatMap((check) => check.actions),
    );
    for (const action of added(4, 2)) {
      expect([action, simulated.has(action)]).toEqual([action, true]);
    }
  });
});
