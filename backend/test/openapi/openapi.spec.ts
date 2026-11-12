import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { OpenAPIObject } from '@nestjs/swagger';
import { AUTH } from '../../src/auth/auth.constants';

// validateEnv runs the moment app.module is first imported, so the environment
// has to be complete before the require below. The document is built from
// decorator metadata, so placeholders are enough, and `??=` leaves a real
// backend/.env alone. The port is one nothing listens on: the app this builds
// does issue one query (see `settleAuthContext`), and on 5432 it reached
// whatever a developer happened to be running there — a password refusal from
// an unrelated local Postgres, rather than the connection refusal CI gets.
process.env.DATABASE_URL ??= 'postgres://openapi:openapi@127.0.0.1:1/openapi';
process.env.APP_ENCRYPTION_SECRET ??=
  'test-encryption-secret-at-least-32-chars';
process.env.BETTER_AUTH_SECRET ??= 'test-auth-secret-at-least-32-chars-long';

const OPENAPI_JSON = join(__dirname, '..', '..', 'openapi.json');

// Both modules are reached through require() for the same reason
// test/utils/test-app.ts does it: ConfigModule snapshots process.env the
// moment app.module is imported, so the import cannot be hoisted above the
// assignments over it.
/* eslint-disable @typescript-eslint/no-require-imports */
const openapi = () =>
  require('../../src/openapi') as {
    buildOpenApiDocument: (app: INestApplication) => OpenAPIObject;
    serializeOpenApiDocument: (doc: OpenAPIObject) => string;
  };

async function generate(): Promise<{
  doc: OpenAPIObject;
  app: INestApplication;
}> {
  const { AppModule } = require('../../src/app.module') as {
    AppModule: new () => unknown;
  };
  /* eslint-enable @typescript-eslint/no-require-imports */

  // Deliberately no `app.init()`. The document is reflected off the module
  // graph, which NestFactory.create has already built; init would additionally
  // bind the realtime gateways, start the schedulers and run every
  // onModuleInit, none of which the document needs.
  const app = await NestFactory.create(AppModule, {
    logger: false,
    abortOnError: false,
  });
  await settleAuthContext(app);
  return { doc: openapi().buildOpenApiDocument(app), app };
}

/**
 * Building the app is not free of a database, though the document is. The
 * better-auth instance starts its `init()` the moment it is constructed
 * (`$context`), and that resolves the trusted origins with a query —
 * `resolveTrustedOrigins` in auth.config.ts — which fails here and is caught
 * and logged through `console.error`, at a moment of its own choosing.
 *
 * When that moment fell after this file had finished, jest's frozen console
 * set `process.exitCode = 1` (jest-runner's `freezeConsole`). With several
 * workers that lands on a worker and is lost; in-band it is the main process's
 * own code. CI's 2-vCPU runner gives the unit lane's `maxWorkers: "50%"` one
 * worker, so its first run exited 1 with all 3103 tests green. Awaiting the
 * context settles the query inside the file. The one refusal it is guaranteed
 * to produce is dropped rather than printed with a stack on every run; any
 * other `console.error` in that window still prints.
 */
async function settleAuthContext(app: INestApplication): Promise<void> {
  const original = console.error;
  const spy = jest
    .spyOn(console, 'error')
    .mockImplementation((...args: unknown[]) => {
      if (String(args[0]).startsWith('Failed to resolve trusted origins:'))
        return;
      original.apply(console, args);
    });
  try {
    await app.get<{ $context: Promise<unknown> }>(AUTH).$context;
  } finally {
    spy.mockRestore();
  }
}

describe('the instance publishes an OpenAPI document', () => {
  let doc: OpenAPIObject;
  let app: INestApplication;

  beforeAll(async () => {
    ({ doc, app } = await generate());
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  it('is an OpenAPI document describing the REST surface', () => {
    expect(doc.openapi).toMatch(/^3\./);
    expect(doc.info.title).toBe('Cloudgate API');

    const operations = Object.values(doc.paths).flatMap((item) =>
      Object.keys(item ?? {}),
    );
    // A floor, not an exact count: the point is that the whole surface is
    // described, not one hand-picked controller.
    expect(operations.length).toBeGreaterThan(400);
  });

  // The property the whole issue turns on. The frontend's union for a
  // deployment status was transcribed by hand; here it comes off the zod enum
  // in deployments/dto/deployment.dto.ts, so widening that enum moves the
  // document — and moves the checked-in openapi.json with it.
  it("a route's request shape is the one its zod DTO declares", () => {
    const list = doc.paths['/deployments']?.get;
    const status = list?.parameters?.find(
      (p) => 'name' in p && p.name === 'status',
    );

    expect(status).toMatchObject({
      in: 'query',
      required: false,
      schema: {
        type: 'string',
        enum: ['pending', 'running', 'done', 'error', 'cancelled', 'held'],
      },
    });
  });

  // Two shapes the F02 client had to work out by hand, called out in the
  // issue. A bare Nest controller signature says nothing about either, so
  // without the annotations both are documented as an empty JSON 200.
  it('says the deployment log route answers in text/plain', () => {
    const ok = doc.paths['/deployments/{deploymentId}/logs']?.get?.responses[
      '200'
    ] as { content?: Record<string, unknown> };

    expect(Object.keys(ok.content ?? {})).toEqual(['text/plain']);
  });

  it("says the member list is better-auth's { members, total } envelope", () => {
    const ok = doc.paths['/organizations/members']?.get?.responses['200'] as {
      content?: { 'application/json'?: { schema?: Record<string, unknown> } };
    };
    const schema = ok.content?.['application/json']?.schema;

    expect(schema).toMatchObject({ type: 'object' });
    expect(Object.keys((schema as { properties: object }).properties)).toEqual([
      'members',
      'total',
    ]);
  });

  // Two unrelated controllers both export a class called TestConnectionDto.
  // Swagger keys components by class name, so without distinct schema ids one
  // silently overwrites the other and a generated client posts an AI
  // provider's credentials to the destinations route.
  it('does not let two same-named DTOs collide into one schema', () => {
    const body = doc.paths['/destinations/test-connection']?.post?.requestBody;
    const ref = (
      body as { content: Record<string, { schema: { $ref: string } }> }
    ).content['application/json'].schema.$ref;
    const schema = doc.components?.schemas?.[
      ref.replace('#/components/schemas/', '')
    ] as { properties: Record<string, unknown> };

    // The destination payload, not the AI provider's apiUrl/apiKey/model.
    expect(Object.keys(schema.properties)).toContain('accessKey');
    expect(Object.keys(schema.properties)).not.toContain('apiUrl');
  });

  // better-auth mounts one `@All('*splat')` catch-all. As a path it is
  // `/api/auth/{splat}` across eight verbs with no body and no response —
  // eight operations that describe nothing and that a code generator would
  // happily turn into eight useless methods.
  it("leaves better-auth's catch-all out rather than describing it wrongly", () => {
    expect(Object.keys(doc.paths)).not.toContain('/api/auth/{splat}');
  });

  // The reason to check the document in: a contract change has to show up as
  // a reviewable diff. That only works if regenerating is byte-stable.
  it('serializes identically on a second, independent generation', async () => {
    const { serializeOpenApiDocument } = openapi();
    const second = await generate();
    try {
      expect(serializeOpenApiDocument(second.doc)).toBe(
        serializeOpenApiDocument(doc),
      );
    } finally {
      await second.app.close();
    }
  }, 120_000);

  it('matches the checked-in backend/openapi.json', () => {
    expect(readFileSync(OPENAPI_JSON, 'utf8')).toBe(
      openapi().serializeOpenApiDocument(doc),
    );
  });
});
