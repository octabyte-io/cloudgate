import {
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  RequestMethod,
} from '@nestjs/common';
import { METHOD_METADATA } from '@nestjs/common/constants';
import { ModuleRef } from '@nestjs/core';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import type {
  AuthInfo,
  CallToolResult,
  McpHttpHandler,
} from '@modelcontextprotocol/server';
import { ALLOWED_WHEN_FROZEN_KEY } from '../cloud/billing/allowed-when-frozen.decorator';
import { FrozenOrganizations } from '../cloud/billing/frozen-organizations.service';
import { elideEncodedPayloads } from '../common/logging/error-payloads';
import { AUDIT_REASON } from '../enterprise/audit-logs/audit-log.schema';
import type {
  AuditAction,
  AuditOutcome,
  AuditReason,
  AuditResourceType,
} from '../enterprise/audit-logs/audit-log.schema';
import { AuditLogService } from '../enterprise/audit-logs/audit-log.service';
import { clip } from '../enterprise/audit-logs/audit-routes';
import { GATEWAY_ONLY_ROLES } from '../rbac/access-control';
import { PermissionService } from '../rbac/permission.service';
import type { PermissionCtx } from '../rbac/permission.service';
import { CLOUDGATE_VERSION } from '../settings/version';
import {
  callFailed,
  deadlineExceeded,
  expiredKey,
  GATEWAY_ONLY,
  INVALID_KEY,
  METHOD_NOT_ALLOWED,
  missingStatement,
  NOT_FOUND_OR_NOT_PERMITTED,
  ORIGIN_REFUSED,
  PERSONAL_KEY,
  rateLimited,
  SUSPENDED,
  UNSUPPORTED_MEDIA_TYPE,
} from './mcp-answers';
import { McpAuthenticator } from './mcp-authenticator';
import type { AgentCaller } from './mcp-authenticator';
import {
  SERVED_REVISIONS,
  TOOL_DEADLINE_MS,
  TOOLS_LIST_TTL_MS,
} from './mcp-limits';
import {
  answer,
  fromWebResponse,
  header,
  JSON_TYPE,
  messagesOf,
  negotiate,
  revisionRefusal,
  serveLegacy,
  toolCallsOf,
} from './mcp-protocol';
import type {
  McpClientInfo,
  McpHttpRequest,
  McpHttpResponse,
  RpcMessage,
  ToolCall,
} from './mcp-protocol';
import { MCP_RATE_BUCKET, MCP_RATE_LIMIT_LISTENER } from './rate-bucket';
import type {
  AgentRateBucket,
  AgentRateLimited,
  AgentRateLimitListener,
} from './rate-bucket';
import { maskValue, SecretMask } from './secret-mask';
import { auditOf, ROW_SCOPED, routeFor } from './tool-definition';
import type { AnyRoute, AnyTool, ToolPermissions } from './tool-definition';
import { answerFor } from './tool-errors';
import { project } from './tool-projection';
import { ToolRegistry } from './tool-registry';

/** What one authenticated request carries into the SDK and back to a tool. */
interface McpCall {
  readonly agent: AgentCaller;
  readonly ip?: string;
  /** The revision the request is served at; self-reported. */
  readonly revision: string | null;
  /** What the client says it is — this request's claim, else the key's last. */
  readonly clientInfo: McpClientInfo | null;
  /** The tools this request's server registers (`tools/list` is role-filtered). */
  readonly tools: readonly AnyTool[];
}

/** The audit vocabulary of a refusal that no tool call names: a connection. */
const CONNECTION = {
  resourceType: 'session',
  action: 'login',
} as const satisfies {
  resourceType: AuditResourceType;
  action: AuditAction;
};

/** Where a request's `McpCall` rides through the SDK to the factory. */
const CALL = 'cloudgate/mcp-call';

const DEADLINE = Symbol('deadline');

const INVALID_TOKEN = {
  ...JSON_TYPE,
  'www-authenticate': 'Bearer error="invalid_token"',
};

/**
 * The MCP endpoint's dispatcher (ADR-0023–0025).
 *
 * **The pipeline, in this order, per request:**
 *
 * 1. `Origin` present → 403 (ADR-0025). Not GET/DELETE/POST → 405.
 * 2. **authenticate** the Bearer key (`McpAuthenticator`) → 401s.
 * 3. **suspension** — the member-deactivation ban → 403 + row.
 * 4. revision — a 2025-era request older than the oldest served → 400 + row;
 *    an unserved 2026-era revision → a row, and straight to the SDK's
 *    400/-32022, spending nothing.
 * 5. for each `tools/call` in the body: **rate bucket** (`MCP_RATE_BUCKET`) →
 *    429 + row, then **permission** (`PermissionService.checkPermission`,
 *    the one check) → 403 + row. Both are HTTP answers, so both run before the
 *    SDK sees the request; a batch is admitted or refused as a whole
 *    ({@link admit}).
 * 6. the SDK: `createMcpHandler` with `legacy: 'reject'` serves 2026-07-28,
 *    and a request `isLegacyRequest` classifies as 2025-era goes to a
 *    per-request `WebStandardStreamableHTTPServerTransport` in JSON mode —
 *    the SDK's own stateless fallback answers SSE, which ADR-0025 rules out.
 * 7. in the tool handler ({@link runTool}): **tool (and its `join`) →
 *    projection → mask → audit**, under {@link TOOL_DEADLINE_MS}.
 *
 * **Every call writes one audit row**, allowed or refused, with the tool's
 * twin's `resourceType`/`action`, `metadata.tool` and `metadata.credential` —
 * a call that never runs included: an unknown tool, invalid arguments, or a
 * call refused with its batch. A refusal that names no tool call (an expired
 * key on `initialize`) is a `session`/`login` row, as is a call to a tool
 * name nothing answers to. An unknown or personal key writes none: there is
 * no Agent to name.
 */
@Injectable()
export class McpDispatcher implements OnModuleDestroy {
  private readonly logger = new Logger(McpDispatcher.name);
  private readonly modern: McpHttpHandler;

  constructor(
    private readonly authenticator: McpAuthenticator,
    private readonly registry: ToolRegistry,
    private readonly permissions: PermissionService,
    private readonly auditLogs: AuditLogService,
    private readonly mask: SecretMask,
    @Inject(MCP_RATE_BUCKET) private readonly bucket: AgentRateBucket,
    @Inject(MCP_RATE_LIMIT_LISTENER)
    private readonly rateLimitListener: AgentRateLimitListener,
    private readonly moduleRef: ModuleRef,
    private readonly frozen: FrozenOrganizations,
  ) {
    this.modern = createMcpHandler(
      (context) => this.serverFor(callOf(context.authInfo)),
      {
        legacy: 'reject',
        responseMode: 'json',
        onerror: (error) => this.logger.debug(`MCP: ${error.message}`),
      },
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.modern.close();
  }

  async handle(request: McpHttpRequest): Promise<McpHttpResponse> {
    if (header(request, 'origin') !== undefined) {
      return answer(403, { code: 'origin_refused', message: ORIGIN_REFUSED });
    }
    if (request.method !== 'POST') {
      return answer(
        405,
        { code: 'method_not_allowed', message: METHOD_NOT_ALLOWED },
        { ...JSON_TYPE, allow: 'POST' },
      );
    }

    const messages = messagesOf(request.body);
    const toolCalls = toolCallsOf(messages);

    // 2. authenticate
    const authentication = await this.authenticator.authenticate(
      header(request, 'authorization'),
    );
    if (authentication.kind === 'invalid') {
      return answer(
        401,
        { code: 'invalid_token', message: INVALID_KEY },
        INVALID_TOKEN,
      );
    }
    if (authentication.kind === 'personal') {
      return answer(
        401,
        { code: 'invalid_token', message: PERSONAL_KEY },
        INVALID_TOKEN,
      );
    }
    const agent = authentication.agent;
    const beforeRevision = {
      agent,
      ip: request.ip,
      revision: null,
      clientInfo: null,
    };
    if (authentication.kind === 'expired') {
      await this.refuseRequest(
        beforeRevision,
        messages,
        toolCalls,
        AUDIT_REASON.credentialExpired,
      );
      const date = authentication.expiredAt.toISOString().slice(0, 10);
      return answer(
        401,
        { code: 'invalid_token', message: expiredKey(date) },
        INVALID_TOKEN,
      );
    }
    await this.authenticator.touch(agent.key.id, null);

    // 3. suspension — before the bucket, so a suspended Agent spends nothing.
    if (agent.suspended) {
      await this.refuseRequest(
        beforeRevision,
        messages,
        toolCalls,
        AUDIT_REASON.suspended,
      );
      return answer(403, {
        code: 'refused',
        reason: AUDIT_REASON.suspended,
        message: SUSPENDED,
      });
    }

    const contentType = header(request, 'content-type') ?? '';
    if (!/^application\/json\b/i.test(contentType)) {
      return answer(415, {
        code: 'unsupported_media_type',
        message: UNSUPPORTED_MEDIA_TYPE,
      });
    }

    // 4. revision
    const { webRequest, legacy, connection } = await negotiate(
      request,
      messages,
    );
    const atRevision = {
      agent,
      ip: request.ip,
      revision: connection.revision,
      clientInfo: connection.client ?? agent.key.lastClient,
    };
    if (connection.refused) {
      await this.refuseRequest(
        atRevision,
        messages,
        toolCalls,
        AUDIT_REASON.unsupportedRevision,
      );
      return revisionRefusal(messages, connection.requested ?? '');
    }
    if (connection.unservedModern) {
      // The SDK answers this one itself, with the spec's 400 and -32022, and
      // runs no tool; the row is ours to write. Straight to it: the bucket
      // and the permission check are for calls that could run, so this one
      // spends nothing and writes no second row.
      await this.refuseRequest(
        atRevision,
        messages,
        toolCalls,
        AUDIT_REASON.unsupportedRevision,
      );
      return this.serve(
        { ...atRevision, tools: this.registry.all() },
        legacy,
        webRequest,
        request.body,
      );
    }
    await this.authenticator.touch(agent.key.id, connection);

    // 5. rate bucket, then permission, for every tool call in the body.
    const refusal = await this.admit(atRevision, toolCalls);
    if (refusal) return refusal;

    // 6. the SDK
    const tools = messages.some((message) => message.method === 'tools/list')
      ? await this.visibleTools(agent.ctx)
      : this.registry.all();
    return this.serve(
      { ...atRevision, tools },
      legacy,
      webRequest,
      request.body,
    );
  }

  /**
   * Admits the body's tool calls, or answers the refusal of the whole
   * request, before any call runs. Every `tools/call` ends with exactly one
   * audit row, and a token is spent only by a call that runs or by the call
   * the refusal names:
   *
   * - **A call naming no tool** is recorded here, `refused`/`unknown-tool`,
   *   and spends nothing; the SDK then answers it ("Tool … not found").
   * - **Arguments the tool's input schema rejects** are recorded here,
   *   `failed`/`invalid-arguments`, and spend nothing; the SDK then answers
   *   its own validation error without running the tool.
   * - **Every other call, in order: the bucket, then permission.** A batch
   *   (2025-03-26) is admitted or refused as a whole, since its answer is one
   *   HTTP status. The first refusal refuses the request: that call gets its
   *   `rate-limit` or `permission` row — and a permission refusal keeps the
   *   token it took, as a lone refused call does, the bucket running first.
   *   Every call admitted before it gets its token back, every call after it
   *   is never asked, and each of them gets a `refused`/`batch-refused` row.
   * - **A Gateway-only role** (`agentCaller`) is refused every tool at
   *   the permission step, row-scoped ones included, with
   *   {@link GATEWAY_ONLY} and no `missing` statement.
   * - Admitted calls run in the SDK, and {@link runTool} writes their rows.
   *
   * The rows are written in the body's order once every call is decided.
   */
  private async admit(
    call: Omit<McpCall, 'tools'>,
    toolCalls: readonly ToolCall[],
  ): Promise<McpHttpResponse | null> {
    const { agent } = call;
    const verdicts: Array<
      | {
          toolCall: ToolCall;
          outcome: 'failed' | 'refused';
          reason: AuditReason;
        }
      | { toolCall: ToolCall; admitted: AnyTool }
    > = [];
    let refusal: McpHttpResponse | null = null;
    let rateLimitedEvent: AgentRateLimited | null = null;
    let gatewayOnly: boolean | undefined;

    for (const toolCall of toolCalls) {
      const tool = this.registry.get(toolCall.name);
      if (!tool) {
        verdicts.push({
          toolCall,
          outcome: 'refused',
          reason: AUDIT_REASON.unknownTool,
        });
        continue;
      }
      if (!tool.input.safeParse(toolCall.args).success) {
        verdicts.push({
          toolCall,
          outcome: 'failed',
          reason: AUDIT_REASON.invalidArguments,
        });
        continue;
      }
      if (refusal) {
        verdicts.push({
          toolCall,
          outcome: 'refused',
          reason: AUDIT_REASON.batchRefused,
        });
        continue;
      }

      const verdict = await this.bucket.take(agent.userId, tool.kind);
      if (!verdict.allowed) {
        verdicts.push({
          toolCall,
          outcome: 'refused',
          reason: AUDIT_REASON.rateLimit,
        });
        rateLimitedEvent = {
          agentUserId: agent.userId,
          organizationId: agent.organizationId,
          keyId: agent.key.id,
          tool: tool.name,
          budget: tool.kind,
          retryAfterSeconds: verdict.retryAfterSeconds,
        };
        refusal = answer(
          429,
          {
            code: 'refused',
            reason: AUDIT_REASON.rateLimit,
            tool: tool.name,
            message: rateLimited(verdict.retryAfterSeconds),
          },
          { ...JSON_TYPE, 'retry-after': String(verdict.retryAfterSeconds) },
        );
        continue;
      }

      gatewayOnly ??= await this.isGatewayOnly(agent.ctx);
      if (gatewayOnly) {
        verdicts.push({
          toolCall,
          outcome: 'refused',
          reason: AUDIT_REASON.permission,
        });
        refusal = answer(403, {
          code: 'refused',
          reason: AUDIT_REASON.permission,
          tool: tool.name,
          message: GATEWAY_ONLY,
        });
        continue;
      }

      const missing = await this.missingStatement(
        agent.ctx,
        this.registry.permissionsOf(tool),
      );
      if (missing) {
        verdicts.push({
          toolCall,
          outcome: 'refused',
          reason: AUDIT_REASON.permission,
        });
        refusal = answer(403, {
          code: 'refused',
          reason: AUDIT_REASON.permission,
          tool: tool.name,
          missing,
          message: missingStatement(missing),
        });
        continue;
      }
      verdicts.push({ toolCall, admitted: tool });
    }

    for (const verdict of verdicts) {
      if ('reason' in verdict) {
        await this.recordCall(call, verdict.toolCall, verdict);
      } else if (refusal) {
        // Admitted before the refusal, and now never run.
        await this.bucket.refund(agent.userId, verdict.admitted.kind);
        await this.recordCall(call, verdict.toolCall, {
          outcome: 'refused',
          reason: AUDIT_REASON.batchRefused,
        });
      }
    }
    // Told after the 429's row is written, as the listener expects.
    if (rateLimitedEvent) this.tellRateLimited(rateLimitedEvent);
    return refusal;
  }

  /** Hands the request to the SDK leg its era names, carrying `call`. */
  private async serve(
    call: McpCall,
    legacy: boolean,
    webRequest: Request,
    body: unknown,
  ): Promise<McpHttpResponse> {
    const authInfo: AuthInfo = {
      token: call.agent.key.id,
      clientId: call.agent.userId,
      scopes: [],
      extra: { [CALL]: call },
    };
    const response = legacy
      ? await serveLegacy(this.serverFor(call), webRequest, body, authInfo)
      : await this.modern.fetch(webRequest, { parsedBody: body, authInfo });
    return fromWebResponse(response);
  }

  /** The per-request server: our revisions, no `listChanged`, a private tools/list hint. */
  private serverFor(call: McpCall): McpServer {
    const server = new McpServer(
      { name: 'cloudgate', version: CLOUDGATE_VERSION },
      {
        supportedProtocolVersions: [...SERVED_REVISIONS],
        capabilities: { tools: { listChanged: false } },
        cacheHints: {
          'tools/list': { ttlMs: TOOLS_LIST_TTL_MS, cacheScope: 'private' },
        },
      },
    );
    for (const tool of call.tools) {
      server.registerTool(
        tool.name,
        {
          title: tool.title,
          description: tool.description,
          inputSchema: tool.input,
          annotations: {
            readOnlyHint: tool.kind === 'read',
            openWorldHint: false,
          },
        },
        (args: Record<string, unknown>) => this.runTool(tool, call, args),
      );
    }
    return server;
  }

  /**
   * tool → projection → mask → audit, under the deadline (ADR-0024,
   * ADR-0025). What comes back is one of: the masked projection, the grant
   * refusal, a declared failure, the deadline, or "The call failed." with the
   * row id — never a thrown message.
   */
  private async runTool(
    tool: AnyTool,
    call: McpCall,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const entry = { tool, args, targetId: targetIdOf(tool, args) };
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<typeof DEADLINE>((resolve) => {
      timer = setTimeout(() => resolve(DEADLINE), TOOL_DEADLINE_MS);
    });
    try {
      const frozen = await this.frozenRefusal(tool, call, args);
      if (frozen) {
        await this.record(call, {
          ...entry,
          outcome: 'refused',
          reason: AUDIT_REASON.frozen,
        });
        return failure('refused', frozen, AUDIT_REASON.frozen);
      }
      const result = await Promise.race([
        this.produce(tool, call, args),
        deadline,
      ]);
      if (result === DEADLINE) {
        const id = await this.record(call, {
          ...entry,
          outcome: 'failed',
          reason: AUDIT_REASON.deadline,
        });
        return failure('failed', deadlineExceeded(id));
      }
      await this.record(call, {
        ...entry,
        outcome: 'succeeded',
        detail: result.detail,
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(result.value) }],
      };
    } catch (error) {
      const declared = answerFor(tool.errors, error);
      if (declared === 'grant') {
        await this.record(call, {
          ...entry,
          outcome: 'refused',
          reason: AUDIT_REASON.grant,
        });
        return failure(
          'refused',
          NOT_FOUND_OR_NOT_PERMITTED,
          AUDIT_REASON.grant,
        );
      }
      const id = await this.record(call, {
        ...entry,
        outcome: 'failed',
        detail: { error: describeError(error) },
      });
      if (declared) return failure('failed', declared.failed);
      this.logger.warn(
        `MCP tool ${tool.name} failed unmapped (audit ${id ?? 'not written'}): ${describeError(error).type}`,
      );
      return failure('failed', callFailed(id));
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The frozen error's sentence when this call writes to a Frozen
   * Organization (ADR-0052), else null: a tool whose HTTP twin is a
   * mutating route answers as that route does under `FrozenGuard` — refused
   * unless the twin carries `@AllowedWhenFrozen`. A read tool is never
   * refused. The endpoint is `@Public()`, so the guard never sees these calls.
   */
  private async frozenRefusal(
    tool: AnyTool,
    call: McpCall,
    args: Record<string, unknown>,
  ): Promise<string | null> {
    const route = routeFor(tool, args);
    if (!route || !writesWhenFrozen(route)) return null;
    try {
      await this.frozen.assertNotFrozen(
        call.agent.ctx.session.activeOrganizationId,
      );
      return null;
    } catch (error) {
      if (error instanceof ForbiddenException) return error.message;
      throw error;
    }
  }

  private async produce(
    tool: AnyTool,
    call: McpCall,
    args: Record<string, unknown>,
  ): Promise<{ value: unknown; detail?: Record<string, unknown> }> {
    // The SDK has validated `args` against the input schema, whose kind enum
    // the registry holds equal to the routes, so a route is always found.
    const route = routeFor(tool, args);
    if (!route) throw new Error(`MCP tool ${tool.name} has no route for args`);
    const service: unknown = this.moduleRef.get(route.target.service, {
      strict: false,
    });
    let raw: unknown = await route.call(service, call.agent.ctx, args);
    if (tool.join) {
      const joined: unknown = this.moduleRef.get(tool.join.target.service, {
        strict: false,
      });
      raw = await tool.join.call(joined, call.agent.ctx, args, raw);
    }
    const projected = project(tool.projection, raw);
    const secrets = await this.mask.secretsFor(tool.maskRoots(args, raw));
    return {
      value: maskValue(projected, secrets),
      detail: tool.auditDetail?.(args, raw),
    };
  }

  /**
   * Hands a 429 to `MCP_RATE_LIMIT_LISTENER` without waiting on it: the
   * answer goes out whatever the listener does, and its failure is logged.
   */
  private tellRateLimited(event: AgentRateLimited): void {
    const failed = (error: unknown) =>
      this.logger.error(
        `Rate-limit listener failed for Agent ${event.agentUserId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    try {
      void Promise.resolve(this.rateLimitListener.rateLimited(event)).catch(
        failed,
      );
    } catch (error) {
      failed(error);
    }
  }

  /**
   * The first `<resource>:<action>` of `declared` the caller's role lacks,
   * by the one check, or `null` when it holds them all.
   */
  private async missingStatement(
    ctx: PermissionCtx,
    declared: ToolPermissions,
  ): Promise<string | null> {
    if (declared === ROW_SCOPED) return null;
    if (await this.holds(ctx, declared)) return null;
    for (const [resource, actions] of Object.entries(declared)) {
      for (const action of actions as string[]) {
        if (!(await this.holds(ctx, { [resource]: [action] }))) {
          return `${resource}:${action}`;
        }
      }
    }
    // Refused as a whole and granted piece by piece cannot both be true of
    // one role; refuse rather than let it through.
    return Object.entries(declared)
      .map(
        ([resource, actions]) =>
          `${resource}:${(actions as string[]).join(',')}`,
      )
      .join(' ');
  }

  private async holds(ctx: PermissionCtx, declared: object): Promise<boolean> {
    try {
      await this.permissions.checkPermission(ctx, declared);
      return true;
    } catch (error) {
      if (error instanceof ForbiddenException) return false;
      throw error;
    }
  }

  /**
   * Whether the caller's role reaches no tool at all. Asked of the role
   * by name rather than of its statements, because a row-scoped tool declares
   * none and would otherwise show to a role holding only `service:call`.
   */
  private async isGatewayOnly(ctx: PermissionCtx): Promise<boolean> {
    const { role } = await this.permissions.findMember(ctx);
    return (GATEWAY_ONLY_ROLES as readonly string[]).includes(role);
  }

  /**
   * The tools the caller's role may call — what `tools/list` shows.
   * None for a Gateway-only role.
   */
  private async visibleTools(ctx: PermissionCtx): Promise<AnyTool[]> {
    if (await this.isGatewayOnly(ctx)) return [];
    const visible: AnyTool[] = [];
    for (const tool of this.registry.all()) {
      const declared = this.registry.permissionsOf(tool);
      if (declared === ROW_SCOPED || (await this.holds(ctx, declared))) {
        visible.push(tool);
      }
    }
    return visible;
  }

  /**
   * One refused row per tool call in the request, or one `session`/`login`
   * row when the request makes no tool call.
   */
  private async refuseRequest(
    call: Omit<McpCall, 'tools'>,
    messages: readonly RpcMessage[],
    toolCalls: readonly ToolCall[],
    reason: AuditReason,
  ): Promise<void> {
    if (toolCalls.length === 0) {
      const methods = messages
        .map((message) => message.method)
        .filter((method): method is string => typeof method === 'string');
      await this.record(call, {
        outcome: 'refused',
        reason,
        detail: { methods },
      });
      return;
    }
    for (const toolCall of toolCalls) {
      await this.recordCall(call, toolCall, { outcome: 'refused', reason });
    }
  }

  /**
   * The row of one `tools/call` that did not run. A name no tool answers to
   * is a `session`/`login` row, since it names no twin, carrying the name it
   * asked for, clipped.
   */
  private async recordCall(
    call: Omit<McpCall, 'tools'>,
    toolCall: ToolCall,
    ending: { outcome: 'failed' | 'refused'; reason: AuditReason },
  ): Promise<void> {
    const tool = this.registry.get(toolCall.name);
    await this.record(call, {
      outcome: ending.outcome,
      reason: ending.reason,
      ...(tool
        ? {
            tool,
            args: toolCall.args,
            targetId: targetIdOf(tool, toolCall.args),
          }
        : { detail: { requestedTool: clip(toolCall.name) } }),
    });
  }

  /**
   * Writes the call's audit row and answers its id. The Agent's name, address
   * and role are resolved by `audit` from its member row, so the row names the
   * Agent and its role tells it from a person.
   */
  private async record(
    call: Omit<McpCall, 'tools'>,
    entry: {
      tool?: AnyTool;
      targetId?: string;
      /** The call's arguments, whose kind picks a routed tool's vocabulary. */
      args?: Record<string, unknown>;
      outcome: AuditOutcome;
      reason?: AuditReason;
      detail?: Record<string, unknown>;
    },
  ): Promise<string | null> {
    const vocabulary = entry.tool
      ? auditOf(entry.tool, entry.args ?? {})
      : CONNECTION;
    return this.auditLogs.audit(
      {
        userId: call.agent.userId,
        organizationId: call.agent.organizationId,
        ip: call.ip,
      },
      {
        resourceType: vocabulary.resourceType,
        action: vocabulary.action,
        resourceId: entry.targetId,
        outcome: entry.outcome,
        metadata: {
          tool: entry.tool?.name ?? null,
          credential: { keyId: call.agent.key.id, start: call.agent.key.start },
          ...(entry.reason ? { reason: entry.reason } : {}),
          ...(call.clientInfo ? { clientInfo: call.clientInfo } : {}),
          ...(call.revision ? { revision: call.revision } : {}),
          ...entry.detail,
        },
      },
    );
  }
}

/** The `McpCall` the dispatcher put on the request's `authInfo`. */
function callOf(authInfo: AuthInfo | undefined): McpCall {
  const call = authInfo?.extra?.[CALL] as McpCall | undefined;
  if (!call) throw new Error('MCP request reached the SDK unauthenticated');
  return call;
}

/** A declared id argument's value, and only that — never a result's id. */
function targetIdOf(
  tool: AnyTool,
  args: Record<string, unknown>,
): string | undefined {
  if (!tool.targetId) return undefined;
  const value = args[tool.targetId];
  return typeof value === 'string' ? value : undefined;
}

/** Methods that cannot change anything; every other twin is a write. */
const READ_METHODS = new Set([RequestMethod.GET, RequestMethod.HEAD]);

/** Whether a route's twin is a write that a Frozen Organization is refused. */
function writesWhenFrozen(route: AnyRoute): boolean {
  const prototype = route.twin.controller.prototype as Record<string, unknown>;
  const handler = prototype[route.twin.handler];
  if (typeof handler !== 'function') return false;
  const verb = Reflect.getMetadata(METHOD_METADATA, handler) as
    RequestMethod | undefined;
  if (verb === undefined || READ_METHODS.has(verb)) return false;
  return !Reflect.getMetadata(ALLOWED_WHEN_FROZEN_KEY, handler);
}

function failure(
  code: 'refused' | 'failed',
  message: string,
  reason?: AuditReason,
): CallToolResult {
  return {
    content: [{ type: 'text', text: message }],
    structuredContent: { code, ...(reason ? { reason } : {}), message },
    isError: true,
  };
}

/** What an unmapped failure's row holds for the console: never the agent's. */
function describeError(error: unknown): { type: string; message: string } {
  const type = error instanceof Error ? error.constructor.name : typeof error;
  const message = error instanceof Error ? error.message : String(error);
  return { type, message: elideEncodedPayloads(message).slice(0, 500) };
}
