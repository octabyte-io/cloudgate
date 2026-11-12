import { eq } from 'drizzle-orm';
import request from 'supertest';
import { App } from 'supertest/types';
import { templateCatalogue } from '../../src/db/schema';
import { FETCH_CLIENT } from '../../src/git-providers/fetch.provider';
import { RemoteExecService } from '../../src/remote/remote-exec.service';
import { createTestApp, TestAppContext } from '../utils/test-app';
import {
  CatalogueHost,
  catalogueFile,
  legacyCatalogueJson,
  MIRROR,
  webTemplate,
} from './catalogue-host.fixture';

jest.setTimeout(120_000);

/**
 * An install whose `CLOUDGATE_TEMPLATES_URL` names a mirror serving one file
 * in place (ADR-0062, ADR-0072). A mirror kept from before ADR-0072 still
 * serves a format-1 `catalogue.json`: it is refused with a reason that names
 * the change, and the saved copy is served until the mirror serves the zip.
 *
 * Set at module scope, before `createTestApp` requires `AppModule`, because
 * `ConfigModule.forRoot({ validate })` snapshots `process.env` on that first
 * import; restored in `afterAll`.
 */
const urlBefore = process.env.CLOUDGATE_TEMPLATES_URL;
const oldUrlBefore = process.env.CLOUDGATE_TEMPLATES_BASE_URL;
process.env.CLOUDGATE_TEMPLATES_URL = MIRROR;
delete process.env.CLOUDGATE_TEMPLATES_BASE_URL;

/** The refusal, written out rather than imported (§1.7). */
const LEGACY_REFUSAL =
  'The newest template catalogue was refused: The catalogue is a catalogue.json, the format before ADR-0072; this Cloudgate reads a catalogue.zip';

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const HOUR = 60 * 60 * 1000;

interface Listed {
  templates: { id: string }[];
  copy: { fetchedAt: string; checkedAt: string; problem: string | null };
}

describe('The Template catalogue read from a mirror (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let cookie: string[];
  const host = new CatalogueHost();

  beforeAll(async () => {
    ctx = await createTestApp({
      overrideProviders: [
        { provide: FETCH_CLIENT, useValue: host.fetch },
        {
          provide: RemoteExecService,
          useValue: { execAsync: jest.fn(), execAsyncRemote: jest.fn() },
        },
      ],
    });
    server = ctx.app.getHttpServer() as App;
  });

  afterAll(async () => {
    await ctx.teardown();
    if (urlBefore === undefined) delete process.env.CLOUDGATE_TEMPLATES_URL;
    else process.env.CLOUDGATE_TEMPLATES_URL = urlBefore;
    if (oldUrlBefore !== undefined)
      process.env.CLOUDGATE_TEMPLATES_BASE_URL = oldUrlBefore;
  });

  beforeEach(async () => {
    await ctx.resetDb();
    host.reset();
    const res = await request(server)
      .post('/api/auth/sign-up/email')
      .send(owner);
    expect(res.status).toBe(200);
    cookie = res.headers['set-cookie'] as unknown as string[];
  });

  const list = () => request(server).get('/templates').set('Cookie', cookie);

  /** Ages the saved copy's last check, as an hour passing would. */
  async function ageLastCheck(by: number) {
    const [row] = await ctx.db
      .select({ checkedAt: templateCatalogue.checkedAt })
      .from(templateCatalogue);
    await ctx.db
      .update(templateCatalogue)
      .set({
        checkedAt: new Date(Date.parse(row.checkedAt) - by).toISOString(),
      })
      .where(eq(templateCatalogue.sourceUrl, MIRROR));
  }

  it('lists the templates of the catalogue.zip the mirror serves, held by its ETag', async () => {
    host.served = { body: catalogueFile(webTemplate('uptime-kuma')) };

    const res = await list();

    expect(res.status).toBe(200);
    expect((res.body as Listed).templates.map((t) => t.id)).toEqual([
      'uptime-kuma',
    ]);
    expect(host.asked).toEqual([MIRROR]);
    const [row] = await ctx.db.select().from(templateCatalogue);
    expect(row).toMatchObject({ sourceUrl: MIRROR, release: 'etag "v1"' });
  });

  describe('a mirror still serving a catalogue.json', () => {
    it('is refused, naming the change, and the saved copy kept and served', async () => {
      host.served = { body: catalogueFile(webTemplate('uptime-kuma')) };
      const first = (await list()).body as Listed;
      await ageLastCheck(HOUR + 1000);
      host.release = 'v2';
      host.served = {
        body: legacyCatalogueJson(
          webTemplate('uptime-kuma'),
          webTemplate('gatus', { name: 'Gatus' }),
        ),
      };

      const res = await list();

      expect(res.status).toBe(200);
      const body = res.body as Listed;
      expect(body.templates.map((t) => t.id)).toEqual(['uptime-kuma']);
      expect(body.copy.fetchedAt).toBe(first.copy.fetchedAt);
      expect(body.copy.problem).toBe(LEGACY_REFUSAL);
      const [row] = await ctx.db.select().from(templateCatalogue);
      // Still the zip's version: the refused file replaced nothing.
      expect(row.release).toBe('etag "v1"');

      // Within the hour the kept copy is served again, problem and all.
      const again = await list();
      expect(again.status).toBe(200);
      expect((again.body as Listed).templates.map((t) => t.id)).toEqual([
        'uptime-kuma',
      ]);
      expect((again.body as Listed).copy.problem).toBe(LEGACY_REFUSAL);
    });

    it('answers 502 with no saved copy, never an empty list', async () => {
      host.served = { body: legacyCatalogueJson(webTemplate('uptime-kuma')) };

      const res = await list();

      expect(res.status).toBe(502);
      expect((res.body as { message: string }).message).toBe(LEGACY_REFUSAL);
      expect(await ctx.db.select().from(templateCatalogue)).toEqual([]);
    });
  });
});
