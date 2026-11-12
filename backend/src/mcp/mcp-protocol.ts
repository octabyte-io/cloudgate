import {
  isLegacyRequest,
  WebStandardStreamableHTTPServerTransport,
} from '@modelcontextprotocol/server';
import type { AuthInfo, McpServer } from '@modelcontextprotocol/server';
import { unsupportedRevision } from './mcp-answers';
import {
  LEGACY_REVISIONS,
  MODERN_REVISIONS,
  OLDEST_SERVED_REVISION,
  SERVED_REVISIONS,
  UNDECLARED_LEGACY_REVISION,
} from './mcp-limits';

/**
 * The MCP endpoint's wire (ADR-0025): the HTTP request and answer
 * the controller trades with the dispatcher, the JSON-RPC messages in a body,
 * which era a request speaks and at what revision, and the hand-off to and
 * from the SDK's web-standard transports. Nothing here authenticates, checks
 * a permission or writes a row — that is `McpDispatcher`'s.
 */

/** One HTTP request to `/mcp`, as the controller hands it over. */
export interface McpHttpRequest {
  readonly method: string;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  /** Express's parsed JSON body. */
  readonly body: unknown;
  readonly ip?: string;
}

/** The whole answer, which the controller writes as-is. */
export interface McpHttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/**
 * What an MCP client says it is — on `initialize` in the 2025 era, in each
 * request's `_meta` in 2026. Self-reported: recorded, never decided on.
 */
export interface McpClientInfo {
  readonly name: string | null;
  readonly version: string | null;
}

export interface RpcMessage {
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: Record<string, unknown>;
}

/** One `tools/call` in a body: the name it asks for and its arguments. */
export interface ToolCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

/** What the request says about its revision and client. */
export interface Connection {
  /** The revision the request is served at; self-reported. */
  readonly revision: string | null;
  /** The revision it asked for. */
  readonly requested: string | null;
  /** Present when this request said who it is. */
  readonly client?: McpClientInfo;
  /** Ours to refuse: a 2025-era revision older than the oldest served. */
  readonly refused: boolean;
  /** The SDK refuses it (-32022); the dispatcher writes the row. */
  readonly unservedModern: boolean;
}

const PROTOCOL_VERSION_META = 'io.modelcontextprotocol/protocolVersion';
const CLIENT_INFO_META = 'io.modelcontextprotocol/clientInfo';

export const JSON_TYPE = { 'content-type': 'application/json' };

export function answer(
  status: number,
  body: unknown,
  headers: Record<string, string> = JSON_TYPE,
): McpHttpResponse {
  return { status, headers, body: JSON.stringify(body) };
}

export function header(
  request: McpHttpRequest,
  name: string,
): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export function messagesOf(body: unknown): RpcMessage[] {
  const all = Array.isArray(body) ? (body as unknown[]) : [body];
  return all.filter(
    (entry): entry is RpcMessage => typeof entry === 'object' && entry !== null,
  );
}

export function toolCallsOf(messages: readonly RpcMessage[]): ToolCall[] {
  return messages
    .filter((message) => message.method === 'tools/call')
    .map((message) => ({
      name: typeof message.params?.name === 'string' ? message.params.name : '',
      args:
        typeof message.params?.arguments === 'object' &&
        message.params.arguments !== null
          ? (message.params.arguments as Record<string, unknown>)
          : {},
    }));
}

/** Whether `revision` is a 2025-era revision still served. */
export function isServedLegacyRevision(revision: string): boolean {
  return (LEGACY_REVISIONS as readonly string[]).includes(revision);
}

/** Whether `revision` is a 2026-era revision served. */
export function isServedModernRevision(revision: string): boolean {
  return (MODERN_REVISIONS as readonly string[]).includes(revision);
}

/**
 * Which era the request speaks, and what it says about its revision and
 * client — with the request as the SDK takes it, which classifying the era
 * needs anyway.
 */
export async function negotiate(
  request: McpHttpRequest,
  messages: readonly RpcMessage[],
): Promise<{ webRequest: Request; legacy: boolean; connection: Connection }> {
  const webRequest = toWebRequest(request);
  const legacy = await isLegacyRequest(webRequest, request.body);
  return {
    webRequest,
    legacy,
    connection: connectionOf(request, messages, legacy),
  };
}

/**
 * The 400 for a 2025-era revision older than the oldest served: JSON-RPC
 * `-32602` naming the served list (ADR-0025, as amended).
 */
export function revisionRefusal(
  messages: readonly RpcMessage[],
  requested: string,
): McpHttpResponse {
  return answer(400, {
    jsonrpc: '2.0',
    id: messages.length === 1 ? (messages[0].id ?? null) : null,
    error: {
      code: -32602,
      message: unsupportedRevision(requested),
      data: { supported: SERVED_REVISIONS, requested },
    },
  });
}

/**
 * One 2025-era request, on `server` with a fresh transport in JSON mode — the
 * SDK's own stateless fallback answers SSE, which ADR-0025 rules out.
 */
export async function serveLegacy(
  server: McpServer,
  request: Request,
  body: unknown,
  authInfo: AuthInfo,
): Promise<Response> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  try {
    const response = await transport.handleRequest(request, {
      parsedBody: body,
      authInfo,
    });
    // Read before the server closes, which ends the transport.
    return new Response(await response.text(), {
      status: response.status,
      headers: response.headers,
    });
  } finally {
    await server.close();
  }
}

/** Never an `Mcp-Session-Id`: the endpoint is stateless in both eras. */
export async function fromWebResponse(
  response: Response,
): Promise<McpHttpResponse> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    if (name === 'mcp-session-id' || name === 'content-length') return;
    headers[name] = value;
  });
  return { status: response.status, headers, body: await response.text() };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function clientInfoOf(value: unknown): McpClientInfo {
  const client = value as { name?: unknown; version?: unknown } | undefined;
  return {
    name: stringOrNull(client?.name),
    version: stringOrNull(client?.version),
  };
}

/**
 * What the request says about the client and its revision, and whether the
 * revision is refused. Self-reported throughout; it decides nothing but the
 * revision refusal, which is the protocol's own rule.
 */
function connectionOf(
  request: McpHttpRequest,
  messages: readonly RpcMessage[],
  legacy: boolean,
): Connection {
  const headerRevision = header(request, 'mcp-protocol-version') ?? null;
  if (legacy) {
    const initialize = messages.find(
      (message) => message.method === 'initialize',
    );
    if (initialize) {
      const requested = stringOrNull(initialize.params?.protocolVersion);
      return {
        requested,
        // What the SDK negotiates: the requested revision when served, else
        // our newest legacy one.
        revision:
          requested && isServedLegacyRevision(requested)
            ? requested
            : LEGACY_REVISIONS[0],
        client: clientInfoOf(initialize.params?.clientInfo),
        refused: requested !== null && requested < OLDEST_SERVED_REVISION,
        unservedModern: false,
      };
    }
    const requested = headerRevision ?? UNDECLARED_LEGACY_REVISION;
    return {
      requested,
      revision: requested,
      refused: !isServedLegacyRevision(requested),
      unservedModern: false,
    };
  }
  const meta = messages[0]?.params?._meta as
    Record<string, unknown> | undefined;
  const requested =
    stringOrNull(meta?.[PROTOCOL_VERSION_META]) ?? headerRevision;
  const client = meta?.[CLIENT_INFO_META];
  return {
    requested,
    revision: requested,
    ...(client ? { client: clientInfoOf(client) } : {}),
    refused: false,
    unservedModern: requested !== null && !isServedModernRevision(requested),
  };
}

/** Headers the SDK has no business seeing: the credential and hop-by-hop. */
const WITHHELD = new Set([
  'authorization',
  'cookie',
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'origin',
]);

/** The request as the SDK takes it: the parsed body re-serialized. */
function toWebRequest(request: McpHttpRequest): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || WITHHELD.has(name)) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  return new Request('http://cloudgate.internal/mcp', {
    method: 'POST',
    headers,
    body: JSON.stringify(request.body ?? null),
  });
}
