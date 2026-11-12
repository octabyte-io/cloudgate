import { buildIdentityNames, CODEBUILD_SERVICE } from './cloud-build-names';
import {
  BUCKET_LIST_ACTIONS,
  BUCKET_OBJECT_ACTIONS,
} from './definitions/bucket-access';
import {
  SESSION_MANAGER_POLICY,
  SNAPSHOT_POLICY,
  STACK_VM_IAM_PATH,
} from './definitions/stack-vm-definition';

/**
 * The AWS setup template and the deploy role's policy, as one pure, versioned
 * function of a Cloud account's ids (the AWS spec, "Connecting (AWS)").
 *
 * **One table, three readers.** {@link STATEMENTS_BY_VERSION} is the whole
 * permission set, statement by statement, and everything else is derived from
 * it: the policy the template installs ({@link deployRolePolicy}), the action
 * list a version needs ({@link requiredActions}), and what the connect check
 * simulates ({@link simulationChecks}). Three hand-kept lists were the
 * alternative, and the first action added to one and not the others would
 * either go unsimulated — a Cloud account saved half-working — or be simulated
 * and never granted, so no Cloud account could ever connect.
 *
 * **The version is the contract with a role already made.** A role is made
 * from the template once, by the operator, and Cloudgate cannot change it. A
 * Cloud account records the version it was checked against, and a newer
 * Cloudgate that needs more actions adds a version here rather than editing
 * one, so "permissions out of date" can list exactly what is missing.
 * An entry here is never edited after it ships.
 *
 * **Scoping**, from the AWS role and permissions research:
 * - a create is allowed only when it carries this Cloud account's tag
 *   (`aws:RequestTag`), and a change or delete only on what already carries it
 *   (`aws:ResourceTag`), so one Cloud account never touches another's, even in
 *   one AWS account;
 * - the reads AWS offers no narrower scope for (`Describe*`, `List*`,
 *   `GetAuthorizationToken`, `tag:GetResources`) are on `*`;
 * - S3 is held to buckets in the account's own regional namespace,
 *   `*-<account-id>-*-an`, which no other AWS account can name: S3 checks
 *   a bucket's tags only where attribute-based access is turned on for it;
 * - RDS and ElastiCache are held by the tag like the rest; a
 *   database Delete's final snapshot, which carries no tag while AWS
 *   authorizes its making, is held to its name (`*-final-*`) instead;
 * - the role's inline policies must fit AWS's 10,240 characters, so the
 *   `Describe*` reads are written as wildcards (`StatementSpec.wildcards`)
 *   while each action is still required and simulated by name, and what
 *   version 1 left no room for goes in the deploy role's one managed policy
 *   (`StatementSpec.attached`), which AWS allows 6,144 characters;
 * - CloudFront is held to this AWS account's distributions, Origin Access
 *   Controls and functions, a `static` site's;
 * - SSM is held to `parameter/cloudgate/*`, IAM to roles under the
 *   `/cloudgate/` path named `cloudgate-`, and `CreateRole` to roles bounded by
 *   the template's permissions boundary (spec, "A task role per Service"),
 *   which allows a task role nothing but the object actions on this AWS
 *   account's buckets (ADR-0032): its regional namespace's, and any
 *   other of its own by `s3:ResourceAccount`, so an existing one is
 *   reached too and another account's never is; which buckets one reaches
 *   is its own inline policy's, written from its links.
 *
 * The connect check runs in no region, so the simulated ARNs carry a stand-in
 * one; the region check re-runs the simulation in the chosen region
 * (`SimulationIds.region`).
 */

/** The tag every resource a Cloud account makes carries; its value is the Cloud account's id. */
export const CLOUD_ACCOUNT_TAG_KEY = 'cloudgate:cloud-account';

/**
 * The newest policy version this Cloudgate knows: the one the Hosted
 * instance generates and checks against.
 */
export const AWS_POLICY_VERSION = 5;

/**
 * The version a Self-hosted instance generates and checks against (ADR-0047):
 * version 3 adds only what a hosted cloud build needs, and a
 * Self-hosted instance builds on its platform host, so its Cloud accounts are
 * never asked to re-run setup for it. So the versions fork: what both
 * instances need later is added twice, as a Self-hosted version over 2 and
 * a Hosted one over 3 — Stack VMs (ADR-0070) as 4 and 5.
 */
export const SELF_HOSTED_AWS_POLICY_VERSION = 4;

/** The version an instance in this mode generates and checks against. */
export function awsPolicyVersion(hosted: boolean): number {
  return hosted ? AWS_POLICY_VERSION : SELF_HOSTED_AWS_POLICY_VERSION;
}

/** The region simulated ARNs name, since a Cloud account has none. */
const SIMULATED_REGION = 'us-east-1';

const ECS_TASKS = 'ecs-tasks.amazonaws.com';

/** What the names in a Cloud account's policy are made of. */
export interface CloudAccountIds {
  /** The 12-digit AWS account id. */
  accountId: string;
  /** This Cloud account's tag value — its id (ids only, ADR-0036). */
  tagValue: string;
}

/** The names the template gives what it makes, all suffixed with the tag value. */
export function setupNames({ accountId, tagValue }: CloudAccountIds) {
  const deployRoleName = `cloudgate-deploy-${tagValue}`;
  const taskExecutionRoleName = `cloudgate-task-execution-${tagValue}`;
  const boundaryPolicyName = `cloudgate-boundary-${tagValue}`;
  const deployManagedPolicyName = `cloudgate-deploy-managed-${tagValue}`;
  const deployStackVmPolicyName = `cloudgate-deploy-stack-vm-${tagValue}`;
  const userName = `cloudgate-${tagValue}`;
  const build = buildIdentityNames({ accountId, tagValue });
  return {
    deployRoleName,
    deployRoleArn: `arn:aws:iam::${accountId}:role/${deployRoleName}`,
    taskExecutionRoleName,
    taskExecutionRoleArn: `arn:aws:iam::${accountId}:role/${taskExecutionRoleName}`,
    boundaryPolicyName,
    boundaryPolicyArn: `arn:aws:iam::${accountId}:policy/${boundaryPolicyName}`,
    /**
     * The deploy role's managed policy: the statements its inline
     * policy has no room for.
     */
    deployManagedPolicyName,
    /** The deploy role's second managed policy (version 4 on): a Stack VM's statements. */
    deployStackVmPolicyName,
    /**
     * The build identity (version 3): the role a hosted cloud build
     * runs as, which the template makes and Cloudgate only passes.
     */
    buildRoleName: build.roleName,
    buildRoleArn: build.roleArn,
    /** Every CodeBuild project in this AWS account, reached only by this Cloud account's tag. */
    buildProjectPattern: build.projectPattern,
    userName,
    userArn: `arn:aws:iam::${accountId}:user/${userName}`,
    /** Every task role Cloudgate may make (spec, "A task role per Service"). */
    taskRolePattern: `arn:aws:iam::${accountId}:role/cloudgate/cloudgate-*`,
    /**
     * A Stack VM's roles, its own and its snapshots' (version 4 on): a
     * path of their own, which the task role pattern does not reach, so
     * neither can ever be passed to a task or given an inline policy.
     */
    stackVmRolePattern: `arn:aws:iam::${accountId}:role${STACK_VM_IAM_PATH}cloudgate-stack-vm-*`,
    stackVmProfilePattern: `arn:aws:iam::${accountId}:instance-profile${STACK_VM_IAM_PATH}cloudgate-stack-vm-*`,
    parameterPattern: `arn:aws:ssm:*:${accountId}:parameter/cloudgate/*`,
    /**
     * The cache parameter and subnet groups a replication group names, in
     * this AWS account, reached only by this Cloud account's tag.
     */
    cacheGroupPatterns: [
      `arn:aws:elasticache:*:${accountId}:parametergroup:*`,
      `arn:aws:elasticache:*:${accountId}:subnetgroup:*`,
    ],
    /** Every VPC in this AWS account, reached only by this Cloud account's tag. */
    vpcPattern: `arn:aws:ec2:*:${accountId}:vpc/*`,
    /** A Stack VM's EC2 parts in this AWS account (version 4 on). */
    instancePattern: `arn:aws:ec2:*:${accountId}:instance/*`,
    volumePattern: `arn:aws:ec2:*:${accountId}:volume/*`,
    networkInterfacePattern: `arn:aws:ec2:*:${accountId}:network-interface/*`,
    subnetPattern: `arn:aws:ec2:*:${accountId}:subnet/*`,
    securityGroupPattern: `arn:aws:ec2:*:${accountId}:security-group/*`,
    /** An EBS snapshot's ARN names no account. */
    snapshotPattern: 'arn:aws:ec2:*::snapshot/*',
    snapshotPolicyPattern: `arn:aws:dlm:*:${accountId}:policy/*`,
    /**
     * A Session Manager session the deploy role started: its id starts with
     * the role session's name, `cloudgate`.
     */
    sessionPattern: `arn:aws:ssm:*:${accountId}:session/cloudgate-*`,
    serviceLinkedRolePattern: `arn:aws:iam::${accountId}:role/aws-service-role/*`,
    /**
     * Every S3 bucket Cloudgate may make: a name in this AWS
     * account's regional namespace, `<name>-<account-id>-<region>-an`.
     */
    bucketPattern: `arn:aws:s3:::*-${accountId}-*-an`,
    /**
     * What a `static` site makes in CloudFront, a global service:
     * its distribution, Origin Access Control and function, in this AWS
     * account.
     */
    cloudFrontPatterns: [
      `arn:aws:cloudfront::${accountId}:distribution/*`,
      `arn:aws:cloudfront::${accountId}:origin-access-control/*`,
      `arn:aws:cloudfront::${accountId}:function/*`,
    ],
    /**
     * A database's final snapshot: RDS's and ElastiCache's, named
     * `<project>-<environment>-<service>-final-<date>` in this AWS account.
     */
    finalSnapshotPatterns: [
      `arn:aws:rds:*:${accountId}:snapshot:*-final-*`,
      `arn:aws:elasticache:*:${accountId}:snapshot:*-final-*`,
    ],
  };
}

type Names = ReturnType<typeof setupNames>;

/** One statement of an IAM policy document, in AWS's own spelling. */
export interface PolicyStatement {
  Sid?: string;
  Effect: 'Allow' | 'Deny';
  Action: string[];
  Resource: string[];
  Condition?: Record<string, Record<string, string | string[]>>;
}

export interface PolicyDocument {
  Version: '2012-10-17';
  Statement: PolicyStatement[];
}

/** One `ContextEntries` item of `SimulatePrincipalPolicy`. */
export interface SimulationContextEntry {
  key: string;
  values: string[];
  type: 'string' | 'stringList' | 'boolean';
}

/** One `SimulatePrincipalPolicy` call: these actions, on one resource, in one context. */
export interface SimulationCheck {
  actions: string[];
  /** `*` when the statement is on `*`. */
  resourceArn: string;
  context: SimulationContextEntry[];
  /**
   * Set on a check of the Stack VM statements (version 4 on), so a denial
   * there is named as the Stack VM gap (`stack-vm-permissions.ts`).
   */
  stackVm?: true;
}

/** The ARNs the operator typed, which the simulation uses over the template's names. */
export interface SimulationIds extends CloudAccountIds {
  deployRoleArn: string;
  taskExecutionRoleArn: string;
  /**
   * The region the region check simulates in: regional ARNs name it
   * and every call carries it as `aws:RequestedRegion`, so a policy (or a
   * permissions boundary) that limits regions is met. Absent for the connect
   * check, which has no region.
   */
  region?: string;
}

/** A `static` site's CloudFront actions. */
const STATIC_SITE_ACTIONS = [
  'cloudfront:CreateDistribution',
  'cloudfront:CreateDistributionWithTags',
  'cloudfront:GetDistribution',
  'cloudfront:GetDistributionConfig',
  'cloudfront:UpdateDistribution',
  'cloudfront:DeleteDistribution',
  'cloudfront:TagResource',
  'cloudfront:UntagResource',
  'cloudfront:ListTagsForResource',
  'cloudfront:CreateOriginAccessControl',
  'cloudfront:GetOriginAccessControl',
  'cloudfront:UpdateOriginAccessControl',
  'cloudfront:DeleteOriginAccessControl',
  'cloudfront:CreateFunction',
  'cloudfront:DescribeFunction',
  'cloudfront:GetFunction',
  'cloudfront:UpdateFunction',
  'cloudfront:PublishFunction',
  'cloudfront:DeleteFunction',
  // Each deploy's `/*` cache clear, and the wait for it.
  'cloudfront:CreateInvalidation',
  'cloudfront:GetInvalidation',
];

/**
 * Actions the connect check leaves out: the IAM simulator evaluates them only
 * on `*`, while AWS authorizes them on the resource's own ARN.
 */
export const UNSIMULATED_ACTIONS: readonly string[] = [
  'cloudfront:CreateDistribution',
  'cloudfront:CreateDistributionWithTags',
  'cloudfront:CreateOriginAccessControl',
  'cloudfront:CreateFunction',
];

/** One row of the permission table. */
interface StatementSpec {
  sid: string;
  actions: readonly string[];
  /**
   * Action wildcards the policy writes in place of the actions they cover,
   * to keep the role's inline policy inside AWS's 10,240 characters. Only
   * for reads on `*`, and for `codebuild:*` on this Cloud account's tagged
   * projects (as ADR-0047 grants it): the actions themselves are
   * still what a version requires and what the connect check simulates,
   * one by one.
   */
  wildcards?: readonly string[];
  /**
   * Written into the deploy role's managed policy rather than its inline
   * one: AWS allows a role's inline policies 10,240 characters in
   * all, and version 1 left too little for a Private web service's. Granted
   * and simulated exactly as an inline statement is. `'stack-vm'`: in the
   * deploy role's second managed policy, the Stack VM one (version 4 on),
   * since the first has no room for it.
   */
  attached?: true | 'stack-vm';
  resources(names: Names): string[];
  condition?(
    names: Names,
    ids: CloudAccountIds,
  ): Record<string, Record<string, string | string[]>>;
  /**
   * What to simulate each action on, one check per resource. An action's
   * ARN must match the statement's resource pattern, or the simulator denies
   * it for a reason that is not a missing permission.
   */
  simulate(
    names: Names,
    ids: SimulationIds,
  ): Array<{
    /** The statement's actions that apply to this resource; all of them when absent. */
    actions?: readonly string[];
    resourceArn: string;
    context: SimulationContextEntry[];
  }>;
}

const requestTag = (tagValue: string) => ({
  [`aws:RequestTag/${CLOUD_ACCOUNT_TAG_KEY}`]: tagValue,
});
const resourceTag = (tagValue: string) => ({
  [`aws:ResourceTag/${CLOUD_ACCOUNT_TAG_KEY}`]: tagValue,
});
const entry = (key: string, value: string): SimulationContextEntry => ({
  key,
  values: [value],
  type: 'string',
});
const requestTagContext = (tagValue: string) => [
  entry(`aws:RequestTag/${CLOUD_ACCOUNT_TAG_KEY}`, tagValue),
  {
    key: 'aws:TagKeys',
    values: [CLOUD_ACCOUNT_TAG_KEY],
    type: 'stringList' as const,
  },
];
const resourceTagContext = (tagValue: string) => [
  entry(`aws:ResourceTag/${CLOUD_ACCOUNT_TAG_KEY}`, tagValue),
];
/**
 * A call an AWS service makes with the caller's own credentials, as Cloud
 * Map's private namespace create makes its hosted zone.
 */
const viaAwsService = { Bool: { 'aws:ViaAWSService': 'true' } };
const viaAwsServiceContext: SimulationContextEntry[] = [
  { key: 'aws:ViaAWSService', values: ['true'], type: 'boolean' },
];
const anywhere = () => ['*'];
/** A task role's simulated ARN — any name the pattern allows. */
const sampleTaskRole = (accountId: string) =>
  `arn:aws:iam::${accountId}:role/cloudgate/cloudgate-check`;

/** A tag-on-create statement: `service`'s tagging action, only inside one of `creates`. */
function tagOnCreate(
  sid: string,
  action: string,
  conditionKey: string,
  creates: string[],
): StatementSpec {
  return {
    sid,
    actions: [action],
    resources: anywhere,
    condition: (_names, { tagValue }) => ({
      StringEquals: { ...requestTag(tagValue), [conditionKey]: creates },
    }),
    simulate: (_names, { tagValue }) => [
      {
        resourceArn: '*',
        context: [
          ...requestTagContext(tagValue),
          entry(conditionKey, creates[0]),
        ],
      },
    ],
  };
}

const EC2_CREATES = [
  'CreateVpc',
  'CreateSubnet',
  'CreateInternetGateway',
  'CreateRouteTable',
  'CreateSecurityGroup',
];
const ECS_CREATES = [
  'CreateCluster',
  'RegisterTaskDefinition',
  'CreateService',
];
const ELB_CREATES = [
  'CreateLoadBalancer',
  'CreateTargetGroup',
  'CreateListener',
  'CreateRule',
];

/** Version 1: the permissions research's table plus the spec's additions (ADR-0032). */
const VERSION_1: readonly StatementSpec[] = [
  {
    sid: 'ReadAnywhere',
    actions: [
      'ecr:GetAuthorizationToken',
      'ecr:DescribeRepositories',
      'ecs:DescribeClusters',
      'ecs:DescribeServices',
      'ecs:DescribeTasks',
      'ecs:DescribeTaskDefinition',
      'ecs:DeregisterTaskDefinition',
      'ecs:ListServices',
      'ecs:ListTasks',
      'elasticloadbalancing:DescribeLoadBalancers',
      'elasticloadbalancing:DescribeLoadBalancerAttributes',
      'elasticloadbalancing:DescribeTargetGroups',
      'elasticloadbalancing:DescribeTargetGroupAttributes',
      'elasticloadbalancing:DescribeTargetHealth',
      'elasticloadbalancing:DescribeListeners',
      'elasticloadbalancing:DescribeListenerCertificates',
      'elasticloadbalancing:DescribeRules',
      'elasticloadbalancing:DescribeTags',
      'acm:ListCertificates',
      'ec2:DescribeVpcs',
      'ec2:DescribeVpcAttribute',
      'ec2:DescribeSubnets',
      'ec2:DescribeSecurityGroups',
      'ec2:DescribeSecurityGroupRules',
      'ec2:DescribeRouteTables',
      'ec2:DescribeInternetGateways',
      'ec2:DescribeAvailabilityZones',
      'ec2:DescribeNetworkInterfaces',
      'logs:DescribeLogGroups',
      'tag:GetResources',
      'tag:GetTagKeys',
      'ssm:DescribeParameters',
      // An existing bucket's lookup: the account's buckets in a
      // region, searched by name; ListBuckets has no narrower scope.
      's3:ListAllMyBuckets',
      // A postgres on RDS and a redis on ElastiCache, read back
      // by their runs, their snapshots and backups listed, and an
      // Existing database looked up by its identifier: one the
      // operator made carries no tag of Cloudgate's, so these are on `*`.
      'rds:DescribeDBInstances',
      'rds:DescribeDBSubnetGroups',
      'rds:DescribeDBSnapshots',
      'rds:DescribeDBInstanceAutomatedBackups',
      'rds:ListTagsForResource',
      'elasticache:DescribeReplicationGroups',
      'elasticache:DescribeCacheClusters',
      'elasticache:DescribeCacheSubnetGroups',
      'elasticache:DescribeCacheParameterGroups',
      'elasticache:DescribeCacheParameters',
      'elasticache:DescribeSnapshots',
      // An existing redis's second look, for a serverless cache.
      'elasticache:DescribeServerlessCaches',
      'elasticache:ListTagsForResource',
    ],
    wildcards: [
      'ec2:Describe*',
      'elasticloadbalancing:Describe*',
      'rds:Describe*',
      'elasticache:Describe*',
    ],
    resources: anywhere,
    simulate: () => [{ resourceArn: '*', context: [] }],
  },
  {
    sid: 'CreateTagged',
    actions: [
      'ecr:CreateRepository',
      'ecs:CreateCluster',
      'ecs:RegisterTaskDefinition',
      'ecs:CreateService',
      'elasticloadbalancing:CreateLoadBalancer',
      'elasticloadbalancing:CreateTargetGroup',
      'elasticloadbalancing:CreateListener',
      'elasticloadbalancing:CreateRule',
      'acm:RequestCertificate',
      'acm:ImportCertificate',
      'ec2:CreateVpc',
      'ec2:CreateSubnet',
      'ec2:CreateInternetGateway',
      'ec2:CreateRouteTable',
      'ec2:CreateSecurityGroup',
      'logs:CreateLogGroup',
      'rds:CreateDBInstance',
      'rds:CreateDBSubnetGroup',
      'elasticache:CreateReplicationGroup',
      'elasticache:CreateCacheSubnetGroup',
      'elasticache:CreateCacheParameterGroup',
    ],
    resources: anywhere,
    condition: (_names, { tagValue }) => ({
      StringEquals: requestTag(tagValue),
    }),
    simulate: (_names, { tagValue }) => [
      { resourceArn: '*', context: requestTagContext(tagValue) },
    ],
  },
  {
    // EC2 authorizes a subnet, route table or security group on the VPC it
    // goes in as well as on itself, and a request's tags are no condition on
    // a VPC that already exists: CreateTagged alone was refused on the
    // Environment network's own VPC in a real account. The VPC is
    // reached by this Cloud account's tag on it instead.
    sid: 'CreateInTaggedVpc',
    actions: [
      'ec2:CreateSubnet',
      'ec2:CreateRouteTable',
      'ec2:CreateSecurityGroup',
    ],
    resources: (names) => [names.vpcPattern],
    condition: (_names, { tagValue }) => ({
      StringEquals: resourceTag(tagValue),
    }),
    simulate: (_names, { accountId, region, tagValue }) => [
      {
        resourceArn: `arn:aws:ec2:${region ?? SIMULATED_REGION}:${accountId}:vpc/vpc-00000000000000000`,
        context: resourceTagContext(tagValue),
      },
    ],
  },
  {
    // The same for ElastiCache: CreateReplicationGroup is authorized on the
    // parameter group and subnet group it names too, which exist by then
    // and carry no request tags; refused in a real account.
    sid: 'CreateCacheInTaggedGroups',
    actions: ['elasticache:CreateReplicationGroup'],
    resources: (names) => names.cacheGroupPatterns,
    condition: (_names, { tagValue }) => ({
      StringEquals: resourceTag(tagValue),
    }),
    simulate: (_names, { accountId, region, tagValue }) =>
      ['parametergroup', 'subnetgroup'].map((type) => ({
        resourceArn: `arn:aws:elasticache:${region ?? SIMULATED_REGION}:${accountId}:${type}:cloudgate-check`,
        context: resourceTagContext(tagValue),
      })),
  },
  tagOnCreate(
    'TagEc2OnCreate',
    'ec2:CreateTags',
    'ec2:CreateAction',
    EC2_CREATES,
  ),
  tagOnCreate(
    'TagEcsOnCreate',
    'ecs:TagResource',
    'ecs:CreateAction',
    ECS_CREATES,
  ),
  tagOnCreate(
    'TagElbOnCreate',
    'elasticloadbalancing:AddTags',
    'elasticloadbalancing:CreateAction',
    ELB_CREATES,
  ),
  {
    sid: 'ChangeTagged',
    actions: [
      'ecr:BatchCheckLayerAvailability',
      'ecr:InitiateLayerUpload',
      'ecr:UploadLayerPart',
      'ecr:CompleteLayerUpload',
      'ecr:PutImage',
      'ecr:BatchGetImage',
      'ecr:BatchDeleteImage',
      'ecr:DescribeImages',
      'ecr:ListImages',
      'ecr:PutLifecyclePolicy',
      'ecr:GetLifecyclePolicy',
      'ecr:DeleteLifecyclePolicy',
      'ecr:DeleteRepository',
      'ecr:TagResource',
      'ecr:UntagResource',
      'ecr:ListTagsForResource',
      'ecs:UpdateService',
      'ecs:DeleteService',
      'ecs:DeleteCluster',
      'ecs:StopTask',
      'ecs:DeleteTaskDefinitions',
      'ecs:UntagResource',
      'ecs:ListTagsForResource',
      'elasticloadbalancing:DeleteLoadBalancer',
      'elasticloadbalancing:ModifyLoadBalancerAttributes',
      'elasticloadbalancing:SetSecurityGroups',
      'elasticloadbalancing:SetSubnets',
      'elasticloadbalancing:DeleteTargetGroup',
      'elasticloadbalancing:ModifyTargetGroup',
      'elasticloadbalancing:ModifyTargetGroupAttributes',
      'elasticloadbalancing:RegisterTargets',
      'elasticloadbalancing:DeregisterTargets',
      'elasticloadbalancing:ModifyListener',
      'elasticloadbalancing:DeleteListener',
      'elasticloadbalancing:ModifyRule',
      'elasticloadbalancing:DeleteRule',
      'elasticloadbalancing:AddListenerCertificates',
      'elasticloadbalancing:RemoveListenerCertificates',
      'elasticloadbalancing:RemoveTags',
      'acm:DescribeCertificate',
      'acm:DeleteCertificate',
      'acm:AddTagsToCertificate',
      'acm:RemoveTagsFromCertificate',
      'acm:ListTagsForCertificate',
      'ec2:AttachInternetGateway',
      'ec2:DetachInternetGateway',
      'ec2:DeleteInternetGateway',
      'ec2:CreateRoute',
      'ec2:DeleteRoute',
      'ec2:AssociateRouteTable',
      'ec2:DisassociateRouteTable',
      'ec2:DeleteRouteTable',
      'ec2:ModifyVpcAttribute',
      'ec2:ModifySubnetAttribute',
      'ec2:DeleteSubnet',
      'ec2:DeleteVpc',
      'ec2:AuthorizeSecurityGroupIngress',
      'ec2:AuthorizeSecurityGroupEgress',
      'ec2:RevokeSecurityGroupIngress',
      'ec2:RevokeSecurityGroupEgress',
      'ec2:DeleteSecurityGroup',
      'ec2:DeleteTags',
      'logs:PutRetentionPolicy',
      'logs:DeleteLogGroup',
      'logs:TagResource',
      'logs:UntagResource',
      'logs:ListTagsForResource',
      'logs:FilterLogEvents',
      'logs:GetLogEvents',
      // A database's own runs, its Delete lifting
      // protection, and its stop and start.
      'rds:ModifyDBInstance',
      'rds:DeleteDBInstance',
      'rds:StopDBInstance',
      'rds:StartDBInstance',
      'rds:CreateDBSnapshot',
      'rds:ModifyDBSubnetGroup',
      'rds:DeleteDBSubnetGroup',
      'rds:AddTagsToResource',
      'rds:RemoveTagsFromResource',
      'elasticache:ModifyReplicationGroup',
      'elasticache:IncreaseReplicaCount',
      'elasticache:DecreaseReplicaCount',
      'elasticache:DeleteReplicationGroup',
      'elasticache:CreateSnapshot',
      'elasticache:ModifyCacheSubnetGroup',
      'elasticache:DeleteCacheSubnetGroup',
      'elasticache:ModifyCacheParameterGroup',
      'elasticache:DeleteCacheParameterGroup',
      'elasticache:AddTagsToResource',
      'elasticache:RemoveTagsFromResource',
    ],
    resources: anywhere,
    condition: (_names, { tagValue }) => ({
      StringEquals: resourceTag(tagValue),
    }),
    simulate: (_names, { tagValue }) => [
      { resourceArn: '*', context: resourceTagContext(tagValue) },
    ],
  },
  {
    sid: 'CloudgateParameters',
    actions: [
      'ssm:PutParameter',
      'ssm:GetParameter',
      'ssm:GetParameters',
      'ssm:DeleteParameter',
      'ssm:AddTagsToResource',
      'ssm:RemoveTagsFromResource',
      'ssm:ListTagsForResource',
    ],
    resources: (names) => [names.parameterPattern],
    simulate: (_names, { accountId, region }) => [
      {
        resourceArn: `arn:aws:ssm:${region ?? SIMULATED_REGION}:${accountId}:parameter/cloudgate/check`,
        context: [],
      },
    ],
  },
  {
    sid: 'CreateTaskRole',
    actions: ['iam:CreateRole'],
    resources: (names) => [names.taskRolePattern],
    condition: (names, { tagValue }) => ({
      StringEquals: {
        ...requestTag(tagValue),
        'iam:PermissionsBoundary': names.boundaryPolicyArn,
      },
    }),
    simulate: (names, { accountId, tagValue }) => [
      {
        resourceArn: sampleTaskRole(accountId),
        context: [
          ...requestTagContext(tagValue),
          entry('iam:PermissionsBoundary', names.boundaryPolicyArn),
        ],
      },
    ],
  },
  {
    // A task role's inline policy cannot outgrow the boundary its create
    // required, and removing that boundary is not granted, so these are held
    // by the tag alone. No `iam:UntagRole`: an untagged task role is one the
    // tag-on-create statement below would let another Cloud account claim.
    sid: 'ChangeTaskRole',
    actions: [
      'iam:PutRolePolicy',
      'iam:DeleteRolePolicy',
      'iam:DeleteRole',
      'iam:TagRole',
    ],
    resources: (names) => [names.taskRolePattern],
    condition: (_names, { tagValue }) => ({
      StringEquals: resourceTag(tagValue),
    }),
    simulate: (_names, { accountId, tagValue }) => [
      {
        resourceArn: sampleTaskRole(accountId),
        context: resourceTagContext(tagValue),
      },
    ],
  },
  {
    // IAM authorizes the tags of a `CreateRole` as an `iam:TagRole` on a role
    // that carries none yet, which the statement above cannot match.
    sid: 'TagTaskRoleOnCreate',
    actions: ['iam:TagRole'],
    resources: (names) => [names.taskRolePattern],
    condition: (_names, { tagValue }) => ({
      StringEquals: requestTag(tagValue),
      Null: { [`aws:ResourceTag/${CLOUD_ACCOUNT_TAG_KEY}`]: 'true' },
    }),
    simulate: (_names, { accountId, tagValue }) => [
      {
        resourceArn: sampleTaskRole(accountId),
        context: requestTagContext(tagValue),
      },
    ],
  },
  {
    sid: 'ReadTaskRole',
    actions: [
      'iam:GetRole',
      'iam:GetRolePolicy',
      'iam:ListRolePolicies',
      'iam:ListAttachedRolePolicies',
      'iam:ListInstanceProfilesForRole',
    ],
    resources: (names) => [names.taskRolePattern],
    simulate: (_names, { accountId }) => [
      { resourceArn: sampleTaskRole(accountId), context: [] },
    ],
  },
  {
    sid: 'PassRoleToTasks',
    actions: ['iam:PassRole'],
    resources: (names) => [names.taskExecutionRoleArn, names.taskRolePattern],
    condition: () => ({ StringEquals: { 'iam:PassedToService': ECS_TASKS } }),
    simulate: (_names, { accountId, taskExecutionRoleArn }) =>
      [taskExecutionRoleArn, sampleTaskRole(accountId)].map((resourceArn) => ({
        resourceArn,
        context: [entry('iam:PassedToService', ECS_TASKS)],
      })),
  },
  {
    sid: 'ServiceLinkedRoles',
    actions: ['iam:CreateServiceLinkedRole'],
    resources: (names) => [names.serviceLinkedRolePattern],
    condition: () => ({
      StringEquals: {
        'iam:AWSServiceName': [
          'ecs.amazonaws.com',
          'elasticloadbalancing.amazonaws.com',
          // A fresh account's first RDS instance and ElastiCache group.
          'rds.amazonaws.com',
          'elasticache.amazonaws.com',
        ],
      },
    }),
    simulate: (_names, { accountId }) => [
      {
        resourceArn: `arn:aws:iam::${accountId}:role/aws-service-role/ecs.amazonaws.com/AWSServiceRoleForECS`,
        context: [entry('iam:AWSServiceName', 'ecs.amazonaws.com')],
      },
    ],
  },
  {
    // A bucket on AWS: made, read back, set and deleted by its
    // state's runs. Each `Put…` also covers its `Delete…` call.
    sid: 'CloudgateBuckets',
    actions: [
      's3:CreateBucket',
      's3:DeleteBucket',
      's3:ListBucket',
      // Whether it holds files, old versions and delete markers included,
      // which its Delete reads first.
      's3:ListBucketVersions',
      's3:GetBucketLocation',
      's3:GetBucketTagging',
      's3:PutBucketTagging',
      's3:ListTagsForResource',
      's3:TagResource',
      's3:UntagResource',
      's3:GetBucketPolicy',
      's3:GetBucketAcl',
      's3:GetBucketCORS',
      's3:PutBucketCORS',
      's3:GetBucketWebsite',
      's3:GetBucketVersioning',
      's3:GetAccelerateConfiguration',
      's3:GetBucketRequestPayment',
      's3:GetBucketLogging',
      's3:GetLifecycleConfiguration',
      's3:GetReplicationConfiguration',
      's3:GetEncryptionConfiguration',
      's3:PutEncryptionConfiguration',
      's3:GetBucketObjectLockConfiguration',
      's3:GetBucketPublicAccessBlock',
      's3:PutBucketPublicAccessBlock',
      's3:GetBucketOwnershipControls',
      's3:PutBucketOwnershipControls',
      // A `static` site's own bucket: the policy that lets only its
      // distribution read it.
      's3:PutBucketPolicy',
      's3:DeleteBucketPolicy',
    ],
    resources: (names) => [names.bucketPattern],
    simulate: (_names, { accountId, region }) => [
      {
        resourceArn: `arn:aws:s3:::cloudgate-check-${accountId}-${region ?? SIMULATED_REGION}-an`,
        context: [],
      },
    ],
  },
  {
    // A bucket's Delete asked to delete its files empties it,
    // every object, old version and delete marker, through the
    // object-storage port with the deploy role's session. A `static`
    // site's deploy uploads its files to a folder of its own bucket
    // the same way, and deletes the folders no longer live.
    sid: 'CloudgateBucketFiles',
    actions: ['s3:PutObject', 's3:DeleteObject', 's3:DeleteObjectVersion'],
    resources: (names) => [`${names.bucketPattern}/*`],
    simulate: (_names, { accountId, region }) => [
      {
        resourceArn: `arn:aws:s3:::cloudgate-check-${accountId}-${region ?? SIMULATED_REGION}-an/cloudgate-check`,
        context: [],
      },
    ],
  },
  {
    // A `static` site on CloudFront: its distribution, its Origin
    // Access Control and its viewer-request function, made, read back,
    // changed and deleted by its state's runs, in this AWS account only.
    sid: 'CloudgateStaticSites',
    actions: STATIC_SITE_ACTIONS,
    resources: (names) => names.cloudFrontPatterns,
    // Each action is simulated on an ARN of its own resource type: the
    // simulator denies an Origin Access Control or function action asked on
    // a distribution. The four creates are not simulated at all: the
    // simulator evaluates them only on `*` (and refuses to mix
    // CreateDistributionWithTags with anything else), while AWS itself
    // authorizes them on the new resource's ARN, which the statement allows.
    // The AWS walk by hand made each under exactly this statement.
    simulate: (_names, { accountId }) => {
      const arn = (type: string) =>
        `arn:aws:cloudfront::${accountId}:${type}/cloudgate-check`;
      const ofType = (word: string) =>
        STATIC_SITE_ACTIONS.filter(
          (action) =>
            action.includes(word) && !UNSIMULATED_ACTIONS.includes(action),
        );
      const originAccess = ofType('OriginAccessControl');
      const functions = ofType('Function');
      return [
        {
          actions: STATIC_SITE_ACTIONS.filter(
            (action) =>
              !UNSIMULATED_ACTIONS.includes(action) &&
              !originAccess.includes(action) &&
              !functions.includes(action),
          ),
          resourceArn: arn('distribution'),
          context: [],
        },
        {
          actions: originAccess,
          resourceArn: arn('origin-access-control'),
          context: [],
        },
        { actions: functions, resourceArn: arn('function'), context: [] },
      ];
    },
  },
  {
    // RDS and ElastiCache authorize the tags of a create as an
    // `AddTagsToResource` of their own, on a resource that carries none yet,
    // which `ChangeTagged` cannot match; one already tagged stays out of
    // reach, as `TagTaskRoleOnCreate` keeps a task role.
    sid: 'TagDatabasesOnCreate',
    actions: ['rds:AddTagsToResource', 'elasticache:AddTagsToResource'],
    resources: anywhere,
    condition: (_names, { tagValue }) => ({
      StringEquals: requestTag(tagValue),
      Null: { [`aws:ResourceTag/${CLOUD_ACCOUNT_TAG_KEY}`]: 'true' },
    }),
    simulate: (_names, { tagValue }) => [
      { resourceArn: '*', context: requestTagContext(tagValue) },
    ],
  },
  {
    // A database Delete's final snapshot: made by the delete of the
    // instance or replication group it keeps (whose own tag `ChangeTagged`
    // checks), and untagged while AWS authorizes it, so held to its name.
    // ElastiCache authorizes the delete itself on the snapshot too.
    sid: 'FinalSnapshots',
    actions: [
      'rds:CreateDBSnapshot',
      'rds:AddTagsToResource',
      'elasticache:CreateSnapshot',
      'elasticache:DeleteReplicationGroup',
    ],
    resources: (names) => names.finalSnapshotPatterns,
    simulate: (_names, { accountId, region }) => {
      const at = region ?? SIMULATED_REGION;
      return [
        {
          actions: ['rds:CreateDBSnapshot', 'rds:AddTagsToResource'],
          resourceArn: `arn:aws:rds:${at}:${accountId}:snapshot:cloudgate-check-final-2026-01-01`,
          context: [],
        },
        {
          actions: [
            'elasticache:CreateSnapshot',
            'elasticache:DeleteReplicationGroup',
          ],
          resourceArn: `arn:aws:elasticache:${at}:${accountId}:snapshot:cloudgate-check-final-2026-01-01`,
          context: [],
        },
      ];
    },
  },
  {
    sid: 'SimulateOwnPolicy',
    actions: ['iam:SimulatePrincipalPolicy'],
    resources: (names) => [names.deployRoleArn],
    simulate: (_names, { deployRoleArn }) => [
      { resourceArn: deployRoleArn, context: [] },
    ],
  },
];

/**
 * What a Private web service's private DNS needs: Cloud Map's
 * private DNS namespace and discovery services, made only with this Cloud
 * account's tag and changed or deleted only where they carry it, and the
 * Route 53 hosted zone Cloud Map makes for a private namespace with the
 * caller's own permissions. All in the deploy role's managed policy
 * (`attached`).
 */
const PRIVATE_DNS: readonly StatementSpec[] = [
  {
    sid: 'PrivateDnsReads',
    attached: true,
    actions: [
      'servicediscovery:GetNamespace',
      'servicediscovery:GetService',
      'servicediscovery:GetOperation',
      'servicediscovery:ListNamespaces',
      'servicediscovery:ListServices',
      'servicediscovery:ListOperations',
      'servicediscovery:ListInstances',
      'servicediscovery:ListTagsForResource',
      'route53:GetHostedZone',
      'route53:ListHostedZonesByName',
      // A private namespace's create reads its VPC (ec2:DescribeVpcs is
      // version 1's) and the region.
      'ec2:DescribeRegions',
    ],
    resources: anywhere,
    simulate: () => [{ resourceArn: '*', context: [] }],
  },
  {
    sid: 'PrivateDnsCreateTagged',
    attached: true,
    actions: [
      'servicediscovery:CreatePrivateDnsNamespace',
      'servicediscovery:CreateService',
    ],
    resources: anywhere,
    condition: (_names, { tagValue }) => ({
      StringEquals: requestTag(tagValue),
    }),
    simulate: (_names, { tagValue }) => [
      { resourceArn: '*', context: requestTagContext(tagValue) },
    ],
  },
  {
    sid: 'PrivateDnsChangeTagged',
    attached: true,
    actions: [
      'servicediscovery:UpdateService',
      'servicediscovery:DeleteService',
      'servicediscovery:DeleteNamespace',
      // A discovery service's Delete takes off the records ECS left.
      'servicediscovery:DeregisterInstance',
      'servicediscovery:TagResource',
      'servicediscovery:UntagResource',
    ],
    resources: anywhere,
    condition: (_names, { tagValue }) => ({
      StringEquals: resourceTag(tagValue),
    }),
    simulate: (_names, { tagValue }) => [
      { resourceArn: '*', context: resourceTagContext(tagValue) },
    ],
  },
  /**
   * The hosted zone a private namespace's create makes. Cloud Map
   * makes it with the caller's credentials, so the role needs
   * `CreateHostedZone`; the zone carries no tag of Cloudgate's and has no
   * ARN before it exists, so the grant is on `*`, held to calls an AWS
   * service makes for the role (`aws:ViaAWSService`): the role cannot make
   * a hosted zone by calling Route 53 itself. No `DeleteHostedZone`: the
   * namespace's Delete removes its zone without the caller holding it, so
   * the role can delete no hosted zone at all.
   *
   * `aws:ViaAWSService` is true for a call any AWS service makes with the
   * role's credentials (a forward access session), not Cloud Map's alone.
   * `aws:CalledVia` naming `servicediscovery.amazonaws.com` would be the
   * narrower grant, but AWS's IAM condition-key docs (read 2026-10-25) say
   * only that the key is set by "a service that supports aws:CalledVia"
   * without listing Cloud Map, and no walk has tried it, so a namespace
   * create under it is untested and could fail at Apply. The residual risk
   * is low: the only action held this way is `CreateHostedZone`.
   */
  {
    sid: 'PrivateDnsHostedZone',
    attached: true,
    actions: ['route53:CreateHostedZone'],
    resources: anywhere,
    condition: () => viaAwsService,
    simulate: () => [{ resourceArn: '*', context: viaAwsServiceContext }],
  },
];

/**
 * What a Cron service's runs need: `RunTask` of a task definition
 * carrying this Cloud account's tag, scoped like the ECS writes version 1
 * grants, and tagging the task it starts only as that `RunTask` does and
 * only with the tag, so `StopTask` (version 1's, on what carries the tag)
 * can stop it. `iam:PassRole` for its task and execution roles is version
 * 1's. In the deploy role's managed policy (`attached`).
 */
const CRON_RUNS: readonly StatementSpec[] = [
  {
    sid: 'CronRunTagged',
    attached: true,
    actions: ['ecs:RunTask'],
    resources: anywhere,
    condition: (_names, { tagValue }) => ({
      StringEquals: resourceTag(tagValue),
    }),
    simulate: (_names, { tagValue }) => [
      { resourceArn: '*', context: resourceTagContext(tagValue) },
    ],
  },
  {
    ...tagOnCreate(
      'TagCronRunOnCreate',
      'ecs:TagResource',
      'ecs:CreateAction',
      ['RunTask'],
    ),
    attached: true,
  },
];

/**
 * Version 2: version 1, a Private web service's private DNS, and a
 * Cron service's runs.
 */
const VERSION_2: readonly StatementSpec[] = [
  ...VERSION_1,
  ...PRIVATE_DNS,
  ...CRON_RUNS,
];

/**
 * What a hosted cloud build needs of Cloudgate's role (ADR-0047):
 * `codebuild:*` on the CodeBuild projects that carry this Cloud account's
 * tag, a project made only with it, and the build identity passed only to
 * CodeBuild. Nothing else: the network's runs already make and change the
 * source bucket and the log group under version 1's S3 and logs
 * statements, and the permissions boundary is untouched, since the build
 * identity is the template's, never a role Cloudgate makes. In the deploy
 * role's managed policy (`attached`).
 */
const CODEBUILD_PROJECT_ACTIONS = [
  'codebuild:BatchGetProjects',
  'codebuild:UpdateProject',
  'codebuild:DeleteProject',
  'codebuild:StartBuild',
  'codebuild:BatchGetBuilds',
  'codebuild:StopBuild',
  'codebuild:ListBuildsForProject',
];

const sampleProject = (accountId: string, region: string | undefined) =>
  `arn:aws:codebuild:${region ?? SIMULATED_REGION}:${accountId}:project/cloudgate-check`;

const CLOUD_BUILDS: readonly StatementSpec[] = [
  {
    sid: 'CloudBuildProjectCreate',
    attached: true,
    actions: ['codebuild:CreateProject'],
    resources: (names) => [names.buildProjectPattern],
    condition: (_names, { tagValue }) => ({
      StringEquals: requestTag(tagValue),
    }),
    simulate: (_names, { accountId, region, tagValue }) => [
      {
        resourceArn: sampleProject(accountId, region),
        context: requestTagContext(tagValue),
      },
    ],
  },
  {
    sid: 'CloudBuildProjects',
    attached: true,
    actions: CODEBUILD_PROJECT_ACTIONS,
    wildcards: ['codebuild:*'],
    resources: (names) => [names.buildProjectPattern],
    condition: (_names, { tagValue }) => ({
      StringEquals: resourceTag(tagValue),
    }),
    simulate: (_names, { accountId, region, tagValue }) => [
      {
        resourceArn: sampleProject(accountId, region),
        context: resourceTagContext(tagValue),
      },
    ],
  },
  {
    sid: 'PassRoleToBuilds',
    attached: true,
    actions: ['iam:PassRole'],
    resources: (names) => [names.buildRoleArn],
    condition: () => ({
      StringEquals: { 'iam:PassedToService': CODEBUILD_SERVICE },
    }),
    simulate: (names) => [
      {
        resourceArn: names.buildRoleArn,
        context: [entry('iam:PassedToService', CODEBUILD_SERVICE)],
      },
    ],
  },
];

/** Version 3: version 2 and a hosted cloud build's CodeBuild. */
const VERSION_3: readonly StatementSpec[] = [...VERSION_2, ...CLOUD_BUILDS];

const sampleInstance = (accountId: string, region: string | undefined) =>
  `arn:aws:ec2:${region ?? SIMULATED_REGION}:${accountId}:instance/i-00000000000000000`;
const sampleVolume = (accountId: string, region: string | undefined) =>
  `arn:aws:ec2:${region ?? SIMULATED_REGION}:${accountId}:volume/vol-00000000000000000`;
const sampleSnapshotPolicy = (accountId: string, region: string | undefined) =>
  `arn:aws:dlm:${region ?? SIMULATED_REGION}:${accountId}:policy/policy-00000000000000000`;
const sampleStackVmRole = (accountId: string) =>
  `arn:aws:iam::${accountId}:role${STACK_VM_IAM_PATH}cloudgate-stack-vm-check`;
const sampleStackVmProfile = (accountId: string) =>
  `arn:aws:iam::${accountId}:instance-profile${STACK_VM_IAM_PATH}cloudgate-stack-vm-check`;

/** What a Stack VM's role and its snapshots' role may ever hold (`stack-vm-definition.ts`). */
const STACK_VM_ROLE_POLICIES = [SESSION_MANAGER_POLICY, SNAPSHOT_POLICY];
/** The services a Stack VM's roles are passed to: EC2 its own, DLM its snapshots'. */
const STACK_VM_ROLE_SERVICES = ['ec2.amazonaws.com', 'dlm.amazonaws.com'];

/** The Session Manager documents a Stack VM's tunnel starts (SSH inside it, ADR-0070). */
const SESSION_DOCUMENTS = [
  'arn:aws:ssm:*::document/AWS-StartSSHSession',
  'arn:aws:ssm:*::document/AWS-StartPortForwardingSession',
];

/** EC2's actions on a Stack VM and its data disk, held by the tag on them. */
const STACK_VM_EC2_CHANGES = [
  'ec2:StartInstances',
  'ec2:StopInstances',
  'ec2:RebootInstances',
  'ec2:TerminateInstances',
  'ec2:ModifyInstanceAttribute',
  'ec2:ModifyInstanceMetadataOptions',
  'ec2:ModifyInstanceMaintenanceOptions',
  'ec2:AttachVolume',
  'ec2:DetachVolume',
  'ec2:DeleteVolume',
  'ec2:ModifyVolume',
  // A Delete's final snapshot of the data disk (ADR-0070 "Delete").
  'ec2:CreateSnapshot',
];

/**
 * What a Compose stack's **Stack VM** needs of Cloudgate's role (ADR-0070,
 * `stack-vm-definition.ts`), on both instances alike, scoped as version 1's
 * EC2 is:
 *
 * - **Session Manager**: a session started only to an instance carrying
 *   this Cloud account's tag (`ssm:resourceTag`, as Session Manager names
 *   it) with the SSH or port-forwarding document, and ended or resumed only
 *   if it is the deploy role's own (its session name, `cloudgate`, starts
 *   the session's id).
 * - **EC2**: `RunInstances` makes an instance only with the tag; its root
 *   volume and network interface are made by that same launch, and it may
 *   use the tagged subnet and security group and any image (Canonical's
 *   Ubuntu is public). The data disk is made only with the tag. Every
 *   change, stop, start, attach, delete and the final snapshot only on
 *   what carries it. Tagging only inside those creates.
 * - **Data Lifecycle Manager**: the daily snapshot policy, made only with
 *   the tag, changed and deleted only where it carries it.
 * - **IAM**: the Stack VM's role and its snapshots' role under
 *   {@link STACK_VM_IAM_PATH}, made with the tag, holding only the two AWS
 *   policies the definition attaches (`iam:PolicyARN`) and no inline one,
 *   and passed only to EC2 and DLM; the instance profile under the same
 *   path. The permissions boundary is untouched: these roles are not task
 *   roles, and the task role pattern does not reach their path.
 * - **SSM parameter**: the region's Ubuntu image id, read from Canonical's
 *   public parameter when a Stack VM is first made.
 *
 * The reads (`ec2:Describe*`) are version 1's. In the deploy role's managed
 * policy (`attached`).
 */
const STACK_VMS: readonly StatementSpec[] = [
  {
    sid: 'StackVmSessions',
    attached: 'stack-vm',
    actions: ['ssm:StartSession'],
    resources: () => ['arn:aws:ec2:*:*:instance/*', ...SESSION_DOCUMENTS],
    condition: (_names, { tagValue }) => ({
      StringEquals: {
        [`ssm:resourceTag/${CLOUD_ACCOUNT_TAG_KEY}`]: tagValue,
      },
    }),
    simulate: (_names, { accountId, region, tagValue }) => [
      {
        resourceArn: sampleInstance(accountId, region),
        context: [entry(`ssm:resourceTag/${CLOUD_ACCOUNT_TAG_KEY}`, tagValue)],
      },
    ],
  },
  {
    // A document carries no tag: the start is held by the instance's.
    sid: 'StackVmSessionDocuments',
    attached: 'stack-vm',
    actions: ['ssm:StartSession'],
    resources: () => SESSION_DOCUMENTS,
    simulate: (_names, { region }) => [
      {
        resourceArn: `arn:aws:ssm:${region ?? SIMULATED_REGION}::document/AWS-StartSSHSession`,
        context: [],
      },
    ],
  },
  {
    sid: 'StackVmOwnSessions',
    attached: 'stack-vm',
    actions: ['ssm:TerminateSession', 'ssm:ResumeSession'],
    resources: (names) => [names.sessionPattern],
    simulate: (_names, { accountId, region }) => [
      {
        resourceArn: `arn:aws:ssm:${region ?? SIMULATED_REGION}:${accountId}:session/cloudgate-0123456789abcdef0`,
        context: [],
      },
    ],
  },
  {
    // Whether the Stack VM's agent answers, before a tunnel is tried.
    sid: 'StackVmSessionReads',
    attached: 'stack-vm',
    actions: ['ssm:DescribeInstanceInformation', 'ssm:GetConnectionStatus'],
    resources: anywhere,
    simulate: () => [{ resourceArn: '*', context: [] }],
  },
  {
    sid: 'StackVmImage',
    attached: 'stack-vm',
    actions: ['ssm:GetParameter', 'ssm:GetParameters'],
    resources: () => [
      'arn:aws:ssm:*::parameter/aws/service/canonical/ubuntu/*',
    ],
    simulate: (_names, { region }) => [
      {
        resourceArn: `arn:aws:ssm:${region ?? SIMULATED_REGION}::parameter/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id`,
        context: [],
      },
    ],
  },
  {
    sid: 'StackVmCreateTagged',
    attached: 'stack-vm',
    actions: [
      'ec2:RunInstances',
      'ec2:CreateVolume',
      'dlm:CreateLifecyclePolicy',
    ],
    resources: (names) => [
      names.instancePattern,
      names.volumePattern,
      names.snapshotPolicyPattern,
    ],
    condition: (_names, { tagValue }) => ({
      StringEquals: requestTag(tagValue),
    }),
    simulate: (_names, { accountId, region, tagValue }) => [
      {
        actions: ['ec2:RunInstances'],
        resourceArn: sampleInstance(accountId, region),
        context: requestTagContext(tagValue),
      },
      {
        actions: ['ec2:CreateVolume'],
        resourceArn: sampleVolume(accountId, region),
        context: requestTagContext(tagValue),
      },
      {
        actions: ['dlm:CreateLifecyclePolicy'],
        resourceArn: sampleSnapshotPolicy(accountId, region),
        context: requestTagContext(tagValue),
      },
    ],
  },
  {
    // RunInstances is authorized on every resource the launch touches: the
    // root volume and network interface it makes, untagged until it tags
    // them, and the public image it starts from. The instance itself is
    // held by the tag above, so nothing launches without it.
    sid: 'StackVmLaunchParts',
    attached: 'stack-vm',
    actions: ['ec2:RunInstances'],
    resources: (names) => [
      names.volumePattern,
      names.networkInterfacePattern,
      'arn:aws:ec2:*::image/*',
    ],
    simulate: (_names, { accountId, region }) => [
      { resourceArn: sampleVolume(accountId, region), context: [] },
    ],
  },
  {
    // The Environment network's subnet and the Stack VM's security group,
    // which carry the tag already.
    sid: 'StackVmLaunchInTagged',
    attached: 'stack-vm',
    actions: ['ec2:RunInstances'],
    resources: (names) => [names.subnetPattern, names.securityGroupPattern],
    condition: (_names, { tagValue }) => ({
      StringEquals: resourceTag(tagValue),
    }),
    simulate: (_names, { accountId, region, tagValue }) => [
      {
        resourceArn: `arn:aws:ec2:${region ?? SIMULATED_REGION}:${accountId}:subnet/subnet-00000000000000000`,
        context: resourceTagContext(tagValue),
      },
    ],
  },
  {
    ...tagOnCreate('StackVmTagOnCreate', 'ec2:CreateTags', 'ec2:CreateAction', [
      'RunInstances',
      'CreateVolume',
      'CreateSnapshot',
    ]),
    attached: 'stack-vm',
  },
  {
    sid: 'StackVmChangeTagged',
    attached: 'stack-vm',
    actions: [
      ...STACK_VM_EC2_CHANGES,
      'dlm:GetLifecyclePolicy',
      'dlm:UpdateLifecyclePolicy',
      'dlm:DeleteLifecyclePolicy',
      'dlm:TagResource',
      'dlm:UntagResource',
      'dlm:ListTagsForResource',
    ],
    resources: anywhere,
    condition: (_names, { tagValue }) => ({
      StringEquals: resourceTag(tagValue),
    }),
    simulate: (_names, { accountId, region, tagValue }) => [
      {
        actions: STACK_VM_EC2_CHANGES,
        resourceArn: sampleVolume(accountId, region),
        context: resourceTagContext(tagValue),
      },
      {
        actions: [
          'dlm:GetLifecyclePolicy',
          'dlm:UpdateLifecyclePolicy',
          'dlm:DeleteLifecyclePolicy',
          'dlm:TagResource',
          'dlm:UntagResource',
          'dlm:ListTagsForResource',
        ],
        resourceArn: sampleSnapshotPolicy(accountId, region),
        context: resourceTagContext(tagValue),
      },
    ],
  },
  {
    // A final snapshot is made by a call on its tagged volume, and is
    // authorized on the snapshot it makes, which carries the request's tag.
    sid: 'StackVmFinalSnapshot',
    attached: 'stack-vm',
    actions: ['ec2:CreateSnapshot'],
    resources: (names) => [names.snapshotPattern],
    condition: (_names, { tagValue }) => ({
      StringEquals: requestTag(tagValue),
    }),
    simulate: (_names, { region, tagValue }) => [
      {
        resourceArn: `arn:aws:ec2:${region ?? SIMULATED_REGION}::snapshot/snap-00000000000000000`,
        context: requestTagContext(tagValue),
      },
    ],
  },
  {
    sid: 'StackVmSnapshotPolicyReads',
    attached: 'stack-vm',
    actions: ['dlm:GetLifecyclePolicies'],
    resources: anywhere,
    simulate: () => [{ resourceArn: '*', context: [] }],
  },
  {
    sid: 'StackVmCreateRoles',
    attached: 'stack-vm',
    actions: ['iam:CreateRole', 'iam:CreateInstanceProfile'],
    resources: (names) => [
      names.stackVmRolePattern,
      names.stackVmProfilePattern,
    ],
    condition: (_names, { tagValue }) => ({
      StringEquals: requestTag(tagValue),
    }),
    simulate: (_names, { accountId, tagValue }) => [
      {
        actions: ['iam:CreateRole'],
        resourceArn: sampleStackVmRole(accountId),
        context: requestTagContext(tagValue),
      },
      {
        actions: ['iam:CreateInstanceProfile'],
        resourceArn: sampleStackVmProfile(accountId),
        context: requestTagContext(tagValue),
      },
    ],
  },
  {
    // As `TagTaskRoleOnCreate`: the tags of a create, on what carries none yet.
    sid: 'StackVmTagRolesOnCreate',
    attached: 'stack-vm',
    actions: ['iam:TagRole', 'iam:TagInstanceProfile'],
    resources: (names) => [
      names.stackVmRolePattern,
      names.stackVmProfilePattern,
    ],
    condition: (_names, { tagValue }) => ({
      StringEquals: requestTag(tagValue),
      Null: { [`aws:ResourceTag/${CLOUD_ACCOUNT_TAG_KEY}`]: 'true' },
    }),
    simulate: (_names, { accountId, tagValue }) => [
      {
        actions: ['iam:TagRole'],
        resourceArn: sampleStackVmRole(accountId),
        context: requestTagContext(tagValue),
      },
      {
        actions: ['iam:TagInstanceProfile'],
        resourceArn: sampleStackVmProfile(accountId),
        context: requestTagContext(tagValue),
      },
    ],
  },
  {
    sid: 'StackVmChangeRoles',
    attached: 'stack-vm',
    actions: [
      'iam:DeleteRole',
      'iam:TagRole',
      'iam:DeleteInstanceProfile',
      'iam:AddRoleToInstanceProfile',
      'iam:RemoveRoleFromInstanceProfile',
      'iam:TagInstanceProfile',
    ],
    resources: (names) => [
      names.stackVmRolePattern,
      names.stackVmProfilePattern,
    ],
    condition: (_names, { tagValue }) => ({
      StringEquals: resourceTag(tagValue),
    }),
    simulate: (_names, { accountId, tagValue }) => [
      {
        actions: ['iam:DeleteRole', 'iam:TagRole'],
        resourceArn: sampleStackVmRole(accountId),
        context: resourceTagContext(tagValue),
      },
      {
        actions: [
          'iam:DeleteInstanceProfile',
          'iam:AddRoleToInstanceProfile',
          'iam:RemoveRoleFromInstanceProfile',
          'iam:TagInstanceProfile',
        ],
        resourceArn: sampleStackVmProfile(accountId),
        context: resourceTagContext(tagValue),
      },
    ],
  },
  {
    sid: 'StackVmRolePolicies',
    attached: 'stack-vm',
    actions: ['iam:AttachRolePolicy', 'iam:DetachRolePolicy'],
    resources: (names) => [names.stackVmRolePattern],
    condition: (_names, { tagValue }) => ({
      StringEquals: resourceTag(tagValue),
      ArnEquals: { 'iam:PolicyARN': STACK_VM_ROLE_POLICIES },
    }),
    simulate: (_names, { accountId, tagValue }) => [
      {
        resourceArn: sampleStackVmRole(accountId),
        context: [
          ...resourceTagContext(tagValue),
          entry('iam:PolicyARN', SESSION_MANAGER_POLICY),
        ],
      },
    ],
  },
  {
    sid: 'StackVmReadRoles',
    attached: 'stack-vm',
    actions: [
      'iam:GetRole',
      'iam:ListRolePolicies',
      'iam:ListAttachedRolePolicies',
      'iam:ListInstanceProfilesForRole',
      'iam:GetInstanceProfile',
    ],
    resources: (names) => [
      names.stackVmRolePattern,
      names.stackVmProfilePattern,
    ],
    simulate: (_names, { accountId }) => [
      {
        actions: [
          'iam:GetRole',
          'iam:ListRolePolicies',
          'iam:ListAttachedRolePolicies',
          'iam:ListInstanceProfilesForRole',
        ],
        resourceArn: sampleStackVmRole(accountId),
        context: [],
      },
      {
        actions: ['iam:GetInstanceProfile'],
        resourceArn: sampleStackVmProfile(accountId),
        context: [],
      },
    ],
  },
  {
    sid: 'StackVmPassRoles',
    attached: 'stack-vm',
    actions: ['iam:PassRole'],
    resources: (names) => [names.stackVmRolePattern],
    condition: () => ({
      StringEquals: { 'iam:PassedToService': STACK_VM_ROLE_SERVICES },
    }),
    simulate: (_names, { accountId }) =>
      STACK_VM_ROLE_SERVICES.map((service) => ({
        resourceArn: sampleStackVmRole(accountId),
        context: [entry('iam:PassedToService', service)],
      })),
  },
];

/**
 * Version 4, a Self-hosted instance's: version 2 and Stack VMs. Never
 * version 3's CodeBuild: versions fork by instance mode (ADR-0047), so
 * a newer version is not always a wider one. {@link makesBuildIdentity}
 * says which hold the build, never a `>=` on the number.
 */
const VERSION_4: readonly StatementSpec[] = [...VERSION_2, ...STACK_VMS];

/** Version 5, the Hosted instance's: version 3 and Stack VMs. */
const VERSION_5: readonly StatementSpec[] = [...VERSION_3, ...STACK_VMS];

const STATEMENTS_BY_VERSION: Readonly<
  Record<number, readonly StatementSpec[]>
> = { 1: VERSION_1, 2: VERSION_2, 3: VERSION_3, 4: VERSION_4, 5: VERSION_5 };

/**
 * The first version whose template makes the build identity, as a
 * refusal names it. Version 4 does not: ask {@link makesBuildIdentity}.
 */
export const BUILD_IDENTITY_FROM = 3;

/** Whether a version's template makes the build identity, and its role may start builds. */
export function makesBuildIdentity(version: number): boolean {
  const found = STATEMENTS_BY_VERSION[version];
  return found ? found.includes(CLOUD_BUILDS[0]) : version > NEWEST_VERSION;
}

/**
 * Whether a version holds what a Stack VM needs (ADR-0070). A version this
 * Cloudgate does not know is a newer one's (a rollback), taken to hold it.
 */
export function holdsStackVms(version: number): boolean {
  const found = STATEMENTS_BY_VERSION[version];
  return found ? found.includes(STACK_VMS[0]) : version > NEWEST_VERSION;
}

const NEWEST_VERSION = Math.max(
  ...Object.keys(STATEMENTS_BY_VERSION).map(Number),
);

/**
 * The actions a Stack VM needs that a role held to `version` lacks, each
 * once: every one of the Stack VM statements before version 4, since an
 * older version may name an action (`iam:GetRole`, `ssm:GetParameter`) but
 * never on a Stack VM's resources; none from version 4 on.
 */
export function stackVmActionsMissing(version: number): string[] {
  return holdsStackVms(version)
    ? []
    : [...new Set(STACK_VMS.flatMap((spec) => [...spec.actions]))];
}

/**
 * The build identity's permissions (ADR-0047), exactly: read its
 * source, push to the repositories that carry this Cloud account's tag, and
 * write build logs; and read its own Cloud account's build parameters, where
 * the build that copies a ready-made image finds a private registry's
 * password, which CodeBuild reads as the build identity. Never the
 * deploy role's, because the customer's own build steps run with these
 * credentials. The parameters are SecureStrings under SSM's AWS managed key,
 * whose key policy lets the account's principals decrypt through SSM, so no
 * KMS action is granted.
 */
export function buildIdentityPolicy(ids: CloudAccountIds): PolicyDocument {
  const names = buildIdentityNames(ids);
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'ReadItsSource',
        Effect: 'Allow',
        Action: ['s3:GetObject', 's3:GetObjectVersion'],
        Resource: [`${names.sourceBucketPattern}/*`],
      },
      {
        Sid: 'FindItsSource',
        Effect: 'Allow',
        Action: ['s3:GetBucketAcl', 's3:GetBucketLocation'],
        Resource: [names.sourceBucketPattern],
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
        Resource: [names.repositoryPattern],
        Condition: { StringEquals: resourceTag(ids.tagValue) },
      },
      {
        Sid: 'WriteBuildLogs',
        Effect: 'Allow',
        Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        Resource: names.logGroupPatterns,
      },
      {
        Sid: 'ReadItsBuildParameters',
        Effect: 'Allow',
        Action: ['ssm:GetParameters'],
        Resource: [names.parameterPattern],
      },
    ],
  };
}

function statementsOf(version: number): readonly StatementSpec[] {
  const found = STATEMENTS_BY_VERSION[version];
  if (!found) throw new Error(`No AWS policy version ${version}`);
  return found;
}

/** Every action a policy version grants, each once. */
export function requiredActions(version: number): string[] {
  return [
    ...new Set(statementsOf(version).flatMap((spec) => [...spec.actions])),
  ];
}

/** An action as a policy's `Action` matches it: `*` stands for any run of characters. */
export function actionMatches(pattern: string, action: string): boolean {
  const escaped = pattern
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${escaped}$`, 'i').test(action);
}

/** A statement's actions as its policy spells them: each wildcard once, in place of those it covers. */
function grantedActions(spec: StatementSpec): string[] {
  const wildcards = spec.wildcards ?? [];
  return [
    ...spec.actions.filter(
      (action) => !wildcards.some((pattern) => actionMatches(pattern, action)),
    ),
    ...wildcards,
  ];
}

/** A policy document of these statements, for this Cloud account. */
function policyOf(
  ids: CloudAccountIds,
  specs: readonly StatementSpec[],
): PolicyDocument {
  const names = setupNames(ids);
  return {
    Version: '2012-10-17',
    Statement: specs.map((spec) => ({
      Sid: spec.sid,
      Effect: 'Allow',
      Action: grantedActions(spec),
      Resource: spec.resources(names),
      ...(spec.condition ? { Condition: spec.condition(names, ids) } : {}),
    })),
  };
}

/** The deploy role's inline permissions policy for this Cloud account. */
export function deployRolePolicy(
  ids: CloudAccountIds,
  version = AWS_POLICY_VERSION,
): PolicyDocument {
  return policyOf(
    ids,
    statementsOf(version).filter((spec) => !spec.attached),
  );
}

/**
 * The deploy role's managed policy for this Cloud account: the
 * version's statements its inline policy has no room for, or `null` for a
 * version with none.
 */
export function deployRoleManagedPolicy(
  ids: CloudAccountIds,
  version = AWS_POLICY_VERSION,
): PolicyDocument | null {
  const attached = statementsOf(version).filter(
    (spec) => spec.attached === true,
  );
  return attached.length > 0 ? policyOf(ids, attached) : null;
}

/**
 * The deploy role's Stack VM policy for this Cloud account (version 4 on),
 * a second managed policy, or `null` for a version without Stack VMs.
 */
export function deployRoleStackVmPolicy(
  ids: CloudAccountIds,
  version = AWS_POLICY_VERSION,
): PolicyDocument | null {
  const attached = statementsOf(version).filter(
    (spec) => spec.attached === 'stack-vm',
  );
  return attached.length > 0 ? policyOf(ids, attached) : null;
}

/**
 * What the connect check simulates: every action of the version, on the ARNs
 * the operator typed, with this Cloud account's tag as context where the
 * policy conditions on it (the simulator reads tag conditions only
 * from `ContextEntries`).
 */
export function simulationChecks(
  ids: SimulationIds,
  version = AWS_POLICY_VERSION,
): SimulationCheck[] {
  const names = setupNames(ids);
  const inRegion = ids.region ? [entry('aws:RequestedRegion', ids.region)] : [];
  return statementsOf(version).flatMap((spec) =>
    spec.simulate(names, ids).map(({ actions, resourceArn, context }) => ({
      actions: [...(actions ?? spec.actions)],
      resourceArn,
      context: [...context, ...inRegion],
      ...(STACK_VMS.includes(spec) ? { stackVm: true as const } : {}),
    })),
  );
}

/** The template's content as plain JSON, for an operator who pastes rather than deploys a stack. */
export interface SetupDocuments {
  policyVersion: number;
  externalId: string;
  tagValue: string;
  deployRole: {
    name: string;
    trustPolicy: TrustPolicy;
    policyName: string;
    policy: PolicyDocument;
    /** Its managed policy, from version 2 on. */
    managedPolicy?: { name: string; policy: PolicyDocument };
    /** Its Stack VM policy, a second managed one, from version 4 on. */
    stackVmPolicy?: { name: string; policy: PolicyDocument };
  };
  taskExecutionRole: {
    name: string;
    trustPolicy: TrustPolicy;
    managedPolicyArns: string[];
    policyName: string;
    policy: PolicyDocument;
  };
  permissionsBoundary: { name: string; policy: PolicyDocument };
  /**
   * The build identity, from version 3 on: the role a hosted cloud
   * build runs as, trusted only by CodeBuild for this AWS account.
   */
  buildRole?: {
    name: string;
    trustPolicy: TrustPolicy;
    policyName: string;
    policy: PolicyDocument;
  };
  user: {
    name: string;
    policyName: string;
    policy: { Version: '2012-10-17'; Statement: SimpleStatement[] };
  };
}

interface SimpleStatement {
  Effect: 'Allow';
  Action: string;
  Resource: string;
}

interface TrustPolicy {
  Version: '2012-10-17';
  Statement: Array<{
    Effect: 'Allow';
    Principal: { AWS: string } | { Service: string };
    Action: 'sts:AssumeRole';
    Condition?: Record<string, Record<string, string>>;
  }>;
}

export interface SetupTemplate {
  policyVersion: number;
  /** A CloudFormation template, as JSON text (CloudFormation reads JSON as well as YAML). */
  cloudFormation: string;
  json: SetupDocuments;
}

/**
 * The setup template for one Cloud account: the deploy role, the task
 * execution role, the permissions boundary and an IAM user allowed only to
 * take on the deploy role, with this Cloud account's external id and tag value
 * already in place; from version 3 on, the build identity too.
 *
 * **No access key.** The operator makes it by hand: a key made by the stack
 * would land in the stack's outputs.
 *
 * **Names, not `${AWS::AccountId}`.** Both forms carry the account id typed
 * into the connect form, so the CloudFormation template and the plain JSON are
 * literally the same documents; the connect check refuses a role made in any
 * other account anyway.
 */
export function setupTemplate(
  input: CloudAccountIds & { externalId: string },
  version = AWS_POLICY_VERSION,
): SetupTemplate {
  const names = setupNames(input);
  const managed = deployRoleManagedPolicy(input, version);
  const stackVm = deployRoleStackVmPolicy(input, version);
  const thisAccountsBuckets = {
    StringEquals: { 's3:ResourceAccount': input.accountId },
  };
  const json: SetupDocuments = {
    policyVersion: version,
    externalId: input.externalId,
    tagValue: input.tagValue,
    deployRole: {
      name: names.deployRoleName,
      trustPolicy: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { AWS: names.userArn },
            Action: 'sts:AssumeRole',
            Condition: { StringEquals: { 'sts:ExternalId': input.externalId } },
          },
        ],
      },
      policyName: `cloudgate-deploy-v${version}`,
      policy: deployRolePolicy(input, version),
      ...(managed
        ? {
            managedPolicy: {
              name: names.deployManagedPolicyName,
              policy: managed,
            },
          }
        : {}),
      ...(stackVm
        ? {
            stackVmPolicy: {
              name: names.deployStackVmPolicyName,
              policy: stackVm,
            },
          }
        : {}),
    },
    taskExecutionRole: {
      name: names.taskExecutionRoleName,
      trustPolicy: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Service: ECS_TASKS },
            Action: 'sts:AssumeRole',
          },
        ],
      },
      managedPolicyArns: [
        'arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy',
      ],
      policyName: 'cloudgate-parameters',
      policy: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Action: ['ssm:GetParameters'],
            Resource: [names.parameterPattern],
          },
        ],
      },
    },
    permissionsBoundary: {
      name: names.boundaryPolicyName,
      // The most a task role can ever hold (ADR-0032): read and write
      // the objects of this AWS account's buckets, never their settings.
      // Cloudgate's own are in the account's regional namespace; an
      // existing bucket (ADR-0033) has whatever name the operator gave
      // it, so the rest are held to this account by `s3:ResourceAccount`
      // rather than by name: the lookup finds only this account's buckets,
      // and a role the deploy role makes must never reach another account's
      // that happens to grant it. A role's inline policy names the buckets
      // it links; one linking none holds nothing.
      policy: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Action: [...BUCKET_OBJECT_ACTIONS],
            Resource: [`${names.bucketPattern}/*`],
          },
          {
            Effect: 'Allow',
            Action: [...BUCKET_LIST_ACTIONS],
            Resource: [names.bucketPattern],
          },
          {
            Effect: 'Allow',
            Action: [...BUCKET_OBJECT_ACTIONS],
            Resource: ['arn:aws:s3:::*/*'],
            Condition: thisAccountsBuckets,
          },
          {
            Effect: 'Allow',
            Action: [...BUCKET_LIST_ACTIONS],
            Resource: ['arn:aws:s3:::*'],
            Condition: thisAccountsBuckets,
          },
        ],
      },
    },
    ...(makesBuildIdentity(version)
      ? {
          buildRole: {
            name: names.buildRoleName,
            trustPolicy: {
              Version: '2012-10-17' as const,
              Statement: [
                {
                  Effect: 'Allow' as const,
                  Principal: { Service: CODEBUILD_SERVICE },
                  Action: 'sts:AssumeRole' as const,
                  // CodeBuild acting for this AWS account only (AWS's
                  // confused-deputy advice).
                  Condition: {
                    StringEquals: { 'aws:SourceAccount': input.accountId },
                  },
                },
              ],
            },
            policyName: 'cloudgate-build',
            policy: buildIdentityPolicy(input),
          },
        }
      : {}),
    user: {
      name: names.userName,
      policyName: 'cloudgate-assume-deploy-role',
      policy: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Action: 'sts:AssumeRole',
            Resource: names.deployRoleArn,
          },
        ],
      },
    },
  };

  const cloudFormation = {
    AWSTemplateFormatVersion: '2010-09-09',
    Description: `Cloudgate setup for Cloud account ${input.tagValue}, policy version ${version}. Make the access key for user ${names.userName} by hand.`,
    Resources: {
      CloudgateUser: {
        Type: 'AWS::IAM::User',
        Properties: {
          UserName: json.user.name,
          Policies: [
            {
              PolicyName: json.user.policyName,
              PolicyDocument: json.user.policy,
            },
          ],
        },
      },
      ...(json.deployRole.managedPolicy
        ? {
            CloudgateDeployManagedPolicy: {
              Type: 'AWS::IAM::ManagedPolicy',
              Properties: {
                ManagedPolicyName: json.deployRole.managedPolicy.name,
                PolicyDocument: json.deployRole.managedPolicy.policy,
              },
            },
          }
        : {}),
      ...(json.deployRole.stackVmPolicy
        ? {
            CloudgateDeployStackVmPolicy: {
              Type: 'AWS::IAM::ManagedPolicy',
              Properties: {
                ManagedPolicyName: json.deployRole.stackVmPolicy.name,
                PolicyDocument: json.deployRole.stackVmPolicy.policy,
              },
            },
          }
        : {}),
      CloudgateDeployRole: {
        Type: 'AWS::IAM::Role',
        // The trust policy names the user by ARN, which must exist first.
        DependsOn: 'CloudgateUser',
        Properties: {
          RoleName: json.deployRole.name,
          AssumeRolePolicyDocument: json.deployRole.trustPolicy,
          ...(json.deployRole.managedPolicy
            ? {
                ManagedPolicyArns: [
                  { Ref: 'CloudgateDeployManagedPolicy' },
                  ...(json.deployRole.stackVmPolicy
                    ? [{ Ref: 'CloudgateDeployStackVmPolicy' }]
                    : []),
                ],
              }
            : {}),
          Policies: [
            {
              PolicyName: json.deployRole.policyName,
              PolicyDocument: json.deployRole.policy,
            },
          ],
          Tags: [{ Key: 'cloudgate:policy-version', Value: String(version) }],
        },
      },
      CloudgateTaskExecutionRole: {
        Type: 'AWS::IAM::Role',
        Properties: {
          RoleName: json.taskExecutionRole.name,
          AssumeRolePolicyDocument: json.taskExecutionRole.trustPolicy,
          ManagedPolicyArns: json.taskExecutionRole.managedPolicyArns,
          Policies: [
            {
              PolicyName: json.taskExecutionRole.policyName,
              PolicyDocument: json.taskExecutionRole.policy,
            },
          ],
        },
      },
      CloudgatePermissionsBoundary: {
        Type: 'AWS::IAM::ManagedPolicy',
        Properties: {
          ManagedPolicyName: json.permissionsBoundary.name,
          PolicyDocument: json.permissionsBoundary.policy,
        },
      },
      ...(json.buildRole
        ? {
            CloudgateBuildRole: {
              Type: 'AWS::IAM::Role',
              Properties: {
                RoleName: json.buildRole.name,
                AssumeRolePolicyDocument: json.buildRole.trustPolicy,
                Policies: [
                  {
                    PolicyName: json.buildRole.policyName,
                    PolicyDocument: json.buildRole.policy,
                  },
                ],
              },
            },
          }
        : {}),
    },
    Outputs: {
      DeployRoleArn: { Value: names.deployRoleArn },
      TaskExecutionRoleArn: { Value: names.taskExecutionRoleArn },
      ...(json.buildRole
        ? { BuildRoleArn: { Value: names.buildRoleArn } }
        : {}),
      UserName: { Value: names.userName },
      ExternalId: { Value: input.externalId },
    },
  };

  return {
    policyVersion: version,
    cloudFormation: JSON.stringify(cloudFormation, null, 2),
    json,
  };
}
