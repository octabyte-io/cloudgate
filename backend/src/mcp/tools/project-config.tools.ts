import { HttpException } from '@nestjs/common';
import { z } from 'zod';
import { SERVICE_SOURCES } from '../../environments/environment-services';
import { environment } from '../../environments/environment.schema';
import { project } from '../../projects/project.schema';
import {
  CONFIG_UNREADABLE_CODE,
  PLAN_REFUSED_CODE,
  PlansController,
  PROJECT_CONFIG_MISSING_CODE,
  ProjectConfigService,
  ProjectConfigsController,
  isNetworkStep,
} from '../../project-config';
import type {
  CloudRead,
  CloudWebCreate,
  DeployTarget,
  FieldDiff,
  HeldBuild,
  StoppedDeployment,
  PlanNote,
  PlanStep,
  PlanView,
  ProjectConfigView,
  SizePair,
  StackVmCreate,
} from '../../project-config';
import type { StackVmMonthly } from '../../cloud-accounts/definitions/stack-vm';
import type {
  AdoptLine,
  DriftEntry,
  DriftField,
  PlanCounts,
  NoStateNote,
  RawLine,
} from '../../cloud-accounts/aws/plan-reader/read-plan';
import type { SecretRoot } from '../secret-mask';
import { defineTool, ROW_SCOPED } from '../tool-definition';
import { GRANT_REFUSALS } from '../tool-errors';
import type { ErrorTable } from '../tool-errors';
import { listOf, row } from '../tool-projection';

/**
 * The Project config tools (spec US70): an Agent reads a Project's
 * config and an Environment's plan, and asks for a plan, so it can tell an
 * operator what would change — and it never applies one. **There is no apply
 * tool, and that is a standing prohibition, not an absence**: applying
 * writes Services, and no agent role holds a Service write
 * (`test/rbac/agent-roles.e2e-spec.ts`), so an apply tool could not be twinned
 * under a statement an Agent holds. `test/mcp/mcp-project-config.e2e-spec.ts`
 * pins that none is listed.
 */

// ------------------------------------------------------- get_project_config

/** Every key of any member of a union. */
type KeysOfUnion<T> = T extends unknown ? keyof T : never;

/**
 * Every field any member carries, so one projection covers a union: a field
 * a step's action (or a note's kind) lacks answers `null`.
 */
type AnyOf<T> = { readonly [K in KeysOfUnion<T>]?: unknown };

/**
 * Where the config is kept, as `get_project_config` answers it.
 *
 * **The text, deliberately (ADR-0024, as amended).** A Cloudgate-kept
 * config's text is `encryptedText` (ADR-0015: YAML comments can carry
 * anything), and a projection may not copy an encrypted column under its own
 * name. The spec's answer is that an Agent reads the config (US70): it
 * names Services and variable *names*, never a value, and it is what the
 * Agent explains a plan against. So the text leaves under `configText`, the
 * one field the amendment allows, through the mask of every secret stored on
 * the Project — and what an operator types into a comment beyond that is the
 * stated limit, as a build's own output is for `read_deployment_log`.
 *
 * **A repository-kept config** is a repository and a path, read per
 * Environment from its Config branch — never a copy of the text ("no
 * fallback copy"), so it has no `configText`. Which commit an Environment's
 * plan read is on the plan (`get_plan`'s `commitSha`, `branch`). `answerOf`
 * is the one place a view becomes an answer.
 */
export type ConfigLocationAnswer =
  | {
      readonly kind: 'cloudgate';
      readonly configText: string;
      readonly textHash: string;
      readonly updatedAt: string;
    }
  | {
      readonly kind: 'repository';
      readonly providerType: string | null;
      readonly connectionName: string | null;
      readonly repository: string;
      readonly path: string;
      readonly updatedAt: string;
    };

export interface ProjectConfigAnswer {
  readonly projectId: string;
  /** `null` for a Project made before configs existed. */
  readonly location: ConfigLocationAnswer | null;
}

function answerOf(view: ProjectConfigView): ProjectConfigAnswer {
  const { location } = view;
  if (location === null) return { projectId: view.projectId, location: null };
  if (location.kind === 'repository') {
    return {
      projectId: view.projectId,
      location: {
        kind: 'repository',
        providerType: location.providerType,
        connectionName: location.connectionName,
        repository: location.repository,
        path: location.path,
        updatedAt: location.updatedAt,
      },
    };
  }
  return {
    projectId: view.projectId,
    location: {
      kind: location.kind,
      configText: location.text,
      textHash: location.textHash,
      updatedAt: location.updatedAt,
    },
  };
}

export const getProjectConfig = defineTool({
  name: 'get_project_config',
  title: 'Get a Project config',
  description:
    "Reads one Project's config: the YAML that says which Services each of its Environments runs, keyed by Config name, as the Project keeps it. Read it to explain a plan; get_plan shows what applying it would change in an Environment. Stored secret values are masked.",
  kind: 'read',
  input: z.object({
    projectId: z.string().min(1).describe('A projectId from list_projects'),
  }),
  // A Project is read on its entitlement alone: there is no `project: read`
  // statement, as for `list_projects`.
  permissions: ROW_SCOPED,
  twin: {
    controller: ProjectConfigsController,
    handler: 'findOne',
    enforcedIn: {
      file: 'src/project-config/project-config.service.ts',
      // findConfig reaches the check through its findProject helper.
      method: 'findProject',
      check: "this.permissions.checkProjectAccess(ctx, 'read', projectId)",
    },
  },
  target: { service: ProjectConfigService, method: 'findConfig' },
  call: async (service, ctx, args): Promise<ProjectConfigAnswer> =>
    answerOf(await service.findConfig(ctx, args.projectId)),
  targetId: 'projectId',
  audit: { resourceType: 'project', action: 'read' },
  projection: row<ProjectConfigAnswer>({
    fields: ['projectId'],
    children: {
      location: [
        'location',
        row<AnyOf<ConfigLocationAnswer>>({
          fields: [
            'kind',
            'configText',
            'textHash',
            'providerType',
            'connectionName',
            'repository',
            'path',
            'updatedAt',
          ],
        }),
      ],
    },
  }),
  errors: GRANT_REFUSALS,
  maskRoots: (args) => [{ table: project, id: args.projectId }],
});

// ------------------------------------------------- get_plan, request_plan

/**
 * A plan as both tools answer it. What it read (`textHash`, matching
 * `get_project_config`'s, and for a repository-kept config the `commitSha`
 * and `branch` it was read at) and what it would do, never who: the requester's,
 * applier's and dismisser's user ids stay in the console, and the settings
 * fingerprint is an Apply's staleness check, not something to explain.
 *
 * The service answers a `PlanView`, which never carries the plan's
 * own `text` (an edited YAML, `encryptedText`): an Agent reads the stored
 * text through `get_project_config`. `baseTextHash` is the Apply's
 * stored-text staleness check, as the fingerprint is, and `results` is what
 * an operator's Apply did, shown on the Config page; neither is a step of
 * explaining what applying would change, so neither is projected.
 *
 * `heldBuilds` are the builds a push held for this plan: an Agent
 * explaining why a build has not started needs which Deployment, which
 * Application (and its Config name) and whether it is still held — not the
 * commit message or description a push wrote, which `list_deployments`
 * answers on the Deployment's own grant.
 *
 * `stoppedDeployment` is the cloud deploy this plan was opened for,
 * when one stopped on more than its new image: which Deployment and which
 * Service's step, so an Agent can say why its redeploy did not go out.
 *
 * A cloud step carries its read of the cloud (`cloudRead`, spec
 * S17) as the plan reader made it: the plain summary, the raw cloud lines,
 * drift, adopt and "in no state" lines, the same as the console shows, and on a Service that exists the live
 * image it was read with. A `network-change` step is the Environment
 * network read for Drift by "Check for changes", or, with `privateLinks`, a
 * Google network gaining its databases' private link, which a
 * `network-create` names too. Values a mask marks sensitive never reach
 * the reader's output, so none reaches an Agent.
 */
const CLOUD_READ = row<AnyOf<CloudRead>>({
  fields: [
    'status',
    'reason',
    'summary',
    'imageOnly',
    'stateId',
    'serviceId',
    'liveImage',
    'readAt',
  ],
  children: {
    counts: [
      'counts',
      row<PlanCounts>({
        fields: [
          'create',
          'change',
          'destroy',
          'replace',
          'drift',
          'adopt',
          'briefDowntime',
        ],
      }),
    ],
    raw: [
      'raw',
      listOf(
        row<RawLine>({
          fields: [
            'address',
            'resourceType',
            'action',
            'fields',
            'briefDowntime',
            'drift',
          ],
        }),
      ),
    ],
    drift: [
      'drift',
      listOf(
        row<DriftEntry>({
          fields: [
            'address',
            'resourceType',
            'line',
            'deleted',
            'replaceForcing',
          ],
          children: {
            fields: [
              'fields',
              listOf(
                row<DriftField>({ fields: ['field', 'hand', 'cloudgate'] }),
              ),
            ],
          },
        }),
      ),
    ],
    adopt: [
      'adopt',
      listOf(
        row<AdoptLine>({
          fields: ['address', 'resourceType', 'arn', 'line'],
        }),
      ),
    ],
    noState: [
      'noState',
      listOf(row<NoStateNote>({ fields: ['arn', 'address', 'line'] })),
    ],
  },
});

const PLAN = row<PlanView>({
  fields: [
    'planId',
    'environmentId',
    'source',
    'status',
    'textHash',
    'commitSha',
    'branch',
    'createdAt',
    'appliedAt',
    'dismissedAt',
  ],
  children: {
    steps: [
      'steps',
      listOf(
        row<AnyOf<PlanStep>>({
          fields: [
            'action',
            'configName',
            'kind',
            'serviceType',
            'serviceId',
            'name',
            'environmentNetworkId',
            'cloudAccountId',
            'region',
            'privateLinks',
          ],
          children: {
            placement: [
              'placement',
              row<AnyOf<DeployTarget>>({
                fields: ['kind', 'serverId', 'cloudAccountId', 'region'],
              }),
            ],
            cloud: [
              'cloud',
              row<CloudWebCreate>({
                fields: [],
                children: {
                  size: [
                    'size',
                    row<CloudWebCreate['size']>({
                      fields: ['name'],
                      children: {
                        pair: [
                          'pair',
                          row<SizePair>({
                            fields: [
                              'runsOn',
                              'wording',
                              'roundedUpFrom',
                              'notes',
                            ],
                          }),
                        ],
                      },
                    }),
                  ],
                },
              }),
            ],
            // A Compose stack's Stack VM (ADR-0070): its machine, disk,
            // price and lines, which an Agent may read and explain but
            // never apply (#1372).
            stackVm: [
              'stackVm',
              row<StackVmCreate>({
                fields: ['region', 'dataDiskGb', 'snapshotDays', 'lines'],
                children: {
                  size: [
                    'size',
                    row<StackVmCreate['size']>({
                      fields: ['name', 'from', 'machineType', 'machine'],
                    }),
                  ],
                  monthly: [
                    'monthly',
                    row<StackVmMonthly>({
                      fields: [
                        'machineUsd',
                        'diskUsd',
                        'snapshotsUsd',
                        'totalUsd',
                      ],
                    }),
                  ],
                },
              }),
            ],
            cloudRead: ['cloudRead', CLOUD_READ],
            fields: [
              'fields',
              listOf(row<FieldDiff>({ fields: ['field', 'from', 'to'] })),
            ],
          },
        }),
      ),
    ],
    notes: [
      'notes',
      listOf(
        row<AnyOf<PlanNote>>({
          fields: ['kind', 'configName', 'list', 'variable', 'line', 'message'],
        }),
      ),
    ],
    heldBuilds: [
      'heldBuilds',
      listOf(
        row<HeldBuild>({
          fields: ['deploymentId', 'applicationId', 'configName', 'status'],
        }),
      ),
    ],
    stoppedDeployment: [
      'stoppedDeployment',
      row<StoppedDeployment>({
        fields: ['deploymentId', 'applicationId', 'configName', 'status'],
      }),
    ],
  },
});

/**
 * The Environment, and each Service a step changes or destroys: a step's
 * `from` is that Service's saved value, so its secrets are masked too.
 */
function planRoots(
  environmentId: string,
  found: PlanView | null,
): SecretRoot[] {
  return [
    { table: environment, id: environmentId },
    ...(found?.steps ?? []).flatMap((step) =>
      step.action === 'create' || isNetworkStep(step)
        ? []
        : [
            {
              table: SERVICE_SOURCES[step.serviceType].table,
              id: step.serviceId,
            },
          ],
    ),
  ];
}

const planInput = z.object({
  environmentId: z
    .string()
    .min(1)
    .describe('An environmentId from list_environments'),
});

export const getPlan = defineTool({
  name: 'get_plan',
  title: "Get an Environment's plan",
  description:
    "Reads an Environment's plan: what applying its Project's config would create, change and destroy there, field by field, and notes such as a variable with no value. Answers the open plan, else the latest, else plan: null. An operator applies or dismisses a plan in the console; an Agent cannot. Call request_plan for a fresh one.",
  kind: 'read',
  input: planInput,
  permissions: { environment: ['read'] },
  twin: { controller: PlansController, handler: 'findOne' },
  target: { service: ProjectConfigService, method: 'findPlan' },
  call: (service, ctx, args): Promise<{ plan: PlanView | null }> =>
    service.findPlan(ctx, args.environmentId),
  targetId: 'environmentId',
  audit: { resourceType: 'environment', action: 'read' },
  projection: row<{ plan: PlanView | null }>({
    fields: [],
    children: { plan: ['plan', PLAN] },
  }),
  errors: GRANT_REFUSALS,
  maskRoots: (args, found) => planRoots(args.environmentId, found.plan),
});

/**
 * Why a plan could not be made, in the tool's own words (ADR-0024): the
 * refusal's places are the operator's to read on the Config page, where they
 * point into the text.
 */
const PLAN_REFUSALS: ErrorTable = [
  {
    exception: HttpException,
    code: PLAN_REFUSED_CODE,
    answer: {
      failed:
        "The Project config cannot be planned as it stands. An operator sees where on the Project's Config page; ask them to fix it, then ask for a plan again.",
    },
  },
  {
    // A repository-kept config's file the plan could not read: the
    // console's refusal names the repository and branch; the Agent is told
    // where an operator sees them (US71).
    exception: HttpException,
    code: CONFIG_UNREADABLE_CODE,
    answer: {
      failed:
        "The Project config cannot be read from its repository, so no plan was made. An operator sees which repository and branch on the Project's Config page; ask them to fix the connection or the branch, then ask for a plan again.",
    },
  },
  {
    exception: HttpException,
    code: PROJECT_CONFIG_MISSING_CODE,
    answer: {
      failed:
        'This Project has no Project config yet, so there is nothing to plan. An operator gives it one in the console.',
    },
  },
];

export const requestPlan = defineTool({
  name: 'request_plan',
  title: 'Ask for a plan',
  description:
    "Asks for a fresh plan of an Environment — the console's Check for changes — comparing its Project's config with what the Environment has saved, and answers it. A plan with steps becomes the Environment's open plan, replacing the one before; one with none answers status: unchanged. It changes no Service: only an operator applies a plan.",
  // It stores a plan and supersedes the open one, so it spends the write
  // budget and is not annotated read-only, though its statement is a read's.
  kind: 'write',
  input: planInput,
  permissions: { environment: ['read'] },
  twin: { controller: PlansController, handler: 'create' },
  target: { service: ProjectConfigService, method: 'requestPlan' },
  call: (service, ctx, args): Promise<PlanView> =>
    service.requestPlan(ctx, args.environmentId),
  targetId: 'environmentId',
  audit: { resourceType: 'environment', action: 'create' },
  projection: PLAN,
  errors: [...GRANT_REFUSALS, ...PLAN_REFUSALS],
  maskRoots: (args, made) => planRoots(args.environmentId, made),
});

export const PROJECT_CONFIG_TOOLS = [getProjectConfig, getPlan, requestPlan];
