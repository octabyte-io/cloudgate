import { z } from 'zod';
import { SERVICE_SOURCES } from '../../environments/environment-services';
import type { EnvironmentServiceSummary } from '../../environments/environment-services';
import { environment } from '../../environments/environment.schema';
import { EnvironmentsController } from '../../environments/environments.controller';
import { EnvironmentsService } from '../../environments/environments.service';
import type {
  EnvironmentWithOpenIncidents,
  EnvironmentWithServices,
} from '../../environments/environments.service';
import { project } from '../../projects/project.schema';
import { ProjectsController } from '../../projects/projects.controller';
import { ProjectsService } from '../../projects/projects.service';
import type { ProjectListRow } from '../../projects/projects.service';
import { defineTool, ROW_SCOPED, toolJoin } from '../tool-definition';
import { GRANT_REFUSALS } from '../tool-errors';
import { listOf, row } from '../tool-projection';

/**
 * The navigation tools: `list_projects` → `list_environments` →
 * `get_environment`, the walk an agent takes to find a Service. Each sees
 * exactly what its HTTP twin shows the same member — the Agent's grant, and
 * nothing else.
 */

type Environment = typeof environment.$inferSelect;

export const listProjects = defineTool({
  name: 'list_projects',
  title: 'List Projects',
  description:
    'Lists the Projects this Agent has been granted, with how many of their Environments it can see. Start here, then call list_environments with a projectId.',
  kind: 'read',
  input: z.object({}),
  permissions: ROW_SCOPED,
  twin: {
    controller: ProjectsController,
    handler: 'list',
    enforcedIn: {
      file: 'src/projects/projects.service.ts',
      method: 'list',
      check: 'this.permissions.findMember(ctx)',
    },
  },
  target: { service: ProjectsService, method: 'list' },
  call: (service, ctx) => service.list(ctx),
  audit: { resourceType: 'project', action: 'read' },
  projection: listOf(
    row<ProjectListRow>({
      fields: [
        'projectId',
        'name',
        'description',
        'createdAt',
        'environmentCount',
      ],
    }),
  ),
  errors: [],
  maskRoots: (_args, rows) =>
    rows.map((found) => ({ table: project, id: found.projectId })),
});

export const listEnvironments = defineTool({
  name: 'list_environments',
  title: 'List Environments',
  description:
    "Lists the Environments of one Project that this Agent has been granted. An unknown Project, or one it was not granted, lists nothing. Call get_environment with an environmentId to see an Environment's Services.",
  kind: 'read',
  input: z.object({
    projectId: z.string().min(1).describe('A projectId from list_projects'),
  }),
  permissions: ROW_SCOPED,
  twin: {
    controller: EnvironmentsController,
    handler: 'listByProject',
    enforcedIn: {
      file: 'src/environments/environments.service.ts',
      method: 'listByProject',
      check: 'this.permissions.findMember(ctx)',
    },
  },
  target: { service: EnvironmentsService, method: 'listByProject' },
  call: (service, ctx, args) => service.listByProject(ctx, args.projectId),
  audit: { resourceType: 'environment', action: 'read' },
  projection: listOf(
    row<Environment>({
      fields: [
        'environmentId',
        'name',
        'description',
        'createdAt',
        'projectId',
      ],
    }),
  ),
  errors: [],
  maskRoots: (_args, rows) =>
    rows.map((found) => ({ table: environment, id: found.environmentId })),
});

const getEnvironmentInput = z.object({
  environmentId: z
    .string()
    .min(1)
    .describe('An environmentId from list_environments'),
});

export const getEnvironment = defineTool({
  name: 'get_environment',
  title: 'Get an Environment',
  description:
    "Reads one Environment and the Services in it that this Agent has been granted: each Service's kind (serviceType), serviceId, name, status and how many Incidents it has open. Poll it to follow a Service's status; call get_service_health on one with open Incidents.",
  kind: 'read',
  input: getEnvironmentInput,
  permissions: { environment: ['read'] },
  twin: {
    controller: EnvironmentsController,
    handler: 'findOne',
    enforcedIn: {
      file: 'src/environments/environments.service.ts',
      method: 'findOwned',
      check:
        "this.permissions.checkEnvironmentAccess(ctx, environmentId, 'read')",
    },
  },
  target: { service: EnvironmentsService, method: 'findOne' },
  call: (service, ctx, args): Promise<EnvironmentWithServices> =>
    service.findOne(ctx, args.environmentId),
  // Each Service's open-Incident count, for the Services it named.
  join: toolJoin(getEnvironmentInput, {
    target: { service: EnvironmentsService, method: 'withOpenIncidents' },
    call: (
      service: EnvironmentsService,
      ctx,
      _args,
      found: EnvironmentWithServices,
    ): Promise<EnvironmentWithServices> =>
      service.withOpenIncidents(ctx, found),
  }),
  targetId: 'environmentId',
  audit: { resourceType: 'environment', action: 'read' },
  projection: row<EnvironmentWithOpenIncidents>({
    fields: ['environmentId', 'name', 'description', 'createdAt', 'projectId'],
    presence: { hasEnv: 'env' },
    children: {
      services: [
        'services',
        listOf(
          row<EnvironmentServiceSummary & { openIncidents: number }>({
            fields: [
              'serviceType',
              'serviceId',
              'name',
              'configName',
              'description',
              'status',
              'createdAt',
              'openIncidents',
            ],
          }),
        ),
      ],
    },
  }),
  errors: GRANT_REFUSALS,
  maskRoots: (args, found) => [
    { table: environment, id: args.environmentId },
    ...found.services.map((service) => ({
      table: SERVICE_SOURCES[service.serviceType].table,
      id: service.serviceId,
    })),
  ],
});

export const NAVIGATION_TOOLS = [
  listProjects,
  listEnvironments,
  getEnvironment,
];
