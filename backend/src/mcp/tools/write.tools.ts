import { BadRequestException, ConflictException } from '@nestjs/common';
import type { Type } from '@nestjs/common';
import { z } from 'zod';
import { ApplicationsController } from '../../applications/applications.controller';
import { ApplicationsService } from '../../applications/applications.service';
import type {
  ServiceType,
  WorkloadServiceType,
} from '../../applications/application.schema';
import { CLOUD_LIFECYCLE_REFUSED_CODE } from '../../applications/cloud-lifecycle';
import {
  ELASTICACHE_CANNOT_STOP,
  ELASTICACHE_CANNOT_STOP_CODE,
  MEMORYSTORE_CANNOT_STOP,
  MEMORYSTORE_CANNOT_STOP_CODE,
} from '../../databases/common/cloud-database-refusals';
import { ComposeController } from '../../compose/compose.controller';
import { ComposeService } from '../../compose/compose.service';
import { deployment } from '../../deployments/deployment.schema';
import type { Deployment } from '../../deployments/deployment.schema';
import { DeploymentsController } from '../../deployments/deployments.controller';
import { DeploymentsService } from '../../deployments/deployments.service';
import type { BuiltServiceType } from '../../deployments/deployments.service';
import type { PermissionCtx } from '../../rbac/permission.service';
import { defineTool, kindRoute } from '../tool-definition';
import type { KindRoute } from '../tool-definition';
import { GRANT_REFUSALS } from '../tool-errors';
import type { ErrorEntry } from '../tool-errors';
import { row } from '../tool-projection';
import {
  BUILT_TYPES,
  buildOwnerOf,
  engineRoutes,
  serviceIdArg,
  serviceRoot,
  workloadTypeArg,
} from './service-kinds';
import type { EngineService } from './service-kinds';

/**
 * The Operator's write tools: `deploy_service`, `start_service`,
 * `stop_service` and `cancel_deployment`. Each spends the write budget
 * (`kind: 'write'`), declares its twin's statement, and answers a
 * declared projection — never the row its service method returns, which for
 * a start or stop is the whole Service row, secrets and all.
 *
 * None of them runs anything an agent wrote: a deploy queues the build the
 * console's Deploy queues, and a start or stop runs the same `docker service
 * scale` or `docker compose` the console's buttons run, on the Service's own
 * Server. There is no exec tool, into a Managed container or onto a Server.
 */

// ------------------------------------------------------------ deploy_service

/** What `deploy_service` answers, before its projection. */
export type DeployAnswer = Deployment & {
  serviceType: BuiltServiceType;
  serviceId: string;
  /** Whether the call joined a Deployment already queued instead of queuing one. */
  coalesced: boolean;
  mode: 'deploy' | 'redeploy';
  message: string;
};

const coalescedMessage = (deploymentId: string) =>
  `Deployment \`${deploymentId}\` of this Service was already queued; poll \`list_deployments\` for it. Deploying again will not queue another.`;

const queuedMessage = (deploymentId: string) =>
  `Deployment \`${deploymentId}\` is queued; poll \`list_deployments\` for it.`;

const deployInput = z.object({
  serviceType: z
    .enum(BUILT_TYPES)
    .describe('application or compose; a database is started, not deployed'),
  serviceId: serviceIdArg,
  mode: z
    .enum(['deploy', 'redeploy'])
    .optional()
    .describe(
      'deploy (the default) builds from the source as it is now; redeploy rebuilds an Application from the source it already has. A Compose always deploys.',
    ),
});

type DeployArgs = z.infer<typeof deployInput>;

/**
 * Coalescing (the spec's "Coalescing"): join the Service's build still
 * waiting in the queue, if there is one, and queue a new one only if not.
 * `joinQueuedBuild` runs the deploy's own gate first and upgrades a queued
 * redeploy that a deploy joins; see its docblock for what is joined and why
 * an orphaned pending row is not. Two calls racing each other can both find
 * nothing and both queue — the write budget bounds that, it does not rule it
 * out.
 */
async function deployOrJoin(
  service: DeploymentsService,
  ctx: PermissionCtx,
  args: DeployArgs,
  queue: (mode: 'deploy' | 'redeploy') => Promise<Deployment>,
): Promise<DeployAnswer> {
  // A Compose has one way to build; `redeploy` is an Application's.
  const mode =
    args.serviceType === 'compose' ? 'deploy' : (args.mode ?? 'deploy');
  const joined = await service.joinQueuedBuild(
    ctx,
    args.serviceType,
    args.serviceId,
    mode,
  );
  const found = joined ?? (await queue(mode));
  return {
    ...found,
    serviceType: args.serviceType,
    serviceId: args.serviceId,
    coalesced: joined !== null,
    mode,
    message: joined
      ? coalescedMessage(found.deploymentId)
      : queuedMessage(found.deploymentId),
  };
}

const NO_SOURCE =
  'This Service has no source to deploy from. An operator sets its source in the console; deploy again after that.';

export const deployService = defineTool({
  name: 'deploy_service',
  title: 'Deploy a Service',
  description:
    'Queues a build of an Application or a Compose and answers its deploymentId; poll list_deployments for its status. If a Deployment of the Service is already queued, it answers that one with coalesced: true and queues nothing, so calling again is safe. A build already running is not joined: a new one is queued behind it.',
  kind: 'write',
  input: deployInput,
  permissions: { deployment: ['create'] },
  routedBy: 'serviceType',
  routes: {
    application: kindRoute(deployInput, {
      // `mode: 'redeploy'` calls `redeploy`, whose twin is
      // `POST /applications/:id/redeploy`, under the same statement.
      twin: { controller: DeploymentsController, handler: 'deploy' },
      target: { service: DeploymentsService, method: 'deploy' },
      call: (service, ctx, args) =>
        deployOrJoin(service, ctx, args, (mode) =>
          mode === 'redeploy'
            ? service.redeploy(ctx, args.serviceId)
            : service.deploy(ctx, args.serviceId),
        ),
    }),
    compose: kindRoute(deployInput, {
      twin: { controller: DeploymentsController, handler: 'deployCompose' },
      target: { service: DeploymentsService, method: 'deployCompose' },
      audit: { resourceType: 'compose', action: 'deploy' },
      call: (service, ctx, args) =>
        deployOrJoin(service, ctx, args, () =>
          service.deployCompose(ctx, args.serviceId),
        ),
    }),
  },
  targetId: 'serviceId',
  audit: { resourceType: 'application', action: 'deploy' },
  projection: row<DeployAnswer>({
    fields: [
      'deploymentId',
      'serviceType',
      'serviceId',
      'status',
      'title',
      'createdAt',
      'coalesced',
      'message',
    ],
  }),
  errors: [
    ...GRANT_REFUSALS,
    // `refuseWithoutSource`'s 409, whose own text names the Service.
    { exception: ConflictException, answer: { failed: NO_SOURCE } },
  ],
  maskRoots: (args) => [serviceRoot(args)],
  auditDetail: (_args, raw) => ({ mode: raw.mode, coalesced: raw.coalesced }),
});

// ------------------------------------------------ start_service, stop_service

/** What `start_service` and `stop_service` answer: that it was asked for. */
export interface LifecycleAnswer {
  serviceType: ServiceType;
  serviceId: string;
  requested: 'start' | 'stop';
  message: string;
}

const lifecycleInput = z.object({
  serviceType: workloadTypeArg,
  serviceId: serviceIdArg,
});

type LifecycleArgs = z.infer<typeof lifecycleInput>;
type LifecycleRoute = KindRoute<
  unknown,
  typeof lifecycleInput,
  LifecycleAnswer
>;

function requested(
  verb: 'start' | 'stop',
  args: LifecycleArgs,
): LifecycleAnswer {
  const said = verb === 'start' ? 'Start' : 'Stop';
  return {
    serviceType: args.serviceType,
    serviceId: args.serviceId,
    requested: verb,
    message: `${said} requested. Poll get_environment or get_service for this Service's status.`,
  };
}

/** A service whose `start`/`stop` scales, and can return before convergence. */
type Scalable = Pick<EngineService, 'start' | 'stop'>;

/**
 * The routes of one verb: an Application and the six engines scale detached
 * (`--detach`), so the call answers once Swarm has the replica count and the
 * agent polls for the rest. A Compose has no detached form — `docker compose
 * start`/`stop` and `docker stack rm` return when they are done — so it runs
 * as the console's button does, and a stack slower than the dispatcher's
 * deadline answers the deadline's `failed`.
 */
function lifecycleRoutes(
  verb: 'start' | 'stop',
): Record<WorkloadServiceType, LifecycleRoute> {
  const scaled = (
    service: Type<Scalable>,
    controller: Type<unknown>,
    resourceType?: 'database',
  ) =>
    kindRoute(lifecycleInput, {
      twin: { controller, handler: verb },
      target: { service, method: verb },
      ...(resourceType ? { audit: { resourceType, action: verb } } : {}),
      call: async (engine: Scalable, ctx, args) => {
        await engine[verb](ctx, args.serviceId, { detach: true });
        return requested(verb, args);
      },
    });
  return {
    application: scaled(ApplicationsService, ApplicationsController),
    compose: kindRoute(lifecycleInput, {
      twin: { controller: ComposeController, handler: verb },
      target: { service: ComposeService, method: verb },
      audit: { resourceType: 'compose', action: verb },
      call: async (service, ctx, args) => {
        await service[verb](ctx, args.serviceId);
        return requested(verb, args);
      },
    }),
    ...engineRoutes((_type, service, controller) =>
      scaled(service, controller, 'database'),
    ),
  };
}

const lifecycleProjection = row<LifecycleAnswer>({
  fields: ['serviceType', 'serviceId', 'requested', 'message'],
});

const lifecycleRoots = (args: LifecycleArgs) => [serviceRoot(args)];

const NOTHING_TO_START =
  'This Service has nothing on its Server to start: it has not been deployed yet, or what was deployed was removed outside Cloudgate. Deploy it first.';
const NOTHING_TO_STOP =
  'This Service has nothing on its Server to stop: it has not been deployed yet, or what was deployed was removed outside Cloudgate.';
/**
 * A cloud Service's Start or Stop that did not reach ECS or Cloud Run
 * — the cloud refused it, its Cloud account could not sign in as
 * its deploy identity, or nothing of it is in the cloud yet. Ahead of the
 * Server's "nothing to start", which a 409 without this code still means.
 */
const CLOUD_LIFECYCLE_REFUSAL: ErrorEntry = {
  exception: ConflictException,
  code: CLOUD_LIFECYCLE_REFUSED_CODE,
  answer: {
    failed:
      'This Service runs in a Cloud account and its cloud did not take the call: AWS or Google Cloud refused it, the Cloud account could not sign in as its deploy identity, or the Service has not been deployed yet. An operator sees why on the Service and its Cloud account in the console.',
  },
};
/**
 * A redis on ElastiCache's Start or Stop: refused with the
 * console's sentence, since ElastiCache has no stopped state.
 */
const ELASTICACHE_REFUSAL: ErrorEntry = {
  exception: ConflictException,
  code: ELASTICACHE_CANNOT_STOP_CODE,
  answer: { failed: ELASTICACHE_CANNOT_STOP },
};
/** A redis on Memorystore's Start or Stop: the same, in Google's name. */
const MEMORYSTORE_REFUSAL: ErrorEntry = {
  exception: ConflictException,
  code: MEMORYSTORE_CANNOT_STOP_CODE,
  answer: { failed: MEMORYSTORE_CANNOT_STOP },
};
const SWARM_STACK_START =
  'A Compose of the stack type is started by deploying it: call deploy_service instead.';

export const startService = defineTool({
  name: 'start_service',
  title: 'Start a Service',
  description:
    'Starts an Application, a Compose or a database and answers as soon as the start is requested, without waiting for it to be running. Poll get_environment or get_service for its status.',
  kind: 'write',
  input: lifecycleInput,
  permissions: { deployment: ['create'] },
  routedBy: 'serviceType',
  routes: lifecycleRoutes('start'),
  targetId: 'serviceId',
  audit: { resourceType: 'application', action: 'start' },
  projection: lifecycleProjection,
  errors: [
    ...GRANT_REFUSALS,
    CLOUD_LIFECYCLE_REFUSAL,
    ELASTICACHE_REFUSAL,
    MEMORYSTORE_REFUSAL,
    // "There is no Swarm service '<appName>' …" / "There is nothing of
    // '<appName>' on its Server …": both name the Service's appName.
    { exception: ConflictException, answer: { failed: NOTHING_TO_START } },
    { exception: BadRequestException, answer: { failed: SWARM_STACK_START } },
  ],
  maskRoots: lifecycleRoots,
});

export const stopService = defineTool({
  name: 'stop_service',
  title: 'Stop a Service',
  description:
    'Stops an Application, a Compose or a database and answers as soon as the stop is requested, without waiting for it to wind down. Its data, domains and configuration are kept. Poll get_environment or get_service for its status.',
  kind: 'write',
  input: lifecycleInput,
  permissions: { deployment: ['create'] },
  routedBy: 'serviceType',
  routes: lifecycleRoutes('stop'),
  targetId: 'serviceId',
  audit: { resourceType: 'application', action: 'stop' },
  projection: lifecycleProjection,
  errors: [
    ...GRANT_REFUSALS,
    CLOUD_LIFECYCLE_REFUSAL,
    ELASTICACHE_REFUSAL,
    MEMORYSTORE_REFUSAL,
    { exception: ConflictException, answer: { failed: NOTHING_TO_STOP } },
  ],
  maskRoots: lifecycleRoots,
});

// --------------------------------------------------------- cancel_deployment

/** What `cancel_deployment` answers, before its projection. */
export type CancelAnswer = Deployment & {
  serviceType: BuiltServiceType;
  serviceId: string;
};

/**
 * A Service's build, and nothing else's: `cancel` refuses a schedule's or a
 * backup's run with a 400 of its own, which is not what an unknown id
 * answers, so any owner but an Application or a Compose is answered here as
 * an unknown id — the narrowing `read_deployment_log` does. A build of
 * another Organization's Service reaches `cancel`, whose gate refuses it into
 * the same answer.
 */
async function cancelBuild(
  service: DeploymentsService,
  ctx: PermissionCtx,
  args: { deploymentId: string },
): Promise<CancelAnswer> {
  const owner = await buildOwnerOf(service, args.deploymentId);
  const cancelled = await service.cancel(ctx, args.deploymentId);
  return { ...cancelled, ...owner };
}

/**
 * Every 409 `cancel` has — finished already, releasing its image, no longer
 * queued, interrupted — in one sentence, since the error table matches the
 * class and none of them carries a code. `list_deployments` tells which.
 */
const NOT_CANCELLABLE =
  'This Deployment cannot be cancelled now: it has already finished, is releasing its image, or is no longer held in the queue. Poll list_deployments for its status.';

export const cancelDeployment = defineTool({
  name: 'cancel_deployment',
  title: 'Cancel a Deployment',
  description:
    "Cancels an Application's or Compose's Deployment that is queued or still building. One that has finished, or is already releasing its image, cannot be cancelled.",
  kind: 'write',
  input: z.object({
    deploymentId: z
      .string()
      .min(1)
      .describe('A deploymentId from list_deployments or deploy_service'),
  }),
  permissions: { deployment: ['cancel'] },
  twin: { controller: DeploymentsController, handler: 'cancel' },
  target: { service: DeploymentsService, method: 'cancel' },
  call: cancelBuild,
  targetId: 'deploymentId',
  audit: { resourceType: 'deployment', action: 'cancel' },
  projection: row<CancelAnswer>({
    fields: [
      'deploymentId',
      'serviceType',
      'serviceId',
      'status',
      'finishedAt',
    ],
  }),
  errors: [
    ...GRANT_REFUSALS,
    { exception: ConflictException, answer: { failed: NOT_CANCELLABLE } },
  ],
  maskRoots: (args, found) => [
    serviceRoot(found),
    { table: deployment, id: args.deploymentId },
  ],
});

export const WRITE_TOOLS = [
  deployService,
  startService,
  stopService,
  cancelDeployment,
];
