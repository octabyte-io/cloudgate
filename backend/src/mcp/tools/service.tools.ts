import { PayloadTooLargeException } from '@nestjs/common';
import type { Type } from '@nestjs/common';
import { z } from 'zod';
import { ApplicationsController } from '../../applications/applications.controller';
import { ApplicationsService } from '../../applications/applications.service';
import type { ServiceType } from '../../applications/application.schema';
import type { AiModelRead } from '../../ai-models/ai-model-facet';
import type { CloudPlace } from '../../applications/cloud-place';
import { BucketsController } from '../../buckets/buckets.controller';
import { BucketsService } from '../../buckets/buckets.service';
import { ComposeController } from '../../compose/compose.controller';
import { ComposeService } from '../../compose/compose.service';
import { deployment } from '../../deployments/deployment.schema';
import type { Deployment } from '../../deployments/deployment.schema';
import { withSecretsHidden } from '../../databases/redis/secrets-hidden';
import { DeploymentsController } from '../../deployments/deployments.controller';
import { DeploymentsService } from '../../deployments/deployments.service';
import type { BuiltServiceType } from '../../deployments/deployments.service';
import { DomainsController } from '../../domains/domains.controller';
import { DomainsService } from '../../domains/domains.service';
import type { PermissionCtx } from '../../rbac/permission.service';
import { isMaxBufferExceeded } from '../../remote/remote-exec.service';
import {
  LOG_WINDOW_DEFAULT_LINES,
  LOG_WINDOW_MAX_BYTES,
  LOG_WINDOW_MAX_LINES,
} from '../mcp-limits';
import { ServiceHealthService } from '../../service-health/service-health.service';
import type { IncidentView } from '../../service-health/service-health.service';
import { defineTool, kindRoute, toolJoin } from '../tool-definition';
import type { KindRoute } from '../tool-definition';
import { GRANT_REFUSALS } from '../tool-errors';
import { listOf, row } from '../tool-projection';
import { INCIDENT_PROJECTION } from './health.tools';
import {
  BUILT_TYPES,
  buildOwnerOf,
  engineRoutes,
  serviceIdArg,
  serviceRoot,
  serviceTypeArg,
} from './service-kinds';
import type { EngineService, ServiceFound } from './service-kinds';

/**
 * The read tools for one Service: `get_service` for its status,
 * `list_deployments` to poll a deploy, `read_deployment_log` for a masked
 * window of a Deployment log, and `list_domains` for where it is served. Each takes
 * the `serviceType` and `serviceId` that `get_environment` lists, and each
 * sees exactly what its HTTP twin shows the same member.
 *
 * None of them ever carries a secret (ADR-0024): a Service's secrets
 * come back as `has*` presence flags, and everything else goes through the
 * dispatcher's mask from the Service's row.
 */

// ---------------------------------------------------------------- get_service

/**
 * One kind's `findOne` row, with the three things that are spelled per kind
 * said once: which kind, its id, and its status column (`composeStatus` on a
 * Compose, `applicationStatus` everywhere else). The row itself rides along
 * whole for the presence flags; the projection decides what leaves.
 */
export type ServiceRead = ServiceFound & {
  serviceType: ServiceType;
  serviceId: string;
  status: string;
  project: { projectId: string; name: string };
  env?: string | null;
  buildArgs?: string | null;
  buildSecrets?: string | null;
  databasePassword?: string | null;
  /** Joined on from the Service's health. */
  openIncidents?: IncidentView[];
  /**
   * An AI model's facet with its Application's GPUs and its endpoint on the
   * gateway; absent on every other kind, so `null` once projected.
   */
  aiModel?: AiModelToolRead | null;
  /**
   * Where the other Services on its Server, or of its Environment
   * network on AWS, reach a web-private, to type into a caller's
   * variable; absent or `null` on every other Service.
   */
  internalAddress?: string | null;
  /**
   * Where a cloud Service runs: its Cloud account's id and name and
   * its region; absent or `null` on any other Service.
   */
  cloudPlace?: CloudPlace | null;
  /** A bucket's real name; absent or `null` on any other Service. */
  bucketName?: string | null;
  /** Whether a bucket's key is set; never the key. */
  hasKey?: boolean | null;
};

/** What `get_service` reads of an AI model. */
export type AiModelToolRead = AiModelRead & {
  gpus: number;
  endpoint: string | null;
};

function serviceRead(
  serviceType: ServiceType,
  id: string,
  found: ServiceFound & Partial<ServiceRead>,
  status: string,
): ServiceRead {
  return {
    ...found,
    serviceType,
    serviceId: id,
    status,
    project: found.environment.project,
  };
}

const getServiceInput = z.object({
  serviceType: serviceTypeArg,
  serviceId: serviceIdArg,
});

type GetServiceRoute = KindRoute<unknown, typeof getServiceInput, ServiceRead>;

/**
 * The six engines share `BaseDatabaseService.findOne` and its gate; each
 * engine's service is checked against the shape `get_service` reads where
 * `DATABASE_ENGINES` lists it.
 */
function databaseRoute(
  serviceType: ServiceType,
  service: Type<EngineService>,
  controller: Type<unknown>,
): GetServiceRoute {
  return kindRoute(getServiceInput, {
    twin: {
      controller,
      handler: 'findOne',
      enforcedIn: {
        file: 'src/databases/common/database-service.ts',
        method: 'findOne',
        check: "this.permissions.checkServiceAccess(ctx, databaseId, 'read')",
      },
    },
    target: { service, method: 'findOne' },
    audit: { resourceType: 'database', action: 'read' },
    call: async (engine, ctx, args) => {
      const found = await engine.findOne(ctx, args.serviceId);
      return serviceRead(
        serviceType,
        args.serviceId,
        // A redis on a cloud is never reached with the Server's password, so
        // `hasDatabasePassword` reads false there, as its API answers.
        serviceType === 'redis' ? withSecretsHidden(found) : found,
        found.applicationStatus,
      );
    },
  });
}

export const getService = defineTool({
  name: 'get_service',
  title: 'Get a Service',
  description:
    "Reads one Service's identity and status: its name, appName, Config name, status, Environment and Project, its open Incidents (a failing Uptime check or a breached Error-rate threshold; get_service_health has the rest), and on an AI model its aiModel: runtime, model, gpus, endpoint (the OpenAI-compatible base URL its callers use) and hasHfToken (null on any other Service), and on a Private web service (kind web-private) its internalAddress, the base URL other Services reach it at: http://<appName>:<port> from its Server, or http://<Config name>.cloudgate.internal:<port> from its Environment network on AWS, or its own https://<service>-<project number>.<region>.run.app URL from its Environment network on Google Cloud, once its first deploy has applied (null on any other Service), and on a Service in a Cloud account its cloudPlace: cloudAccountId, cloudAccountName and region (null on any other Service), and on a bucket its bucketName, the real name Cloudgate made, and hasKey (null on any other Service). Secrets are never returned; hasEnv, hasBuildArgs, hasBuildSecrets and hasDatabasePassword say only whether one is set. Poll it to follow a start or stop.",
  kind: 'read',
  input: getServiceInput,
  permissions: { service: ['read'] },
  routedBy: 'serviceType',
  routes: {
    application: kindRoute(getServiceInput, {
      twin: {
        controller: ApplicationsController,
        handler: 'findOne',
        enforcedIn: {
          file: 'src/applications/applications.service.ts',
          method: 'findOne',
          check:
            "this.permissions.checkServiceAccess(ctx, applicationId, 'read')",
        },
      },
      target: { service: ApplicationsService, method: 'findOne' },
      call: async (service, ctx, args) => {
        const found = await service.findOne(ctx, args.serviceId);
        return serviceRead(
          'application',
          args.serviceId,
          {
            ...found,
            // The GPUs an AI model reserves are its Application's.
            aiModel: found.aiModel && { ...found.aiModel, gpus: found.gpus },
          },
          found.applicationStatus,
        );
      },
    }),
    compose: kindRoute(getServiceInput, {
      twin: {
        controller: ComposeController,
        handler: 'findOne',
        enforcedIn: {
          file: 'src/compose/compose.service.ts',
          method: 'findOne',
          check: "this.permissions.checkServiceAccess(ctx, composeId, 'read')",
        },
      },
      target: { service: ComposeService, method: 'findOne' },
      audit: { resourceType: 'compose', action: 'read' },
      call: async (service, ctx, args) => {
        const found = await service.findOne(ctx, args.serviceId);
        return serviceRead(
          'compose',
          args.serviceId,
          found,
          found.composeStatus,
        );
      },
    }),
    ...engineRoutes(databaseRoute),
    // A bucket is read as any Service is: its real name rides along,
    // its key only as `hasKey`, never the key itself.
    bucket: kindRoute(getServiceInput, {
      twin: {
        controller: BucketsController,
        handler: 'findOne',
        enforcedIn: {
          file: 'src/buckets/buckets.service.ts',
          method: 'findOne',
          check: "this.permissions.checkServiceAccess(ctx, bucketId, 'read')",
        },
      },
      target: { service: BucketsService, method: 'findOne' },
      call: async (service, ctx, args) => {
        const found = await service.findOne(ctx, args.serviceId);
        return serviceRead(
          'bucket',
          args.serviceId,
          found,
          found.applicationStatus,
        );
      },
    }),
  },
  // Its open Incidents, under the health summary's own gate.
  join: toolJoin(getServiceInput, {
    target: { service: ServiceHealthService, method: 'openIncidents' },
    call: async (
      service: ServiceHealthService,
      ctx,
      args,
      found: ServiceRead,
    ): Promise<ServiceRead> => ({
      ...found,
      openIncidents: await service.openIncidents(
        ctx,
        args.serviceType,
        args.serviceId,
      ),
    }),
  }),
  targetId: 'serviceId',
  audit: { resourceType: 'application', action: 'read' },
  projection: row<ServiceRead>({
    fields: [
      'serviceType',
      'serviceId',
      'name',
      'appName',
      'configName',
      'description',
      'status',
      'createdAt',
      // What an Agent types into a caller's variable.
      'internalAddress',
      // A bucket's real name, and whether its key is set.
      'bucketName',
      'hasKey',
    ],
    presence: {
      hasEnv: 'env',
      hasBuildArgs: 'buildArgs',
      hasBuildSecrets: 'buildSecrets',
      hasDatabasePassword: 'databasePassword',
    },
    children: {
      environment: [
        'environment',
        row<ServiceFound['environment']>({
          fields: [['id', 'environmentId'], 'name'],
        }),
      ],
      project: [
        'project',
        row<ServiceRead['project']>({ fields: [['id', 'projectId'], 'name'] }),
      ],
      openIncidents: ['openIncidents', listOf(INCIDENT_PROJECTION)],
      // Write client code against an AI model and confirm a
      // model swap. Never its upstream secret, not even as a flag; its
      // Hugging Face token only as `hasHfToken`, read as a flag.
      aiModel: [
        'aiModel',
        row<AiModelToolRead>({
          fields: ['runtime', 'model', 'gpus', 'endpoint', 'hasHfToken'],
        }),
      ],
      // Where a cloud Service runs, without `cloudAccount: read`.
      cloudPlace: [
        'cloudPlace',
        row<CloudPlace>({
          fields: ['cloudAccountId', 'cloudAccountName', 'region'],
        }),
      ],
    },
  }),
  errors: GRANT_REFUSALS,
  maskRoots: (args) => [serviceRoot(args)],
});

// ----------------------------------------------------------- list_deployments

const builtServiceInput = z.object({
  serviceType: z
    .enum(BUILT_TYPES)
    .describe('application or compose; a database has no Deployments'),
  serviceId: serviceIdArg,
});

export const listDeployments = defineTool({
  name: 'list_deployments',
  title: 'List Deployments',
  description:
    "Lists an Application's or Compose's Deployments, newest first, each with its status (pending, running, done, error, cancelled), startedAt and finishedAt. Poll it to follow a deploy to completion, then call read_deployment_log with a deploymentId.",
  kind: 'read',
  input: builtServiceInput,
  permissions: { deployment: ['read'] },
  routedBy: 'serviceType',
  routes: {
    application: kindRoute(builtServiceInput, {
      twin: {
        controller: DeploymentsController,
        handler: 'findAllByApplication',
      },
      target: {
        service: DeploymentsService,
        method: 'findAllByApplicationId',
      },
      call: (service, ctx, args) =>
        service.findAllByApplicationId(ctx, args.serviceId),
    }),
    compose: kindRoute(builtServiceInput, {
      twin: { controller: DeploymentsController, handler: 'findAllByCompose' },
      target: { service: DeploymentsService, method: 'findAllByComposeId' },
      call: (service, ctx, args) =>
        service.findAllByComposeId(ctx, args.serviceId),
    }),
  },
  targetId: 'serviceId',
  audit: { resourceType: 'deployment', action: 'read' },
  projection: listOf(
    row<Deployment>({
      fields: [
        'deploymentId',
        'title',
        'description',
        'status',
        'createdAt',
        'startedAt',
        'finishedAt',
        // The preview a build built, null on production's.
        'previewDeploymentId',
      ],
    }),
  ),
  errors: GRANT_REFUSALS,
  maskRoots: (args) => [serviceRoot(args)],
});

// -------------------------------------------------------- read_deployment_log

/** What `read_deployment_log` answers, before its projection. */
export interface LogWindow {
  deploymentId: string;
  serviceType: BuiltServiceType;
  serviceId: string;
  /** The window applied: the lines asked for, capped. */
  lines: number;
  log: string;
}

const LOG_TOO_LARGE = `This part of the log is larger than ${LOG_WINDOW_MAX_BYTES / (1024 * 1024)} MiB. Ask for fewer lines.`;

/**
 * The log of a Service's build, and nothing else's. `readLogs` answers for
 * every owner a Deployment row can have — a schedule's or a backup's run too —
 * but the tool is for a Service, so any other owner answers here,
 * before `readLogs`, exactly as an unknown id does. A Deployment of another
 * Organization's Service reaches `readLogs` and is refused by its gate, which
 * the error table folds into the same answer.
 */
async function readWindow(
  service: DeploymentsService,
  ctx: PermissionCtx,
  args: { deploymentId: string; lines?: number },
): Promise<LogWindow> {
  const owner = await buildOwnerOf(service, args.deploymentId);
  const lines = Math.min(
    args.lines ?? LOG_WINDOW_DEFAULT_LINES,
    LOG_WINDOW_MAX_LINES,
  );
  try {
    const log = await service.readLogs(ctx, args.deploymentId, lines, {
      maxBuffer: LOG_WINDOW_MAX_BYTES,
    });
    return { deploymentId: args.deploymentId, ...owner, lines, log };
  } catch (error) {
    if (isMaxBufferExceeded(error)) throw new PayloadTooLargeException();
    throw error;
  }
}

export const readDeploymentLog = defineTool({
  name: 'read_deployment_log',
  title: 'Read a Deployment log',
  description: `Reads the last lines of an Application's or Compose's Deployment log: ${LOG_WINDOW_DEFAULT_LINES} unless you ask for another number, and never more than ${LOG_WINDOW_MAX_LINES}. Stored secrets in the log are masked as ••••••. Use it to find why a Deployment failed.`,
  kind: 'read',
  input: z.object({
    deploymentId: z
      .string()
      .min(1)
      .describe('A deploymentId from list_deployments'),
    lines: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        `How many lines from the end: default ${LOG_WINDOW_DEFAULT_LINES}, at most ${LOG_WINDOW_MAX_LINES}`,
      ),
  }),
  permissions: { deployment: ['read'] },
  twin: { controller: DeploymentsController, handler: 'readLogs' },
  target: { service: DeploymentsService, method: 'readLogs' },
  call: readWindow,
  targetId: 'deploymentId',
  audit: { resourceType: 'deployment', action: 'read' },
  projection: row<LogWindow>({
    fields: ['deploymentId', 'serviceType', 'serviceId', 'lines', 'log'],
  }),
  errors: [
    ...GRANT_REFUSALS,
    { exception: PayloadTooLargeException, answer: { failed: LOG_TOO_LARGE } },
  ],
  maskRoots: (args, found) => [
    serviceRoot(found),
    { table: deployment, id: args.deploymentId },
  ],
});

// --------------------------------------------------------------- list_domains

type DomainRead = Awaited<
  ReturnType<DomainsService['byApplicationId']>
>[number];

export const listDomains = defineTool({
  name: 'list_domains',
  title: 'List Domains',
  description:
    "Lists where an Application or Compose is served: each Domain's host, path, whether it is HTTPS, and the container port it routes to.",
  kind: 'read',
  input: builtServiceInput,
  permissions: { domain: ['read'] },
  routedBy: 'serviceType',
  routes: {
    application: kindRoute(builtServiceInput, {
      twin: { controller: DomainsController, handler: 'byApplicationId' },
      target: { service: DomainsService, method: 'byApplicationId' },
      call: (service, ctx, args) =>
        service.byApplicationId(ctx, args.serviceId),
    }),
    compose: kindRoute(builtServiceInput, {
      twin: { controller: DomainsController, handler: 'byComposeId' },
      target: { service: DomainsService, method: 'byComposeId' },
      call: (service, ctx, args) => service.byComposeId(ctx, args.serviceId),
    }),
  },
  targetId: 'serviceId',
  audit: { resourceType: 'domain', action: 'read' },
  projection: listOf(
    row<DomainRead>({
      fields: ['domainId', 'host', 'path', 'https', 'port'],
    }),
  ),
  errors: GRANT_REFUSALS,
  maskRoots: (args) => [serviceRoot(args)],
});

export const SERVICE_TOOLS = [
  getService,
  listDeployments,
  readDeploymentLog,
  listDomains,
];
