import { STATUS_CODES } from 'node:http';

import { errorBodySchema, NOT_ORGANIZATION_MEMBER_CODE } from 'api-schemas';

import { EXIT } from './exit-codes.js';
import type { ExitCode } from './exit-codes.js';

/**
 * A run that ends without its result: what to print, and how to exit.
 *
 * Every refusal in the CLI is one of these, so one place ({@link reportError})
 * decides how a failure looks — `Error: <message>` on stderr, then at most one
 * hint line — and stdout is never written on the way out. That is what keeps a
 * `--json` command's stdout empty on error: the data is printed only after
 * everything it depends on has succeeded.
 */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: ExitCode,
    /** One line saying how to fix it, when the CLI knows a fix. */
    readonly hint?: string,
    /** An Instance's refusal's `code`, the one thing a command may branch on. */
    readonly code?: string,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

/** Wrong use, or input missing with no one to ask (exit 2). */
export function usageError(message: string, hint?: string): CliError {
  return new CliError(message, EXIT.usage, hint);
}

/** What the caller knows that makes a refusal's hint more exact. */
export interface RefusalContext {
  /** Where the key came from; `env` when it was `CLOUDGATE_KEY`. */
  keyFrom?: 'env' | 'login';
  /** The Organization the request acted in, when the CLI knows its name. */
  organizationName?: string;
}

/**
 * The 403 codes that mean "your access does not reach this", which an owner
 * can grant (`ACCESS_NOT_GRANTED_CODE` in `backend/src/rbac/permission.service.ts`).
 * The role's own refusal publishes no code at all, and means the same.
 */
const ACCESS_CODES = new Set([
  'PROJECT_ACCESS_NOT_GRANTED',
  'ENVIRONMENT_ACCESS_NOT_GRANTED',
  'SERVICE_ACCESS_NOT_GRANTED',
]);

/**
 * An Instance's refusal, as the CLI reports it (CLI spec, Output
 * conventions): 401 exits 3, every other refusal exits 1, and the server's own
 * message is what is printed.
 *
 * **The hint is chosen by `code`, never by `message`.** The message is English
 * for a person and the server may reword it; the code is the contract. A 403
 * gets "ask an owner" only when it is unnamed (the role's refusal) or one of
 * the access codes — the console's own rule (`ApiError.isUnnamedRefusal` in
 * `frontend/src/lib/api/api-error.ts`), and for the same reason: a banned
 * account or a removed member is also a 403, and no owner granting access
 * fixes either.
 */
export function refusalFromResponse(
  status: number,
  body: unknown,
  context: RefusalContext = {},
): CliError {
  const parsed = errorBodySchema.safeParse(body);
  const fields = parsed.success ? parsed.data : {};
  const message =
    fields.message && fields.message.trim().length > 0
      ? fields.message
      : `the Instance answered ${status}${STATUS_CODES[status] ? ` ${STATUS_CODES[status]}` : ''}`;

  if (status === 401) {
    return new CliError(
      message,
      EXIT.notLoggedIn,
      context.keyFrom === 'env'
        ? 'The Instance does not accept the key in CLOUDGATE_KEY; it may have ended or been deleted.'
        : undefined,
    );
  }
  if (status === 403 && fields.code === NOT_ORGANIZATION_MEMBER_CODE) {
    // No owner can fix this one: the run named an Organization the key's
    // owner is not in (`x-organization-id`), so the fix is naming another.
    return new CliError(
      message,
      EXIT.failed,
      "Check --org, CLOUDGATE_ORG or this folder's link (cloudgate link to change it).",
    );
  }
  if (status === 403 && (!fields.code || ACCESS_CODES.has(fields.code))) {
    return new CliError(
      message,
      EXIT.failed,
      `Ask an owner of ${context.organizationName ?? 'the Organization'} for access.`,
    );
  }
  return new CliError(message, EXIT.failed, undefined, fields.code);
}

/** `fetch failed` says nothing; the cause's code (`ECONNREFUSED`, `ENOTFOUND`) does. */
export function reasonOf(error: unknown): string {
  const cause = (error as { cause?: { code?: unknown; message?: unknown } })
    ?.cause;
  if (typeof cause?.code === 'string') return ` (${cause.code})`;
  if (typeof cause?.message === 'string') return ` (${cause.message})`;
  return '';
}

/** The two streams a run writes to. */
export interface Streams {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/**
 * Prints a failure and answers the exit code to end with. Anything that is not
 * a {@link CliError} is a failure the CLI did not foresee: it still prints one
 * `Error:` line and exits 1, because a stack trace is not something a person
 * or a CI log can act on.
 */
export function reportError(
  error: unknown,
  io: Pick<Streams, 'stderr'>,
): ExitCode {
  if (error instanceof CliError) {
    io.stderr(`Error: ${error.message}\n`);
    if (error.hint) io.stderr(`${error.hint}\n`);
    return error.exitCode;
  }
  const message = error instanceof Error ? error.message : String(error);
  io.stderr(`Error: ${message}\n`);
  return EXIT.failed;
}
