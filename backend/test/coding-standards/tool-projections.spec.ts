import { getTableColumns, is } from 'drizzle-orm';
import { PgTable } from 'drizzle-orm/pg-core';
import * as schema from '../../src/db/schema';
import {
  allowList,
  assertProjection,
  listOf,
  PUBLIC_NAMESAKES,
  row,
  SELF,
} from '../../src/mcp/tool-projection';
import { MCP_TOOLS } from '../../src/mcp/tools';

/**
 * What a tool result may carry, frozen (ADR-0024).
 *
 * A tool returns a declared projection, never its service method's return
 * value, and `ToolRegistry` refuses to boot on a projection that fails
 * `assertProjection`. This file is the other half: every output path every
 * tool can produce is written out below, so a field enters a tool result only
 * through an edit a reviewer reads — and ADR-0024's test for that edit is
 * "does a named step of the agent loop need it", not "is it harmless".
 *
 * The secret-name rule is re-derived here from the schema rather than read
 * from `encryptedColumnNames`, so the boot check and this census are two
 * readings of the schema and not one reading twice.
 */

/** An Incident, open or closed, wherever a tool carries one. */
const INCIDENT = [
  'closeReason',
  'closedAt',
  'durationSeconds',
  'errorRateThresholdId',
  'incidentId',
  'openedAt',
  'openingError',
  'openingErrorRate',
  'openingRequests',
  'source',
  'uptimeCheckId',
  'worstErrorRate',
];
const incidents = (at: string) => INCIDENT.map((key) => `${at}[].${key}`);

/** The Error rate's summed figures, over 24 hours or per Domain. */
const TOTALS = ['errorRate', 'errors', 'requests', 'slow', 'slowShare'];

/** One Requested preview, as get, extend and delete answer it. */
const PREVIEW = [
  'applicationId',
  'branch',
  'createdAt',
  'expired',
  'expiresAt',
  'latestDeploymentId',
  'previewDeploymentId',
  'requestedByYou',
  'status',
  'url',
  'urlNote',
];

/**
 * One plan, as get_plan and request_plan answer it: what it read and what it
 * would do — never who asked, applied or dismissed it, nor the settings
 * fingerprint an Apply checks staleness by. A cloud step's read of its cloud
 * (`cloudRead` since spec S17) is the plan reader's lines, as the console shows
 * them; the deploy a plan was opened for is named by its ids and status.
 */
const PLAN = [
  'appliedAt',
  'branch',
  'commitSha',
  'createdAt',
  'dismissedAt',
  'environmentId',
  'heldBuilds[].applicationId',
  'heldBuilds[].configName',
  'heldBuilds[].deploymentId',
  'heldBuilds[].status',
  'notes[].configName',
  'notes[].kind',
  'notes[].line',
  'notes[].list',
  'notes[].message',
  'notes[].variable',
  'planId',
  'source',
  'status',
  'steps[].action',
  'steps[].cloud.size.name',
  'steps[].cloud.size.pair.notes',
  'steps[].cloud.size.pair.roundedUpFrom',
  'steps[].cloud.size.pair.runsOn',
  'steps[].cloud.size.pair.wording',
  'steps[].cloudAccountId',
  'steps[].cloudRead.adopt[].address',
  'steps[].cloudRead.adopt[].arn',
  'steps[].cloudRead.adopt[].line',
  'steps[].cloudRead.adopt[].resourceType',
  'steps[].cloudRead.counts.adopt',
  'steps[].cloudRead.counts.briefDowntime',
  'steps[].cloudRead.counts.change',
  'steps[].cloudRead.counts.create',
  'steps[].cloudRead.counts.destroy',
  'steps[].cloudRead.counts.drift',
  'steps[].cloudRead.counts.replace',
  'steps[].cloudRead.drift[].address',
  'steps[].cloudRead.drift[].deleted',
  'steps[].cloudRead.drift[].fields[].cloudgate',
  'steps[].cloudRead.drift[].fields[].field',
  'steps[].cloudRead.drift[].fields[].hand',
  'steps[].cloudRead.drift[].line',
  'steps[].cloudRead.drift[].replaceForcing',
  'steps[].cloudRead.drift[].resourceType',
  'steps[].cloudRead.imageOnly',
  'steps[].cloudRead.liveImage',
  'steps[].cloudRead.noState[].address',
  'steps[].cloudRead.noState[].arn',
  'steps[].cloudRead.noState[].line',
  'steps[].cloudRead.raw[].action',
  'steps[].cloudRead.raw[].address',
  'steps[].cloudRead.raw[].briefDowntime',
  'steps[].cloudRead.raw[].drift',
  'steps[].cloudRead.raw[].fields',
  'steps[].cloudRead.raw[].resourceType',
  'steps[].cloudRead.readAt',
  'steps[].cloudRead.reason',
  'steps[].cloudRead.serviceId',
  'steps[].cloudRead.stateId',
  'steps[].cloudRead.status',
  'steps[].cloudRead.summary',
  'steps[].configName',
  'steps[].environmentNetworkId',
  'steps[].fields[].field',
  'steps[].fields[].from',
  'steps[].fields[].to',
  'steps[].kind',
  'steps[].name',
  'steps[].placement.cloudAccountId',
  'steps[].placement.kind',
  'steps[].placement.region',
  'steps[].placement.serverId',
  // A Google network step's private link: `cloud-sql`, no secret.
  'steps[].privateLinks',
  'steps[].region',
  'steps[].serviceId',
  'steps[].serviceType',
  // A Stack VM's plan lines (#1372): machine, disk and price, no secret.
  'steps[].stackVm.dataDiskGb',
  'steps[].stackVm.lines',
  'steps[].stackVm.monthly.diskUsd',
  'steps[].stackVm.monthly.machineUsd',
  'steps[].stackVm.monthly.snapshotsUsd',
  'steps[].stackVm.monthly.totalUsd',
  'steps[].stackVm.region',
  'steps[].stackVm.size.from',
  'steps[].stackVm.size.machine',
  'steps[].stackVm.size.machineType',
  'steps[].stackVm.size.name',
  'steps[].stackVm.snapshotDays',
  'stoppedDeployment.applicationId',
  'stoppedDeployment.configName',
  'stoppedDeployment.deploymentId',
  'stoppedDeployment.status',
  'textHash',
];

const FROZEN_PROJECTIONS: Readonly<Record<string, readonly string[]>> = {
  list_projects: [
    '[].createdAt',
    '[].description',
    '[].environmentCount',
    '[].name',
    '[].projectId',
  ],
  list_environments: [
    '[].createdAt',
    '[].description',
    '[].environmentId',
    '[].name',
    '[].projectId',
  ],
  get_environment: [
    'createdAt',
    'description',
    'environmentId',
    'hasEnv',
    'name',
    'projectId',
    // The key a plan names a Service by, so an Agent reading a plan
    // can tell which Service each step is for.
    'services[].configName',
    'services[].createdAt',
    'services[].description',
    'services[].name',
    // Find the sick Service without reading each one.
    'services[].openIncidents',
    'services[].serviceId',
    'services[].serviceType',
    'services[].status',
  ],
  // Identity and status; a secret only as presence, never a key list
  // or a count; databaseUser and databaseName stay out.
  get_service: [
    // ADR-0024's test (a named step of the agent loop needs it):
    // an Agent writes client code against an AI model's endpoint and
    // confirms a model swap. Never its upstream secret, not even as has*.
    'aiModel.endpoint',
    'aiModel.gpus',
    // Whether a Hugging Face token is set, never the token.
    'aiModel.hasHfToken',
    'aiModel.model',
    'aiModel.runtime',
    'appName',
    // A bucket's real name, which no config writes, and whether its
    // key is set — never the key.
    'bucketName',
    // Where a cloud Service runs; the Cloud account by name only.
    'cloudPlace.cloudAccountId',
    'cloudPlace.cloudAccountName',
    'cloudPlace.region',
    // As get_environment's.
    'configName',
    'createdAt',
    'description',
    'environment.id',
    'environment.name',
    'hasBuildArgs',
    'hasBuildSecrets',
    'hasDatabasePassword',
    'hasEnv',
    'hasKey',
    // The base URL an Agent types into a caller's variable.
    'internalAddress',
    'name',
    // Notice a problem while reading the Service.
    ...incidents('openIncidents'),
    'project.id',
    'project.name',
    'serviceId',
    'serviceType',
    'status',
  ].sort(),
  // Poll a deploy to completion: status and its two times. `logPath` — a
  // path on the build host — stays out. `previewDeploymentId` tells a
  // preview's build from production's in the parent's history, so an Agent
  // polling its preview's redeploy finds that build; null on production's.
  list_deployments: [
    '[].createdAt',
    '[].deploymentId',
    '[].description',
    '[].finishedAt',
    '[].previewDeploymentId',
    '[].startedAt',
    '[].status',
    '[].title',
  ],
  read_deployment_log: [
    'deploymentId',
    'lines',
    'log',
    'serviceId',
    'serviceType',
  ],
  // Where it is served. Middlewares, entrypoints, resolvers and the stored
  // certificate are routing internals no step of the loop reads.
  list_domains: ['[].domainId', '[].host', '[].https', '[].path', '[].port'],
  // Spec story 80: diagnose a Service's health. A check's keyword
  // and header value only as presence; the header name shown. No raw Probe
  // and no 24-hour strip: lastProbe and upShare24h are the reading. The Error
  // rate's 96 chart buckets stay out; its totals and per-Domain figures, or
  // unavailableReason, are what a diagnosis reads.
  get_service_health: [
    'errorRate.available',
    ...TOTALS.map((key) => `errorRate.domains[].${key}`),
    'errorRate.domains[].domainId',
    'errorRate.domains[].host',
    'errorRate.lastCollectedAt',
    'errorRate.since',
    ...TOTALS.map((key) => `errorRate.totals.${key}`),
    'errorRate.unavailableReason',
    'errorRateThreshold.createdAt',
    'errorRateThreshold.enabled',
    'errorRateThreshold.errorRateThresholdId',
    'errorRateThreshold.minRequests',
    'errorRateThreshold.percentage',
    'errorRateThreshold.windowMinutes',
    ...incidents('openIncidents'),
    ...incidents('recentlyClosedIncidents'),
    'serviceId',
    'serviceType',
    'state',
    'uptimeChecks[].createdAt',
    'uptimeChecks[].disabledReason',
    'uptimeChecks[].downAfter',
    'uptimeChecks[].enabled',
    'uptimeChecks[].expectedStatuses',
    'uptimeChecks[].hasHeaderValue',
    'uptimeChecks[].hasKeyword',
    'uptimeChecks[].headerName',
    'uptimeChecks[].intervalSeconds',
    'uptimeChecks[].kind',
    'uptimeChecks[].lastProbe.errorClass',
    'uptimeChecks[].lastProbe.latencyMs',
    'uptimeChecks[].lastProbe.probedAt',
    'uptimeChecks[].lastProbe.verdict',
    'uptimeChecks[].target.domainId',
    'uptimeChecks[].target.host',
    'uptimeChecks[].target.https',
    'uptimeChecks[].target.path',
    'uptimeChecks[].target.url',
    'uptimeChecks[].tcpTarget.address',
    'uptimeChecks[].tcpTarget.host',
    'uptimeChecks[].tcpTarget.port',
    'uptimeChecks[].timeoutSeconds',
    'uptimeChecks[].upShare24h',
    'uptimeChecks[].uptimeCheckId',
  ].sort(),
  // The id to poll, and whether it joined one already queued. The
  // row's `logPath` stays out, as on list_deployments.
  deploy_service: [
    'coalesced',
    'createdAt',
    'deploymentId',
    'message',
    'serviceId',
    'serviceType',
    'status',
    'title',
  ],
  // That it was asked for — never the Service row the method returns, which
  // carries every secret the Service has.
  start_service: ['message', 'requested', 'serviceId', 'serviceType'],
  stop_service: ['message', 'requested', 'serviceId', 'serviceType'],
  cancel_deployment: [
    'deploymentId',
    'finishedAt',
    'serviceId',
    'serviceType',
    'status',
  ],
  // The preview spec's fields: follow, keep and kill a Requested preview. The
  // requester is `requestedByYou`, never its user id; the pull-request fields,
  // the preview's appName and host, and every env value stay out. Create and
  // redeploy add the queued build's id and where to poll it.
  create_preview: [
    'applicationId',
    'branch',
    'createdAt',
    'deploymentId',
    'expired',
    'expiresAt',
    'latestDeploymentId',
    'message',
    'previewDeploymentId',
    'requestedByYou',
    'status',
    'url',
    'urlNote',
  ],
  list_previews: [
    '[].applicationId',
    '[].branch',
    '[].createdAt',
    '[].expired',
    '[].expiresAt',
    '[].latestDeploymentId',
    '[].previewDeploymentId',
    '[].requestedByYou',
    '[].status',
    '[].url',
    '[].urlNote',
  ],
  get_preview: PREVIEW,
  extend_preview: PREVIEW,
  redeploy_preview: [
    'applicationId',
    'branch',
    'createdAt',
    'deploymentId',
    'expired',
    'expiresAt',
    'latestDeploymentId',
    'message',
    'previewDeploymentId',
    'requestedByYou',
    'status',
    'url',
    'urlNote',
  ],
  delete_preview: PREVIEW,
  // `configText` is a Cloudgate-kept config's encrypted text, carried on
  // purpose under ADR-0024's amendment, through the Project's mask.
  // A repository-kept config carries where it is read, never text.
  get_project_config: [
    'location.configText',
    'location.connectionName',
    'location.kind',
    'location.path',
    'location.providerType',
    'location.repository',
    'location.textHash',
    'location.updatedAt',
    'projectId',
  ],
  get_plan: PLAN.map((key) => `plan.${key}`),
  request_plan: PLAN,
};

/**
 * Paths carrying a public value under a name some encrypted column also has.
 * The only right edit is a deletion; adding one means saying why the value is
 * never that column's.
 */
const FROZEN_NAMESAKES = [
  // An AI model's gateway URL, computed; a custom Notification channel's
  // `endpoint` is the encrypted column of that name.
  'get_service aiModel.endpoint',
];

/** Every encrypted-at-rest column's property name, read straight off the schema. */
function secretNames(): Set<string> {
  const names = new Set<string>();
  for (const value of Object.values(schema) as unknown[]) {
    if (!is(value, PgTable)) continue;
    for (const [key, column] of Object.entries(getTableColumns(value))) {
      if (column.columnType === 'PgCustomColumn') names.add(key);
    }
  }
  return names;
}

describe('allowList', () => {
  it('finds the encrypted columns it guards against', () => {
    // A schema walk that found nothing would pass every assertion below.
    expect([...secretNames()]).toEqual(
      expect.arrayContaining([
        'env',
        'buildArgs',
        'buildSecrets',
        'databasePassword',
        'privateKey',
        'password',
      ]),
    );
  });

  it('holds every tool to its frozen allow-list', () => {
    expect(
      Object.fromEntries(
        MCP_TOOLS.map((tool) => [tool.name, allowList(tool.projection)]),
      ),
    ).toEqual(FROZEN_PROJECTIONS);
  });

  it('holds the public namesakes of encrypted columns to a frozen list, each with a reason', () => {
    expect(Object.keys(PUBLIC_NAMESAKES).sort()).toEqual(
      [...FROZEN_NAMESAKES].sort(),
    );
    for (const reason of Object.values(PUBLIC_NAMESAKES)) {
      expect(reason.length).toBeGreaterThan(40);
    }
  });

  it('lets no output path end in the name of an encrypted column, but a frozen public namesake', () => {
    const secrets = secretNames();
    const leaks = MCP_TOOLS.flatMap((tool) =>
      allowList(tool.projection)
        .filter((path) => !FROZEN_NAMESAKES.includes(`${tool.name} ${path}`))
        .filter((path) =>
          secrets.has(
            path
              .split(/[.[\]]+/)
              .filter(Boolean)
              .pop() ?? '',
          ),
        )
        .map((path) => `${tool.name}: ${path}`),
    );
    expect(leaks).toEqual([]);
  });

  it('passes every tool through the boot check against the schema read here', () => {
    const secrets = secretNames();
    for (const tool of MCP_TOOLS) {
      expect(() =>
        assertProjection(tool.name, tool.projection, secrets),
      ).not.toThrow();
    }
  });

  it('refuses at boot a secret carried as a field, under its name or renamed, and a nested Project wider than { id, name }, and allows its presence flag', () => {
    const secrets = secretNames();
    expect(() =>
      assertProjection(
        'probe',
        row<{ env: string }>({ fields: ['env'] }),
        secrets,
      ),
    ).toThrow(/encrypted column/);
    expect(() =>
      assertProjection(
        'probe',
        row<{ env: string }>({ fields: [['variables', 'env']] }),
        secrets,
      ),
    ).toThrow(/encrypted column/);
    expect(() =>
      assertProjection(
        'probe',
        row<{ env: string }>({ presence: { hasEnv: 'env' }, fields: [] }),
        secrets,
      ),
    ).not.toThrow();
    expect(() =>
      assertProjection(
        'probe',
        listOf(
          row<{
            projectId: string;
            projectName: string;
            organizationId: string;
          }>({
            fields: [],
            children: {
              project: [
                SELF,
                row<{
                  projectId: string;
                  projectName: string;
                  organizationId: string;
                }>({
                  fields: [
                    ['id', 'projectId'],
                    ['name', 'projectName'],
                    'organizationId',
                  ],
                }),
              ],
            },
          }),
        ),
        secrets,
      ),
    ).toThrow(/only \{ id, name \}/);
  });

  it('allows a public namesake at its exact path only: the same name elsewhere, or in another tool, is refused at boot', () => {
    const secrets = secretNames();
    expect(secrets.has('endpoint')).toBe(true);
    const nested = row<{ aiModel: unknown }>({
      fields: [],
      children: {
        aiModel: [
          'aiModel',
          row<{ endpoint: string }>({ fields: ['endpoint'] }),
        ],
      },
    });
    expect(() =>
      assertProjection('get_service', nested, secrets),
    ).not.toThrow();
    expect(() => assertProjection('get_environment', nested, secrets)).toThrow(
      /encrypted column/,
    );
    expect(() =>
      assertProjection(
        'get_service',
        row<{ endpoint: string }>({ fields: ['endpoint'] }),
        secrets,
      ),
    ).toThrow(/encrypted column/);
  });
});
