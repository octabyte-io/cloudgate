import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// The metricsConfig a Server's monitoring setup takes. The type discriminator
// is not accepted — setup always writes 'Remote'.
//
// **`token` is optional, and the three cases are distinct** — the same contract
// `admin/dto/admin.dto.ts` states at length for the instance-wide twin, which
// this schema is otherwise member-for-member and refusal-for-refusal identical
// to. It was required here once, and required was the wrong half of a
// disagreement rather than a defensible difference:
//
//   - `endpoints/monitoring.ts` declares **one** `MetricsConfigInput` for both
//     routes, with `token?: string` and the three cases in its docblock, on the
//     stated ground that the two schemas are identical;
//   - `toMetricsConfig` omits the field for any config carrying `hasToken` and
//     no readable value, and the token projection made that shape reachable for
//     a `server` row — the nested `server` on `GET /applications/:id`, `GET
//     /compose/:id` and every database read now projects the token out;
//   - and `monitoring-setup-modal.tsx`'s own footer promises an operator that
//     saving never rotates a token already set, *"either sent back unchanged or
//     — where the console is not shown it — left out of the request entirely"*.
//
// So a required `token` refused with a 400 the exact body the console's shared
// form is written to send, on the one route whose read had just stopped
// carrying the value. `MonitoringService.setupMonitoring` implements the cases:
// **omitted** keeps what is stored, **`''`** clears it (the only way to stop
// collecting, which is why `.default('')` is ruled out — an empty string has to
// stay distinguishable from an absent key), **anything else** sets or rotates.
const metricsConfigSchema = z.object({
  server: z.object({
    refreshRate: z.number().min(2),
    port: z.number().min(1),
    token: z.string().optional(),
    urlCallback: z.url(),
    retentionDays: z.number().min(1),
    cronJob: z.string().min(1),
    thresholds: z.object({
      cpu: z.number().min(0),
      memory: z.number().min(0),
    }),
  }),
  containers: z.object({
    refreshRate: z.number().min(2),
    services: z.object({
      include: z.array(z.string()).optional(),
      exclude: z.array(z.string()).optional(),
    }),
  }),
});

export class SetupMonitoringBodyDto extends createZodDto(
  z.object({ metricsConfig: metricsConfigSchema }),
) {}

export class ServerIdParamsDto extends createZodDto(
  z.object({ serverId: z.string().min(1) }),
) {}

// Query params: limit is '50' by default, 'all' or a number string, with parse
// failures falling back to 50.
//
// start/end are the inclusive RFC3339 bounds of a time window, and stay
// plain strings here on purpose: their shape, their timezone handling and how
// they compose with limit are one decision, made in `parseMetricsRange` so
// that a caller reaching the service directly gets the same refusals as one
// coming over HTTP. Same treatment as `dateRange` below.
const metricsWindow = {
  start: z.string().optional(),
  end: z.string().optional(),
};

/**
 * Which machine the samples come from. Optional, and absent means the web
 * server — the instance's own machine, which has no `server` row and so no id
 * a caller could name. Same `serverId: null` the docker and
 * traefik routes read as "this machine"; still `.min(1)` when it is given, so
 * a caller that meant to name a Server and sent an empty string is refused
 * rather than quietly answered with the web server's samples.
 */
const targetServerId = z.string().min(1).optional();

export class MetricsQueryDto extends createZodDto(
  z.object({
    serverId: targetServerId,
    limit: z.string().optional(),
    ...metricsWindow,
  }),
) {}

/**
 * Container samples are always *one service's* samples — there is no "every
 * container on this host" reading behind this route — so `appName` is required.
 * It was optional, and the service answered a missing one with `[]` and
 * a 200, which made "you did not say which service" indistinguishable from
 * "that service has no samples". The refusal now comes from validation, which
 * is the only place that can name the parameter it is refusing.
 */
export class ContainerMetricsQueryDto extends createZodDto(
  z.object({
    serverId: targetServerId,
    appName: z.string().min(1),
    limit: z.string().optional(),
    ...metricsWindow,
  }),
) {}

const dateRange = z
  .object({ start: z.string().optional(), end: z.string().optional() })
  .optional();

/**
 * The request-rows query: page, sort, search, status and date range, plus
 * the path and service filters.
 *
 * `search` is still one term and still matches `RequestHost` first; it falls
 * back to `RequestPath` and `ServiceName` only when no host matched, so a term
 * that names a host answers exactly what it answered before. `method` is a set
 * of verbs, any of which matches — the same shape as `status`, and it stays a
 * free `string[]` rather than an enum because Traefik logs whatever verb the
 * client sent, including ones no allow-list would have.
 */
export class ReadStatsLogsBodyDto extends createZodDto(
  z.object({
    page: z.object({ pageIndex: z.number(), pageSize: z.number() }).optional(),
    sort: z.object({ id: z.string(), desc: z.boolean() }).optional(),
    search: z.string().optional(),
    status: z.array(z.string()).optional(),
    method: z.array(z.string()).optional(),
    dateRange,
  }),
) {}

export class ReadStatsBodyDto extends createZodDto(z.object({ dateRange })) {}

/** `?status=a&status=b` arrives as an array, a single `?status=a` as a string. */
const queryList = z.preprocess(
  (value): unknown =>
    value === undefined || Array.isArray(value) ? value : [value],
  z.array(z.string()).optional(),
);

/**
 * One read of the Requests page, as a `GET` so a Frozen Organization keeps
 * it (ADR-0052, ADR-0055): the request-rows query above flattened into the
 * address, plus which Access log. `serverId` names a customer Server;
 * absent, it is the platform host's log, which takes instance authority (the
 * same "absent is the platform host" every metrics route reads, ADR-0008).
 * `.min(1)` when given, so an empty string is refused rather than read as
 * the platform host.
 */
const readRequestsQuerySchema = z.object({
  serverId: targetServerId,
  start: z.string().optional(),
  end: z.string().optional(),
  pageIndex: z.coerce.number().int().min(0).optional(),
  pageSize: z.coerce.number().int().min(1).max(500).optional(),
  search: z.string().optional(),
  status: queryList,
  method: queryList,
  /**
   * The Service filter: Service ids, any of which matches, plus
   * `noService=true` for the lines that matched no Domain. Neither given is
   * every line the caller may see. Applied after the split by Service, so an
   * id the caller cannot read, and `noService` without `server: ['read']`,
   * narrow to nothing rather than reveal anything. Ignored on the platform
   * host's read, which is not split by Service.
   */
  serviceId: queryList,
  noService: z.enum(['true', 'false']).optional(),
});

export class ReadRequestsQueryDto extends createZodDto(
  readRequestsQuerySchema,
) {}

/**
 * A Service's Requests tab: the same window and filters, without the
 * Server or the Service filter — the Service is in the path, and its Server
 * is found from it, so the address keeps working wherever the Service runs.
 */
export class ReadServiceRequestsQueryDto extends createZodDto(
  readRequestsQuerySchema.omit({
    serverId: true,
    serviceId: true,
    noService: true,
  }),
) {}

export class ServiceIdParamsDto extends createZodDto(
  z.object({ serviceId: z.string().min(1) }),
) {}
