import type { INestApplication } from '@nestjs/common';
import type {
  CorsOptions,
  CorsOptionsDelegate,
} from '@nestjs/common/interfaces/external/cors-options.interface';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { isTraceStoreFramePath } from '../../traces/trace-store-frame';

/**
 * The CORS policy main.ts installs, from the CORS_ALLOWED_ORIGINS allowlist.
 *
 * `enableCors()` bare answers every request with
 * `Access-Control-Allow-Origin: *` and never `Access-Control-Allow-Credentials`,
 * a pairing a browser refuses. The session is a cookie, so every authenticated
 * call from a browser is credentialed — meaning that configuration let no
 * cross-origin browser client through while advertising that any origin could.
 *
 * Naming the origins is the only arrangement that can carry credentials, and an
 * empty allowlist therefore means what it says: no cross-origin browser client.
 * That is the normal case — the frontend proxies the browser through its own
 * origin (frontend/next.config.ts), so requests are same-origin and CORS never
 * applies. An empty array is deliberately not passed through to the `cors`
 * package as a falsy origin, which would put the wildcard back.
 */
export function corsOptions(allowedOrigins: string[]): CorsOptions {
  return {
    // A `string[]` origin makes `cors` echo the request's own origin when it is
    // on the list and send no allow-origin header when it is not — the only
    // form a credentialed request can use. Never '*'.
    origin: [...allowedOrigins],
    credentials: true,
  };
}

/**
 * The one carve-out from {@link corsOptions}: a Trace store frame's requests
 * (ADR-0075). The frame is sandboxed into an opaque origin, so its module
 * scripts, fonts and fetches arrive with `Origin: null`, and its JSON `POST`
 * is preflighted. They are authorized by the frame token in their path, never
 * by a cookie, so they are answered to any origin and **never with
 * credentials**, which is the only pairing a browser accepts with `*` and the
 * reason no cookie-authorized route may match {@link isTraceStoreFramePath}.
 * Only the verbs the proxy forwards are offered.
 */
export const TRACE_STORE_FRAME_CORS: CorsOptions = {
  origin: '*',
  credentials: false,
  methods: ['GET', 'HEAD', 'POST'],
  maxAge: 600,
};

/**
 * {@link corsOptions}, except on a Trace store frame's path, which gets
 * {@link TRACE_STORE_FRAME_CORS}.
 */
export function corsPolicy(
  allowedOrigins: string[],
): CorsOptionsDelegate<Request> {
  const options = corsOptions(allowedOrigins);
  return (req, callback) =>
    callback(
      null,
      isTraceStoreFramePath(req.url ?? '') ? TRACE_STORE_FRAME_CORS : options,
    );
}

/**
 * {@link corsOptions} *and the key it is read off, and the `enableCors` that
 * installs it* — one call, so a process that boots Nest and wants this policy
 * gets all three or none (H-42).
 *
 * The same argument `applyTrustProxy` makes one file over, arrived at the same
 * way. `main.ts` held these three lines and `createTestApp` held none of them,
 * so `CORS_ALLOWED_ORIGINS` had no integration coverage at all: `cors.spec.ts`
 * boots its own two-route app and asserts the *options object*, and no request
 * in the tree's 89 e2e files has ever met the policy. Nothing was wrong,
 * because nothing asserted a cross-origin refusal — and that is exactly the
 * H-28 failure mode one step earlier, because the first assertion to arrive
 * would have passed against an app with no policy at all, which answers every
 * origin and refuses none.
 *
 * **Opt-in per suite rather than wired into `createTestApp` by default.**
 * Turning the policy on for all 89 files changes what a credentialed request
 * with no `Origin` header does, which is nearly every request those files
 * make. So this is passed as `beforeInit` by the one suite whose subject it is
 * — the shape `test/openapi/docs-route.e2e-spec.ts` already uses for
 * `mountOpenApiDocument`, and the reason `TestAppOptions.beforeInit` exists.
 *
 * Typed `INestApplication` and reading its own `ConfigService`, so it takes the
 * app and nothing else and can be handed to `beforeInit` by name. Installs
 * {@link corsPolicy} and returns the options it gives every path but a Trace
 * store frame's, so a caller can assert on the decision rather than
 * re-deriving it.
 */
export function applyCors(app: INestApplication): CorsOptions {
  const allowedOrigins = app
    .get(ConfigService)
    .get<string[]>('CORS_ALLOWED_ORIGINS', []);
  app.enableCors(corsPolicy(allowedOrigins));
  return corsOptions(allowedOrigins);
}
