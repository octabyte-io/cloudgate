import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { AuthenticatedRequest } from '../auth.guard';

/** The user resolved by the AuthGuard (undefined on @Public() routes). */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext) =>
    context.switchToHttp().getRequest<AuthenticatedRequest>().user,
);

/** The session resolved by the AuthGuard (undefined on @Public() routes). */
export const CurrentSession = createParamDecorator(
  (_data: unknown, context: ExecutionContext) =>
    context.switchToHttp().getRequest<AuthenticatedRequest>().session,
);

/**
 * The credential the AuthGuard recognised the caller by: a session or
 * a Personal key, named by id. Undefined on @Public() routes.
 */
export const CurrentCredential = createParamDecorator(
  (_data: unknown, context: ExecutionContext) =>
    context.switchToHttp().getRequest<AuthenticatedRequest>().credential,
);
