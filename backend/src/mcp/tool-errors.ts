import {
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import type { Type } from '@nestjs/common';
import { ACCESS_NOT_GRANTED_CODE } from '../rbac/permission.service';

/**
 * What a tool answers when its service method throws: a declared table, never
 * the thrown message (ADR-0024).
 *
 * An entry matches on the exception **class plus, where given, the `code`** in
 * its response body. The code is not optional decoration: the row-level
 * `*_ACCESS_NOT_GRANTED` refusals are plain `ForbiddenException`s carrying a
 * code (`PermissionService`'s `notGranted`), the same class as a role refusal
 * and as `NOT_A_MEMBER_CODE`, and CODING_STANDARDS §2.5 rules out a class of
 * their own. So a `ForbiddenException` entry must name its code — the census
 * refuses one that does not, because it would swallow every 403 there is.
 *
 * - `'grant'` answers the one byte-identical `Not found or not permitted`
 *   refusal, with the finality sentence and a `refused`/`grant` row.
 * - `{ failed: text }` answers `text` as an `isError` result with no
 *   finality sentence, and a `failed` row: a failure the agent can act on,
 *   declared by the tool that knows what it means.
 *
 * Anything no entry matches answers "The call failed." with the audit row id.
 */
export type ErrorAnswer = 'grant' | { readonly failed: string };

export interface ErrorEntry {
  readonly exception: Type<HttpException>;
  /** The response body's `code`; required for a `ForbiddenException`. */
  readonly code?: string;
  readonly answer: ErrorAnswer;
}

export type ErrorTable = readonly ErrorEntry[];

/**
 * What every id-addressed tool maps to `grant`: its target's 404, and each
 * `*_ACCESS_NOT_GRANTED` 403. A tool addressing a Service can meet the
 * Environment's or Project's refusal on the way (a Service's reads resolve
 * through their parents), so all three codes are in, whatever the tool's own
 * level. Spread it into a tool's table; the census checks each id-addressed
 * tool's table contains every entry.
 */
export const GRANT_REFUSALS: ErrorTable = [
  { exception: NotFoundException, answer: 'grant' },
  ...Object.values(ACCESS_NOT_GRANTED_CODE).map((code) => ({
    exception: ForbiddenException,
    code,
    answer: 'grant' as const,
  })),
];

/** The `code` a Nest exception's response body carries, if any. */
function codeOf(error: HttpException): string | undefined {
  const body = error.getResponse();
  if (typeof body !== 'object' || body === null) return undefined;
  const code = (body as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** The first entry that matches `error`, or `null` when none does. */
export function answerFor(
  table: ErrorTable,
  error: unknown,
): ErrorAnswer | null {
  if (!(error instanceof HttpException)) return null;
  for (const entry of table) {
    if (!(error instanceof entry.exception)) continue;
    if (entry.code !== undefined && codeOf(error) !== entry.code) continue;
    return entry.answer;
  }
  return null;
}
