import { TOOL_DEADLINE_MS } from './mcp-limits';

/**
 * Every sentence the MCP endpoint says to an agent, in one place. A thrown
 * message never reaches an agent (ADR-0024), so each of these
 * is the whole of what it is told.
 */

/**
 * Appended to every access decision — a permission, grant or suspension
 * refusal — and to nothing else: never to a failure, never to a rate limit,
 * which the agent should wait out rather than report.
 */
export const FINALITY_SENTENCE =
  'This is an access decision, not a failure. Retrying, or trying another tool or id, will not change it. Tell the operator what you needed.';

/** Unknown, revoked or disabled key. Writes no audit row: there is no Agent to name. */
export const INVALID_KEY = 'This key is not valid.';

/** A personal key presented here. Each credential has exactly one surface. */
export const PERSONAL_KEY =
  'This endpoint takes an agent key, and this is a personal key. Create an Agent in the console and use its key.';

/** An expired Agent key; `date` is the UTC day it expired. */
export const expiredKey = (date: string): string =>
  `This agent key expired on ${date}. An operator can issue a new one in the console.`;

export const SUSPENDED = `This Agent has been suspended by an operator. ${FINALITY_SENTENCE}`;

/** A statement the Agent's role lacks, e.g. `deployment:create`. */
export const missingStatement = (statement: string): string =>
  `This Agent's role does not include ${statement}. ${FINALITY_SENTENCE}`;

/**
 * Any tool called with a key whose role is Gateway-only (`agentCaller`):
 * the key spends on AI models and does nothing here, row-scoped tools included,
 * so no one statement is the thing it lacks.
 */
export const GATEWAY_ONLY = `This Agent's role only calls AI models through the Gateway and holds no tool here. ${FINALITY_SENTENCE}`;

/**
 * An id-addressed tool's target that is missing, in another Organization or
 * not granted — one byte-identical answer for all three.
 */
export const NOT_FOUND_OR_NOT_PERMITTED = `Not found or not permitted. ${FINALITY_SENTENCE}`;

/** A failure no tool's error table maps; the detail is in the audit row. */
export const callFailed = (auditLogId: string | null): string =>
  auditLogId
    ? `The call failed. The detail is in audit entry ${auditLogId}.`
    : 'The call failed.';

/** A tool that did not finish inside {@link TOOL_DEADLINE_MS}. */
export const deadlineExceeded = (auditLogId: string | null): string =>
  `The call did not finish within ${TOOL_DEADLINE_MS / 1000} seconds and was abandoned.` +
  (auditLogId ? ` The detail is in audit entry ${auditLogId}.` : '');

export const ORIGIN_REFUSED =
  'A request carrying an Origin header is refused: this endpoint is for MCP clients, not browsers.';

export const METHOD_NOT_ALLOWED = 'Method not allowed.';

export const UNSUPPORTED_MEDIA_TYPE =
  'A request to this endpoint must be application/json.';

/**
 * The per-Agent bucket is empty. No finality sentence: waiting
 * *will* change it, and the agent should wait rather than report.
 */
export const rateLimited = (seconds: number): string =>
  `Rate limit reached for this Agent. Wait ${seconds} seconds before the next call.`;

/** 2024-11-05, or any 2025-era revision older than the oldest served. */
export const unsupportedRevision = (requested: string): string =>
  `Unsupported protocol version: ${requested}`;
