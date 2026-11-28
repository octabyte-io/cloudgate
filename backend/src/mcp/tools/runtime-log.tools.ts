import {
  BadGatewayException,
  BadRequestException,
  PayloadTooLargeException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { z } from 'zod';
import { RuntimeLogController, RuntimeLogs } from '../../project-config';
import type { RuntimeLogWindow } from '../../project-config';
import { windowText } from '../../project-config/runtime-log/server-runtime-log';
import {
  LOG_WINDOW_DEFAULT_LINES,
  LOG_WINDOW_MAX_BYTES,
  LOG_WINDOW_MAX_LINES,
} from '../mcp-limits';
import { defineTool } from '../tool-definition';
import { GRANT_REFUSALS } from '../tool-errors';
import { row } from '../tool-projection';
import { serviceIdArg, serviceRoot } from './service-kinds';

/**
 * `read_runtime_log`: the last lines an Application or a Compose wrote
 * (ADR-0095), the fourth source ADR-0024 lets a tool return text from. Read
 * only by an Agent whose **Can read runtime logs** switch is on, which the
 * dispatcher checks before the call (`agentSwitch`); a Caller never reaches a
 * tool at all.
 */

/** What `read_runtime_log` answers, before its projection. */
export interface RuntimeLogRead {
  serviceType: RuntimeLogWindow['serviceType'];
  serviceId: string;
  /** The window applied: the lines asked for, capped. */
  lines: number;
  /** The `since` asked for, as given, or null. */
  since: string | null;
  /** `<ISO time> [<copy>] <line>`, a line each, oldest first. */
  log: string;
}

const RUNTIME_LOG_TOO_LARGE = `This part of the Runtime log is larger than ${LOG_WINDOW_MAX_BYTES / (1024 * 1024)} MiB. Ask for fewer lines.`;

const MACHINE_UNREACHABLE =
  'The Server, platform host or Stack VM this Service runs on could not be reached, so its Runtime log could not be read. Try again later, or tell the operator.';

const CLOUD_REFUSED =
  "The Cloud account this Service runs in could not read its Runtime log. The Cloud account's page in the console says why.";

const CLOUD_UNREACHABLE =
  'The cloud this Service runs in could not be reached. Try again later.';

const input = z.object({
  serviceId: serviceIdArg.describe(
    'The serviceId of an Application or a Compose, from get_environment',
  ),
  lines: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      `How many lines from the end: default ${LOG_WINDOW_DEFAULT_LINES}, at most ${LOG_WINDOW_MAX_LINES}`,
    ),
  since: z.iso
    .datetime({ offset: true })
    .optional()
    .describe(
      'Only lines written at or after this time, as an ISO 8601 date-time',
    ),
});

export const readRuntimeLog = defineTool({
  name: 'read_runtime_log',
  title: 'Read a Runtime log',
  description: `Reads the last lines an Application or a Compose itself wrote while running, from every copy it runs, merged by time, each line as "<time> [<copy>] <line>": ${LOG_WINDOW_DEFAULT_LINES} unless you ask for another number, never more than ${LOG_WINDOW_MAX_LINES}, and only those at or after since when you give one. Use it to find why a running Service keeps crashing. Stored secrets in the log are masked as ••••••; anything else the app prints is not. Needs the Agent's Can read runtime logs switch, which an operator turns on.`,
  kind: 'read',
  input,
  permissions: { service: ['read'] },
  agentSwitch: 'canReadRuntimeLogs',
  twin: {
    controller: RuntimeLogController,
    handler: 'read',
    enforcedIn: {
      file: 'src/project-config/runtime-log/runtime-logs.service.ts',
      method: 'window',
      check: "this.permissions.checkServiceAccess(ctx, serviceId, 'read')",
    },
  },
  target: { service: RuntimeLogs, method: 'window' },
  call: async (service: RuntimeLogs, ctx, args): Promise<RuntimeLogRead> => {
    const count = Math.min(
      args.lines ?? LOG_WINDOW_DEFAULT_LINES,
      LOG_WINDOW_MAX_LINES,
    );
    const found = await service.window(ctx, args.serviceId, {
      count,
      ...(args.since === undefined ? {} : { since: Date.parse(args.since) }),
    });
    return {
      serviceType: found.serviceType,
      serviceId: found.serviceId,
      lines: count,
      since: args.since ?? null,
      log: windowText(found.lines),
    };
  },
  targetId: 'serviceId',
  audit: { resourceType: 'application', action: 'read' },
  projection: row<RuntimeLogRead>({
    fields: ['serviceType', 'serviceId', 'lines', 'since', 'log'],
  }),
  errors: [
    ...GRANT_REFUSALS,
    {
      exception: PayloadTooLargeException,
      answer: { failed: RUNTIME_LOG_TOO_LARGE },
    },
    {
      exception: ServiceUnavailableException,
      answer: { failed: MACHINE_UNREACHABLE },
    },
    { exception: BadRequestException, answer: { failed: CLOUD_REFUSED } },
    { exception: BadGatewayException, answer: { failed: CLOUD_UNREACHABLE } },
  ],
  maskRoots: (_args, found) => [serviceRoot(found)],
});

export const RUNTIME_LOG_TOOLS = [readRuntimeLog];
