import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import type { OpenAPIObject } from '@nestjs/swagger';
import type { NextFunction, Request, Response } from 'express';
import { cleanupOpenApiDoc } from 'nestjs-zod';
import { AuthService } from './auth/auth.service';

/** Where the interactive document is served from. */
export const OPENAPI_ROUTE = 'docs';

/**
 * Every path `SwaggerModule.setup(OPENAPI_ROUTE, …)` answers on.
 *
 * The two document paths are **siblings of** `/docs`, not children of it, so a
 * plain `app.use('/docs', …)` mount would guard the UI and leave the document
 * itself readable — the thing actually worth reading. They are listed rather
 * than prefix-matched for that reason.
 */
const openApiPaths = [
  `/${OPENAPI_ROUTE}`,
  `/${OPENAPI_ROUTE}-json`,
  `/${OPENAPI_ROUTE}-yaml`,
];

/** The UI's own assets, which Swagger serves beneath `/docs/`. */
const openApiAssetPrefix = `/${OPENAPI_ROUTE}/`;

function isOpenApiPath(path: string): boolean {
  return openApiPaths.includes(path) || path.startsWith(openApiAssetPrefix);
}

/**
 * The instance's OpenAPI document, built from the module graph.
 *
 * Nothing here declares a schema. The request shapes come out of the
 * `createZodDto` wrappers the global `ZodValidationPipe` already validates
 * against (app.module.ts) — nestjs-zod v5 hangs a `_OPENAPI_METADATA_FACTORY`
 * off every DTO class, which `@nestjs/swagger` calls on its own, so the zod
 * object stays the single definition of what a request may contain. (v5
 * dropped `patchNestJsSwagger()`; `cleanupOpenApiDoc` is its replacement and
 * is not optional — without it DTOs built from non-object schemas stay wrapped
 * in the `root` property nestjs-zod uses to smuggle them through Nest's
 * property-shaped metadata.)
 *
 * Emitted to `backend/openapi.json` by `pnpm openapi:generate` as well as
 * served at `/docs`, so a contract change lands in review as a diff.
 */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Cloudgate API')
    .setDescription(
      'The REST surface of a Cloudgate instance. Request shapes are generated ' +
        'from the zod DTOs the server validates against, so this document and ' +
        'the running validation cannot disagree.',
    )
    .setVersion('1.0.0')
    .addCookieAuth('better-auth.session_token', {
      type: 'apiKey',
      in: 'cookie',
      description:
        'The better-auth session cookie. Every route is authenticated ' +
        'unless it is marked @Public().',
    })
    .build();

  return cleanupOpenApiDoc(SwaggerModule.createDocument(app, config));
}

/**
 * The one way the document is turned into bytes, shared by the emit script and
 * the test that guards `backend/openapi.json` against drift — a checked-in
 * artifact is only reviewable if regenerating it is byte-stable.
 */
export function serializeOpenApiDocument(doc: OpenAPIObject): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/**
 * Serves the document at `/docs`, to signed-in callers only.
 *
 * Swagger registers its routes straight onto Express, so the app-wide
 * `AuthGuard` never sees them — `SwaggerModule.setup` on its own publishes the
 * whole surface, 464 operations of it, to anyone who asks. On a platform that
 * manages servers, SSH keys and deployments that is a map worth withholding, so
 * the same `AuthService.validateRequest` the guard uses runs here as middleware
 * ahead of Swagger's own handlers.
 *
 * This is not the document's only reader: `backend/openapi.json` is checked in,
 * so tooling and CI get the contract with no instance running and no session.
 * What the route adds is the browsable UI, and that can wait for a login.
 *
 * A failure to *build* the document is different from a failure to authorise a
 * request for it: an unrepresentable DTO is a documentation fault, not a reason
 * to refuse to serve the API, so the caller reports it and boots on.
 */
export function mountOpenApiDocument(app: INestApplication): void {
  const authService = app.get(AuthService);

  app.use(async (req: Request, res: Response, next: NextFunction) => {
    if (!isOpenApiPath(req.path)) return next();
    try {
      const { session, user } = await authService.validateRequest(req.headers);
      if (!session || !user) {
        res.status(401).json({ statusCode: 401, message: 'Unauthorized' });
        return;
      }
    } catch {
      // validateRequest reaches the session store; a failure there is not
      // permission to read the document.
      res.status(401).json({ statusCode: 401, message: 'Unauthorized' });
      return;
    }
    next();
  });

  SwaggerModule.setup(OPENAPI_ROUTE, app, buildOpenApiDocument(app));
}
