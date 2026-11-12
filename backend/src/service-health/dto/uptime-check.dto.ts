import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import {
  serviceTypeEnum,
  WORKLOAD_SERVICE_TYPES,
} from '../../applications/application.schema';

/** A status class (`2xx`) or an exact code (`301`). */
const expectedStatusSchema = z
  .string()
  .regex(
    /^(?:[1-5]xx|[1-5]\d\d)$/,
    'an expected status is a class such as 2xx or a code such as 301',
  );

/**
 * The rule an HTTP Uptime check probes by. The bounds are the
 * console's to present; they are here so a stored check can always be
 * probed: an interval under 30 s would make the platform host a load
 * generator, and a timeout longer than the interval would let one check's
 * Probes overlap its own schedule.
 */
const ruleShape = {
  intervalSeconds: z.number().int().min(30).max(3600),
  timeoutSeconds: z.number().int().min(1).max(60),
  expectedStatuses: z
    .array(expectedStatusSchema)
    .min(1, 'at least one expected status is required')
    .max(20),
  downAfter: z.number().int().min(1).max(20),
  enabled: z.boolean(),
};

/**
 * An HTTP header name as Node's `http` will send one (RFC 9110 `token`), and
 * not one that would change what the request *is* rather than what it says:
 * the Host it is routed by, its framing, or its connection.
 */
const RESERVED_HEADERS = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'proxy-connection',
]);
const headerNameSchema = z
  .string()
  .min(1, 'the header name cannot be empty')
  .max(128)
  .regex(
    /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/,
    'a header name is letters, digits and - (such as Authorization)',
  )
  .refine((name) => !RESERVED_HEADERS.has(name.toLowerCase()), {
    message:
      'that header decides how the request is routed or framed, and cannot be set',
  });

/**
 * The header's value: write-only. A tab and printable Latin-1 only,
 * which is what Node's `http` accepts in a header value — never a line break,
 * which would be a second header.
 */
const headerValueSchema = z
  .string()
  .min(1, 'the header value cannot be empty; remove it instead')
  .max(4096)
  .regex(
    /^[\t\x20-\x7e\x80-\xff]+$/,
    'a header value is one line of printable characters',
  );

/** A string the body must contain. */
const keywordSchema = z
  .string()
  .min(1, 'the keyword cannot be empty; clear it instead')
  .max(256);

const portSchema = z.number().int().min(1).max(65535);

/** What only an HTTP check has: a TCP check is refused every one of them. */
export const HTTP_ONLY_FIELDS = [
  'domainId',
  'expectedStatuses',
  'keyword',
  'headerName',
  'headerValue',
] as const;

const timeoutWithinInterval = (rule: {
  intervalSeconds?: number;
  timeoutSeconds?: number;
}) =>
  rule.intervalSeconds === undefined ||
  rule.timeoutSeconds === undefined ||
  rule.timeoutSeconds <= rule.intervalSeconds;

const TIMEOUT_MESSAGE = {
  message: 'the timeout cannot be longer than the interval',
  path: ['timeoutSeconds'],
};

/**
 * `POST /uptime-checks`. The Service is named by `serviceType` + `serviceId`,
 * `mount`'s shape, and the target by one of its own Domains (HTTP) or one of
 * its published TCP ports (TCP) — never a URL or a free address.
 *
 * An HTTP check may require a `keyword` in its body and send one header:
 * `headerName` in plain text, `headerValue` encrypted at rest and never
 * returned. A TCP check has neither, and no expected statuses.
 */
export const createUptimeCheckSchema = z
  .object({
    serviceType: z.enum(WORKLOAD_SERVICE_TYPES),
    serviceId: z.string().min(1, 'serviceId cannot be empty'),
    kind: z.enum(['http', 'tcp']).default('http'),
    domainId: z.string().min(1, 'domainId cannot be empty').optional(),
    port: portSchema.optional(),
    intervalSeconds: ruleShape.intervalSeconds.default(60),
    timeoutSeconds: ruleShape.timeoutSeconds.default(10),
    expectedStatuses: ruleShape.expectedStatuses.optional(),
    downAfter: ruleShape.downAfter.default(3),
    enabled: ruleShape.enabled.default(true),
    keyword: keywordSchema.nullish(),
    headerName: headerNameSchema.nullish(),
    headerValue: headerValueSchema.nullish(),
  })
  .refine(timeoutWithinInterval, TIMEOUT_MESSAGE)
  .superRefine((check, issues) => {
    if (check.kind === 'http') {
      if (check.domainId === undefined) {
        issues.addIssue({
          code: 'custom',
          message: 'an HTTP check is aimed at one of its Service’s Domains',
          path: ['domainId'],
        });
      }
      if (check.port !== undefined) {
        issues.addIssue({
          code: 'custom',
          message: 'an HTTP check is aimed at a Domain, not a port',
          path: ['port'],
        });
      }
      if (check.headerValue && !check.headerName) {
        issues.addIssue({
          code: 'custom',
          message: 'a header value is sent under a header name',
          path: ['headerName'],
        });
      }
      return;
    }
    if (check.port === undefined) {
      issues.addIssue({
        code: 'custom',
        message: 'a TCP check dials one of its Service’s published ports',
        path: ['port'],
      });
    }
    for (const field of HTTP_ONLY_FIELDS) {
      if (check[field] !== undefined && check[field] !== null) {
        issues.addIssue({
          code: 'custom',
          message: `a TCP check has no ${field}; it only connects`,
          path: [field],
        });
      }
    }
  });
export class CreateUptimeCheckDto extends createZodDto(
  createUptimeCheckSchema,
) {}

/**
 * `PATCH /uptime-checks/:uptimeCheckId`. The owner and kind are fixed for a
 * check's life; the target, the rule and `enabled` change. Turning a check off
 * closes its open Incident with `turned-off`; any other edit leaves an open
 * Incident open and the next Probe is judged by the new rule.
 *
 * **The header value is write-only**: a string **replaces** it, `null`
 * **removes** it, and leaving it out keeps it — no read ever answers it, so
 * nothing here can echo it either. `headerName: null` removes the header,
 * value and all; `keyword: null` clears the keyword. Which fields a kind takes
 * is the service's to refuse, since only the stored check knows its kind.
 */
export const updateUptimeCheckSchema = z
  .object({
    domainId: z.string().min(1, 'domainId cannot be empty'),
    port: portSchema,
    ...ruleShape,
    keyword: keywordSchema.nullable(),
    headerName: headerNameSchema.nullable(),
    headerValue: headerValueSchema.nullable(),
  })
  .partial()
  .refine(timeoutWithinInterval, TIMEOUT_MESSAGE);
export class UpdateUptimeCheckDto extends createZodDto(
  updateUptimeCheckSchema,
) {}

/** `GET /uptime-checks?serviceType=&serviceId=`. */
export const listUptimeChecksSchema = z.object({
  serviceType: z.enum(serviceTypeEnum.enumValues),
  serviceId: z.string().min(1, 'serviceId cannot be empty'),
});
export class ListUptimeChecksDto extends createZodDto(listUptimeChecksSchema) {}

/** `GET /uptime-checks/published-ports?serviceType=&serviceId=`. */
export class ListPublishedPortsDto extends createZodDto(
  listUptimeChecksSchema,
) {}
