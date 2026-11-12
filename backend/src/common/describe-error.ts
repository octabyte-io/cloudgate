import { HttpException } from '@nestjs/common';

/**
 * An error as the sentence a step result, a log line or a refusal shows:
 * an HTTP exception's own message (a list joined), else the error's.
 * One spelling of `error instanceof Error ? error.message : String(error)`
 * for every module (§1.4), moved here from `project-config/messages.utils`.
 */
export function describeError(error: unknown): string {
  if (error instanceof HttpException) {
    const response = error.getResponse();
    if (typeof response === 'string') return response;
    const message = (response as { message?: unknown }).message;
    if (typeof message === 'string') return message;
    if (Array.isArray(message)) return message.join('; ');
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}
