import {
  ecsDefinitionOf,
  HEALTH_CHECK,
  webDefinition,
} from '../../../../src/cloud-accounts/aws/definitions/web-definition';
import type { WebDefinitionInput } from '../../../../src/cloud-accounts/aws/definitions/web-definition';
import { renderDefinition } from '../../../../src/cloud-accounts/definitions/tofu-json';
import type { NativeAwsBlock } from '../../../../src/native/aws-native';
import { resource, sampleWebEntry } from './definition-helpers';

/**
 * ADR-0044 rule 3: `native.aws` laid over the one ECS builder's
 * definition, before `main.tf.json` is written. Pure: what the operator
 * writes in, what the definition holds out.
 */

const NETWORK = {
  vpcId: 'vpc-0a1b',
  publicSubnetIds: ['subnet-0aaa', 'subnet-0bbb'] as const,
  clusterArn: 'arn:aws:ecs:eu-west-1:123456789012:cluster/cloudgate-env-prod',
  httpsListenerArn:
    'arn:aws:elasticloadbalancing:eu-west-1:123456789012:listener/app/cg-x/1/2',
  albSecurityGroupId: 'sg-0alb',
  privateDnsNamespaceId: 'ns-0private',
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
    image: {
      tag: 'dep-42',
      architecture: 'amd64',
      healthCheck: { test: ['CMD', '/healthcheck'], retries: 3 },
    },
    variables: { values: { API_KEY: 'hunter2' }, digestSecret: 'secret' },
    ...overrides,
  };
}

function definitionOf(native?: NativeAwsBlock, kind = 'web') {
  const { entry, ...rest } = input({ native });
  const result =
    kind === 'web'
      ? webDefinition({ ...rest, entry })
      : ecsDefinitionOf(kind, { ...rest, entry }, { port: entry.port });
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

const ECS_SERVICE: NativeAwsBlock = {
  'aws_ecs_service.service': {
    health_check_grace_period_seconds: 60,
    enable_execute_command: true,
    deployment_maximum_percent: 150,
    deployment_minimum_healthy_percent: 50,
    deployment_circuit_breaker: { enable: true, rollback: true },
  },
};

describe('webDefinition with native.aws laid over it', () => {
  it('writes exactly what it wrote before when there is no block', () => {
    expect(renderDefinition(definitionOf(undefined))).toBe(
      renderDefinition(definitionOf({})),
    );
    expect(renderDefinition(definitionOf(undefined))).toBe(
      renderDefinition(definitionOf(null as unknown as NativeAwsBlock)),
    );
  });

  it("sets a plain value and a block Cloudgate writes none of on the ECS service, keeping Cloudgate's own arguments and lifecycle", () => {
    const service = resource(
      definitionOf(ECS_SERVICE),
      'aws_ecs_service.service',
    );
    expect(service).toMatchObject({
      health_check_grace_period_seconds: 60,
      enable_execute_command: true,
      deployment_maximum_percent: 150,
      deployment_minimum_healthy_percent: 50,
      deployment_circuit_breaker: { enable: true, rollback: true },
      launch_type: 'FARGATE',
      lifecycle: { ignore_changes: ['desired_count'] },
      force_new_deployment: true,
    });
    const before = resource(definitionOf(), 'aws_ecs_service.service');
    expect(service.network_configuration).toEqual(before.network_configuration);
    expect(service.triggers).toEqual(before.triggers);
  });

  it("merges a block the provider allows once field by field: health_check.path keeps Cloudgate's matcher", () => {
    const group = resource(
      definitionOf({
        'aws_lb_target_group.service': {
          health_check: { path: '/healthz' },
        },
      }),
      'aws_lb_target_group.service',
    );
    expect(group.health_check).toEqual({ ...HEALTH_CHECK, path: '/healthz' });
    expect(group.lifecycle).toEqual({ create_before_destroy: true });
  });

  it('takes a block written as a list of one as the same block', () => {
    const group = resource(
      definitionOf({
        'aws_lb_target_group.service': {
          health_check: [{ interval: 10 }],
        },
      }),
      'aws_lb_target_group.service',
    );
    expect(group.health_check).toEqual({ ...HEALTH_CHECK, interval: 10 });
  });

  it('replaces a real list whole', () => {
    const service = resource(
      definitionOf({
        'aws_ecs_service.service': {
          ordered_placement_strategy: [{ type: 'spread', field: 'host' }],
        },
      }),
      'aws_ecs_service.service',
    );
    expect(service.ordered_placement_strategy).toEqual([
      { type: 'spread', field: 'host' },
    ]);
  });

  it("replaces a plain value Cloudgate writes, keeping the resource's other arguments", () => {
    const group = resource(
      definitionOf({
        'aws_cloudwatch_log_group.service': { retention_in_days: 30 },
      }),
      'aws_cloudwatch_log_group.service',
    );
    expect(group.retention_in_days).toBe(30);
    expect(group.name).toBe('/cloudgate/env-prod/App_Id-1');
  });

  describe('the container', () => {
    const native: NativeAwsBlock = {
      'aws_ecs_task_definition.service': {
        container_definitions: {
          healthCheck: { retries: 5, startPeriod: 30 },
          stopTimeout: 90,
          dockerLabels: { team: 'payments' },
        },
      },
    };

    it("merges its object into Cloudgate's one container in ECS's spelling, keeping its image, ports, secrets and log configuration", () => {
      const before = containerOf(definitionOf());
      const container = containerOf(definitionOf(native));
      expect(container).toEqual({
        ...before,
        healthCheck: {
          ...(before.healthCheck as object),
          retries: 5,
          startPeriod: 30,
        },
        stopTimeout: 90,
        dockerLabels: { team: 'payments' },
      });
      expect(container.image).toBe(before.image);
      expect(container.portMappings).toEqual(before.portMappings);
      expect(container.secrets).toEqual(before.secrets);
      expect(container.logConfiguration).toEqual(before.logConfiguration);
    });

    it("keeps the task definition's own arguments beside it", () => {
      const task = resource(
        definitionOf({
          'aws_ecs_task_definition.service': {
            ...native['aws_ecs_task_definition.service'],
            ephemeral_storage: { size_in_gib: 50 },
          },
        }),
        'aws_ecs_task_definition.service',
      );
      expect(task).toMatchObject({
        family: 'cloudgate-App_Id-1',
        ephemeral_storage: { size_in_gib: 50 },
      });
      expect(task.depends_on).toEqual(['aws_ssm_parameter.variable']);
    });
  });

  it('escapes a template in a native string, so it reaches AWS as written', () => {
    const definition = definitionOf({
      'aws_lb_target_group.service': {
        health_check: { path: '/health/${var.x}' },
      },
      'aws_ecs_task_definition.service': {
        container_definitions: { dockerLabels: { '%{k}': '${v}' } },
      },
    });
    expect(
      (
        resource(definition, 'aws_lb_target_group.service')
          .health_check as Record<string, unknown>
      ).path,
    ).toBe('/health/$${var.x}');
    expect(containerOf(definition).dockerLabels).toEqual({ '%%{k}': '$${v}' });
  });

  it('throws on an address the definition does not write, which the plan refuses first', () => {
    expect(() =>
      definitionOf(
        { 'aws_lb_target_group.service': { slow_start: 30 } },
        'worker',
      ),
    ).toThrow(/aws_lb_target_group\.service/);
  });

  it.each(['worker', 'web-private'])(
    'lays the same block on a %s through the shared builder',
    (kind) => {
      const service = resource(
        definitionOf(
          {
            ...ECS_SERVICE,
            'aws_ecs_task_definition.service': {
              container_definitions: { stopTimeout: 90 },
            },
          },
          kind,
        ),
        'aws_ecs_service.service',
      );
      expect(service).toMatchObject(ECS_SERVICE['aws_ecs_service.service']);
    },
  );

  it("lays a cron's container through the shared builder", () => {
    const definition = definitionOf(
      {
        'aws_ecs_task_definition.service': {
          container_definitions: { stopTimeout: 90 },
        },
      },
      'cron',
    );
    expect(containerOf(definition).stopTimeout).toBe(90);
  });
});
