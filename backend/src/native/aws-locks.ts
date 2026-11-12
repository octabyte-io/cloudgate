import { VALKEY_VERSIONS } from '../cloud-accounts/aws/definitions/redis-version';
import type { ConfigKind } from '../project-config/planner/plan.types';

/**
 * **The AWS Locked setting list** (ADR-0044 rules 2, 4, 7–9): what a
 * `native.aws` block may name, and which of each address's provider
 * arguments it may not set, and why, in one place.
 *
 * It is exactly the per-address list decided for AWS (as amended:
 * `apply_immediately` on RDS and ElastiCache, and ElastiCache's `engine`,
 * stay locked), taken from the definitions the cloud builders write
 * (`backend/src/cloud-accounts/aws/definitions/`). **A cloud is a
 * deny-list** (rule 8): every provider argument not named here is open, so
 * native stays an escape hatch for settings nobody foresaw. Size-bearing
 * arguments (`instance_class`, `node_type`, the task's and container's
 * `cpu` and `memory`) are open: native wins over `size`.
 *
 * **One list, three readers.** The plan refuses a locked value
 * (`aws-native.ts`, on every plan, whatever the Deploy target), and the
 * console's save and the deploy read the same table once the per-kind
 * tickets lay native over a definition, so a value locked
 * here is locked on every path at once. Refused by path with its reason,
 * never stripped or written over (rule 9).
 *
 * Beyond that list, these entries carry its own reasons onto arguments
 * the list did not spell out:
 *
 * - `region` on every address: the pinned provider (6.x) takes a region per
 *   resource, and the location is locked on every address (ADR-0044 rule
 *   7), as Google's is.
 * - `id` on every address: OpenTofu's id for what Cloudgate made, which a
 *   definition never writes; and the naming twins of a locked name
 *   (`identifier_prefix`, `bucket_prefix`, a target group's `name` beside
 *   its `name_prefix`), which name the resource as surely.
 * - `password_wo` / `auth_token_wo` and their `_version`s beside the
 *   `password` and `auth_token` the list locks: the same login, written once.
 * - `bucket` on a bucket's encryption and CORS resources, the bucket they
 *   are of, as `repository` is on the ECR lifecycle policy.
 * - On `aws_s3_bucket` itself, the provider's older inline twins of
 *   what the list locks whole or keeps: `policy` (the bucket policy), `acl` and
 *   `grant` (the ownership controls), `cors_rule` (the CORS, whose origins
 *   are the bucket page's), and `replication_configuration`, which runs as
 *   an IAM role and copies every file to a bucket outside the Service.
 *
 * **CORS is open, but its origins are kept**: a bucket's
 * `cors_rule` list is the operator's to write, and each rule written is laid
 * with the origins the bucket's page trusts ({@link AwsAddressEntry.kept}),
 * which no native block may set.
 *
 * **A static site's `custom_error_response` is locked only while the
 * config's `spa` owns it** ({@link AwsAddressEntry.lockedWhile}): with
 * `spa` off, its error pages are the operator's.
 *
 * **A replace that loses data is refused by one rule**, not by
 * per-setting locks: {@link AWS_DATA_HOLDING} names the addresses a native
 * change may never replace, read from the cloud plan's actions
 * (`nativeAwsReplaceRefusals` in `aws-lay.ts`).
 *
 * `aws_service_discovery_service.service` (a `web-private`'s) is not
 * on that list. It stays **locked whole**, no other answer being given
 * there: it is
 * routing and discovery, categories (b) and (c), and its body's digest
 * feeds the ECS service's `triggers`.
 *
 * **The census** (`test/coding-standards/native-lock-census.spec.ts`)
 * holds this table equal to what the definitions write, and classes every
 * argument of every address it may name, at every depth, locked here or
 * open in `aws-open-settings.ts`. What it found that the list did not spell
 * out is locked by the list's own categories:
 *
 * - deletion protection and "what a destroy does" on every address that
 *   has them (`deletion_protection_enabled` and `skip_destroy` on the log
 *   group, `skip_destroy` on the task definition, `force_delete` on the ECS
 *   service, `retain_on_delete` on the distribution,
 *   `delete_automated_backups` on RDS), as Google's are;
 * - the naming twins (`name_prefix` on the log group), the tag twins
 *   (`managed_ebs_volume.tag_specifications`), and ECR's tag-mutability
 *   exclusions, which move a tag as surely as `image_tag_mutability`;
 * - the ECS service's other deployment and routing settings
 *   (`deployment_configuration.strategy` and its `lifecycle_hook`,
 *   `vpc_lattice_configurations`, `scheduling_strategy`), the task
 *   definition's `proxy_configuration` and `track_latest`;
 * - RDS's directory and IAM logins (`domain*`,
 *   `iam_database_authentication_enabled`, the master secret's key),
 *   `network_type`, `customer_owned_ip_enabled`, `custom_iam_instance_profile`
 *   and `s3_import`; ElastiCache's other login, TLS, cluster, network and
 *   made-from settings, its global replication, and its minor-version
 *   upgrades as RDS's;
 * - an S3 bucket's `server_side_encryption_configuration` (the inline twin
 *   of its own encryption resource; the other twins and replication are
 *   above), its `website` endpoint, object lock, requester pays,
 *   versioning and MFA delete, which open it or outlive Delete; and a
 *   distribution's `ordered_cache_behavior` origin and function, as its
 *   default behaviour's, its Lambda@Edge associations and its continuous
 *   deployment to a staging distribution, which could serve the site from
 *   somewhere else;
 * - the ECS container's `privileged`, `repositoryCredentials`,
 *   `firelensConfiguration`, `environmentFiles`, `credentialSpecs` and the
 *   fields naming other containers (`dependsOn`, `links`, `volumesFrom`).
 */

const TAGS = 'tags are how Cloudgate finds, marks and deletes what it made';

/** Locked on every address (ADR-0044 rule 7). */
export const AWS_LOCKED_EVERYWHERE: Readonly<Record<string, string>> = {
  tags: TAGS,
  tags_all: TAGS,
  region:
    "the region is the Environment's, the same for every resource it makes",
  id: "the id is OpenTofu's for what Cloudgate made, never written",
};

/**
 * The addresses made once per Domain or once per variable: refused whole, since they belong to the Service's Domains and
 * variables, not to the config.
 */
export const AWS_PER_INSTANCE: Readonly<Record<string, string>> = {
  'aws_acm_certificate.domain':
    "made once per Domain; a Domain's certificate is set through the Service's Domains",
  'aws_lb_listener_rule.domain':
    "made once per Domain; a Domain's routing is set through the Service's Domains",
  'aws_lb_listener_certificate.domain':
    "made once per Domain; a Domain's certificate is set through the Service's Domains",
  'aws_lb_target_group.stack_vm':
    "made once per port a Stack VM's Domains reach; set through the stack's Domains",
  'aws_lb_target_group_attachment.stack_vm':
    "made once per port a Stack VM's Domains reach; set through the stack's Domains",
  'aws_ssm_parameter.variable':
    "made once per variable; a variable's value is set through the Service's variables",
};

/**
 * **The Environment network's addresses**: in the network's
 * own state, which no config entry describes, so `native.aws` names none of
 * them (ADR-0044 Consequences) and each is refused whole with this reason.
 * The census holds the list equal to what `networkDefinition` writes.
 */
const ENVIRONMENT_NETWORK =
  'the Environment network has no native block: no config entry describes it, and every Service in the Environment shares it';

export const AWS_ENVIRONMENT_NETWORK: Readonly<Record<string, string>> =
  Object.fromEntries(
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
      'aws_acm_certificate.default',
      'aws_lb_listener.http',
      'aws_lb_listener.https',
      'aws_ecs_cluster.network',
      'aws_service_discovery_private_dns_namespace.network',
      // A Stack VM's way out, once the first one needs it.
      'aws_eip.nat',
      'aws_nat_gateway.nat',
      'aws_route_table.private',
      'aws_route.private_internet',
      'aws_route_table_association.private_a',
      'aws_route_table_association.private_b',
      // A hosted cloud build's standing pieces, on the Hosted
      // instance only.
      'aws_s3_bucket.build_source',
      'aws_s3_bucket_public_access_block.build_source',
      'aws_s3_bucket_ownership_controls.build_source',
      'aws_s3_bucket_server_side_encryption_configuration.build_source',
      'aws_cloudwatch_log_group.build',
      'aws_codebuild_project.build',
    ].map((address) => [address, ENVIRONMENT_NETWORK]),
  );

/**
 * **What `native.aws` names on each kind** (ADR-0044 rule 11): one
 * entry per kind the config describes, the census's record that each was
 * looked at. The addresses themselves are {@link AWS_ADDRESSES}'.
 */
export const AWS_KIND_ENTRIES: Readonly<Record<ConfigKind, string>> = {
  web: "an ECS-run Service's addresses, with its target group and listener rule; its Domains' are refused whole",
  'web-private':
    "an ECS-run Service's addresses, with its discovery service, locked whole",
  worker: "an ECS-run Service's addresses, with nothing routing to it",
  cron: "an ECS-run Service's addresses but the ECS service: each run is a one-off task of its task definition",
  postgres:
    'the RDS instance; its subnet and security groups are locked whole, and an Existing database makes nothing',
  mysql:
    'the RDS instance; its subnet and security groups are locked whole, and an Existing database makes nothing',
  redis:
    'the ElastiCache replication group and its parameter group; its subnet and security groups are locked whole, and an Existing database makes nothing',
  bucket:
    'the S3 bucket and its encryption and CORS; its public access and ownership resources are locked whole, and an existing bucket makes nothing',
  static:
    "the site's bucket, its encryption and its CloudFront distribution; what reaches the bucket is locked whole, and its Domain's certificate is refused whole",
  compose:
    "its Stack VM's instance and data disk (ADR-0070): the machine type is open, what reaches it and what it boots are locked; its identity, security group and snapshot policy are locked whole",
};

/**
 * What decides whether a Service makes an address **right now**, beyond its
 * kind. Facts only an AWS Environment's saved Service knows are absent on
 * any other target, and an absent fact is never a reason to refuse: the
 * address is taken as made, and the deploy names anything wrong.
 */
export interface AwsMadeFacts {
  /** The kinds of the Services the entry's links name (ADR-0031). */
  readonly linkedKinds: readonly string[];
  /** It is an Existing database or an existing bucket, used as given (ADR-0033). */
  readonly existing?: boolean;
  /** Its bucket's page trusts at least one browser origin. */
  readonly browserOrigins?: boolean;
  /** The parameter group family its version runs (`valkey8`), when it can be read. */
  readonly parameterFamily?: string;
  /**
   * A `static` entry's `spa`, the config's on every target: while
   * set, it owns the site's custom error responses.
   */
  readonly spa?: boolean;
}

/** One address a kind makes, with its locks. */
export interface AwsAddressEntry {
  /** The resource type, which picks its committed schema. */
  readonly type: string;
  /** The kinds whose definition writes it. */
  readonly kinds: readonly ConfigKind[];
  /** Locked whole, with the reason: no argument of it may be set. */
  readonly whole?: string;
  /**
   * Locked arguments, each with its reason: a top-level argument by name,
   * one inside a block by its dotted path (`default_cache_behavior.target_origin_id`).
   */
  readonly locked?: Readonly<Record<string, string>>;
  /**
   * Top-level arguments locked only while a fact holds, each with
   * its reason: a static site's `custom_error_response` while its `spa`
   * owns it.
   */
  readonly lockedWhile?: Readonly<
    Record<
      string,
      {
        readonly reason: string;
        readonly while: (facts: AwsMadeFacts) => boolean;
      }
    >
  >;
  /**
   * Arguments inside each item of a list a native block may write that
   * keep **Cloudgate's** value, by dotted path
   * (`cors_rule.allowed_origins`), each with the reason none is written:
   * the check refuses one written and asks for none, and the lay gives
   * every item written Cloudgate's.
   */
  readonly kept?: Readonly<Record<string, string>>;
  /** Why it is not made right now, or `null` when it is. */
  readonly madeNow?: (facts: AwsMadeFacts, address: string) => string | null;
}

const ECS_KINDS = ['web', 'web-private', 'worker', 'cron'] as const;
const ALWAYS_RUNNING = ['web', 'web-private', 'worker'] as const;
const RDS_KINDS = ['postgres', 'mysql'] as const;
const STACK_VM = ['compose'] as const;
const NEVER_PUBLIC =
  'a Stack VM is never reachable from outside; Cloudgate reaches it through Session Manager';
const FIRST_BOOT =
  "its first boot installs Cloudgate's pinned Docker and mounts its data disk";

const IDENTITY = "Cloudgate's name for it, which it finds and deletes it by";
const NETWORK =
  "the Environment network's, shared with every other Service in it";
const RUNS_AS = 'who the Service runs as is Cloudgate’s';
const CONFIG_OWNS = (field: string) => `the config's ${field} sets it`;
const REPLACE = (what: string) =>
  `${what} is Cloudgate's; a change replaces the resource`;
const LOGIN =
  'the login is Cloudgate’s, which every linked Service is wired with';
const DELETE = "Delete is Cloudgate's, and asks before it deletes";
const DESTROY = "what a destroy does is Delete's, which asks before it deletes";
const ONE_DISTRIBUTION =
  'the site is served by its own distribution alone, from its own bucket’s live Deployment';
const OUTLIVES_DELETE =
  'a file kept by it would outlive Delete, which empties the bucket it asked to';

/**
 * The parameter group's local name is its family (`valkey8`), the address
 * the plan's cloud lines show; {@link awsAddressKey} maps an address to it.
 */
export const PARAMETER_GROUP = 'aws_elasticache_parameter_group.<family>';

/** The families a `redis` on ElastiCache can run, one per Valkey major. */
export const PARAMETER_FAMILIES: readonly string[] = [
  ...new Set(VALKEY_VERSIONS.map((v) => `valkey${v.split('.')[0]}`)),
];

const whileLinksBucket = (facts: AwsMadeFacts) =>
  facts.linkedKinds.includes('bucket')
    ? null
    : 'it is made only while the Service links a bucket';

const whileTrustsOrigins = (facts: AwsMadeFacts) =>
  facts.browserOrigins === false
    ? "it is made only while the bucket's page trusts a browser origin"
    : null;

const ORIGINS = "the trusted origins are the bucket page's";
const PUBLIC_ACCESS =
  'Block Public Access keeps the bucket unreachable from outside';
const OWNERSHIP = 'ACLs stay off, so no object can be opened to the world';

/**
 * A bucket's own resources, a `bucket`'s and a `static` site's alike;
 * `policy` and `cors` are why each may set no inline policy or CORS.
 */
function bucketAddresses(
  local: string,
  kind: ConfigKind,
  policy: string,
  cors: string,
): Record<string, AwsAddressEntry> {
  return {
    [`aws_s3_bucket.${local}`]: {
      type: 'aws_s3_bucket',
      kinds: [kind],
      locked: {
        bucket: IDENTITY,
        bucket_namespace:
          "the account-regional namespace keeps the name the account's alone",
        force_destroy:
          'a destroy never empties a bucket; Delete asks before it does',
        bucket_prefix: IDENTITY,
        // Inline twins of what the bucket's own resources set or keep: two
        // writers of one setting would put each other back on every plan.
        policy,
        acl: OWNERSHIP,
        grant: OWNERSHIP,
        cors_rule: cors,
        server_side_encryption_configuration:
          'set on its own resource, aws_s3_bucket_server_side_encryption_configuration',
        website: 'a website endpoint would reach the bucket from outside',
        replication_configuration:
          'it runs as an IAM role and copies every file to a bucket outside the Service',
        object_lock_enabled: OUTLIVES_DELETE,
        object_lock_configuration: OUTLIVES_DELETE,
        versioning: OUTLIVES_DELETE,
        request_payer:
          'Cloudgate and every linked Service read the bucket as its owner',
      },
    },
    [`aws_s3_bucket_public_access_block.${local}`]: {
      type: 'aws_s3_bucket_public_access_block',
      kinds: [kind],
      whole: PUBLIC_ACCESS,
    },
    [`aws_s3_bucket_ownership_controls.${local}`]: {
      type: 'aws_s3_bucket_ownership_controls',
      kinds: [kind],
      whole: OWNERSHIP,
    },
    [`aws_s3_bucket_server_side_encryption_configuration.${local}`]: {
      type: 'aws_s3_bucket_server_side_encryption_configuration',
      kinds: [kind],
      locked: { bucket: 'the bucket it encrypts is Cloudgate’s' },
    },
  };
}

/**
 * **Every address a Service makes, by kind, with its locks**. The
 * census holds it equal to what the definition builders write.
 */
export const AWS_ADDRESSES: Readonly<Record<string, AwsAddressEntry>> = {
  // ── An ECS-run Service: web, web-private, worker and cron ──
  'aws_ecr_repository.service': {
    type: 'aws_ecr_repository',
    kinds: ECS_KINDS,
    locked: {
      name: IDENTITY,
      force_delete: "Delete takes the Service's images with it",
      image_tag_mutability:
        'going back to an older Deployment relies on its tag never moving',
      image_tag_mutability_exclusion_filter:
        'going back to an older Deployment relies on its tag never moving',
    },
  },
  'aws_ecr_lifecycle_policy.service': {
    type: 'aws_ecr_lifecycle_policy',
    kinds: ECS_KINDS,
    locked: { repository: "the Service's own repository is Cloudgate's" },
  },
  'aws_cloudwatch_log_group.service': {
    type: 'aws_cloudwatch_log_group',
    kinds: ECS_KINDS,
    locked: {
      name: "the Runtime log reads the Service's logs by this name",
      name_prefix: "the Runtime log reads the Service's logs by this name",
      deletion_protection_enabled: DELETE,
      skip_destroy: DESTROY,
    },
  },
  'aws_iam_role.task': {
    type: 'aws_iam_role',
    kinds: ECS_KINDS,
    whole: RUNS_AS,
  },
  'aws_iam_role_policy.buckets': {
    type: 'aws_iam_role_policy',
    kinds: ECS_KINDS,
    whole:
      'a link is the access (ADR-0032); what the Service may reach is Cloudgate’s',
    madeNow: whileLinksBucket,
  },
  'aws_ecs_task_definition.service': {
    type: 'aws_ecs_task_definition',
    kinds: ECS_KINDS,
    locked: {
      family: IDENTITY,
      requires_compatibilities: 'the Service runs on Fargate',
      network_mode: 'the task joins the Environment network in awsvpc mode',
      execution_role_arn: RUNS_AS,
      task_role_arn: RUNS_AS,
      runtime_platform: 'it follows the image Cloudgate built',
      skip_destroy: DESTROY,
      track_latest:
        "the revision the Service runs is its Deployment's, which Cloudgate writes",
      proxy_configuration: "the Service's routing is Cloudgate's",
    },
  },
  'aws_security_group.service': {
    type: 'aws_security_group',
    kinds: ECS_KINDS,
    whole: `who may reach the Service is Cloudgate's; ${NETWORK}`,
  },
  'aws_ecs_service.service': {
    type: 'aws_ecs_service',
    kinds: ALWAYS_RUNNING,
    locked: {
      name: IDENTITY,
      cluster: NETWORK,
      task_definition: "the task definition is the Service's own, Cloudgate's",
      desired_count:
        'the running count is Stop’s and Start’s, set outside the plan',
      network_configuration: NETWORK,
      load_balancer: "the Service's routing is Cloudgate's",
      launch_type: 'the Service runs on Fargate',
      capacity_provider_strategy:
        'the Service runs on Fargate; Fargate Spot is not offered yet',
      deployment_controller:
        'Cloudgate deploys the Service with ECS’s own rolling update',
      wait_for_steady_state: 'Cloudgate waits for the deploy itself',
      service_registries: "the Service's routing is Cloudgate's",
      service_connect_configuration: "the Service's routing is Cloudgate's",
      iam_role: RUNS_AS,
      triggers:
        'a changed variable or discovery service rolls the tasks through it',
      force_new_deployment: 'a changed variable rolls the tasks through it',
      propagate_tags: TAGS,
      enable_ecs_managed_tags: TAGS,
      'volume_configuration.managed_ebs_volume.role_arn': RUNS_AS,
      'volume_configuration.managed_ebs_volume.tag_specifications': TAGS,
      force_delete: DESTROY,
      scheduling_strategy:
        'the running count is Stop’s and Start’s, set outside the plan',
      'deployment_configuration.strategy':
        'Cloudgate deploys the Service with ECS’s own rolling update',
      'deployment_configuration.lifecycle_hook':
        'Cloudgate deploys the Service with ECS’s own rolling update, and a hook runs as a role Cloudgate does not make',
      vpc_lattice_configurations: "the Service's routing is Cloudgate's",
    },
  },
  'aws_lb_target_group.service': {
    type: 'aws_lb_target_group',
    kinds: ['web'],
    locked: {
      name: IDENTITY,
      name_prefix: IDENTITY,
      target_type: 'the tasks are registered by IP',
      port: CONFIG_OWNS('port'),
      vpc_id: NETWORK,
    },
  },
  'aws_lb_listener_rule.service': {
    type: 'aws_lb_listener_rule',
    kinds: ['web'],
    whole:
      "the Service's routing on the Environment's load balancer is Cloudgate's",
  },
  'aws_service_discovery_service.service': {
    type: 'aws_service_discovery_service',
    kinds: ['web-private'],
    whole:
      "a Private web service's discovery is its routing, Cloudgate's, and its digest rolls the ECS service's tasks",
  },

  // ── postgres and mysql on RDS ──
  'aws_db_subnet_group.database': {
    type: 'aws_db_subnet_group',
    kinds: RDS_KINDS,
    whole: NETWORK,
  },
  'aws_security_group.database': {
    type: 'aws_security_group',
    kinds: RDS_KINDS,
    whole: `who may reach the database is Cloudgate's; ${NETWORK}`,
  },
  'aws_db_instance.database': {
    type: 'aws_db_instance',
    kinds: RDS_KINDS,
    locked: {
      identifier: IDENTITY,
      identifier_prefix: IDENTITY,
      engine: REPLACE('the engine'),
      engine_version: CONFIG_OWNS('version'),
      auto_minor_version_upgrade: CONFIG_OWNS('version'),
      allow_major_version_upgrade: CONFIG_OWNS('version'),
      db_name: CONFIG_OWNS('database'),
      username: CONFIG_OWNS('user'),
      password:
        'the login is Cloudgate’s, which every linked Service is wired with',
      password_wo:
        'the login is Cloudgate’s, which every linked Service is wired with',
      password_wo_version:
        'the login is Cloudgate’s, which every linked Service is wired with',
      manage_master_user_password:
        'the login is Cloudgate’s, which every linked Service is wired with',
      port: 'every linked Service is wired with it',
      db_subnet_group_name: NETWORK,
      vpc_security_group_ids: NETWORK,
      publicly_accessible: 'a database on RDS is never reachable from outside',
      deletion_protection: "Delete is Cloudgate's, and asks before it deletes",
      skip_final_snapshot: 'Delete keeps a final snapshot',
      final_snapshot_identifier: 'Delete names the final snapshot it keeps',
      copy_tags_to_snapshot: TAGS,
      apply_immediately:
        'a change held for the maintenance window would read as Drift until then',
      monitoring_role_arn: RUNS_AS,
      replicate_source_db: 'what the database is made from is Cloudgate’s',
      snapshot_identifier: 'what the database is made from is Cloudgate’s',
      restore_to_point_in_time: 'what the database is made from is Cloudgate’s',
      s3_import: 'what the database is made from is Cloudgate’s',
      delete_automated_backups: 'what Delete keeps of the database is Delete’s',
      master_user_secret_kms_key_id: LOGIN,
      iam_database_authentication_enabled: LOGIN,
      domain: LOGIN,
      domain_auth_secret_arn: LOGIN,
      domain_dns_ips: LOGIN,
      domain_fqdn: LOGIN,
      domain_iam_role_name: LOGIN,
      domain_ou: LOGIN,
      custom_iam_instance_profile: RUNS_AS,
      network_type: NETWORK,
      customer_owned_ip_enabled:
        'a database on RDS is reached only from the Environment network',
    },
  },

  // ── redis on ElastiCache ──
  'aws_elasticache_subnet_group.cache': {
    type: 'aws_elasticache_subnet_group',
    kinds: ['redis'],
    whole: NETWORK,
  },
  'aws_security_group.cache': {
    type: 'aws_security_group',
    kinds: ['redis'],
    whole: `who may reach the cache is Cloudgate's; ${NETWORK}`,
  },
  [PARAMETER_GROUP]: {
    type: 'aws_elasticache_parameter_group',
    kinds: ['redis'],
    locked: {
      name: IDENTITY,
      family: CONFIG_OWNS('version'),
      description:
        'a new description replaces the parameter group, whose name is Cloudgate’s and taken while the old one stands',
    },
    madeNow: (facts, address) =>
      facts.parameterFamily === undefined ||
      address === `aws_elasticache_parameter_group.${facts.parameterFamily}`
        ? null
        : `its version runs ${facts.parameterFamily}, so its parameter group is aws_elasticache_parameter_group.${facts.parameterFamily}`,
  },
  'aws_elasticache_replication_group.cache': {
    type: 'aws_elasticache_replication_group',
    kinds: ['redis'],
    locked: {
      replication_group_id: IDENTITY,
      engine: 'a redis on AWS is always Valkey',
      engine_version: CONFIG_OWNS('version'),
      port: 'every linked Service is wired with it',
      subnet_group_name: NETWORK,
      security_group_ids: NETWORK,
      parameter_group_name: "the cache's parameter group is Cloudgate's",
      transit_encryption_enabled:
        'every linked Service is wired to connect over TLS',
      auth_token:
        'the login is Cloudgate’s, which every linked Service is wired with',
      auth_token_wo:
        'the login is Cloudgate’s, which every linked Service is wired with',
      auth_token_wo_version:
        'the login is Cloudgate’s, which every linked Service is wired with',
      final_snapshot_identifier: 'Delete names the final snapshot it keeps',
      apply_immediately:
        'a change held for the maintenance window would read as Drift until then',
      cluster_mode: 'every linked Service is wired to one primary endpoint',
      num_node_groups: 'every linked Service is wired to one primary endpoint',
      node_group_configuration:
        'every linked Service is wired to one primary endpoint',
      auto_minor_version_upgrade: CONFIG_OWNS('version'),
      transit_encryption_mode:
        'every linked Service is wired to connect over TLS',
      auth_token_update_strategy: LOGIN,
      user_group_ids: LOGIN,
      network_type: NETWORK,
      ip_discovery: NETWORK,
      security_group_names: NETWORK,
      snapshot_arns: 'what the cache is made from is Cloudgate’s',
      snapshot_name: 'what the cache is made from is Cloudgate’s',
      global_replication_group_id:
        'what the cache replicates with reaches past its Service',
    },
  },

  // ── bucket on S3 ──
  ...bucketAddresses(
    'bucket',
    'bucket',
    'a bucket has no policy of its own: a link is the access (ADR-0032)',
    `its CORS is aws_s3_bucket_cors_configuration.bucket, where ${ORIGINS}`,
  ),
  'aws_s3_bucket_cors_configuration.bucket': {
    type: 'aws_s3_bucket_cors_configuration',
    kinds: ['bucket'],
    locked: {
      bucket: 'the bucket it is of is Cloudgate’s',
    },
    // Each rule written keeps the page's origins.
    kept: { 'cors_rule.allowed_origins': ORIGINS },
    madeNow: whileTrustsOrigins,
  },

  // ── compose on its Stack VM ──
  'aws_instance.stack_vm': {
    type: 'aws_instance',
    kinds: STACK_VM,
    locked: {
      ami: 'the image it was made from is recorded; only an approved "replace VM" line moves it',
      launch_template: 'the Stack VM is written whole by Cloudgate',
      subnet_id: NETWORK,
      network_interface: NETWORK,
      vpc_security_group_ids: NEVER_PUBLIC,
      security_groups: NEVER_PUBLIC,
      associate_public_ip_address: NEVER_PUBLIC,
      iam_instance_profile: 'who the Stack VM runs as is Cloudgate’s',
      user_data: FIRST_BOOT,
      user_data_base64: FIRST_BOOT,
      user_data_replace_on_change: FIRST_BOOT,
      disable_api_stop: 'Stop and Start are Cloudgate’s',
      disable_api_termination: DELETE,
      instance_initiated_shutdown_behavior: 'Stop and Start are Cloudgate’s',
      force_destroy: DESTROY,
      availability_zone: NETWORK,
      private_ip: NETWORK,
      secondary_private_ips: NETWORK,
      primary_network_interface: NETWORK,
      secondary_network_interface: NETWORK,
      ipv6_address_count: NEVER_PUBLIC,
      ipv6_addresses: NEVER_PUBLIC,
      enable_primary_ipv6: NEVER_PUBLIC,
      key_name:
        'Cloudgate reaches the Stack VM through Session Manager, with its own key; no key pair is needed',
      ebs_block_device:
        "the stack's data disk is its own resource, aws_ebs_volume.data",
      volume_tags: TAGS,
      'root_block_device.delete_on_termination': DESTROY,
      'root_block_device.tags': TAGS,
      'root_block_device.tags_all': TAGS,
    },
  },
  'aws_ebs_volume.data': {
    type: 'aws_ebs_volume',
    kinds: STACK_VM,
    locked: {
      availability_zone: "it sits in its Stack VM's zone",
      size: 'the data disk starts at 20 GB and only grows, from the stack page',
      snapshot_id: REPLACE('what the disk starts from'),
      encrypted: 'the stack’s volumes are encrypted at rest',
      kms_key_id: REPLACE('its key'),
      final_snapshot: DELETE,
      outpost_arn: "it sits in its Stack VM's zone",
      multi_attach_enabled: 'it is attached to its own Stack VM alone',
    },
  },
  'aws_volume_attachment.data': {
    type: 'aws_volume_attachment',
    kinds: STACK_VM,
    whole: "the data disk is Docker's volume folder on its Stack VM",
  },
  'aws_iam_role.stack_vm': {
    type: 'aws_iam_role',
    kinds: STACK_VM,
    whole: 'who the Stack VM runs as is Cloudgate’s',
  },
  'aws_iam_role_policy_attachment.session_manager': {
    type: 'aws_iam_role_policy_attachment',
    kinds: STACK_VM,
    whole: 'Session Manager is how Cloudgate reaches the Stack VM',
  },
  'aws_iam_instance_profile.stack_vm': {
    type: 'aws_iam_instance_profile',
    kinds: STACK_VM,
    whole: 'who the Stack VM runs as is Cloudgate’s',
  },
  'aws_security_group.stack_vm': {
    type: 'aws_security_group',
    kinds: STACK_VM,
    whole: `who may reach the Stack VM is Cloudgate's; ${NETWORK}`,
  },
  'aws_iam_role.snapshots': {
    type: 'aws_iam_role',
    kinds: STACK_VM,
    whole: 'the daily snapshots are taken as Cloudgate’s role',
  },
  'aws_iam_role_policy_attachment.snapshots': {
    type: 'aws_iam_role_policy_attachment',
    kinds: STACK_VM,
    whole: 'the daily snapshots are taken as Cloudgate’s role',
  },
  'aws_dlm_lifecycle_policy.snapshots': {
    type: 'aws_dlm_lifecycle_policy',
    kinds: STACK_VM,
    whole: 'the data disk is snapshotted daily and each kept 7 days (ADR-0070)',
  },

  // ── static on S3 and CloudFront ──
  ...bucketAddresses(
    'site',
    'static',
    'only the site’s own distribution may read its bucket',
    'its distribution serves it; its bucket trusts no browser origin',
  ),
  'aws_s3_bucket_policy.site': {
    type: 'aws_s3_bucket_policy',
    kinds: ['static'],
    whole: 'only the site’s own distribution may read its bucket',
  },
  'aws_cloudfront_origin_access_control.site': {
    type: 'aws_cloudfront_origin_access_control',
    kinds: ['static'],
    whole: 'how the distribution signs its reads of the bucket is Cloudgate’s',
  },
  'aws_cloudfront_function.site': {
    type: 'aws_cloudfront_function',
    kinds: ['static'],
    whole: 'it serves index.html for a path ending in /, as on a Server',
  },
  'aws_cloudfront_distribution.site': {
    type: 'aws_cloudfront_distribution',
    kinds: ['static'],
    locked: {
      origin: 'the site is served from its own bucket’s live Deployment',
      aliases: "the site's Domain is set through the Service's Domains",
      viewer_certificate:
        "the site's certificate is set through the Service's Domains",
      enabled: 'Stop and Start are Cloudgate’s',
      'default_cache_behavior.target_origin_id':
        'the site is served from its own bucket’s live Deployment',
      'default_cache_behavior.function_association':
        'it serves index.html for a path ending in /, as on a Server',
      'ordered_cache_behavior.target_origin_id':
        'the site is served from its own bucket’s live Deployment',
      'ordered_cache_behavior.function_association':
        'it serves index.html for a path ending in /, as on a Server',
      retain_on_delete: DESTROY,
      continuous_deployment_policy_id: ONE_DISTRIBUTION,
      staging: ONE_DISTRIBUTION,
      'default_cache_behavior.lambda_function_association': ONE_DISTRIBUTION,
      'ordered_cache_behavior.lambda_function_association': ONE_DISTRIBUTION,
    },
    lockedWhile: {
      // With `spa` off, its error pages are the operator's.
      custom_error_response: {
        reason: CONFIG_OWNS('spa'),
        while: (facts) => facts.spa === true,
      },
    },
  },
};

/**
 * **What a native change may never replace**: each
 * address holding data, with what its replace loses. The plan refuses any
 * native change OpenTofu would carry out as a replace of one, naming the
 * path, read from the cloud plan's actions (`nativeAwsReplaceRefusals`): a
 * bucket's, and a postgres's, a mysql's and a redis's.
 */
export const AWS_DATA_HOLDING: Readonly<Record<string, string>> = {
  'aws_s3_bucket.bucket': 'the bucket for it, losing every file in it',
  'aws_s3_bucket.site':
    "the site's bucket for it, losing every Deployment's files in it",
  'aws_db_instance.database':
    'the database instance for it, deleting the data it holds (set it back, or move the data to a new Service yourself)',
  'aws_elasticache_replication_group.cache':
    'the replication group for it, deleting the data it holds (set it back, or move the data to a new Service yourself)',
  'aws_ebs_volume.data':
    "the Stack VM's data disk for it, deleting every volume on it (set it back, or move the data to a new Service yourself)",
};

/**
 * The one container a `web` runs: `container_definitions` written as
 * one object in ECS's camelCase, merged into Cloudgate's container. These
 * keys Cloudgate depends on, or the config already owns. Every other
 * `ContainerDefinition` field is open.
 */
export const AWS_CONTAINER_LOCKS: Readonly<Record<string, string>> = {
  name: 'Cloudgate reads the container and its logs by this name',
  image: "the image is the Deployment's, which Cloudgate built",
  essential: 'the task stands or falls with its one container',
  portMappings: CONFIG_OWNS('port'),
  logConfiguration: "the Runtime log reads the Service's logs from it",
  secrets: CONFIG_OWNS('env'),
  environment: CONFIG_OWNS('env'),
  entryPoint: CONFIG_OWNS('command'),
  command: CONFIG_OWNS('args'),
  environmentFiles: CONFIG_OWNS('env'),
  privileged:
    'a privileged container reaches past its Service to what runs it (Fargate refuses one too)',
  repositoryCredentials:
    "the image is the Deployment's, pulled from the Service's own repository",
  firelensConfiguration: "the Runtime log reads the Service's logs from it",
  credentialSpecs: RUNS_AS,
  dependsOn: 'the task runs one container, Cloudgate’s',
  links: 'the task runs one container, Cloudgate’s',
  volumesFrom: 'the task runs one container, Cloudgate’s',
};

/** The address of the ECS container, and its key, as the file writes them. */
export const AWS_CONTAINER_ADDRESS = 'aws_ecs_task_definition.service';
export const CONTAINER_KEY = 'container_definitions';

/**
 * The table key an address is listed under: itself, or
 * {@link PARAMETER_GROUP} for a parameter group named by a family.
 */
export function awsAddressKey(address: string): string {
  const [type, local] = address.split('.');
  if (
    type === 'aws_elasticache_parameter_group' &&
    local !== undefined &&
    PARAMETER_FAMILIES.includes(local)
  ) {
    return PARAMETER_GROUP;
  }
  return address;
}
