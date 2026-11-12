import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { WsAdapter } from '@nestjs/platform-ws';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { applyCors } from './common/config/cors';
import { applyTrustProxy } from './common/config/trust-proxy';
import { applyGatewayBodyParser } from './gateway/gateway-body';
import { NotificationDispatcherService } from './notifications/dispatcher.service';
import { mountOpenApiDocument, OPENAPI_ROUTE } from './openapi';

async function bootstrap() {
  // rawBody: Stripe signs the exact request bytes, so the billing webhook has
  // to verify against them rather than a re-serialized body.
  // Typed as the Express application because `trust proxy` below is an Express
  // setting and `INestApplication` has no `set`.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    rawBody: true,
  });
  const logger = app.get(Logger);
  app.useLogger(logger);
  // SIGTERM (a `systemctl stop` or an upgrade) runs the shutdown hooks before
  // the process exits, which it once did not: `CloudRunsService`
  // interrupts and waits for its `tofu` children and settles their rows.
  // `deploy/systemd/cloudgate-backend.service` gives it `TimeoutStopSec=5min`.
  app.enableShutdownHooks();
  // Named origins, not a wildcard. The session is a cookie, so every
  // authenticated call from a browser is credentialed, and a browser refuses to
  // pair a credentialed request with `Access-Control-Allow-Origin: *`. Empty
  // unless CORS_ALLOWED_ORIGINS says otherwise, which means no cross-origin
  // browser client — the shipped frontend proxies through its own origin.
  //
  // Through `applyCors` rather than inline since H-42, for the reason the line
  // below is through `applyTrustProxy`: the key, the default and the
  // `enableCors` call lived only here, so no e2e could reach the policy without
  // copying all three, and `CORS_ALLOWED_ORIGINS` had no request-level coverage
  // at all. `cors-policy.e2e-spec.ts` now passes this same function as
  // `beforeInit`.
  const config = app.get(ConfigService);
  applyCors(app);
  // What `req.ip` is allowed to mean. Off unless TRUST_PROXY says
  // otherwise, which is the safe half of the pair — with nothing trusted `req.ip`
  // is the socket peer, so the address a session records cannot be chosen by the
  // caller, and `AuthController.toWebRequest` has something true to hand
  // better-auth. `true` was the tempting shortcut and is the dangerous one: it
  // believes any caller's `x-forwarded-for`, and an audit column that lies is
  // worse than one that is blank.
  //
  // Set before `listen`, because `req.ip` is read on the first request that
  // arrives — and set here rather than in the AuthModule because it governs
  // every route's `req.ip`, not only the ones that mint a session.
  //
  // Through `applyTrustProxy` rather than inline since H-28: `createTestApp`
  // had no equivalent, so every e2e ran with Express trusting nothing while
  // better-auth was handed the declared list off the same key. The harness now
  // calls this same function, which is the only arrangement in which the two
  // cannot drift again.
  applyTrustProxy(app, config.get<string>('TRUST_PROXY'), (message) =>
    logger.log(message, 'Bootstrap'),
  );
  // A call to the Gateway carries a body of up to 16 MiB, and one it
  // cannot take is refused in OpenAI's shape. Before `listen`, which is where
  // Nest's own 100 kB parser is added behind it.
  applyGatewayBodyParser(app);
  // The OpenAPI document, at /docs, for signed-in callers only. Generated
  // from the same zod DTOs the global ZodValidationPipe validates against, so
  // it cannot describe a request the server would reject. The identical
  // document is checked in at backend/openapi.json — see
  // `pnpm openapi:generate` — which is how tooling reads it without a session.
  //
  // A DTO that cannot be expressed as JSON Schema makes this throw (zod
  // refuses a bare `z.date()`, for one). That is a documentation fault, not a
  // reason to refuse to serve the API, so it is reported and stepped over —
  // test/openapi/openapi.spec.ts is what stops it reaching a release.
  try {
    mountOpenApiDocument(app);
  } catch (error) {
    logger.error(
      error,
      `Could not build the OpenAPI document; /${OPENAPI_ROUTE} is unavailable`,
    );
  }
  app.useWebSocketAdapter(new WsAdapter(app));
  await app.listen(process.env.PORT ?? 4000);

  // The instance-restart notification on server start: instance-wide, and
  // never allowed to take the boot down.
  await app
    .get(NotificationDispatcherService)
    .dispatch(null, { type: 'instance-restart' })
    .catch((error) => console.error('instance-restart notification:', error));
}
void bootstrap();
