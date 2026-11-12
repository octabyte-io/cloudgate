import { Injectable } from '@nestjs/common';
import type {
  CallHandler,
  ExecutionContext,
  NestInterceptor,
} from '@nestjs/common';
import { map } from 'rxjs';
import type { Observable } from 'rxjs';

/**
 * Each token a redis row holds, by the field a response answers in its
 * place (ADR-0019): its ElastiCache AUTH token. A redis on
 * Memorystore has none (ADR-0042).
 */
const TOKENS = {
  authToken: 'hasAuthToken',
} as const;

/**
 * A redis row as a response carries it (ADR-0019): each of its tokens
 * replaced by whether one is set, `hasAuthToken`, at the depth the token
 * lived at; and, on a redis Cloudgate made on a cloud (`cloudAccountId`
 * set), no `databasePassword`. That column is the Server's: on
 * Memorystore the instance has no password (ADR-0042), and on ElastiCache
 * a linked Service is given the AUTH token, so answering it would name a
 * password nothing connects with. Anything that is not a row with one of
 * the fields passes through as it is.
 */
export function withSecretsHidden<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((one: unknown) => withSecretsHidden(one)) as T;
  }
  if (
    !value ||
    typeof value !== 'object' ||
    !(
      Object.keys(TOKENS).some((field) => field in value) ||
      'databasePassword' in value
    )
  ) {
    return value;
  }
  const rest: Record<string, unknown> = {
    ...(value as Record<string, unknown>),
  };
  for (const [field, presence] of Object.entries(TOKENS)) {
    if (!(field in rest)) continue;
    const token = rest[field];
    delete rest[field];
    rest[presence] = typeof token === 'string' && token !== '';
  }
  if (typeof rest.cloudAccountId === 'string' && rest.cloudAccountId !== '') {
    delete rest.databasePassword;
  }
  return rest as T;
}

/**
 * Every route of the redis controller answers through this, so no route —
 * the read, or the row a create, update, status change or Delete echoes —
 * hands out a token, or a cloud redis's unused password. One place rather than one call per route, so a route
 * added later is covered without remembering to be.
 */
@Injectable()
export class SecretsHidden implements NestInterceptor {
  intercept(
    _context: ExecutionContext,
    next: CallHandler<unknown>,
  ): Observable<unknown> {
    return next.handle().pipe(map((body: unknown) => withSecretsHidden(body)));
  }
}
