import { z } from 'zod';
import type { ServiceType } from '../../applications/application.schema';
import type {
  ErrorRateDomain,
  ErrorRateTotals,
} from '../../service-health/error-rate.service';
import type { ErrorRateThresholdView } from '../../service-health/error-rate-thresholds.service';
import { ServiceHealthController } from '../../service-health/service-health.controller';
import { ServiceHealthService } from '../../service-health/service-health.service';
import type {
  IncidentView,
  ProbeView,
  ServiceHealthRead,
  UptimeCheckHealth,
} from '../../service-health/service-health.service';
import type {
  UptimeCheckTarget,
  UptimeCheckTcpTarget,
} from '../../service-health/uptime-checks.service';
import { defineTool, kindRoute } from '../tool-definition';
import type { KindRoute, ToolAudit } from '../tool-definition';
import { GRANT_REFUSALS } from '../tool-errors';
import { listOf, row } from '../tool-projection';
import {
  SERVICE_TYPES,
  serviceIdArg,
  serviceRoot,
  serviceTypeArg,
} from './service-kinds';

/**
 * A Service's health, read and never configured: the Uptime
 * checks, the Error rate, the Error-rate threshold and the Incidents, as the
 * Health tab shows the same member. No tool writes a check or a threshold —
 * `tool-permissions.spec.ts` holds that — so an Agent cannot silence an
 * Incident, and neither agent role gained a statement for it.
 *
 * **What never leaves.** A check's keyword and its header value appear only as
 * `hasKeyword` / `hasHeaderValue`; the header name is shown. A Probe's error
 * class is a closed vocabulary (`timeout`, `status 503`, `keyword missing`…),
 * never a response body, and the raw Probes and the 24-hour strip stay out:
 * `upShare24h` and `lastProbe` are the reading. An Error rate that cannot be
 * read is `available: false` with its `unavailableReason`, never 0 %.
 */

/** An Incident as every health answer carries it, open or closed. */
export const INCIDENT_PROJECTION = row<IncidentView>({
  fields: [
    'incidentId',
    'source',
    'uptimeCheckId',
    'errorRateThresholdId',
    'openedAt',
    'closedAt',
    'durationSeconds',
    'openingError',
    'openingErrorRate',
    'openingRequests',
    'worstErrorRate',
    'closeReason',
  ],
});

const TOTALS: ReadonlyArray<keyof ErrorRateTotals> = [
  'requests',
  'errors',
  'slow',
  'errorRate',
  'slowShare',
];

/** The summary's `errorRate` union, read as one row: absent keys project to null. */
interface ErrorRateRead {
  available: boolean;
  message?: string;
  since?: string;
  lastCollectedAt?: string;
  totals?: ErrorRateTotals;
  domains?: ErrorRateDomain[];
}

const getServiceHealthInput = z.object({
  serviceType: serviceTypeArg,
  serviceId: serviceIdArg,
});

/** The audit vocabulary of each kind, as `get_service` writes it. */
function auditOf(serviceType: ServiceType): ToolAudit {
  const resourceType =
    serviceType === 'application' || serviceType === 'compose'
      ? serviceType
      : 'database';
  return { resourceType, action: 'read' };
}

/**
 * Every kind has the one twin, `GET /service-health/:serviceType/:serviceId`;
 * the tool is routed by kind only so each call's audit row names the Service
 * as `get_service`'s does.
 */
function healthRoute(
  serviceType: ServiceType,
): KindRoute<ServiceHealthService, typeof getServiceHealthInput> {
  return kindRoute(getServiceHealthInput, {
    twin: { controller: ServiceHealthController, handler: 'findOne' },
    target: { service: ServiceHealthService, method: 'forAgent' },
    audit: auditOf(serviceType),
    call: (service: ServiceHealthService, ctx, args) =>
      service.forAgent(ctx, args.serviceType, args.serviceId),
  });
}

export const getServiceHealth = defineTool({
  name: 'get_service_health',
  title: "Get a Service's health",
  description:
    "Reads one Service's health: its Uptime checks (each with its target, rule, last Probe and the share of Probes up over 24 hours), its Error rate over 24 hours or why it is unavailable, its Error-rate threshold, and its open Incidents with the 10 most recently closed. state sums it up: incident, down, pending, up or unchecked. Read-only: no tool changes a check or a threshold.",
  kind: 'read',
  input: getServiceHealthInput,
  permissions: { service: ['read'] },
  routedBy: 'serviceType',
  routes: Object.fromEntries(
    SERVICE_TYPES.map((serviceType) => [serviceType, healthRoute(serviceType)]),
  ) as Record<ServiceType, KindRoute<any, typeof getServiceHealthInput>>,
  targetId: 'serviceId',
  audit: { resourceType: 'application', action: 'read' },
  projection: row<ServiceHealthRead>({
    fields: ['serviceType', 'serviceId', 'state'],
    children: {
      uptimeChecks: [
        'uptimeChecks',
        listOf(
          row<UptimeCheckHealth>({
            fields: [
              'uptimeCheckId',
              'kind',
              'enabled',
              'disabledReason',
              'intervalSeconds',
              'timeoutSeconds',
              'expectedStatuses',
              'downAfter',
              'headerName',
              'upShare24h',
              'createdAt',
            ],
            presence: {
              hasKeyword: 'keyword',
              hasHeaderValue: 'hasHeaderValue',
            },
            children: {
              target: [
                'target',
                row<UptimeCheckTarget>({
                  fields: ['domainId', 'host', 'path', 'https', 'url'],
                }),
              ],
              tcpTarget: [
                'tcpTarget',
                row<UptimeCheckTcpTarget>({
                  fields: ['host', 'port', 'address'],
                }),
              ],
              lastProbe: [
                'lastProbe',
                row<ProbeView>({
                  fields: ['probedAt', 'verdict', 'latencyMs', 'errorClass'],
                }),
              ],
            },
          }),
        ),
      ],
      errorRate: [
        'errorRate',
        row<ErrorRateRead>({
          fields: [
            'available',
            ['unavailableReason', 'message'],
            'since',
            'lastCollectedAt',
          ],
          children: {
            totals: ['totals', row<ErrorRateTotals>({ fields: TOTALS })],
            domains: [
              'domains',
              listOf(
                row<ErrorRateDomain>({
                  fields: ['domainId', 'host', ...TOTALS],
                }),
              ),
            ],
          },
        }),
      ],
      errorRateThreshold: [
        'errorRateThreshold',
        row<ErrorRateThresholdView>({
          fields: [
            'errorRateThresholdId',
            'percentage',
            'windowMinutes',
            'minRequests',
            'enabled',
            'createdAt',
          ],
        }),
      ],
      openIncidents: ['openIncidents', listOf(INCIDENT_PROJECTION)],
      recentlyClosedIncidents: [
        'recentlyClosedIncidents',
        listOf(INCIDENT_PROJECTION),
      ],
    },
  }),
  errors: GRANT_REFUSALS,
  maskRoots: (args) => [serviceRoot(args)],
});

export const HEALTH_TOOLS = [getServiceHealth];
