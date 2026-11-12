import type { INestApplication } from '@nestjs/common';

import type { Auth } from '../../src/auth/auth.config';
import { AUTH } from '../../src/auth/auth.constants';

export interface RoutedAuthEndpoint {
  /** The endpoint's key on `auth.api`, e.g. `'updateMemberRole'`. */
  name: string;
  /** The path under `/api/auth`, e.g. `'/organization/update-member-role'`. */
  path: string;
  /** The HTTP methods it answers. */
  methods: string[];
}

/**
 * Every endpoint of the running better-auth instance that its router serves
 * over HTTP, with the methods it answers — read from `auth.api` rather than
 * written down, and filtered the way better-call's router filters it (a
 * `SERVER_ONLY` endpoint is never routed).
 *
 * For a test that pins a route closed: looking the route up here first means a
 * better-auth upgrade that renames or adds one reds the test rather than
 * leaving the new path open.
 */
export function routedAuthEndpoints(
  app: INestApplication,
): RoutedAuthEndpoint[] {
  const auth = app.get<Auth>(AUTH);
  const routed: RoutedAuthEndpoint[] = [];
  for (const [name, endpoint] of Object.entries(
    auth.api as unknown as Record<string, unknown>,
  )) {
    const described = endpoint as {
      path?: unknown;
      options?: { method?: unknown; metadata?: { SERVER_ONLY?: unknown } };
    };
    if (typeof described.path !== 'string' || !described.options) continue;
    if (described.options.metadata?.SERVER_ONLY) continue;
    const method = described.options.method;
    const methods = (Array.isArray(method) ? method : [method]).filter(
      (m): m is string => typeof m === 'string',
    );
    routed.push({ name, path: described.path, methods });
  }
  return routed;
}
