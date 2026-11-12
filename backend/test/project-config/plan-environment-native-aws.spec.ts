import { parseProjectConfig, planEnvironment } from '../../src/project-config';
import type {
  DeployTarget,
  PlanInput,
  PlanOutcome,
  SavedService,
} from '../../src/project-config';

/**
 * `native.aws` through the planner. It is checked on every plan,
 * whatever the Deploy target, so a typo shows on a Docker staging plan
 * rather than on the first deploy to AWS (ADR-0044 rules 2, 4, 5, 7–9).
 */

const DOCKER: DeployTarget = { kind: 'platform-host' };
const AWS: DeployTarget = {
  kind: 'cloud',
  cloudAccountId: 'ca-1',
  region: 'eu-west-1',
};

/** The provider version Cloudgate runs, as `deploy/opentofu/` pins it. */
const PROVIDER = 'hashicorp/aws 6.69.1';

type Entry = Record<string, unknown>;

/** A config text of these entries (JSON is YAML). */
function config(services: Record<string, Entry>): string {
  return JSON.stringify({ version: 1, services });
}

function plan(
  services: Record<string, Entry>,
  deployTarget: DeployTarget,
  more: Partial<PlanInput> = {},
): PlanOutcome {
  const parsed = parseProjectConfig(config(services));
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

function planned(...args: Parameters<typeof plan>) {
  const outcome = plan(...args);
  if (!outcome.ok) {
    throw new Error(
      `refused: ${outcome.refusals.map((r) => r.message).join('; ')}`,
    );
  }
  return outcome;
}

const web = (aws: Entry, more: Entry = {}): Entry => ({
  kind: 'web',
  ...more,
  native: { aws },
});

const BOTH = [
  ['a Docker Environment', DOCKER],
  ['an AWS Environment', AWS],
] as const;

describe('planEnvironment native.aws', () => {
  describe.each(BOTH)('on %s', (_where, target) => {
    it('refuses a misspelt argument, naming its path and the provider Cloudgate runs', () => {
      expect(
        refusals(
          {
            api: web({
              'aws_ecs_service.service': {
                health_check_grace_perod_seconds: 60,
              },
            }),
          },
          target,
        ),
      ).toEqual([
        `api.native.aws."aws_ecs_service.service".health_check_grace_perod_seconds: refused - aws_ecs_service has no argument health_check_grace_perod_seconds in ${PROVIDER}, the version Cloudgate runs`,
      ]);
    });

    it('refuses an argument gone from the pinned provider, naming the version Cloudgate runs', () => {
      // `name` left aws_db_instance in the provider's 5.0, for `db_name`.
      expect(
        refusals(
          {
            pg: {
              kind: 'postgres',
              native: { aws: { 'aws_db_instance.database': { name: 'app' } } },
            },
          },
          target,
        ),
      ).toEqual([
        `pg.native.aws."aws_db_instance.database".name: refused - aws_db_instance has no argument name in ${PROVIDER}, the version Cloudgate runs`,
      ]);
    });

    it('refuses a value of the wrong type, and one written inside a block it is not in', () => {
      expect(
        refusals(
          {
            api: web({
              'aws_ecs_service.service': {
                health_check_grace_period_seconds: [60],
              },
              'aws_lb_target_group.service': {
                health_check: { path: '/up', paht: '/up' },
              },
            }),
          },
          target,
        ),
      ).toEqual([
        'api.native.aws."aws_ecs_service.service".health_check_grace_period_seconds: refused - must be a number',
        `api.native.aws."aws_lb_target_group.service".health_check.paht: refused - this block of aws_lb_target_group has no argument paht in ${PROVIDER}, the version Cloudgate runs`,
      ]);
    });

    it('refuses an address the kind does not make, naming what it makes', () => {
      expect(
        refusals(
          {
            api: web({
              'aws_db_instance.database': { instance_class: 'db.r7g.xlarge' },
            }),
          },
          target,
        ),
      ).toEqual([
        'api.native.aws."aws_db_instance.database": refused - a web on AWS makes aws_ecr_repository.service, aws_ecr_lifecycle_policy.service, aws_cloudwatch_log_group.service, aws_iam_role.task, aws_ecs_task_definition.service, aws_security_group.service, aws_ecs_service.service, aws_lb_target_group.service, aws_lb_listener_rule.service, not aws_db_instance.database',
      ]);
    });

    it('refuses an address the kind makes, but not right now: a bucket policy with no bucket linked', () => {
      expect(
        refusals(
          {
            api: web({ 'aws_iam_role_policy.buckets': { name: 'mine' } }),
          },
          target,
        ),
      ).toEqual([
        'api.native.aws."aws_iam_role_policy.buckets": refused - it is made only while the Service links a bucket',
      ]);
    });

    it('refuses a parameter group of a family its version does not run', () => {
      expect(
        refusals(
          {
            cache: {
              kind: 'redis',
              version: '8',
              native: {
                aws: {
                  'aws_elasticache_parameter_group.valkey7': {
                    parameter: [
                      { name: 'maxmemory-policy', value: 'allkeys-lru' },
                    ],
                  },
                },
              },
            },
          },
          target,
        ),
      ).toEqual([
        'cache.native.aws."aws_elasticache_parameter_group.valkey7": refused - its version runs valkey8, so its parameter group is aws_elasticache_parameter_group.valkey8',
      ]);
    });

    it.each([
      [
        'aws_acm_certificate.domain',
        "made once per Domain; a Domain's certificate is set through the Service's Domains",
      ],
      [
        'aws_lb_listener_rule.domain',
        "made once per Domain; a Domain's routing is set through the Service's Domains",
      ],
      [
        'aws_lb_listener_certificate.domain',
        "made once per Domain; a Domain's certificate is set through the Service's Domains",
      ],
      [
        'aws_ssm_parameter.variable',
        "made once per variable; a variable's value is set through the Service's variables",
      ],
    ])('refuses the per-Domain or per-variable %s whole', (address, reason) => {
      expect(
        refusals({ api: web({ [address]: { tags: { a: 'b' } } }) }, target),
      ).toEqual([`api.native.aws."${address}": refused - ${reason}`]);
    });

    it.each([
      'lifecycle',
      'depends_on',
      'count',
      'for_each',
      'provider',
      'provisioner',
      'connection',
    ])('refuses the meta-argument %s', (meta) => {
      const [refusal] = refusals(
        { api: web({ 'aws_ecs_service.service': { [meta]: {} } }) },
        target,
      );
      expect(refusal).toMatch(
        new RegExp(
          `^api\\.native\\.aws\\."aws_ecs_service\\.service"\\.${meta}: refused - ${meta} (is an instruction to OpenTofu|would make)`,
        ),
      );
    });

    it('refuses the tags on every address, and a locked argument with its reason', () => {
      expect(
        refusals(
          {
            pg: {
              kind: 'postgres',
              native: {
                aws: {
                  'aws_db_instance.database': {
                    tags: { team: 'payments' },
                    publicly_accessible: true,
                    apply_immediately: false,
                    backup_retention_period: 14,
                  },
                },
              },
            },
          },
          target,
        ),
      ).toEqual([
        'pg.native.aws."aws_db_instance.database".tags: refused - locked: tags are how Cloudgate finds, marks and deletes what it made',
        'pg.native.aws."aws_db_instance.database".publicly_accessible: refused - locked: a database on RDS is never reachable from outside',
        'pg.native.aws."aws_db_instance.database".apply_immediately: refused - locked: a change held for the maintenance window would read as Drift until then',
      ]);
    });

    it('refuses ElastiCache’s engine and apply_immediately', () => {
      expect(
        refusals(
          {
            cache: {
              kind: 'redis',
              native: {
                aws: {
                  'aws_elasticache_replication_group.cache': {
                    engine: 'redis',
                    apply_immediately: false,
                  },
                },
              },
            },
          },
          target,
        ),
      ).toEqual([
        'cache.native.aws."aws_elasticache_replication_group.cache".engine: refused - locked: a redis on AWS is always Valkey',
        'cache.native.aws."aws_elasticache_replication_group.cache".apply_immediately: refused - locked: a change held for the maintenance window would read as Drift until then',
      ]);
    });

    it('refuses an argument locked inside a block, by its full path', () => {
      expect(
        refusals(
          {
            api: web({
              'aws_ecs_service.service': {
                volume_configuration: {
                  name: 'data',
                  managed_ebs_volume: { role_arn: 'arn:aws:iam::1:role/x' },
                },
              },
            }),
          },
          target,
        ),
      ).toEqual([
        'api.native.aws."aws_ecs_service.service".volume_configuration.managed_ebs_volume.role_arn: refused - locked: who the Service runs as is Cloudgate’s',
      ]);
    });

    it('refuses an address locked whole, a web-private’s discovery service among them', () => {
      expect(
        refusals(
          {
            api: web({ 'aws_security_group.service': { description: 'x' } }),
            internal: {
              kind: 'web-private',
              port: 8080,
              native: {
                aws: {
                  'aws_service_discovery_service.service': { description: 'x' },
                },
              },
            },
          },
          target,
        ),
      ).toEqual([
        'api.native.aws."aws_security_group.service": refused - locked whole: who may reach the Service is Cloudgate\'s; the Environment network\'s, shared with every other Service in it',
        "internal.native.aws.\"aws_service_discovery_service.service\": refused - locked whole: a Private web service's discovery is its routing, Cloudgate's, and its digest rolls the ECS service's tasks",
      ]);
    });

    // The census classes what the spec did not spell out by its own
    // categories.
    it('locks what the census classed by the spec’s categories: deletion protection, an inline bucket policy and a privileged container', () => {
      expect(
        refusals(
          {
            api: web({
              'aws_cloudwatch_log_group.service': {
                deletion_protection_enabled: true,
              },
              'aws_ecs_task_definition.service': {
                container_definitions: { privileged: true },
              },
            }),
            files: {
              kind: 'bucket',
              native: { aws: { 'aws_s3_bucket.bucket': { policy: '{}' } } },
            },
          },
          target,
        ),
      ).toEqual([
        'api.native.aws."aws_cloudwatch_log_group.service".deletion_protection_enabled: refused - locked: Delete is Cloudgate\'s, and asks before it deletes',
        'api.native.aws."aws_ecs_task_definition.service".container_definitions.privileged: refused - locked: a privileged container reaches past its Service to what runs it (Fargate refuses one too)',
        'files.native.aws."aws_s3_bucket.bucket".policy: refused - locked: a bucket has no policy of its own: a link is the access (ADR-0032)',
      ]);
    });

    it('refuses an Environment network address whole, naming why', () => {
      expect(
        refusals(
          { api: web({ 'aws_lb.network': { idle_timeout: 120 } }) },
          target,
        ),
      ).toEqual([
        'api.native.aws."aws_lb.network": refused - the Environment network has no native block: no config entry describes it, and every Service in the Environment shares it',
      ]);
    });

    it('refuses an unknown key in the container object, which the provider would drop without a word, and a locked one', () => {
      expect(
        refusals(
          {
            api: web({
              'aws_ecs_task_definition.service': {
                container_definitions: {
                  stopTimeout: 30,
                  stopTimout: 30,
                  image: 'nginx',
                },
              },
            }),
          },
          target,
        ),
      ).toEqual([
        'api.native.aws."aws_ecs_task_definition.service".container_definitions.stopTimout: refused - not a ContainerDefinition field of @aws-sdk/client-ecs 3.1143.0, the version Cloudgate runs; ECS would drop it without a word',
        'api.native.aws."aws_ecs_task_definition.service".container_definitions.image: refused - locked: the image is the Deployment\'s, which Cloudgate built',
      ]);
    });

    it('refuses the container written as anything but one object', () => {
      expect(
        refusals(
          {
            api: web({
              'aws_ecs_task_definition.service': {
                container_definitions: [{ stopTimeout: 30 }],
              },
            }),
          },
          target,
        ),
      ).toEqual([
        'api.native.aws."aws_ecs_task_definition.service".container_definitions: refused - write the container as one object in ECS\'s camelCase; it is merged into Cloudgate\'s one container',
      ]);
    });

    it('plans a deprecated argument with a warning naming its path', () => {
      const outcome = planned(
        {
          files: {
            kind: 'bucket',
            native: {
              aws: {
                'aws_s3_bucket.bucket': { acceleration_status: 'Enabled' },
              },
            },
          },
        },
        target,
      );
      expect(
        outcome.notes.filter((note) => note.kind === 'native-deprecated'),
      ).toEqual([
        {
          kind: 'native-deprecated',
          configName: 'files',
          at: 'files.native.aws."aws_s3_bucket.bucket".acceleration_status',
          message: `files.native.aws."aws_s3_bucket.bucket".acceleration_status: deprecated - ${PROVIDER} deprecates it: acceleration_status is deprecated. Use the aws_s3_bucket_accelerate_configuration resource instead.`,
        },
      ]);
    });

    it('names every refusal of both native blocks in one plan', () => {
      expect(
        refusals(
          {
            api: {
              kind: 'web',
              native: {
                docker: { Privileged: true },
                aws: { 'aws_ecs_service.service': { desired_count: 3 } },
              },
            },
          },
          target,
        ),
      ).toEqual([
        'api.native.docker.Privileged: refused - a privileged container reaches past its Service to the Server and every tenant on it',
        'api.native.aws."aws_ecs_service.service".desired_count: refused - locked: the running count is Stop’s and Start’s, set outside the plan',
      ]);
    });
  });

  // On AWS a valid block is laid, and planned as native lines
  // (`plan-environment-native-aws-lines.spec.ts`); on any other target it
  // is checked only.
  it.each([
    ['a Docker Environment', DOCKER, {}],
    ['a Google Cloud Environment', AWS, { cloud: 'gcp' as const }],
  ])(
    'plans on %s exactly what the entry plans without a valid block',
    (_where, target, cloud) => {
      const valid = {
        'aws_ecs_service.service': {
          health_check_grace_period_seconds: 60,
          enable_execute_command: true,
          deployment_circuit_breaker: { enable: true, rollback: true },
        },
        'aws_lb_target_group.service': {
          health_check: { path: '/up', matcher: '200-299' },
        },
        'aws_ecs_task_definition.service': {
          cpu: '1024',
          container_definitions: {
            stopTimeout: 30,
            healthCheck: { command: ['CMD-SHELL', 'curl -f localhost'] },
          },
        },
      };
      const more = {
        networks: [{ cloudAccountId: 'ca-1', region: 'eu-west-1' }],
        ...cloud,
      };
      expect(plan({ api: web(valid) }, target, more)).toEqual(
        plan({ api: { kind: 'web' } }, target, more),
      );
    },
  );

  describe('what the Service makes right now', () => {
    it('takes a bucket policy once the web links a bucket, and refuses it whole as locked', () => {
      expect(
        refusals(
          {
            files: { kind: 'bucket' },
            api: web(
              { 'aws_iam_role_policy.buckets': { name: 'mine' } },
              { env: [{ S3_BUCKET: 'files.name' }] },
            ),
          },
          DOCKER,
        ),
      ).toEqual([
        'api.native.aws."aws_iam_role_policy.buckets": refused - locked whole: a link is the access (ADR-0032); what the Service may reach is Cloudgate’s',
      ]);
    });

    const corsBlock = {
      kind: 'bucket',
      native: {
        aws: {
          'aws_s3_bucket_cors_configuration.bucket': {
            expected_bucket_owner: '123456789012',
          },
        },
      },
    };

    /** A bucket already made on S3 in this Environment. */
    const onS3 = (origins: string[]): SavedService => ({
      serviceType: 'bucket',
      serviceId: 'bkt-id',
      name: 'files',
      configName: 'files',
      cloud: {
        cloudAccountId: 'ca-1',
        region: 'eu-west-1',
        linkedRegistries: [],
      },
      settings: {
        description: null,
        bucketName: 'files-k3f9a2qd-123456789012-eu-west-1-an',
      },
      variables: { env: [] },
      cors: { origins, applied: origins },
    });

    it('refuses a bucket’s CORS on AWS while its page trusts no origin', () => {
      expect(
        refusals({ files: corsBlock }, AWS, { saved: [onS3([])] }),
      ).toEqual([
        'files.native.aws."aws_s3_bucket_cors_configuration.bucket": refused - it is made only while the bucket\'s page trusts a browser origin',
      ]);
    });

    it('checks a bucket’s CORS on AWS once its page trusts one, and on a Server, where its origins are not known', () => {
      for (const outcome of [
        planned({ files: corsBlock }, AWS, {
          saved: [onS3(['https://app.example.com'])],
        }),
        planned({ files: corsBlock }, DOCKER),
      ]) {
        expect(outcome.notes.map((note) => note.kind)).toContain(
          'native-deprecated',
        );
      }
    });

    it('refuses every address of an Existing database on AWS, which Cloudgate makes nothing of', () => {
      const existing: SavedService = {
        serviceType: 'postgres',
        serviceId: 'pg-id',
        name: 'pg',
        configName: 'pg',
        existing: {
          cloudAccountId: 'ca-1',
          region: 'eu-west-1',
          identifier: 'acme-prod',
          madeReachable: false,
        },
        settings: {
          description: null,
          cpuLimit: null,
          memoryLimit: null,
          dockerImage: 'postgres:18',
          databaseName: 'shop',
          databaseUser: 'shop_app',
        },
        variables: { env: [] },
      };
      expect(
        refusals(
          {
            pg: {
              kind: 'postgres',
              native: {
                aws: {
                  'aws_db_instance.database': { backup_retention_period: 14 },
                },
              },
            },
          },
          AWS,
          { saved: [existing] },
        ),
      ).toEqual([
        'pg.native.aws."aws_db_instance.database": refused - an Existing database is used as given; Cloudgate makes nothing of it on AWS',
      ]);
    });

    it('checks native.aws on a Google Cloud Environment too, where it is not used', () => {
      expect(
        refusals(
          { api: web({ 'aws_ecs_service.service': { desired_cuont: 1 } }) },
          AWS,
          { cloud: 'gcp' },
        ),
      ).toEqual([
        `api.native.aws."aws_ecs_service.service".desired_cuont: refused - aws_ecs_service has no argument desired_cuont in ${PROVIDER}, the version Cloudgate runs`,
      ]);
    });
  });
});
