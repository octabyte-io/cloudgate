/**
 * Regenerates `backend/openapi.json` — `pnpm openapi:generate`.
 *
 * The document is checked in so that a change to a request contract arrives in
 * review as a diff on this file, next to the DTO that caused it. Run this
 * whenever a controller or a zod DTO changes; `test/openapi/openapi.spec.ts`
 * fails if the committed file and the code have drifted apart.
 *
 * No database is involved. `NestFactory.create` builds the module graph, which
 * is all the document is reflected from — there is deliberately no
 * `app.init()`, so no gateway binds, no scheduler starts and no `onModuleInit`
 * runs.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { buildOpenApiDocument, serializeOpenApiDocument } from '../src/openapi';

const OUTPUT = join(__dirname, '..', 'openapi.json');

async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    logger: false,
    // Without this a failure to build the graph exits the process silently,
    // and a truncated document would be written on the next run.
    abortOnError: false,
  });
  try {
    const document = buildOpenApiDocument(app);
    writeFileSync(OUTPUT, serializeOpenApiDocument(document));
    const operations = Object.values(document.paths).reduce(
      (total, item) => total + Object.keys(item ?? {}).length,
      0,
    );
    console.log(
      `openapi.json: ${Object.keys(document.paths).length} paths, ` +
        `${operations} operations, ` +
        `${Object.keys(document.components?.schemas ?? {}).length} schemas`,
    );
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
