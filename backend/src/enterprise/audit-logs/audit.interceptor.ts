import { Inject, Injectable } from '@nestjs/common';
import type {
  CallHandler,
  ExecutionContext,
  NestInterceptor,
} from '@nestjs/common';
import type { Response } from 'express';
import { from, Observable } from 'rxjs';
import { concatMap, map } from 'rxjs/operators';
import { readAiModelFacet } from '../../ai-models/ai-model-facet';
import type { AuthenticatedRequest } from '../../auth/auth.guard';
import { DRIZZLE } from '../../db/drizzle.module';
import type { DrizzleDB } from '../../db/drizzle.module';
import { AuditLogService } from './audit-log.service';
import {
  auditTargetFor,
  changedFacetFieldsOf,
  clip,
  isAiModelUpdateRoute,
  routeOf,
  routeParamOf,
} from './audit-routes';
import type { AuditTarget, StoredFacet } from './audit-routes';

/**
 * Records every successful mutating request a signed-in caller makes.
 *
 * Registered app-wide by `AuditLogsModule`, so it runs after `AuthGuard` and
 * `PermissionsGuard` have admitted the caller: a refused or failed request
 * throws before the `concatMap` below and records nothing. What each route
 * records — or why it records nothing — is `audit-routes.ts`.
 *
 * **What an entry carries:** the actor and their role in the active
 * Organization (resolved by `AuditLogService.audit`, which records nothing
 * when there is no active Organization or the caller is not a member of it),
 * the caller's address, the kind and action, the route's id parameter, the
 * `name` (or `host`) of the row the handler returned, and `metadata.route` —
 * the path *template*, so neither a query string nor an id in a path can put
 * anything the template does not already say into the row. **Never the request
 * body**: it is where passwords, tokens, keys and environment variables
 * travel. The one thing read off it is an AI model's update's `changed`, the
 * *names* of the facet fields it changed (`changedFacetFieldsOf`).
 *
 * The write is awaited before the response is sent, so a caller that reads the
 * trail straight after a write sees its entry; `audit` swallows its own
 * failures, so a trail that cannot be written never fails the action.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly auditLogs: AuditLogService,
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const route = routeOf(context.getClass(), context.getHandler());
    const target = route ? auditTargetFor(route.method, route.path) : null;
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (!route || !target || !request.user) return next.handle();

    const response = context.switchToHttp().getResponse<Response>();
    const user = request.user;
    const session = request.session;
    return from(this.facetBefore(route, request)).pipe(
      concatMap((stored) =>
        next.handle().pipe(map((body: unknown) => ({ body, stored }))),
      ),
      concatMap(({ body, stored }) => {
        if (response.statusCode >= 400) return from([body]);
        return from(
          this.auditLogs.audit(
            {
              userId: user.id,
              organizationId: session?.activeOrganizationId,
              ip: request.ip,
            },
            {
              ...target,
              resourceId: resourceIdOf(
                route.path,
                request.params,
                body,
                target,
              ),
              resourceName: resourceNameOf(body),
              metadata: auditMetadata(route, request.body, stored),
            },
          ),
        ).pipe(map(() => body));
      }),
    );
  }

  /**
   * An AI model's facet as it stood before an update that names it, which
   * is what `changed` compares the request with; `null` for any other
   * request, and for a plain Application.
   */
  private async facetBefore(
    route: { method: string; path: string },
    request: AuthenticatedRequest,
  ): Promise<StoredFacet | null> {
    if (!isAiModelUpdateRoute(route.method, route.path)) return null;
    const body = request.body as { aiModel?: unknown } | undefined;
    if (!body?.aiModel || typeof body.aiModel !== 'object') return null;
    const id = routeParamOf(route.path, request.params);
    return id ? readAiModelFacet(this.db, id) : null;
  }
}

/**
 * The route's first id parameter, or — for a create, which has none — the new
 * row's own id off the response (`projectId` for a Project, `mysqlId` for a
 * MySQL database, else `id`).
 */
function resourceIdOf(
  path: string,
  params: Record<string, string | string[]> | undefined,
  body: unknown,
  target: AuditTarget,
): string | undefined {
  const fromRoute = routeParamOf(path, params);
  if (fromRoute) return fromRoute;

  const segment = path.split('/').filter(Boolean)[0];
  return firstString(body, [`${target.resourceType}Id`, `${segment}Id`, 'id']);
}

/**
 * The route template, and for an AI model's update the facet fields it
 * changed by name — never the body's values.
 */
function auditMetadata(
  route: { method: string; path: string },
  body: unknown,
  stored: StoredFacet | null,
): Record<string, unknown> {
  const changed = changedFacetFieldsOf(route.method, route.path, body, stored);
  return {
    route: `${route.method} ${route.path}`,
    ...(changed.length > 0 && { changed }),
  };
}

/** What the returned row calls itself, when the handler returned one. */
function resourceNameOf(body: unknown): string | undefined {
  return firstString(body, ['name', 'host']);
}

function firstString(body: unknown, keys: string[]): string | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return undefined;
  for (const key of keys) {
    const value = (body as Record<string, unknown>)[key];
    if (typeof value === 'string' && value !== '') return clip(value);
  }
  return undefined;
}
