import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AuditLogService } from '../enterprise/audit-logs/audit-log.service';
import { AUDIT_REASON } from '../enterprise/audit-logs/audit-log.schema';
import {
  refusedTargetFor,
  routeOf,
  routeParamOf,
} from '../enterprise/audit-logs/audit-routes';
import type { AuthSession } from './auth.config';
import { AuthService, refusalException } from './auth.service';
import type {
  CredentialHandle,
  RefusedAgent,
  ValidatedRequest,
} from './auth.service';
import { IS_PUBLIC_KEY } from './decorators/public.decorator';

export interface AuthenticatedRequest extends Request {
  user?: AuthSession['user'];
  session?: NonNullable<ValidatedRequest['session']>;
  /**
   * Which credential the caller was recognised by — a session or a Personal
   * key, by id. Read by a route that answers about the credential
   * itself, such as `GET /users/me/whoami` saying when the key it was asked
   * with ends; never a secret, so it is safe to keep on the request.
   */
  credential?: CredentialHandle;
}

/**
 * App-wide guard (registered as APP_GUARD in AuthModule): resolves the caller
 * via AuthService.validateRequest and populates request.user / request.session.
 * Routes marked with @Public() are exempt.
 *
 * **An Agent refused here is an audit row**: every call an
 * Agent makes, allowed or refused, names it in the trail, and an Agent key
 * on a REST route is refused by `validateRequest`'s one branch. The row is
 * `refused` with `AUDIT_REASON.permission`, the route's kind and action
 * ({@link refusedTargetFor}), `metadata.route` as the interceptor writes it,
 * and the key as an MCP call's row names it. A person's refused request is
 * still not recorded.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authService: AuthService,
    private readonly auditLogs: AuditLogService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const { session, user, rejection, refusedAgent, credential } =
      await this.authService.validateRequest(request.headers);

    if (!session || !user) {
      // A credential the caller really holds, turned down for a reason
      // better-auth named, answers with that reason and its own status —
      // a rate-limited key used to come back as the same bare 401 an invalid
      // one does, which is how the limit was misread as a bad key. Everything
      // else stays a bare 401 on purpose; see NAMED_API_KEY_REFUSALS.
      //
      // `refusalException` rather than the `HttpException` this built itself,
      // because H-26 gave a refusal a second thing to carry: the ban publishes
      // a `code`, and this is the one place a banned *cookie* becomes the 403
      // that `/servers` and `/projects` answer. Building the exception here
      // meant the console could tell a banned caller apart from a
      // wrong-role one on better-auth's surface and nowhere else.
      if (rejection) {
        if (refusedAgent) {
          await this.recordAgentRefusal(context, request, refusedAgent);
        }
        throw refusalException(rejection);
      }
      throw new UnauthorizedException();
    }

    request.user = user;
    request.session = session;
    request.credential = credential;
    return true;
  }

  /** The refused row naming the Agent; `audit` swallows its own failures. */
  private async recordAgentRefusal(
    context: ExecutionContext,
    request: AuthenticatedRequest,
    agent: RefusedAgent,
  ): Promise<void> {
    const route = routeOf(context.getClass(), context.getHandler());
    if (!route) return;
    await this.auditLogs.audit(
      {
        userId: agent.userId,
        organizationId: agent.organizationId,
        ip: request.ip,
      },
      {
        ...refusedTargetFor(route.method, route.path),
        resourceId: routeParamOf(route.path, request.params),
        outcome: 'refused',
        metadata: {
          route: `${route.method} ${route.path}`,
          reason: AUDIT_REASON.permission,
          ...(agent.key
            ? { credential: { keyId: agent.key.id, start: agent.key.start } }
            : {}),
        },
      },
    );
  }
}
