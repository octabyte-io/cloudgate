import { z } from 'zod';
import type { WorkloadServiceType } from '../../applications/application.schema';
import { MonitoringController } from '../../monitoring/monitoring.controller';
import { MonitoringService } from '../../monitoring/monitoring.service';
import type {
  ServiceMetricsCpu,
  ServiceMetricsDisk,
  ServiceMetricsMemory,
  ServiceMetricsNetwork,
  ServiceMetricsPoint,
  ServiceMetricsSummary,
} from '../../monitoring/service-metrics-summary';
import {
  METRICS_TREND_MAX_POINTS,
  METRICS_WINDOW_DEFAULT_HOURS,
  METRICS_WINDOW_MAX_HOURS,
} from '../mcp-limits';
import { defineTool, kindRoute } from '../tool-definition';
import type { KindRoute } from '../tool-definition';
import { GRANT_REFUSALS } from '../tool-errors';
import { listOf, row } from '../tool-projection';
import {
  auditOf,
  serviceIdArg,
  serviceRoot,
  WORKLOAD_TYPES,
} from './service-kinds';

/**
 * A granted Service's own container metrics, summarised (ADR-0096): CPU and
 * memory now, on average and at peak, memory against its limit, network and
 * disk totals, and a trend of at most {@link METRICS_TREND_MAX_POINTS}
 * points, over an hour unless asked and {@link METRICS_WINDOW_MAX_HOURS} at
 * most. A Service runs as one or more containers — an Application's
 * replicas, a Compose's services — and every figure is summed across them,
 * collection tick by collection tick.
 *
 * The twin is `GET /monitoring/metrics/containers`, under its
 * `monitoring: ['read']`, which `agentReader` and `agentOperator` hold for
 * this tool alone; the Service's own `service: ['read']` is checked by the
 * service before anything is read. No tool reads a Server's own metrics, the
 * platform host's, or a container that belongs to no Service: this one is
 * addressed by a Service, and that is the bound. A bucket runs no container,
 * so the tool takes no bucket kind.
 *
 * **What never leaves.** Numbers and the window, never a container's name
 * (an include list naming it is a stored secret the mask hides); a Service
 * with no metrics is `available: false` with its `unavailableReason`, never
 * zeros. The Server's or platform host's include and exclude lists, which
 * the twin's refusal can name, stay out.
 */

const getServiceMetricsInput = z.object({
  serviceType: z
    .enum(WORKLOAD_TYPES)
    .describe(
      'The kind of Service, as get_environment lists it; a bucket runs no container',
    ),
  serviceId: serviceIdArg,
  hours: z
    .number()
    .positive()
    .max(METRICS_WINDOW_MAX_HOURS)
    .optional()
    .describe(
      `The window, in hours back from now: ${METRICS_WINDOW_DEFAULT_HOURS} unless given, ${METRICS_WINDOW_MAX_HOURS} at most`,
    ),
});

/**
 * Every kind has the one twin; the tool is routed by kind only so each call's
 * audit row names the Service as `get_service`'s does.
 */
function metricsRoute(
  serviceType: WorkloadServiceType,
): KindRoute<MonitoringService, typeof getServiceMetricsInput> {
  return kindRoute(getServiceMetricsInput, {
    twin: { controller: MonitoringController, handler: 'getContainerMetrics' },
    target: { service: MonitoringService, method: 'summarizeServiceMetrics' },
    audit: auditOf(serviceType),
    call: (service: MonitoringService, ctx, args) =>
      service.summarizeServiceMetrics(ctx, args.serviceType, args.serviceId, {
        hours: args.hours ?? METRICS_WINDOW_DEFAULT_HOURS,
        maxPoints: METRICS_TREND_MAX_POINTS,
      }),
  });
}

export const getServiceMetrics = defineTool({
  name: 'get_service_metrics',
  title: "Get a Service's container metrics",
  description: `Reads one Service's own container metrics over a window (hours back from now, ${METRICS_WINDOW_DEFAULT_HOURS} unless given, ${METRICS_WINDOW_MAX_HOURS} at most): CPU % now, on average and at peak; memory in MiB now, on average and at peak, against its limit, and as a % of it; network received and sent and disk read and written in MB since each container started; and a trend of at most ${METRICS_TREND_MAX_POINTS} points. Every figure is summed across the Service's containers: an Application's replicas, a Compose's services. A Service in a Cloud account, or on a Server or platform host where monitoring is not set up or has stored no sample of it, is available: false with its unavailableReason. Use it to tell whether a crashing Service ran out of memory or CPU. It never reads a Server's own metrics.`,
  kind: 'read',
  input: getServiceMetricsInput,
  permissions: { monitoring: ['read'] },
  routedBy: 'serviceType',
  routes: Object.fromEntries(
    WORKLOAD_TYPES.map((serviceType) => [
      serviceType,
      metricsRoute(serviceType),
    ]),
  ) as Record<
    WorkloadServiceType,
    KindRoute<any, typeof getServiceMetricsInput>
  >,
  targetId: 'serviceId',
  audit: { resourceType: 'application', action: 'read' },
  projection: row<ServiceMetricsSummary>({
    fields: [
      'serviceType',
      'serviceId',
      'available',
      'unavailableReason',
      'windowHours',
      'since',
      'until',
      'samples',
      'lastSampledAt',
    ],
    children: {
      cpu: [
        'cpu',
        row<ServiceMetricsCpu>({
          fields: ['nowPercent', 'averagePercent', 'peakPercent'],
        }),
      ],
      memory: [
        'memory',
        row<ServiceMetricsMemory>({
          fields: [
            'nowMiB',
            'averageMiB',
            'peakMiB',
            'limitMiB',
            'nowPercent',
            'peakPercent',
          ],
        }),
      ],
      network: [
        'network',
        row<ServiceMetricsNetwork>({ fields: ['receivedMB', 'sentMB'] }),
      ],
      disk: [
        'disk',
        row<ServiceMetricsDisk>({ fields: ['readMB', 'writtenMB'] }),
      ],
      trend: [
        'trend',
        listOf(
          row<ServiceMetricsPoint>({
            fields: ['at', 'cpuPercent', 'memoryMiB'],
          }),
        ),
      ],
    },
  }),
  errors: GRANT_REFUSALS,
  maskRoots: (args) => [serviceRoot(args)],
});

export const METRICS_TOOLS = [getServiceMetrics];
