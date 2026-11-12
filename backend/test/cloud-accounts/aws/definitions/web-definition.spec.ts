import {
  networkStandIns,
  STAND_IN_IMAGE_TAG,
  isStandIn,
} from '../../../../src/cloud-accounts/aws/definitions/stand-ins';
import { renderDefinition } from '../../../../src/cloud-accounts/definitions/tofu-json';
import {
  CRON_OUTPUTS,
  cronTaskDefinition,
  DOMAIN_ADDRESSES,
  ecrRepositoryName,
  ecsRoutingOf,
  ecsServiceDefinition,
  privateAddress,
  webDefinition,
} from '../../../../src/cloud-accounts/aws/definitions/web-definition';
import {
  addresses,
  defaultTags,
  effectiveTags,
  resource,
  resources,
  sampleWebEntry,
  taggableResources,
} from './definition-helpers';
import type {
  CronTaskDefinitionInput,
  EcsServiceDefinitionInput,
  WebDefinitionInput,
} from '../../../../src/cloud-accounts/aws/definitions/web-definition';
import type { WebEntry } from '../../../../src/project-config';

const SECRET = 'a-test-app-encryption-secret';

const NETWORK = {
  vpcId: 'vpc-0a1b',
  publicSubnetIds: ['subnet-0aaa', 'subnet-0bbb'] as const,
  clusterArn: 'arn:aws:ecs:eu-west-1:123456789012:cluster/cloudgate-env-prod',
  httpsListenerArn:
    'arn:aws:elasticloadbalancing:eu-west-1:123456789012:listener/app/cg-x/1/2',
  albSecurityGroupId: 'sg-0alb',
};

function input(
  overrides: Partial<WebDefinitionInput> = {},
): WebDefinitionInput {
  return {
    configName: 'api',
    entry: sampleWebEntry('api'),
    service: { serviceId: 'App_Id-1', replicas: 2 },
    account: {
      cloudAccountId: 'cloud-acct-1',
      awsAccountId: '123456789012',
      deployRoleArn:
        'arn:aws:iam::123456789012:role/cloudgate/cloudgate-deploy',
      externalId: 'ext-abc',
      taskExecutionRoleArn:
        'arn:aws:iam::123456789012:role/cloudgate/cloudgate-task-execution',
      permissionsBoundaryArn:
        'arn:aws:iam::123456789012:policy/cloudgate/cloudgate-task-boundary',
    },
    region: 'eu-west-1',
    environmentId: 'env-prod',
    stateId: 'state-api-1',
    network: NETWORK,
    image: { tag: 'dep-42', architecture: 'amd64' },
    variables: { values: {}, digestSecret: SECRET },
    ...overrides,
  };
}

function definitionOf(overrides: Partial<WebDefinitionInput> = {}) {
  const result = webDefinition(input(overrides));
  if (!result.ok) throw new Error(result.refusal.message);
  return result.definition;
}

function containerOf(definition: Record<string, unknown>) {
  const task = resource(definition, 'aws_ecs_task_definition.service');
  const [container] = JSON.parse(
    task.container_definitions as string,
  ) as Record<string, unknown>[];
  return container;
}

describe('webDefinition', () => {
  const definition = definitionOf();

  it("holds exactly the Service's own resources", () => {
    expect(addresses(definition)).toEqual(
      [
        'aws_ecr_repository.service',
        'aws_ecr_lifecycle_policy.service',
        'aws_cloudwatch_log_group.service',
        'aws_ecs_task_definition.service',
        'aws_ecs_service.service',
        'aws_lb_target_group.service',
        'aws_lb_listener_rule.service',
        'aws_security_group.service',
        'aws_iam_role.task',
      ].sort(),
    );
  });

  describe('ECR repository', () => {
    it('keeps tags immutable and is deleted with its images', () => {
      expect(resource(definition, 'aws_ecr_repository.service')).toMatchObject({
        image_tag_mutability: 'IMMUTABLE',
        force_delete: true,
      });
    });

    // ECR's rule for each part of a name: lower-case letters and digits,
    // with `.`, `_`, `__` or hyphens only between two of them.
    const ECR_NAME =
      /^[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*)*$/;

    it("is the Service's id in lower case when ECR takes it as it is", () => {
      expect(ecrRepositoryName('R5Y5XiaNb1bpIqSr9DMHv')).toBe(
        'cloudgate/r5y5xianb1bpiqsr9dmhv',
      );
      expect(ecrRepositoryName('vln5YAn-lqZM_1Zoy')).toBe(
        'cloudgate/vln5yan-lqzm_1zoy',
      );
    });

    // A Service id may start or end with `-` or `_` (a real AWS walk's `api`
    // was `-OD2ZrH81QqNnk5tZ3FKw`), which ECR refuses: such a name has every
    // character but a letter or digit folded to `x`, as RDS's are.
    it.each([
      ['-OD2ZrH81QqNnk5tZ3FKw', 'cloudgate/xod2zrh81qqnnk5tz3fkw'],
      ['_abc', 'cloudgate/xabc'],
      ['abc-', 'cloudgate/abcx'],
      ['ab_-cd', 'cloudgate/abxxcd'],
      ['ab___cd', 'cloudgate/abxxxcd'],
    ])('folds %s, which ECR refuses, to %s', (serviceId, name) => {
      expect(ecrRepositoryName(serviceId)).toBe(name);
      expect(name).toMatch(ECR_NAME);
    });

    it('expires untagged images a day after they were pushed', () => {
      const policy = JSON.parse(
        resource(definition, 'aws_ecr_lifecycle_policy.service')
          .policy as string,
      ) as { rules: unknown[] };
      expect(policy.rules).toEqual([
        expect.objectContaining({
          selection: {
            tagStatus: 'untagged',
            countType: 'sinceImagePushed',
            countUnit: 'days',
            countNumber: 1,
          },
          action: { type: 'expire' },
        }),
      ]);
    });
  });

  it('keeps logs 90 days in a log group the task writes to and never creates', () => {
    expect(
      resource(definition, 'aws_cloudwatch_log_group.service'),
    ).toMatchObject({
      retention_in_days: 90,
    });
    const options = (
      containerOf(definition).logConfiguration as {
        options: Record<string, string>;
      }
    ).options;
    expect(options).toMatchObject({
      'awslogs-group': '${aws_cloudwatch_log_group.service.name}',
      'awslogs-region': 'eu-west-1',
    });
    expect(options).not.toHaveProperty('awslogs-create-group');
  });

  describe('task definition', () => {
    it("runs the size's Fargate pair: small is 0.5 vCPU / 1 GB", () => {
      const result = webDefinition(input());
      expect(result.ok && result.pair).toEqual({
        cpuUnits: 512,
        memoryMb: 1024,
      });
      expect(
        resource(definition, 'aws_ecs_task_definition.service'),
      ).toMatchObject({
        requires_compatibilities: ['FARGATE'],
        network_mode: 'awsvpc',
        cpu: '512',
        memory: '1024',
      });
    });

    it("creates an entry with no size at xsmall's pair", () => {
      const unsized: WebEntry = { ...sampleWebEntry('api'), size: undefined };
      expect(
        resource(
          definitionOf({ entry: unsized }),
          'aws_ecs_task_definition.service',
        ),
      ).toMatchObject({ cpu: '256', memory: '512' });
    });

    it.each([
      ['amd64', 'X86_64'],
      ['arm64', 'ARM64'],
    ] as const)(
      "follows a %s image's architecture",
      (architecture, cpuArchitecture) => {
        expect(
          resource(
            definitionOf({ image: { tag: 'dep-42', architecture } }),
            'aws_ecs_task_definition.service',
          ).runtime_platform,
        ).toEqual({
          operating_system_family: 'LINUX',
          cpu_architecture: cpuArchitecture,
        });
      },
    );

    it("runs the Deployment's image from the Service's own repository, with the entry's port and command", () => {
      expect(containerOf(definition)).toMatchObject({
        image: '${aws_ecr_repository.service.repository_url}:dep-42',
        portMappings: [{ containerPort: 4000, protocol: 'tcp' }],
        entryPoint: ['node'],
        command: ['dist/main.js'],
      });
      expect(
        resource(definition, 'aws_ecs_task_definition.service'),
      ).toMatchObject({
        execution_role_arn:
          'arn:aws:iam::123456789012:role/cloudgate/cloudgate-task-execution',
        task_role_arn: '${aws_iam_role.task.arn}',
      });
    });

    it('passes a command written with template syntax through as written', () => {
      const entry = { ...sampleWebEntry('api'), args: ['echo ${HOME} %{x}'] };
      expect(containerOf(definitionOf({ entry })).command).toEqual([
        'echo $${HOME} %%{x}',
      ]);
    });
  });

  describe("the image's HEALTHCHECK", () => {
    it('copies its test, interval, timeout, retries and start period into the container, in seconds', () => {
      const container = containerOf(
        definitionOf({
          image: {
            tag: 'dep-42',
            architecture: 'amd64',
            healthCheck: {
              test: ['CMD-SHELL', 'curl -f http://localhost:4000/ || exit 1'],
              interval: 10_000_000_000,
              timeout: 3_000_000_000,
              startPeriod: 20_000_000_000,
              retries: 5,
            },
          },
        }),
      );
      expect(container.healthCheck).toEqual({
        command: ['CMD-SHELL', 'curl -f http://localhost:4000/ || exit 1'],
        interval: 10,
        timeout: 3,
        retries: 5,
        startPeriod: 20,
      });
    });

    it("fills what the image leaves out with Docker's own defaults: 30 s, 30 s, 3 retries, no start period", () => {
      const container = containerOf(
        definitionOf({
          image: {
            tag: 'dep-42',
            architecture: 'amd64',
            healthCheck: { test: ['CMD', '/healthcheck'] },
          },
        }),
      );
      expect(container.healthCheck).toEqual({
        command: ['CMD', '/healthcheck'],
        interval: 30,
        timeout: 30,
        retries: 3,
      });
    });

    it("brings a value outside ECS's range to its nearest end, so the task definition registers", () => {
      const container = containerOf(
        definitionOf({
          image: {
            tag: 'dep-42',
            architecture: 'amd64',
            healthCheck: {
              test: ['CMD', 'true'],
              interval: 1_000_000_000,
              timeout: 600_000_000_000,
              startPeriod: 900_000_000_000,
              retries: 40,
            },
          },
        }),
      );
      expect(container.healthCheck).toEqual({
        command: ['CMD', 'true'],
        interval: 5,
        timeout: 120,
        retries: 10,
        startPeriod: 300,
      });
    });

    it('passes a command written with template syntax through as written', () => {
      const container = containerOf(
        definitionOf({
          image: {
            tag: 'dep-42',
            architecture: 'amd64',
            healthCheck: { test: ['CMD-SHELL', 'curl localhost:${PORT}'] },
          },
        }),
      );
      expect((container.healthCheck as { command: string[] }).command).toEqual([
        'CMD-SHELL',
        'curl localhost:$${PORT}',
      ]);
    });

    it('writes no healthCheck for an image with none, so an existing web plans as it did', () => {
      expect(containerOf(definition)).not.toHaveProperty('healthCheck');
      expect(
        containerOf(
          definitionOf({
            image: { tag: 'dep-42', architecture: 'amd64', healthCheck: null },
          }),
        ),
      ).not.toHaveProperty('healthCheck');
      expect(renderDefinition(definitionOf())).toBe(
        renderDefinition(
          definitionOf({
            image: { tag: 'dep-42', architecture: 'amd64', healthCheck: null },
          }),
        ),
      );
    });

    it("keeps the target group's HTTP check alongside it", () => {
      const withCheck = definitionOf({
        image: {
          tag: 'dep-42',
          architecture: 'amd64',
          healthCheck: { test: ['CMD', 'true'] },
        },
      });
      expect(
        resource(withCheck, 'aws_lb_target_group.service').health_check,
      ).toMatchObject({ path: '/', matcher: '200-399' });
    });
  });

  describe('ECS service', () => {
    it('runs the replicas on public IPs in the public subnets, propagating tags', () => {
      expect(resource(definition, 'aws_ecs_service.service')).toMatchObject({
        cluster: NETWORK.clusterArn,
        launch_type: 'FARGATE',
        desired_count: 2,
        propagate_tags: 'SERVICE',
        network_configuration: {
          subnets: ['subnet-0aaa', 'subnet-0bbb'],
          security_groups: ['${aws_security_group.service.id}'],
          assign_public_ip: true,
        },
        load_balancer: {
          target_group_arn: '${aws_lb_target_group.service.arn}',
          container_port: 4000,
        },
      });
    });

    it('leaves the running count to Stop, Start and Deploy, so a plan never counts it', () => {
      expect(resource(definition, 'aws_ecs_service.service')).toMatchObject({
        lifecycle: { ignore_changes: ['desired_count'] },
      });
    });

    it('has no discovery service to roll on, so no discovery trigger', () => {
      expect(resource(definition, 'aws_ecs_service.service').triggers).toEqual({
        variables: '${var.variables_digest}',
      });
    });
  });

  describe('target group and listener rule', () => {
    it('health-checks HTTP on the traffic port at / for any 2xx or 3xx, and drains in 30 s', () => {
      expect(resource(definition, 'aws_lb_target_group.service')).toMatchObject(
        {
          target_type: 'ip',
          protocol: 'HTTP',
          port: 4000,
          vpc_id: 'vpc-0a1b',
          deregistration_delay: '30',
          health_check: {
            protocol: 'HTTP',
            port: 'traffic-port',
            path: '/',
            matcher: '200-399',
          },
        },
      );
    });

    it("forwards from the network's HTTPS listener to the target group", () => {
      expect(
        resource(definition, 'aws_lb_listener_rule.service'),
      ).toMatchObject({
        listener_arn: NETWORK.httpsListenerArn,
        action: {
          type: 'forward',
          target_group_arn: '${aws_lb_target_group.service.arn}',
        },
      });
    });
  });

  it("admits traffic only from the load balancer's security group", () => {
    const group = resource(definition, 'aws_security_group.service');
    expect(group.vpc_id).toBe('vpc-0a1b');
    expect(group.ingress).toEqual([
      expect.objectContaining({
        from_port: 4000,
        to_port: 4000,
        protocol: 'tcp',
        security_groups: ['sg-0alb'],
        cidr_blocks: [],
        ipv6_cidr_blocks: [],
      }),
    ]);
  });

  it('makes a task role under /cloudgate/, named cloudgate-, inside the boundary, with no permissions', () => {
    const role = resource(definition, 'aws_iam_role.task');
    expect(role).toMatchObject({
      path: '/cloudgate/',
      name: 'cloudgate-App_Id-1',
      permissions_boundary:
        'arn:aws:iam::123456789012:policy/cloudgate/cloudgate-task-boundary',
    });
    expect(role).not.toHaveProperty('inline_policy');
    expect(role).not.toHaveProperty('managed_policy_arns');
    expect(resources(definition).map((r) => r.type)).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^aws_iam_(role_)?policy/),
      ]),
    );
    const trust = JSON.parse(role.assume_role_policy as string) as {
      Statement: unknown[];
    };
    expect(trust.Statement).toEqual([
      expect.objectContaining({
        Principal: { Service: 'ecs-tasks.amazonaws.com' },
        Action: 'sts:AssumeRole',
      }),
    ]);
  });

  describe('tags', () => {
    it("sets the Cloud account, Environment and state ids as the provider's default tags", () => {
      expect(defaultTags(definition)).toEqual({
        'cloudgate:cloud-account': 'cloud-acct-1',
        'cloudgate:environment': 'env-prod',
        'cloudgate:state': 'state-api-1',
      });
    });

    it('leaves every taggable resource with all four tags, its own address among them, and a Name', () => {
      const taggable = taggableResources(definition);
      expect(taggable).toHaveLength(8);
      for (const { address, body } of taggable) {
        expect([address, effectiveTags(definition, body)]).toEqual([
          address,
          {
            'cloudgate:cloud-account': 'cloud-acct-1',
            'cloudgate:environment': 'env-prod',
            'cloudgate:state': 'state-api-1',
            'cloudgate:address': address,
            Name: expect.stringMatching(/\S/) as string,
          },
        ]);
      }
    });
  });

  describe('stand-ins', () => {
    it('wires the Service to stand-ins for a network the same plan makes, each recognisable as one', () => {
      const standIns = networkStandIns('eu-west-1', '123456789012');
      const planned = definitionOf({
        network: standIns,
        image: { tag: STAND_IN_IMAGE_TAG, architecture: 'amd64' },
      });

      const wired = [
        resource(planned, 'aws_ecs_service.service').cluster,
        ...(
          resource(planned, 'aws_ecs_service.service')
            .network_configuration as {
            subnets: string[];
          }
        ).subnets,
        resource(planned, 'aws_lb_target_group.service').vpc_id,
        resource(planned, 'aws_lb_listener_rule.service').listener_arn,
        (
          resource(planned, 'aws_security_group.service').ingress as {
            security_groups: string[];
          }[]
        )[0].security_groups[0],
        containerOf(planned).image,
      ];
      expect(wired).toHaveLength(7);
      for (const value of wired) expect(isStandIn(value)).toBe(true);
      expect(standIns.httpsListenerArn).toMatch(
        /^arn:aws:elasticloadbalancing:eu-west-1:123456789012:listener\/app\//,
      );
      // A real id is never taken for one.
      expect(isStandIn(NETWORK.vpcId)).toBe(false);
    });
  });

  it("refuses a size above Fargate's largest pair, naming the entry, and writes nothing", () => {
    const entry: WebEntry = {
      ...sampleWebEntry('api'),
      size: { cpu: 32, memoryMb: 65536 },
    };
    expect(webDefinition(input({ entry }))).toEqual({
      ok: false,
      refusal: {
        at: 'api.size',
        message: expect.stringContaining('api') as string,
      },
    });
  });

  describe('variables', () => {
    const values = {
      DATABASE_URL: 'postgres://u:hunter2@db/app',
      BIG_CERT: 'C'.repeat(5000),
      EMPTY: '',
    };
    const result = webDefinition(
      input({ variables: { values, digestSecret: SECRET } }),
    );
    if (!result.ok) throw new Error(result.refusal.message);
    const withVariables = result.definition;
    const parameters = resource(withVariables, 'aws_ssm_parameter.variable');

    it('makes one SecureString per variable with a value, named by environment, Service and variable, with the default aws/ssm key', () => {
      expect(parameters).toMatchObject({
        for_each: { BIG_CERT: 'Advanced', DATABASE_URL: 'Standard' },
        name: '/cloudgate/env-prod/App_Id-1/${each.key}',
        type: 'SecureString',
        tier: '${each.value}',
        value: '${local.variable_values[each.key]}',
      });
      expect(parameters).not.toHaveProperty('key_id');
      expect(parameters).not.toHaveProperty('insecure_value');
    });

    it('tags each parameter with all four tags, its own instance address among them', () => {
      expect(effectiveTags(withVariables, parameters)).toEqual({
        'cloudgate:cloud-account': 'cloud-acct-1',
        'cloudgate:environment': 'env-prod',
        'cloudgate:state': 'state-api-1',
        'cloudgate:address': 'aws_ssm_parameter.variable/${each.key}',
        Name: 'cloudgate/api/variables/${each.key}',
      });
    });

    it('passes each value as a sensitive variable, and writes no value into the definition', () => {
      expect(result.variables).toMatchObject({
        variable_value_DATABASE_URL: values.DATABASE_URL,
        variable_value_BIG_CERT: values.BIG_CERT,
      });
      expect(result.variables).not.toHaveProperty('variable_value_EMPTY');
      expect(withVariables.variable).toEqual({
        variables_digest: { type: 'string', sensitive: true, nullable: false },
        variable_value_DATABASE_URL: {
          type: 'string',
          sensitive: true,
          nullable: false,
        },
        variable_value_BIG_CERT: {
          type: 'string',
          sensitive: true,
          nullable: false,
        },
      });
      expect(withVariables.locals).toEqual({
        variable_values: {
          BIG_CERT: '${var.variable_value_BIG_CERT}',
          DATABASE_URL: '${var.variable_value_DATABASE_URL}',
        },
      });
      const text = renderDefinition(withVariables);
      expect(text).not.toContain('hunter2');
      expect(text).not.toContain('CCCCCCCC');
      expect(text).not.toContain(result.variables.variables_digest);
    });

    it("references each parameter from the task's secrets, and an empty value as a plain environment entry", () => {
      expect(containerOf(withVariables)).toMatchObject({
        secrets: [
          {
            name: 'BIG_CERT',
            valueFrom:
              'arn:aws:ssm:eu-west-1:123456789012:parameter/cloudgate/env-prod/App_Id-1/BIG_CERT',
          },
          {
            name: 'DATABASE_URL',
            valueFrom:
              'arn:aws:ssm:eu-west-1:123456789012:parameter/cloudgate/env-prod/App_Id-1/DATABASE_URL',
          },
        ],
        environment: [{ name: 'EMPTY', value: '' }],
      });
      expect(
        resource(withVariables, 'aws_ecs_task_definition.service').depends_on,
      ).toEqual(['aws_ssm_parameter.variable']);
    });

    it('gives the task role nothing to read them with: only the execution role reads parameter/cloudgate/*', () => {
      const role = resource(withVariables, 'aws_iam_role.task');
      expect(JSON.stringify(role)).not.toMatch(/ssm/i);
      expect(
        resource(withVariables, 'aws_ecs_task_definition.service'),
      ).toMatchObject({
        execution_role_arn:
          'arn:aws:iam::123456789012:role/cloudgate/cloudgate-task-execution',
      });
    });

    it("rolls the tasks on any changed value: the values' digest in the ECS service's triggers", () => {
      expect(resource(withVariables, 'aws_ecs_service.service')).toMatchObject({
        triggers: { variables: '${var.variables_digest}' },
        force_new_deployment: true,
      });
      const changed = webDefinition(
        input({
          variables: {
            values: { ...values, DATABASE_URL: 'postgres://u:new@db/app' },
            digestSecret: SECRET,
          },
        }),
      );
      expect(changed.ok && changed.variables.variables_digest).toMatch(
        /^[0-9a-f]{64}$/,
      );
      expect(changed.ok && changed.variables.variables_digest).not.toBe(
        result.variables.variables_digest,
      );
    });

    it('writes no parameter, and still a digest, for a Service with no variables', () => {
      const none = webDefinition(input());
      if (!none.ok) throw new Error(none.refusal.message);
      expect(addresses(none.definition)).not.toContain(
        'aws_ssm_parameter.variable',
      );
      expect(none.definition).not.toHaveProperty('locals');
      expect(Object.keys(none.variables)).toEqual(['variables_digest']);
      expect(containerOf(none.definition)).not.toHaveProperty('secrets');
    });

    it('refuses a value over 8 KB, naming the variable, and writes nothing', () => {
      expect(
        webDefinition(
          input({
            variables: {
              values: { BIG_CERT: 'C'.repeat(8193) },
              digestSecret: SECRET,
            },
          }),
        ),
      ).toEqual({
        ok: false,
        refusal: {
          at: 'api.env',
          message: expect.stringContaining('BIG_CERT is 8193 bytes') as string,
        },
      });
    });
  });

  it('writes the same text for the same input', () => {
    expect(renderDefinition(definitionOf())).toBe(
      renderDefinition(definitionOf()),
    );
  });

  describe('bucket access', () => {
    const UPLOADS = 'uploads-k3j9x2ab-123456789012-eu-west-1-an';
    const AVATARS = 'avatars-p0q1r2s3-123456789012-eu-west-1-an';
    const linking = definitionOf({ buckets: [UPLOADS, AVATARS] });
    const policyOf = (definition: Record<string, unknown>) =>
      JSON.parse(
        resource(definition, 'aws_iam_role_policy.buckets').policy as string,
      ) as { Version: string; Statement: unknown[] };

    it('gives the task role object access on exactly the buckets it links, by their real names, and nothing on their settings', () => {
      expect(resource(linking, 'aws_iam_role_policy.buckets')).toMatchObject({
        name: 'cloudgate-buckets',
        role: '${aws_iam_role.task.id}',
      });
      expect(policyOf(linking)).toEqual({
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Action: [
              's3:GetObject',
              's3:PutObject',
              's3:DeleteObject',
              's3:AbortMultipartUpload',
              's3:ListMultipartUploadParts',
            ],
            Resource: [
              `arn:aws:s3:::${AVATARS}/*`,
              `arn:aws:s3:::${UPLOADS}/*`,
            ],
          },
          {
            Effect: 'Allow',
            Action: ['s3:ListBucket', 's3:ListBucketMultipartUploads'],
            Resource: [`arn:aws:s3:::${AVATARS}`, `arn:aws:s3:::${UPLOADS}`],
          },
        ],
      });
    });

    it("grants nothing on a bucket's settings, tags or policy, and no wildcard action or bucket", () => {
      const actions = (
        policyOf(linking).Statement as {
          Action: string[];
          Resource: string[];
        }[]
      ).flatMap((statement) => statement.Action);
      for (const action of actions) {
        expect(action).toMatch(
          /^s3:(GetObject|PutObject|DeleteObject|AbortMultipartUpload|ListMultipartUploadParts|ListBucket|ListBucketMultipartUploads)$/,
        );
      }
      const statements = policyOf(linking).Statement as {
        Action: string[];
        Resource: string[];
      }[];
      for (const { Action, Resource } of statements) {
        expect(Action.filter((action) => action.includes('*'))).toEqual([]);
        for (const arn of Resource) {
          expect(arn).toMatch(/^arn:aws:s3:::[a-z0-9-]+(\/\*)?$/);
        }
      }
    });

    it('names each bucket once, in the same order whatever order its links give', () => {
      expect(
        policyOf(definitionOf({ buckets: [UPLOADS, AVATARS, UPLOADS] })),
      ).toEqual(policyOf(definitionOf({ buckets: [AVATARS, UPLOADS] })));
    });

    it('leaves the policy out when it links no bucket, so an unlink removes it', () => {
      for (const definition of [
        definitionOf(),
        definitionOf({ buckets: [] }),
      ]) {
        expect(addresses(definition)).not.toContain(
          'aws_iam_role_policy.buckets',
        );
      }
    });
  });

  describe('Domains', () => {
    const domains = [
      {
        domainId: 'dom_A1',
        host: 'shop.example.com',
        path: '/',
        attempt: 1,
        attach: true,
      },
      {
        domainId: 'dom_B2',
        host: 'example.com',
        path: '/api',
        attempt: 3,
        attach: false,
      },
    ];
    const withDomains = definitionOf({ domains });
    const block = (type: string) =>
      resource(withDomains, `${type}.domain`) as Record<string, unknown> & {
        for_each: Record<string, Record<string, unknown>>;
      };

    it('writes no Domain resources for a definition given no Domains', () => {
      expect(
        addresses(definition).filter((a) => DOMAIN_ADDRESSES.includes(a)),
      ).toEqual([]);
    });

    it('requests one DNS-validated ACM certificate per Domain, keyed by its attempt so Ask again makes a new one', () => {
      const certificate = block('aws_acm_certificate');
      expect(Object.keys(certificate.for_each).sort()).toEqual([
        'dom_A1-1',
        'dom_B2-3',
      ]);
      expect(certificate.for_each['dom_B2-3'].host).toBe('example.com');
      expect(certificate).toMatchObject({
        domain_name: '${each.value.host}',
        validation_method: 'DNS',
        lifecycle: { create_before_destroy: true },
      });
    });

    it("adds a host rule per Domain on the network's HTTPS listener, forwarding to the Service's target group", () => {
      const rule = block('aws_lb_listener_rule');
      expect(Object.keys(rule.for_each).sort()).toEqual(['dom_A1', 'dom_B2']);
      expect(rule.for_each.dom_A1.paths).toEqual(['/*']);
      expect(rule.for_each.dom_B2.paths).toEqual(['/api', '/api/*']);
      expect(rule).toMatchObject({
        listener_arn: NETWORK.httpsListenerArn,
        action: {
          type: 'forward',
          target_group_arn: '${aws_lb_target_group.service.arn}',
        },
        condition: [
          { host_header: { values: ['${each.value.host}'] } },
          { path_pattern: { values: '${each.value.paths}' } },
        ],
      });
    });

    it('attaches only an issued certificate to the listener', () => {
      const attached = block('aws_lb_listener_certificate');
      expect(Object.keys(attached.for_each)).toEqual(['dom_A1-1']);
      expect(attached).toMatchObject({
        listener_arn: NETWORK.httpsListenerArn,
        certificate_arn: '${aws_acm_certificate.domain[each.key].arn}',
      });
    });

    it('never makes the ECS service wait on a certificate or a Domain rule', () => {
      const service = resource(withDomains, 'aws_ecs_service.service');
      expect(service.depends_on).toEqual(['aws_lb_listener_rule.service']);
      expect(JSON.stringify(service)).not.toContain('.domain');
      expect(addresses(withDomains)).not.toContain(
        'aws_acm_certificate_validation.domain',
      );
    });

    it('tags each certificate and rule with its own instance address', () => {
      expect(block('aws_acm_certificate').tags).toEqual({
        'cloudgate:address': 'aws_acm_certificate.domain/${each.key}',
        Name: '${each.value.name}',
      });
      expect(block('aws_acm_certificate').for_each['dom_A1-1'].name).toBe(
        'cloudgate/api/domain/shop.example.com',
      );
      expect(block('aws_lb_listener_rule').tags).toEqual({
        'cloudgate:address': 'aws_lb_listener_rule.domain/${each.key}',
        Name: '${each.value.name}',
      });
    });

    it('answers each certificate and its validation record as an output', () => {
      expect(
        (withDomains.output as Record<string, { value: string }>)
          .domain_certificates.value,
      ).toContain('aws_acm_certificate.domain');
    });

    it('keeps the three blocks with nothing in them once the last Domain is gone, so a run removes what is left', () => {
      const none = definitionOf({ domains: [] });
      for (const type of [
        'aws_acm_certificate',
        'aws_lb_listener_rule',
        'aws_lb_listener_certificate',
      ]) {
        expect(resource(none, `${type}.domain`).for_each).toEqual({});
      }
    });
  });
});

/**
 * A Worker on ECS (spec "Worker on ECS"): the same builder
 * with routing none, so everything a `web` keeps is kept and only what
 * routes traffic to it goes.
 */
describe('ecsServiceDefinition with routing none, a Worker', () => {
  const { entry, ...rest } = input();
  // What a worker's entry has: the sample's size and command, no port.
  const workerEntry = {
    size: entry.size,
    command: entry.command,
    args: entry.args,
  };
  function workerOf(overrides: Partial<EcsServiceDefinitionInput> = {}) {
    const result = ecsServiceDefinition({
      ...rest,
      entry: workerEntry,
      routing: { kind: 'none' },
      ...overrides,
    });
    if (!result.ok) throw new Error(result.refusal.message);
    return result.definition;
  }
  const worker = workerOf();

  it("keeps a web's own resources but its target group and listener rule", () => {
    expect(addresses(worker)).toEqual(
      [
        'aws_ecr_repository.service',
        'aws_ecr_lifecycle_policy.service',
        'aws_cloudwatch_log_group.service',
        'aws_ecs_task_definition.service',
        'aws_ecs_service.service',
        'aws_security_group.service',
        'aws_iam_role.task',
      ].sort(),
    );
  });

  it('keeps one SSM parameter per variable and the bucket access of its task role', () => {
    const linked = workerOf({
      variables: { values: { API_KEY: 'k' }, digestSecret: SECRET },
      buckets: ['uploads-x'],
    });
    expect(addresses(linked)).toEqual(
      expect.arrayContaining([
        'aws_ssm_parameter.variable',
        'aws_iam_role_policy.buckets',
      ]),
    );
  });

  it("runs Cloudgate's replicas on public IPs in the public subnets, with no load_balancer block and nothing to wait for", () => {
    const service = resource(worker, 'aws_ecs_service.service');
    expect(service).toMatchObject({
      desired_count: 2,
      network_configuration: {
        subnets: [...NETWORK.publicSubnetIds],
        assign_public_ip: true,
      },
      lifecycle: { ignore_changes: ['desired_count'] },
    });
    expect(service).not.toHaveProperty('load_balancer');
    expect(service).not.toHaveProperty('depends_on');
  });

  it('lets nothing in and everything out', () => {
    const group = resource(worker, 'aws_security_group.service');
    expect(group.vpc_id).toBe('vpc-0a1b');
    expect(group.ingress).toEqual([]);
    expect(group.egress).toEqual([
      expect.objectContaining({
        from_port: 0,
        to_port: 0,
        protocol: '-1',
        cidr_blocks: ['0.0.0.0/0'],
      }),
    ]);
    expect(JSON.stringify(group)).not.toContain(NETWORK.albSecurityGroupId);
  });

  it('maps no port in its container, and keeps its command and args', () => {
    const container = containerOf(worker);
    expect(container).not.toHaveProperty('portMappings');
    const web = containerOf(definitionOf());
    expect(container.entryPoint).toEqual(web.entryPoint);
    expect(container.command).toEqual(web.command);
  });

  it("copies the image's HEALTHCHECK into its container, and writes none for an image with none", () => {
    const checked = workerOf({
      image: {
        tag: 'dep-42',
        architecture: 'amd64',
        healthCheck: { test: ['CMD-SHELL', 'test -f /tmp/alive'] },
      },
    });
    expect(containerOf(checked).healthCheck).toEqual({
      command: ['CMD-SHELL', 'test -f /tmp/alive'],
      interval: 30,
      timeout: 30,
      retries: 3,
    });
    expect(containerOf(worker)).not.toHaveProperty('healthCheck');
  });

  it('writes no Domain block, nothing of the load balancer, and no target group output', () => {
    expect(JSON.stringify(worker)).not.toContain('aws_lb_');
    expect(Object.keys(worker.output as object).sort()).toEqual([
      'ecr_repository_url',
      'ecs_service_name',
      'log_group_name',
      'task_role_arn',
    ]);
  });

  it('is routed by its kind: a worker none, a web its public target group (ecsRoutingOf)', () => {
    expect(ecsRoutingOf('worker', null)).toEqual({ kind: 'none' });
    expect(ecsRoutingOf('worker', 3000, [])).toEqual({ kind: 'none' });
    expect(ecsRoutingOf('web', 4000, [])).toEqual({
      kind: 'public-target-group',
      port: 4000,
      domains: [],
    });
  });
});

/**
 * A Private web service on ECS (spec "Private web service on
 * ECS"): the same builder with routing private DNS, so its tasks are listed
 * in the Environment network's Cloud Map namespace and reached from inside
 * the VPC alone.
 */
describe('ecsServiceDefinition with routing private DNS, a Private web service', () => {
  const { entry, ...rest } = input();
  const privateEntry = {
    size: entry.size,
    command: entry.command,
    args: entry.args,
  };
  const NAMESPACE = 'ns-0private';
  function privateOf(overrides: Partial<EcsServiceDefinitionInput> = {}) {
    const result = ecsServiceDefinition({
      ...rest,
      network: { ...NETWORK, privateDnsNamespaceId: NAMESPACE },
      entry: privateEntry,
      routing: { kind: 'private-dns', port: 4000 },
      ...overrides,
    });
    if (!result.ok) throw new Error(result.refusal.message);
    return result.definition;
  }
  const internal = privateOf();

  it("keeps a web's own resources but its target group and listener rule, and adds its discovery service", () => {
    expect(addresses(internal)).toEqual(
      [
        'aws_ecr_repository.service',
        'aws_ecr_lifecycle_policy.service',
        'aws_cloudwatch_log_group.service',
        'aws_ecs_task_definition.service',
        'aws_ecs_service.service',
        'aws_security_group.service',
        'aws_iam_role.task',
        'aws_service_discovery_service.service',
      ].sort(),
    );
    expect(JSON.stringify(internal)).not.toContain('aws_lb_');
  });

  it('lists its tasks as A records, each healthy task once, under its Config name in the namespace', () => {
    const discovery = resource(
      internal,
      'aws_service_discovery_service.service',
    );
    expect(discovery).toMatchObject({
      name: 'api',
      dns_config: {
        namespace_id: NAMESPACE,
        routing_policy: 'MULTIVALUE',
        dns_records: [{ type: 'A' }],
      },
      // ECS reports each task's health, so only healthy tasks are listed.
      // The threshold is set because AWS drops an empty block, which then
      // plans as a replacement on every Check for changes.
      health_check_custom_config: { failure_threshold: 1 },
      force_destroy: true,
    });
  });

  it('registers its tasks through service_registries, with no load_balancer block', () => {
    const service = resource(internal, 'aws_ecs_service.service');
    expect(service.service_registries).toEqual({
      registry_arn: '${aws_service_discovery_service.service.arn}',
    });
    expect(service).not.toHaveProperty('load_balancer');
    expect(service).toMatchObject({
      desired_count: 2,
      network_configuration: { assign_public_ip: true },
    });
  });

  // Cloud Map hands a re-created discovery service its old id and ARN, so
  // neither moves on a replace; what it is written with does.
  it('rolls its ECS service in place on any change of its discovery service: the digest of what that is written with, in the triggers', () => {
    const service = resource(internal, 'aws_ecs_service.service');
    expect(service).toMatchObject({
      triggers: {
        variables: '${var.variables_digest}',
        discovery: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
      },
      force_new_deployment: true,
    });
    // Not replaced with it: ECS refuses a create under a draining name.
    expect(service.lifecycle).toEqual({ ignore_changes: ['desired_count'] });
    // Known at plan time: the provider plans a `triggers` value known only
    // after apply as the old one, and the Apply stops on it.
    expect(JSON.stringify(service.triggers)).not.toContain('terraform_data');

    const triggers = (one: Record<string, unknown>) =>
      resource(one, 'aws_ecs_service.service').triggers as {
        discovery: string;
      };
    expect(triggers(privateOf()).discovery).toBe(triggers(internal).discovery);
    const moved = privateOf({
      network: { ...NETWORK, privateDnsNamespaceId: 'ns-0another' },
    });
    expect(triggers(moved).discovery).not.toBe(triggers(internal).discovery);
  });

  it("lets in only its port, only from the Environment network's VPC range, and everything out", () => {
    const group = resource(internal, 'aws_security_group.service');
    expect(group.ingress).toEqual([
      expect.objectContaining({
        from_port: 4000,
        to_port: 4000,
        protocol: 'tcp',
        cidr_blocks: ['10.80.0.0/16'],
      }),
    ]);
    expect(JSON.stringify(group.ingress)).not.toContain(
      NETWORK.albSecurityGroupId,
    );
    expect(group.egress).toEqual([
      expect.objectContaining({ protocol: '-1', cidr_blocks: ['0.0.0.0/0'] }),
    ]);
  });

  it('maps its port in its container', () => {
    expect(containerOf(internal).portMappings).toEqual([
      { containerPort: 4000, protocol: 'tcp' },
    ]);
  });

  it("copies the image's HEALTHCHECK into its container", () => {
    const checked = privateOf({
      image: {
        tag: 'dep-42',
        architecture: 'amd64',
        healthCheck: { test: ['CMD-SHELL', 'wget -qO- localhost:4000'] },
      },
    });
    expect(containerOf(checked).healthCheck).toMatchObject({
      command: ['CMD-SHELL', 'wget -qO- localhost:4000'],
    });
  });

  it('outputs its discovery service, and no target group', () => {
    expect(Object.keys(internal.output as object).sort()).toEqual([
      'discovery_service_arn',
      'ecr_repository_url',
      'ecs_service_name',
      'log_group_name',
      'task_role_arn',
    ]);
  });

  it('tags its discovery service as every other taggable resource is', () => {
    const tagged = taggableResources(internal).map(({ address }) => address);
    expect(tagged).toContain('aws_service_discovery_service.service');
  });

  it("is not written without the network's namespace", () => {
    expect(() =>
      ecsServiceDefinition({
        ...rest,
        entry: privateEntry,
        routing: { kind: 'private-dns', port: 4000 },
      }),
    ).toThrow(/namespace/);
  });

  it('is routed by its kind: a web-private by private DNS on its port (ecsRoutingOf)', () => {
    expect(ecsRoutingOf('web-private', 4000, [])).toEqual({
      kind: 'private-dns',
      port: 4000,
    });
  });

  it('is reached at its private DNS address, http://<entry>.cloudgate.internal:<port>', () => {
    expect(privateAddress('api', 4000)).toBe(
      'http://api.cloudgate.internal:4000',
    );
  });
});

/**
 * A Cron service on ECS (spec "Cron service on ECS"): the
 * same builder with routing none and no ECS service, so each run is a
 * one-off task of its task definition, started by Cloudgate's timetable.
 */
describe('cronTaskDefinition, a Cron service', () => {
  const { entry, service, ...rest } = input();
  const cronEntry = {
    size: entry.size,
    command: 'node dist/jobs/nightly.js',
    args: ['--all'],
  };
  function cronOf(overrides: Partial<CronTaskDefinitionInput> = {}) {
    const result = cronTaskDefinition({
      ...rest,
      entry: cronEntry,
      service: { serviceId: service.serviceId },
      ...overrides,
    });
    if (!result.ok) throw new Error(result.refusal.message);
    return result.definition;
  }
  const cron = cronOf();

  it("keeps a Worker's resources but its ECS service: the repository, task definition, task role, log group and security group", () => {
    expect(addresses(cron)).toEqual(
      [
        'aws_ecr_repository.service',
        'aws_ecr_lifecycle_policy.service',
        'aws_cloudwatch_log_group.service',
        'aws_ecs_task_definition.service',
        'aws_security_group.service',
        'aws_iam_role.task',
      ].sort(),
    );
    expect(JSON.stringify(cron)).not.toContain('aws_ecs_service');
    expect(JSON.stringify(cron)).not.toContain('aws_scheduler');
  });

  it('keeps one SSM parameter per variable, which its task reads', () => {
    const withValue = cronOf({
      variables: { values: { API_KEY: 'k' }, digestSecret: SECRET },
    });
    expect(addresses(withValue)).toContain('aws_ssm_parameter.variable');
    expect(containerOf(withValue).secrets).toEqual([
      expect.objectContaining({ name: 'API_KEY' }),
    ]);
  });

  it('runs its command and args, and maps no port', () => {
    const container = containerOf(cron);
    expect(container.entryPoint).toEqual(['node', 'dist/jobs/nightly.js']);
    expect(container.command).toEqual(['--all']);
    expect(container).not.toHaveProperty('portMappings');
  });

  it("never carries the image's HEALTHCHECK: a run is judged by its exit code alone", () => {
    const checked = cronOf({
      image: {
        tag: 'dep-42',
        architecture: 'amd64',
        healthCheck: { test: ['CMD-SHELL', 'test -f /tmp/alive'] },
      },
    });
    expect(containerOf(checked)).not.toHaveProperty('healthCheck');
  });

  it('lets nothing in and everything out', () => {
    const group = resource(cron, 'aws_security_group.service');
    expect(group.ingress).toEqual([]);
    expect(group.egress).toEqual([
      expect.objectContaining({ protocol: '-1', cidr_blocks: ['0.0.0.0/0'] }),
    ]);
  });

  it('outputs what a run is started with, its task definition revision and security group, and no ECS service', () => {
    expect(Object.keys(cron.output as object).sort()).toEqual(
      [
        'ecr_repository_url',
        'log_group_name',
        CRON_OUTPUTS.securityGroupId,
        CRON_OUTPUTS.taskDefinitionArn,
        'task_role_arn',
      ].sort(),
    );
  });

  it('tags every taggable resource with the state mark', () => {
    for (const found of taggableResources(cron)) {
      expect(effectiveTags(cron, found.body)).toMatchObject(defaultTags(cron));
    }
  });
});
