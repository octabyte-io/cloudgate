import { createHash } from 'node:crypto';

import { bucketAccessPolicy } from './bucket-access';
import { containerHealthCheck } from './container-health-check';
import { fargateSize } from './fargate-size';
import {
  DIGEST_VARIABLE,
  placeVariables,
  ssmParameterName,
  variablesDigest,
} from './ssm-variables';
import { valueVariable } from '../../definitions/tofu-json';
import { NETWORK_ADDRESS_RANGE } from './network-definition';
import { PRIVATE_DNS_TTL_SECONDS, privateHost } from './private-dns';
import { addressTag, resourceTags } from './tags';
import { frame, Resources, rule } from './tofu-json';
import { literal, ref } from '../../definitions/tofu-json';
import { TAG_KEYS } from './tags';
import { layNativeAws } from '../../../native/aws-lay';
import type { NativeAwsBlock } from '../../../native/aws-native';
import type { PlanRefusal, WebEntry } from '../../../project-config';
import type { ImageHealthCheck } from './container-health-check';
import type { FargatePair } from './fargate-size';
import type { NetworkIds } from './stand-ins';
import type { AwsAccountAccess } from './tofu-json';
import type { TofuDefinition } from '../../definitions/tofu-json';

/**
 * The CPU an image was built for, as Docker names it (`docker image inspect`'s
 * `Architecture`). The task follows it, so an operator never sets it.
 */
export type ImageArchitecture = 'amd64' | 'arm64';

const CPU_ARCHITECTURE: Record<ImageArchitecture, string> = {
  amd64: 'X86_64',
  arm64: 'ARM64',
};

/** What a cloud `web` Service's definition needs of its Cloud account. */
export interface WebCloudAccount extends AwsAccountAccess {
  /** Cloudgate's id of the Cloud account, for the mark. */
  readonly cloudAccountId: string;
  /** The task execution role the operator made from the template. */
  readonly taskExecutionRoleArn: string;
  /** The boundary every task role is created under (ADR-0032). */
  readonly permissionsBoundaryArn: string;
}

/**
 * One Domain of a cloud `web` Service: its host rule on the
 * network's HTTPS listener and its own DNS-validated ACM certificate.
 */
export interface WebDomain {
  readonly domainId: string;
  readonly host: string;
  /** The Domain's path; `/` matches every path of the host. */
  readonly path: string;
  /** Which certificate of the Domain is current (Ask again, a new host). */
  readonly attempt: number;
  /** The certificate is issued, so it goes on the listener. */
  readonly attach: boolean;
}

/**
 * What of its Config entry an ECS Service's definition reads, whatever its
 * kind: its size, and the `command` and `args` its container runs. The port
 * is the routing's, since not every kind has one ({@link EcsRouting}).
 */
export type EcsServiceEntry = Pick<WebEntry, 'size' | 'command' | 'args'>;

/**
 * How traffic reaches an ECS Service's tasks: the one thing in which a
 * `web`, a Worker and a Private web service differ on ECS (Worker on ECS), so
 * one builder ({@link ecsServiceDefinition}) makes all three and
 * they cannot drift apart.
 *
 * - **public target group**: a `web`. A target group, the Service's own
 *   listener rule, the ECS service's `load_balancer` block, the security
 *   group's rule from the load balancer, and the Domain blocks.
 * - **none**: a Worker. None of those, no port mapped, and a
 *   security group that lets nothing in.
 * - **private DNS**: a Private web service. None of the load
 *   balancer's pieces either; its tasks are listed, each healthy one, in
 *   the Environment network's Cloud Map namespace through its own
 *   discovery service, and its `port` is let in from the network's VPC
 *   range alone.
 */
export type EcsRouting =
  | {
      readonly kind: 'public-target-group';
      /** The container's port, which the target group forwards to. */
      readonly port: number;
      /**
       * The Service's Domains. Left out by a plan read of a new
       * Service, which has none; given (if empty) by every run of a
       * Service, so a Domain removed is a Domain its run destroys.
       */
      readonly domains?: readonly WebDomain[];
    }
  | { readonly kind: 'none' }
  | {
      readonly kind: 'private-dns';
      /** The container's port, which callers in the VPC reach it on. */
      readonly port: number;
    };

/**
 * An always-running ECS Service's routing by its config kind: a
 * `worker` none, whatever port its row keeps; a `web-private` private DNS
 * on its `port`, with no Domain; any other kind its public target
 * group on `port`, with its Domains. The one place a kind picks its
 * routing, so every plan read and deploy of a Service writes the same one.
 */
export function ecsRoutingOf(
  kind: string,
  port: number | null,
  domains?: readonly WebDomain[],
): EcsRouting {
  if (kind === 'worker') return { kind: 'none' };
  if (port === null) throw new Error(`A ${kind} on ECS needs a port`);
  if (kind === 'web-private') return { kind: 'private-dns', port };
  return { kind: 'public-target-group', port, domains };
}

export { privateAddress } from './private-dns';

/**
 * The input of {@link ecsServiceDefinition}: everything a `web`'s
 * definition takes, with its entry's port and Domains moved into `routing`.
 */
export interface EcsServiceDefinitionInput extends Omit<
  WebDefinitionInput,
  'entry' | 'domains'
> {
  readonly entry: EcsServiceEntry;
  readonly routing: EcsRouting;
}

export interface WebDefinitionInput {
  /** The entry's Config name: the Service's name in the Environment. */
  readonly configName: string;
  readonly entry: WebEntry;
  /** The Service's Cloudgate settings. */
  readonly service: {
    readonly serviceId: string;
    /** Running copies; the ECS service's desired count. */
    readonly replicas: number;
  };
  readonly account: WebCloudAccount;
  readonly region: string;
  readonly environmentId: string;
  /** The Service's Infrastructure state. */
  readonly stateId: string;
  /** The network's saved ids, or `networkStandIns` before it is made. */
  readonly network: NetworkIds;
  readonly image: {
    /** The Deployment's id, or `STAND_IN_IMAGE_TAG` before a build. */
    readonly tag: string;
    readonly architecture: ImageArchitecture;
    /**
     * The image's `HEALTHCHECK`, which the container runs as Docker
     * runs it on a Server; left out or `null` for an image with none, or
     * read before this was recorded, and then the container has none.
     */
    readonly healthCheck?: ImageHealthCheck | null;
  };
  /**
   * The Service's variables: their resolved values, which reach
   * `tofu` only through the result's `variables`, and Cloudgate's secret,
   * the key of their digest.
   */
  readonly variables: {
    readonly values: Readonly<Record<string, string>>;
    readonly digestSecret: string;
  };
  /**
   * The Service's Domains. Left out by a plan read of a new Service,
   * which has none; given (if empty) by every run of a Service, so a Domain
   * removed is a Domain its run destroys.
   */
  readonly domains?: readonly WebDomain[];
  /**
   * The real names of the buckets on S3 its links name (ADR-0032),
   * whose objects its task role may read and write. Absent or empty: the
   * role holds no permission.
   */
  readonly buckets?: readonly string[];
  /**
   * Its `native.aws` (ADR-0044 rule 3), already checked: laid over
   * what this builder writes, field by field, before `main.tf.json` is
   * written; the container's object merged into its one container. A plan
   * read lays the entry's, a deploy and a read for Drift the applied one
   * its row holds. Absent or `null`: exactly Cloudgate's definition.
   */
  readonly native?: NativeAwsBlock | null;
}

export type WebDefinitionResult =
  | {
      readonly ok: true;
      readonly definition: TofuDefinition;
      /** The Fargate pair the size landed on, for the plan's summary. */
      readonly pair: FargatePair;
      /**
       * Values for the definition's `sensitive` variables, which the run
       * passes as `TF_VAR_<name>`: each variable's value, and the
       * digest of them all. Never written to `main.tf.json`.
       */
      readonly variables: Record<string, string>;
    }
  | { readonly ok: false; readonly refusal: PlanRefusal };

/** The name of the one container in a Service's task. */
export const CONTAINER_NAME = 'service';

/** Prefix of every stream in the log group, and so of the Runtime log's. */
export const LOG_STREAM_PREFIX = 'service';

/**
 * The health check on every cloud `web` Service's target group (an open point
 * of the AWS spec, adopted from its suggestion): HTTP on the port traffic
 * goes to, path `/`, any 2xx or 3xx. Wide enough that an app redirecting `/`
 * to a login page counts as healthy; any other check is slice 8's `native`
 * block.
 */
export const HEALTH_CHECK = {
  enabled: true,
  protocol: 'HTTP',
  port: 'traffic-port',
  path: '/',
  matcher: '200-399',
} as const;

/**
 * The header the Service's own listener rule matches: `X-Cloudgate-Service`
 * set to the Service's id.
 *
 * ECS refuses to create a service whose target group no listener rule uses,
 * and a `web` a plan creates in a Cloud account has no Domain to route by
 * (CONTEXT.md **Domain**), so the Service's state holds one rule of its own
 * from the start. Matching on this header, rather than on a host nobody can
 * reach, also gives an operator a way to call the Service through the load
 * balancer before any DNS exists. A Domain's host rule is its own, added with
 * the Domain.
 */
export const SERVICE_HEADER = 'X-Cloudgate-Service';

/** ECR's rule for one part of a repository name. */
const ECR_NAME_PART = /^[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*$/;

/**
 * The Service's ECR repository: one per Service, lower case as ECR requires.
 * An id ECR refuses as it is — one starting or ending with `-` or `_`, or
 * with them side by side — has every character but a letter or digit folded
 * to `x`, as RDS's identifier is; every other keeps the name it always had,
 * so no running Service's repository is renamed.
 */
export function ecrRepositoryName(serviceId: string): string {
  const lower = serviceId.toLowerCase();
  return `cloudgate/${ECR_NAME_PART.test(lower) ? lower : lower.replace(/[^a-z0-9]/g, 'x')}`;
}

/**
 * The resources a Service's first deploy makes before it pushes: its
 * ECR repository and the repository's lifecycle rule, by their addresses in
 * the Service's state. The image goes in before the rest is applied.
 */
export const ECR_ADDRESSES: readonly string[] = [
  'aws_ecr_repository.service',
  'aws_ecr_lifecycle_policy.service',
];

/**
 * The three Domain blocks, each one resource over every Domain
 * (`for_each`). A Domain's own Cloud run applies only these (`-target`), and
 * because a target names the block rather than one Domain, a Domain no
 * longer in the definition is destroyed by the same run.
 */
export const DOMAIN_ADDRESSES: readonly string[] = [
  'aws_acm_certificate.domain',
  'aws_lb_listener_rule.domain',
  'aws_lb_listener_certificate.domain',
];

/** A Domain's certificate's key in the state: its id and which attempt. */
export function domainCertificateKey(domain: {
  domainId: string;
  attempt: number;
}): string {
  return `${domain.domainId}-${domain.attempt}`;
}

/**
 * The output a Domain's run reads each certificate's ARN and validation
 * record from, by {@link domainCertificateKey}.
 */
export const DOMAIN_CERTIFICATES_OUTPUT = 'domain_certificates';

/** The Service's log group, which Cloudgate makes (the AWS spec, "Runtime log"). */
export function logGroupName(environmentId: string, serviceId: string): string {
  return `/cloudgate/${environmentId}/${serviceId}`;
}

/** The ECS service's name. */
export function ecsServiceName(configName: string, serviceId: string): string {
  return `${configName}-${serviceId}`;
}

/** One task's log stream, as `awslogs` names it: prefix, container, task id. */
export function taskLogStream(taskId: string): string {
  return `${LOG_STREAM_PREFIX}/${CONTAINER_NAME}/${taskId}`;
}

/** The address of the SSM parameters, one instance per variable name. */
export const VARIABLE_ADDRESS = 'aws_ssm_parameter.variable';

/** The address of the task role's bucket access, present while it links one. */
export const BUCKET_ACCESS_ADDRESS = 'aws_iam_role_policy.buckets';

/** The log group keeps 90 days (the AWS spec, "Runtime log"). */
const LOG_RETENTION_DAYS = 90;

/** Long enough for a request in flight to finish, short enough for a deploy. */
const DEREGISTRATION_DELAY_SECONDS = 30;

/**
 * The OpenTofu definition of a cloud `web` Service's own state (the AWS spec,
 * "The Environment network": what sits in each Service's state). Pure: no AWS
 * call, no `tofu`, no database.
 *
 * It holds the Service's ECR repository (immutable tags; untagged images
 * expire after a day; force-deleted with its images on Delete), its log group,
 * task definition, ECS service on public IPs, target group and listener rule,
 * a security group that admits only the load balancer's, and a task role
 * under `/cloudgate/` that holds no permission but object access on the
 * buckets its links name ({@link bucketAccessPolicy}) — gone again
 * once it links none — and, when given its Domains, each Domain's
 * certificate and rule ({@link domainResources}).
 *
 * **Variables** are SSM `SecureString`s, one per variable with a
 * value (`ssm-variables.ts`), encrypted with AWS's default `aws/ssm` key and
 * read by the task execution role alone (the task role reads none), from
 * the task definition's `secrets`. An empty value is a plain `environment`
 * entry. Each value is a `sensitive` variable, and the HMAC digest of them
 * all sits in the ECS service's `triggers` with `force_new_deployment`, so
 * any changed value rolls the tasks in the run that writes it.
 *
 * A size above Fargate's largest refuses, naming the entry, before anything
 * is written, as does a value SSM cannot hold, naming the variable.
 *
 * It is {@link ecsServiceDefinition} with public target group routing.
 */
export function webDefinition(input: WebDefinitionInput): WebDefinitionResult {
  const { entry, domains, ...rest } = input;
  return ecsServiceDefinition({
    ...rest,
    entry,
    routing: { kind: 'public-target-group', port: entry.port, domains },
  });
}

/**
 * The OpenTofu definition of an ECS Service of any kind: everything
 * {@link webDefinition} describes, with what routes traffic to the tasks
 * chosen by `routing` ({@link EcsRouting}) and nothing else differing.
 */
export function ecsServiceDefinition(
  input: EcsServiceDefinitionInput,
): WebDefinitionResult {
  return ecsDefinition(input, { ecsService: true });
}

/**
 * The input of {@link cronTaskDefinition}: an ECS Service's, with no
 * routing (a run is reached by nothing) and no running count (nothing runs
 * between runs).
 */
export interface CronTaskDefinitionInput extends Omit<
  EcsServiceDefinitionInput,
  'routing' | 'service'
> {
  readonly service: { readonly serviceId: string };
}

/**
 * The OpenTofu definition of a Cron service on ECS (ADR-0034 as amended):
 * {@link ecsServiceDefinition} with routing none and
 * **no ECS service**. It keeps the ECR repository, the one task definition
 * (with `command` and `args`), the task role, the SSM parameters, the log
 * group, and a security group that lets nothing in. Cloudgate's own
 * timetable starts each run as a one-off task of the task definition, on
 * the Environment network's cluster, so nothing bills between runs but the
 * images and the logs.
 *
 * The task definition never carries the image's `HEALTHCHECK`, whatever
 * the image says: a run is judged by its exit code alone. Its outputs name
 * what a run is started with: the task definition's revision and the
 * security group.
 */
export function cronTaskDefinition(
  input: CronTaskDefinitionInput,
): WebDefinitionResult {
  return ecsDefinition(
    {
      ...input,
      routing: { kind: 'none' },
      service: { serviceId: input.service.serviceId, replicas: 0 },
      image: { ...input.image, healthCheck: null },
    },
    { ecsService: false },
  );
}

/**
 * An ECS-run Service's definition by its config kind: a `cron` its
 * task definition with no ECS service ({@link cronTaskDefinition}); every
 * other kind its ECS Service, routed as {@link ecsRoutingOf} says. The one
 * place a kind picks its shape, so every plan read and deploy writes the
 * same one.
 */
export function ecsDefinitionOf(
  kind: string,
  input: Omit<EcsServiceDefinitionInput, 'routing'>,
  route: { port: number | null; domains?: readonly WebDomain[] },
): WebDefinitionResult {
  if (kind === 'cron') return cronTaskDefinition(input);
  return ecsServiceDefinition({
    ...input,
    routing: ecsRoutingOf(kind, route.port, route.domains),
  });
}

/** The outputs a Cron service's run is started from. */
export const CRON_OUTPUTS = {
  taskDefinitionArn: 'task_definition_arn',
  securityGroupId: 'security_group_id',
} as const;

function ecsDefinition(
  input: EcsServiceDefinitionInput,
  shape: { readonly ecsService: boolean },
): WebDefinitionResult {
  const sizing = fargateSize(input.configName, input.entry.size);
  if (!sizing.ok) return { ok: false, refusal: sizing.refusal };
  const placed = placeVariables(input.configName, input.variables.values);
  if (!placed.ok) return { ok: false, refusal: placed.refusal };

  const { serviceId } = input.service;
  const { entry, network, account, routing } = input;
  const mark = {
    cloudAccountId: account.cloudAccountId,
    environmentId: input.environmentId,
    stateId: input.stateId,
  };
  const label = (part: string) => `cloudgate/${input.configName}/${part}`;
  const r = new Resources();

  // ECR names are lower case only. A nanoid differs from another only in
  // case with odds far below anything else that can go wrong here, and the
  // mark, not the name, is what identifies the repository.
  const repository = r.tagged(
    'aws_ecr_repository',
    'service',
    label('images'),
    {
      name: ecrRepositoryName(serviceId),
      image_tag_mutability: 'IMMUTABLE',
      force_delete: true,
    },
  );
  r.untagged('aws_ecr_lifecycle_policy', 'service', {
    repository: ref(repository, 'name'),
    policy: JSON.stringify({
      rules: [
        {
          rulePriority: 1,
          description: 'Expire half-pushed untagged images after a day',
          selection: {
            tagStatus: 'untagged',
            countType: 'sinceImagePushed',
            countUnit: 'days',
            countNumber: 1,
          },
          action: { type: 'expire' },
        },
      ],
    }),
  });

  // Cloudgate makes the log group itself, tagged and with its retention, and
  // the task never sets `awslogs-create-group` (the AWS spec, "Runtime log").
  const logs = r.tagged('aws_cloudwatch_log_group', 'service', label('logs'), {
    name: logGroupName(input.environmentId, serviceId),
    retention_in_days: LOG_RETENTION_DAYS,
  });

  const taskRole = r.tagged('aws_iam_role', 'task', label('task-role'), {
    name: `cloudgate-${serviceId}`,
    path: '/cloudgate/',
    permissions_boundary: account.permissionsBoundaryArn,
    assume_role_policy: JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: { Service: 'ecs-tasks.amazonaws.com' },
          Action: 'sts:AssumeRole',
          Condition: {
            StringEquals: { 'aws:SourceAccount': account.awsAccountId },
          },
        },
      ],
    }),
  });

  // A link is the access (ADR-0032): an inline policy takes no tags, and
  // goes with the role.
  if (input.buckets && input.buckets.length > 0) {
    r.untagged('aws_iam_role_policy', 'buckets', {
      name: 'cloudgate-buckets',
      role: ref(taskRole, 'id'),
      policy: JSON.stringify(bucketAccessPolicy(input.buckets)),
    });
  }

  // One parameter per variable with a value, its value a sensitive
  // variable. `for_each` keys are names, never values, so the plan's
  // addresses (`aws_ssm_parameter.variable["API_KEY"]`) name the variable.
  const secure = placed.placements.flatMap((one) =>
    one.kind === 'secure' ? [one] : [],
  );
  const parameterName = (name: string) =>
    ssmParameterName(input.environmentId, serviceId, name);
  const variable: Record<string, unknown> = {
    [DIGEST_VARIABLE]: { type: 'string', sensitive: true, nullable: false },
  };
  const variables: Record<string, string> = {
    [DIGEST_VARIABLE]: variablesDigest(
      input.variables.digestSecret,
      input.variables.values,
    ),
  };
  const locals: Record<string, unknown> = {};
  if (secure.length > 0) {
    const values: Record<string, string> = {};
    for (const { name } of secure) {
      const holder = valueVariable(name);
      variable[holder] = { type: 'string', sensitive: true, nullable: false };
      variables[holder] = input.variables.values[name];
      values[name] = `\${var.${holder}}`;
    }
    locals.variable_values = values;
    r.untagged('aws_ssm_parameter', 'variable', {
      for_each: Object.fromEntries(secure.map((one) => [one.name, one.tier])),
      name: parameterName('${each.key}'),
      type: 'SecureString',
      tier: '${each.value}',
      value: '${local.variable_values[each.key]}',
      // `untagged` only because the address differs per instance: these
      // are its own tags, as `Resources.tagged` would write them.
      tags: resourceTags(
        `${VARIABLE_ADDRESS}["\${each.key}"]`,
        label('variables/${each.key}'),
      ),
    });
  }

  const container: Record<string, unknown> = {
    name: CONTAINER_NAME,
    image: `${ref(repository, 'repository_url')}:${input.image.tag}`,
    essential: true,
    // A Worker listens on nothing anyone is promised: no mapping.
    ...(routing.kind === 'none'
      ? {}
      : { portMappings: [{ containerPort: routing.port, protocol: 'tcp' }] }),
    logConfiguration: {
      logDriver: 'awslogs',
      options: {
        'awslogs-group': ref(logs, 'name'),
        'awslogs-region': input.region,
        'awslogs-stream-prefix': LOG_STREAM_PREFIX,
      },
    },
  };
  // The image's own check, beside whatever routing checks: a task
  // failing either is replaced. None writes nothing, so a Service deployed
  // before its check was recorded plans exactly as it did.
  if (input.image.healthCheck) {
    container.healthCheck = containerHealthCheck(input.image.healthCheck);
  }
  // As on a Server, `command` replaces the image's entrypoint and `args` its
  // command (`mechanize.ts` hands Swarm the same split).
  if (entry.command) {
    container.entryPoint = entry.command.split(' ').map(literal);
  }
  if (entry.args && entry.args.length > 0) {
    container.command = entry.args.map(literal);
  }
  // By ARN, which is known before the parameter exists: a reference would
  // need quotes inside this JSON string. `depends_on` keeps the order.
  if (secure.length > 0) {
    container.secrets = secure.map(({ name }) => ({
      name,
      valueFrom: `arn:aws:ssm:${input.region}:${account.awsAccountId}:parameter${parameterName(name)}`,
    }));
  }
  const plain = placed.placements.filter((one) => one.kind === 'plain');
  if (plain.length > 0) {
    container.environment = plain.map(({ name }) => ({ name, value: '' }));
  }

  const task = r.tagged('aws_ecs_task_definition', 'service', label('task'), {
    family: `cloudgate-${serviceId}`,
    requires_compatibilities: ['FARGATE'],
    network_mode: 'awsvpc',
    cpu: String(sizing.pair.cpuUnits),
    memory: String(sizing.pair.memoryMb),
    execution_role_arn: account.taskExecutionRoleArn,
    task_role_arn: ref(taskRole, 'arn'),
    runtime_platform: {
      operating_system_family: 'LINUX',
      cpu_architecture: CPU_ARCHITECTURE[input.image.architecture],
    },
    container_definitions: JSON.stringify([container]),
    ...(secure.length > 0 ? { depends_on: [VARIABLE_ADDRESS] } : {}),
  });

  const inbound = routedInbound(routing, network);
  const group = r.tagged('aws_security_group', 'service', label('tasks'), {
    name: serviceSecurityGroupName(serviceId),
    description: inbound.description,
    vpc_id: network.vpcId,
    ingress: inbound.ingress,
    // Out to anywhere: with no NAT gateway the task pulls its image and
    // reads its variables over its own public IP.
    egress: [rule({ port: 0, protocol: '-1', cidr: '0.0.0.0/0' })],
  });

  const routed =
    routing.kind === 'public-target-group'
      ? publicTargetGroup(r, routing, { network, serviceId, label })
      : null;
  const discovery =
    routing.kind === 'private-dns'
      ? discoveryService(r, input.configName, network, label)
      : null;

  // A Cron service has none: each run is a one-off task of `task`.
  const ecsService = shape.ecsService
    ? r.tagged('aws_ecs_service', 'service', label('service'), {
        name: ecsServiceName(input.configName, serviceId),
        cluster: network.clusterArn,
        task_definition: ref(task, 'arn'),
        desired_count: input.service.replicas,
        launch_type: 'FARGATE',
        propagate_tags: 'SERVICE',
        enable_ecs_managed_tags: true,
        network_configuration: {
          subnets: [...network.publicSubnetIds],
          security_groups: [ref(group, 'id')],
          assign_public_ip: true,
        },
        ...(routed ? { load_balancer: routed.loadBalancer } : {}),
        // ECS lists each task in DNS once it is healthy, and takes it off
        // when it stops. An A record in `awsvpc` mode needs no port.
        ...(discovery
          ? {
              service_registries: {
                registry_arn: ref(discovery.address, 'arn'),
              },
            }
          : {}),
        // The running count is Stop's and Start's, set through the
        // port, so a stopped Service is not Drift that the next plan puts
        // back.
        lifecycle: { ignore_changes: ['desired_count'] },
        // The digest of every value: a changed one is a new deployment
        // as is a changed discovery service.
        triggers: {
          variables: `\${var.${DIGEST_VARIABLE}}`,
          ...(discovery ? { discovery: discovery.digest } : {}),
        },
        force_new_deployment: true,
        ...(routed ? { depends_on: routed.dependsOn } : {}),
      })
    : null;

  const domainOutputs =
    routed === null ||
    routing.kind !== 'public-target-group' ||
    routing.domains === undefined
      ? {}
      : domainResources(r, routing.domains, {
          listenerArn: network.httpsListenerArn,
          targetGroup: routed.targetGroup,
          label,
        });

  const output = (value: unknown) => ({ value });
  return {
    ok: true,
    pair: sizing.pair,
    variables,
    definition: {
      ...frame(account, input.region, mark),
      variable,
      ...(Object.keys(locals).length > 0 ? { locals } : {}),
      // Native last, over everything Cloudgate wrote.
      resource: layNativeAws(r.all(), input.native),
      output: {
        ecr_repository_url: output(ref(repository, 'repository_url')),
        log_group_name: output(ref(logs, 'name')),
        ...(ecsService
          ? { ecs_service_name: output(ref(ecsService, 'name')) }
          : {
              // What a Cron service's run is started with.
              [CRON_OUTPUTS.taskDefinitionArn]: output(ref(task, 'arn')),
              [CRON_OUTPUTS.securityGroupId]: output(ref(group, 'id')),
            }),
        ...(routed
          ? { target_group_arn: output(ref(routed.targetGroup, 'arn')) }
          : {}),
        ...(discovery
          ? { discovery_service_arn: output(ref(discovery.address, 'arn')) }
          : {}),
        // A tag search cannot find an IAM role, so a Delete checks it by
        // ARN (ADR-0036).
        task_role_arn: output(ref(taskRole, 'arn')),
        ...domainOutputs,
      },
    },
  };
}

/**
 * What the Service's security group lets in, by its routing: for a
 * public target group, its port from the load balancer's group only; for
 * none (a Worker), nothing at all; for private DNS (a Private web service), its
 * port from the Environment network's VPC range only,
 * where every `web`, Worker and Cron run of the Environment sits, and the
 * load balancer's group is no source.
 */
function routedInbound(
  routing: EcsRouting,
  network: NetworkIds,
): { description: string; ingress: Record<string, unknown>[] } {
  if (routing.kind === 'none') {
    return {
      description: 'Cloudgate: a Service that lets nothing in',
      ingress: [],
    };
  }
  if (routing.kind === 'private-dns') {
    return {
      description:
        'Cloudgate: a Private web service, reachable from the VPC of its Environment network only',
      ingress: [
        rule({
          port: routing.port,
          protocol: 'tcp',
          cidr: NETWORK_ADDRESS_RANGE.vpc,
        }),
      ],
    };
  }
  return {
    description: 'Cloudgate: a Service, reachable from its load balancer only',
    ingress: [
      rule({
        port: routing.port,
        protocol: 'tcp',
        securityGroupId: network.albSecurityGroupId,
      }),
    ],
  };
}

/**
 * A Private web service's discovery service: its Config name in the
 * Environment network's namespace, answering one A record per healthy task
 * (`MULTIVALUE`), with ECS reporting each task's health. Deleted with the
 * Service, the records ECS left in it included; the namespace stays.
 *
 * With its address comes the digest of what it is written with, which sits
 * in the ECS service's `triggers`. Cloud Map hands a re-created
 * discovery service its old id and ARN, so a replace leaves the ECS service
 * nothing to roll out and its running tasks out of DNS; a new deployment
 * lists them again, and every change that replaces it is a change of what
 * it is written with. Rejected: `replace_triggered_by` on the ECS service,
 * since ECS refuses a create under the name of one still draining and the
 * replace is an outage of its own; and a `terraform_data` replaced with it,
 * its new `id` in the `triggers`, since the AWS provider plans a value of
 * `triggers` known only after apply as the old one, and the Apply then
 * stops on an inconsistent final plan (the moto lane, OpenTofu 1.13.1,
 * provider 6.69.1).
 */
function discoveryService(
  r: Resources,
  configName: string,
  network: NetworkIds,
  label: (part: string) => string,
): { address: string; digest: string } {
  if (!network.privateDnsNamespaceId) {
    throw new Error(
      `${configName} is a Private web service, and its Environment network has no private DNS namespace`,
    );
  }
  const body = {
    name: configName,
    description: `Cloudgate: ${privateHost(configName)}`,
    dns_config: {
      namespace_id: network.privateDnsNamespaceId,
      routing_policy: 'MULTIVALUE',
      dns_records: [{ ttl: PRIVATE_DNS_TTL_SECONDS, type: 'A' }],
    },
    // ECS reports each task's health to Cloud Map, so only healthy tasks
    // are listed. The threshold is set explicitly: AWS drops an empty
    // block on create and answers no custom health check, so every later
    // plan would replace the discovery service. AWS always uses 1; the
    // provider still accepts the deprecated field.
    health_check_custom_config: { failure_threshold: 1 },
    force_destroy: true,
  };
  return {
    address: r.tagged(
      'aws_service_discovery_service',
      'service',
      label('dns'),
      body,
    ),
    digest: discoveryDigest(body),
  };
}

/**
 * The digest of a discovery service's body, as the ECS service's `triggers`
 * carry it; exported for the moto lane, which writes a body that
 * forces a replace.
 */
export function discoveryDigest(body: object): string {
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

/**
 * A public target group's own resources: the target group and the
 * Service's own listener rule on the network's HTTPS listener, and what the
 * ECS service takes of them, its `load_balancer` block and the rule it
 * waits for.
 */
function publicTargetGroup(
  r: Resources,
  routing: Extract<EcsRouting, { kind: 'public-target-group' }>,
  on: {
    network: NetworkIds;
    serviceId: string;
    label: (part: string) => string;
  },
): {
  targetGroup: string;
  loadBalancer: Record<string, unknown>;
  dependsOn: string[];
} {
  const target = r.tagged(
    'aws_lb_target_group',
    'service',
    on.label('targets'),
    {
      name_prefix: 'cg-',
      target_type: 'ip',
      protocol: 'HTTP',
      port: routing.port,
      vpc_id: on.network.vpcId,
      deregistration_delay: String(DEREGISTRATION_DELAY_SECONDS),
      health_check: { ...HEALTH_CHECK },
      // A changed port replaces the group, and the listener rule holds the
      // old one until the new one exists.
      lifecycle: { create_before_destroy: true },
    },
  );

  // No priority: AWS gives the next free one, so two Services' rules in one
  // listener never collide and a plan never shows it as a change.
  const listenerRule = r.tagged(
    'aws_lb_listener_rule',
    'service',
    on.label('rule'),
    {
      listener_arn: on.network.httpsListenerArn,
      action: { type: 'forward', target_group_arn: ref(target, 'arn') },
      condition: {
        http_header: {
          http_header_name: SERVICE_HEADER,
          values: [on.serviceId],
        },
      },
    },
  );

  return {
    targetGroup: target,
    loadBalancer: {
      target_group_arn: ref(target, 'arn'),
      container_name: CONTAINER_NAME,
      container_port: routing.port,
    },
    dependsOn: [listenerRule],
  };
}

/**
 * A cloud `web`'s Domains (the AWS spec, "Domains"): per Domain, its own
 * ACM certificate (DNS validation, which the operator's DNS provider answers;
 * Cloudgate writes no DNS), a listener rule on the host (and path), and the
 * certificate on the listener once ACM has issued it.
 *
 * No `aws_acm_certificate_validation`: it would hold the apply until ACM
 * issues, and a deploy never waits on a certificate. Cloudgate polls ACM
 * instead and attaches the issued certificate in a run of its own. Nothing of
 * the ECS service depends on these.
 *
 * Every instance carries its own address as its `cloudgate:address` tag, as
 * every other resource does.
 *
 * `targetGroup` is the one target group every rule forwards to (a `web`'s),
 * or, for a Stack VM whose Domains reach different ports, each Domain's
 * own target group's ARN.
 */
export function domainResources<Domain extends WebDomain>(
  r: Resources,
  domains: readonly Domain[],
  on: {
    listenerArn: string;
    targetGroup: string | ((domain: Domain) => string);
    label: (part: string) => string;
  },
): Record<string, { value: string }> {
  const { targetGroup } = on;
  const tags = (type: string) => ({
    [TAG_KEYS.address]: addressTag(`${type}.domain["\${each.key}"]`),
    Name: '${each.value.name}',
  });
  const name = (host: string) => on.label(`domain/${host}`);

  const certificates = Object.fromEntries(
    domains.map((domain) => [
      domainCertificateKey(domain),
      { host: domain.host, name: name(domain.host) },
    ]),
  );
  r.untagged('aws_acm_certificate', 'domain', {
    for_each: certificates,
    domain_name: '${each.value.host}',
    validation_method: 'DNS',
    // Ask again's new certificate exists before the failed one goes.
    lifecycle: { create_before_destroy: true },
    tags: tags('aws_acm_certificate'),
  });

  const rules = Object.fromEntries(
    domains.map((domain) => [
      domain.domainId,
      {
        host: domain.host,
        name: name(domain.host),
        paths: domain.path === '/' ? ['/*'] : [domain.path, `${domain.path}/*`],
        ...(typeof targetGroup === 'string'
          ? {}
          : { target_group: targetGroup(domain) }),
      },
    ]),
  );
  // No priority, like the Service's own rule: AWS gives the next free one.
  r.untagged('aws_lb_listener_rule', 'domain', {
    for_each: rules,
    listener_arn: on.listenerArn,
    action: {
      type: 'forward',
      target_group_arn:
        typeof targetGroup === 'string'
          ? ref(targetGroup, 'arn')
          : '${each.value.target_group}',
    },
    condition: [
      { host_header: { values: ['${each.value.host}'] } },
      { path_pattern: { values: '${each.value.paths}' } },
    ],
    tags: tags('aws_lb_listener_rule'),
  });

  // A listener certificate takes no tags.
  r.untagged('aws_lb_listener_certificate', 'domain', {
    for_each: Object.fromEntries(
      domains
        .filter((domain) => domain.attach)
        .map((domain) => [domainCertificateKey(domain), true]),
    ),
    listener_arn: on.listenerArn,
    certificate_arn: '${aws_acm_certificate.domain[each.key].arn}',
  });

  return {
    [DOMAIN_CERTIFICATES_OUTPUT]: {
      value:
        '${ {for key, certificate in aws_acm_certificate.domain : key => { arn = certificate.arn, validation = [for option in certificate.domain_validation_options : { name = option.resource_record_name, type = option.resource_record_type, value = option.resource_record_value }] }} }',
    },
  };
}

/**
 * A cloud Service's own security group, by its name in AWS: what an
 * Existing database's security group lets in, which the operator
 * does, never Cloudgate.
 */
export function serviceSecurityGroupName(serviceId: string): string {
  return `cloudgate-service-${serviceId}`;
}
