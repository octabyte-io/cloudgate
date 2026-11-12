import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { STATUS_CODES } from 'node:http';
import type { Request, Response } from 'express';
import { ZodValidationException } from 'nestjs-zod';
import type { ZodError } from 'zod';

import { isUnreachableCode } from '../../docker-ops/host-reachability';

export interface ErrorResponseBody {
  statusCode: number;
  error: string;
  message: string;
  /**
   * A machine-readable name for *which* refusal this is, when the status alone
   * does not say (H-26). Optional and opt-in, exactly like `details`
   * below: a thrower publishes one by throwing `new HttpException({ message,
   * code }, status)`, and everything that throws a bare
   * `NotFoundException('…')` carries none and is unchanged on the wire.
   *
   * **Why this is on the contract at all.** `errorMessage()` in the console
   * turns an `ApiError` into the one sentence a person reads, and for a 403 it
   * had exactly one sentence — *"Your role in this Organization does not allow
   * this"* — so a **banned** caller's `/servers` and `/projects` 403s were
   * reported to them as a role problem they could ask an owner to fix, which is
   * the second half of H-08's complaint. The refusal already carried *"This
   * account is banned"* in `message`, and matching that English in the console
   * is precisely the failure mode `frontend/src/lib/auth/auth-error.ts` records
   * a ticket as having been filed to remove: a reworded sentence here would
   * silently drop the console back to the wrong one. A code cannot be reworded
   * by accident.
   *
   * **Rejected: a code on every error.** ADR-0005's shape is deliberately small
   * and every `HttpException` in the tree would have to grow one, for a client
   * that branches on exactly one. `details` set the precedent for a field that
   * appears only where a specific answer needs it, and this follows it.
   *
   * **Rejected: a custom exception class** carrying the code. §2.5 forbids
   * domain exception classes outright, and Nest's own object-response form
   * already carries everything this needs.
   */
  code?: string;
  /**
   * Where a refused change is made instead: the file and branch of a
   * repository-kept Project config, on `PROJECT_CONFIG_REPOSITORY_KEPT`. Opt-in
   * like `code` and `details` — published only by a thrower whose object
   * response carries one in exactly this shape, so no other body changes. The
   * console links to the file from it and an API caller reads it rather than
   * the sentence; `message` still names the place for a person. `fileUrl` is
   * the file at the commit read, `null` when it could not be read.
   */
  pointer?: {
    repository: string;
    path: string;
    branch: string | null;
    fileUrl: string | null;
  };
  details?: { path: string; message: string }[];
  /**
   * A tool's own output behind a refusal whose `message` already says it in
   * plain words: a registry test's `docker login` stderr, which the
   * console keeps behind a "Details" disclosure. Opt-in like `code`: only a
   * thrower whose object response carries a non-empty string publishes one.
   */
  output?: string;
  path: string;
  timestamp: string;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request>();
    const response = ctx.getResponse<Response>();

    const body: ErrorResponseBody = {
      ...this.describe(exception),
      path: request.url,
      timestamp: new Date().toISOString(),
    };

    // A host that was not reached is not a Cloudgate fault, and its thrower
    // has already journaled it — `rethrowIfHostUnreachable` writes the host's
    // own words at warn before it throws the 503. Logging it again here at
    // error made every page load of an unreachable Server's Overview an
    // error-level line for a routine condition. The code, not the
    // status: every other 503 is still ours to explain.
    if (body.statusCode >= 500 && !isUnreachableCode(body.code)) {
      this.logger.error(exception);
    }

    response.status(body.statusCode).json(body);
  }

  private describe(
    exception: unknown,
  ): Omit<ErrorResponseBody, 'path' | 'timestamp'> {
    if (exception instanceof ZodValidationException) {
      return {
        statusCode: HttpStatus.BAD_REQUEST,
        error: STATUS_CODES[HttpStatus.BAD_REQUEST] as string,
        message: 'Validation failed',
        // nestjs-zod types this as `unknown` to stay agnostic across zod majors.
        details: (exception.getZodError() as ZodError).issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      };
    }

    if (exception instanceof HttpException) {
      const statusCode = exception.getStatus();
      const res = exception.getResponse();
      const message =
        typeof res === 'string'
          ? res
          : ((res as { message?: string | string[] }).message ??
            exception.message);
      // Only a non-empty string, and only from the object form. Nest's built-in
      // subclasses answer `getResponse()` with `{ statusCode, message, error }`
      // and no `code`, so every existing throw site keeps the body it had —
      // this reads a field that nothing in the tree sets except a thrower that
      // means to publish one.
      const code =
        typeof res === 'string' ? undefined : (res as { code?: unknown }).code;
      const pointer =
        typeof res === 'string'
          ? undefined
          : pointerOf((res as { pointer?: unknown }).pointer);
      const output =
        typeof res === 'string'
          ? undefined
          : (res as { output?: unknown }).output;
      return {
        statusCode,
        error: STATUS_CODES[statusCode] ?? 'Error',
        message: Array.isArray(message) ? message.join('; ') : message,
        ...(typeof code === 'string' && code.length > 0 ? { code } : {}),
        ...(pointer ? { pointer } : {}),
        ...(typeof output === 'string' && output.length > 0 ? { output } : {}),
      };
    }

    return {
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      error: STATUS_CODES[HttpStatus.INTERNAL_SERVER_ERROR] as string,
      message: 'Internal server error',
    };
  }
}

/** A response's `pointer`, only in its published shape (never other fields). */
function pointerOf(value: unknown): ErrorResponseBody['pointer'] {
  if (typeof value !== 'object' || value === null) return undefined;
  const { repository, path, branch, fileUrl } = value as Record<
    string,
    unknown
  >;
  if (typeof repository !== 'string' || typeof path !== 'string') {
    return undefined;
  }
  if (branch !== null && typeof branch !== 'string') return undefined;
  return {
    repository,
    path,
    branch,
    fileUrl: typeof fileUrl === 'string' ? fileUrl : null,
  };
}
