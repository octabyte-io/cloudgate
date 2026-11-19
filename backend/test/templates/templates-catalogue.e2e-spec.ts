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
  LATEST,
  releaseUrl,
  SQUARE_SVG,
  webTemplate,
} from './catalogue-host.fixture';
import { png } from './check/catalogue.fixture';
import { catalogueZip, zipOf } from './zip.fixture';

jest.setTimeout(120_000);

/**
 * The catalogue reader on a fresh install (ADR-0062, ADR-0072): nothing set,
 * so it reads the newest `cg-templates` release's `catalogue.zip`, keeps the
 * last good copy in the database and re-checks it at most once an hour.
 *
 * Both settings are cleared at module scope, before `createTestApp` requires
 * `AppModule`, because `ConfigModule.forRoot({ validate })` snapshots
 * `process.env` on that first import; restored in `afterAll`.
 */
const urlBefore = process.env.CLOUDGATE_TEMPLATES_URL;
const oldUrlBefore = process.env.CLOUDGATE_TEMPLATES_BASE_URL;
delete process.env.CLOUDGATE_TEMPLATES_URL;
delete process.env.CLOUDGATE_TEMPLATES_BASE_URL;

const owner = {
  name: 'Grace Hopper',
  email: 'grace@example.com',
  password: 'super-secret-password',
};

const HOUR = 60 * 60 * 1000;

interface Listed {
  templates: {
    id: string;
    revision: string;
    name: string;
    description: string;
    version: string | null;
    tags: string[];
    links: Record<string, string>;
    logo: string;
    runsOn: string[];
    page: string | null;
  }[];
  copy: { fetchedAt: string; checkedAt: string; problem: string | null };
}

describe('The Template catalogue reader (e2e)', () => {
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
    if (urlBefore !== undefined)
      process.env.CLOUDGATE_TEMPLATES_URL = urlBefore;
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
      .where(eq(templateCatalogue.sourceUrl, LATEST));
  }

  describe('on a fresh install', () => {
    it('reads the official catalogue.zip, offering what it can read and hiding the rest', async () => {
      host.served = {
        body: catalogueFile(
          webTemplate('uptime-kuma'),
          // Needs a Cloudgate this one is not: hidden, and the rest still listed.
          webTemplate('from-the-future', { cloudgate: '99.0.0' }),
        ),
      };

      const res = await list();

      expect(res.status).toBe(200);
      const body = res.body as Listed;
      expect(body.templates).toEqual([
        {
          id: 'uptime-kuma',
          revision: 'c0ffee1',
          name: 'Uptime Kuma',
          description: 'A self-hosted monitoring tool.',
          version: '1.23',
          tags: ['monitoring'],
          links: {
            website: 'https://uptime.kuma.pet',
            source: 'https://github.com/louislam/uptime-kuma',
          },
          // An address on our own origin, never the logo itself (#123).
          logo: '/backend/templates/uptime-kuma/logo?rev=c0ffee1',
          runsOn: ['server', 'aws', 'gcp'],
          // The official catalogue's templates open their directory page.
          page: 'https://octabyte-io.github.io/cg-templates/templates/uptime-kuma/',
        },
      ]);
      expect(body.copy.problem).toBeNull();
      // The official address, followed to its release and on to the zip.
      expect(host.asked[0]).toBe(
        'https://github.com/octabyte-io/cg-templates/releases/latest/download/catalogue.zip',
      );
      expect(host.asked[1]).toBe(releaseUrl('v1'));
      expect(host.bodiesRead()).toBe(1);
    });

    it('lists the tags of the Templates it offers', async () => {
      host.served = {
        body: catalogueFile(
          webTemplate('uptime-kuma', { tags: ['monitoring', 'status'] }),
          webTemplate('gatus', { name: 'Gatus', tags: ['monitoring'] }),
        ),
      };

      const res = await request(server)
        .get('/templates/tags')
        .set('Cookie', cookie);

      expect(res.status).toBe(200);
      expect(res.body).toEqual(['monitoring', 'status']);
    });

    it('takes no catalogue address from the request', async () => {
      const res = await request(server)
        .get('/templates')
        .query({ baseUrl: 'https://attacker.example' })
        .set('Cookie', cookie);

      expect(res.status).toBe(400);
      expect(host.asked).toEqual([]);
    });
  });

  describe('the saved copy', () => {
    it('is kept in the database with when it was checked and which version it is', async () => {
      host.served = { body: catalogueFile(webTemplate('uptime-kuma')) };

      await list();

      const rows = await ctx.db.select().from(templateCatalogue);
      expect(rows).toEqual([
        expect.objectContaining({
          sourceUrl: LATEST,
          release: releaseUrl('v1'),
          problem: null,
        }),
      ]);
      expect(rows[0].fetchedAt).toBe(rows[0].checkedAt);
    });

    it('holds the zip exactly as fetched, as base64 text', async () => {
      const zip = catalogueFile(webTemplate('uptime-kuma'));
      host.served = { body: zip };

      await list();

      const [row] = await ctx.db.select().from(templateCatalogue);
      // A zip is not UTF-8: a text round trip would have changed its bytes.
      expect(Buffer.from(row.body, 'base64').equals(zip)).toBe(true);
    });

    it('is served without a check within the hour', async () => {
      host.served = { body: catalogueFile(webTemplate('uptime-kuma')) };
      await list();
      host.asked.length = 0;

      const res = await list();

      expect(res.status).toBe(200);
      expect((res.body as Listed).templates.map((t) => t.id)).toEqual([
        'uptime-kuma',
      ]);
      expect(host.asked).toEqual([]);
    });

    it('is re-checked after an hour, and a version already held is not fetched again', async () => {
      host.served = { body: catalogueFile(webTemplate('uptime-kuma')) };
      const first = (await list()).body as Listed;
      await ageLastCheck(HOUR + 1000);
      host.asked.length = 0;

      const res = await list();

      expect(res.status).toBe(200);
      // Only the hop that names the release: no release download, no body.
      expect(host.asked).toEqual([LATEST]);
      const body = res.body as Listed;
      expect(body.copy.fetchedAt).toBe(first.copy.fetchedAt);
      expect(Date.parse(body.copy.checkedAt)).toBeGreaterThan(
        Date.parse(first.copy.checkedAt) - HOUR,
      );
    });

    it('is replaced by a newer version', async () => {
      host.served = { body: catalogueFile(webTemplate('uptime-kuma')) };
      await list();
      await ageLastCheck(HOUR + 1000);
      host.release = 'v2';
      host.served = {
        body: catalogueFile(
          webTemplate('uptime-kuma'),
          webTemplate('gatus', { name: 'Gatus' }),
        ),
      };

      const res = await list();

      expect((res.body as Listed).templates.map((t) => t.id)).toEqual([
        'uptime-kuma',
        'gatus',
      ]);
      const [row] = await ctx.db.select().from(templateCatalogue);
      expect(row.release).toBe(releaseUrl('v2'));
    });
  });

  describe('an unreachable catalogue', () => {
    it('serves the saved copy, saying it could not be reached and how old the copy is', async () => {
      host.served = { body: catalogueFile(webTemplate('uptime-kuma')) };
      const first = (await list()).body as Listed;
      await ageLastCheck(HOUR + 1000);
      host.unreachable = true;

      const res = await list();

      expect(res.status).toBe(200);
      const body = res.body as Listed;
      expect(body.templates.map((t) => t.id)).toEqual(['uptime-kuma']);
      expect(body.copy.fetchedAt).toBe(first.copy.fetchedAt);
      expect(body.copy.problem).toMatch(
        /^The template catalogue at github\.com could not be reached/,
      );
    });

    it('answers 502 with no saved copy, never an empty list', async () => {
      host.unreachable = true;

      const res = await list();

      expect(res.status).toBe(502);
      expect((res.body as { message: string }).message).toMatch(
        /github\.com could not be reached/,
      );
      expect(await ctx.db.select().from(templateCatalogue)).toEqual([]);
    });

    it('answers 502 for an error status, never an empty list', async () => {
      host.served = { status: 500 };

      const res = await list();

      expect(res.status).toBe(502);
      expect((res.body as { message: string }).message).toMatch(/HTTP 500/);
    });

    it('answers 504 when the catalogue does not answer within ten seconds', async () => {
      host.served = { hangs: true };

      const res = await list();

      expect(res.status).toBe(504);
      expect((res.body as { message: string }).message).toMatch(
        /github\.com did not answer within 10 seconds/,
      );
    });
  });

  describe('a file that is not a catalogue', () => {
    it('is refused over 10 MB, and the saved copy kept', async () => {
      host.served = { body: catalogueFile(webTemplate('uptime-kuma')) };
      const first = (await list()).body as Listed;
      await ageLastCheck(HOUR + 1000);
      host.release = 'v2';
      host.served = { body: 'x'.repeat(10 * 1024 * 1024 + 1) };

      const res = await list();

      expect(res.status).toBe(200);
      const body = res.body as Listed;
      expect(body.templates.map((t) => t.id)).toEqual(['uptime-kuma']);
      expect(body.copy.fetchedAt).toBe(first.copy.fetchedAt);
      expect(body.copy.problem).toMatch(/larger than 10 MB/);
      const [row] = await ctx.db.select().from(templateCatalogue);
      expect(row.release).toBe(releaseUrl('v1'));
    });

    it('is refused when invalid, and the saved copy kept', async () => {
      host.served = { body: catalogueFile(webTemplate('uptime-kuma')) };
      await list();
      await ageLastCheck(HOUR + 1000);
      host.release = 'v2';
      host.served = {
        body: zipOf([
          {
            path: 'catalogue.json',
            bytes: JSON.stringify({ format: 3, templates: [] }),
          },
        ]),
      };

      const res = await list();

      expect(res.status).toBe(200);
      const body = res.body as Listed;
      expect(body.templates.map((t) => t.id)).toEqual(['uptime-kuma']);
      expect(body.copy.problem).toMatch(
        /^The newest template catalogue was refused: The catalogue is format 3/,
      );
    });

    it('answers 502 with no saved copy to keep', async () => {
      host.served = { body: 'x'.repeat(10 * 1024 * 1024 + 1) };

      const res = await list();

      expect(res.status).toBe(502);
      expect((res.body as { message: string }).message).toMatch(
        /larger than 10 MB/,
      );
      expect(await ctx.db.select().from(templateCatalogue)).toEqual([]);
    });
  });

  /**
   * ADR-0072: the website's `index.md` and `screenshots/` sit beside a
   * template in the repository, but CI leaves them out of the zip. A zip that
   * holds one is refused as a whole, not by hiding that one template.
   */
  describe('a zip holding a website file', () => {
    const withWebsite = (id: string) => {
      const folder = webTemplate(id);
      return { ...folder, files: { ...folder.files, 'index.md': '# Gatus\n' } };
    };

    it('is refused whole, naming the file, and the saved copy kept', async () => {
      host.served = { body: catalogueFile(webTemplate('uptime-kuma')) };
      const first = (await list()).body as Listed;
      await ageLastCheck(HOUR + 1000);
      host.release = 'v2';
      host.served = {
        body: catalogueFile(webTemplate('uptime-kuma'), withWebsite('gatus')),
      };

      const res = await list();

      expect(res.status).toBe(200);
      const body = res.body as Listed;
      // Not even the sound template in the same zip is taken from it.
      expect(body.templates.map((t) => t.id)).toEqual(['uptime-kuma']);
      expect(body.copy.fetchedAt).toBe(first.copy.fetchedAt);
      expect(body.copy.problem).toBe(
        'The newest template catalogue was refused: The catalogue holds templates/gatus/index.md, a website file; a catalogue leaves the website out',
      );
      const [row] = await ctx.db.select().from(templateCatalogue);
      expect(row.release).toBe(releaseUrl('v1'));
    });

    it('answers 502 with no saved copy, never an empty list', async () => {
      host.served = { body: catalogueFile(withWebsite('gatus')) };

      const res = await list();

      expect(res.status).toBe(502);
      expect((res.body as { message: string }).message).toMatch(
        /templates\/gatus\/index\.md, a website file/,
      );
      expect(await ctx.db.select().from(templateCatalogue)).toEqual([]);
    });
  });
  /**
   * #123: the list carries each logo's address, not the logo, so the
   * catalogue's ~580 logos no longer travel inside one 10 MB answer. The
   * logo route serves the bytes from the saved copy.
   */
  describe("a Template's logo", () => {
    const logo = (id: string) =>
      request(server).get(`/templates/${id}/logo`).set('Cookie', cookie);

    it('is listed as an address on our own origin, never a data: address', async () => {
      host.served = {
        body: catalogueFile(
          webTemplate('uptime-kuma'),
          webTemplate('gatus', { name: 'Gatus' }),
        ),
      };

      const body = (await list()).body as Listed;

      expect(body.templates.map((t) => t.logo)).toEqual([
        '/backend/templates/uptime-kuma/logo?rev=c0ffee1',
        '/backend/templates/gatus/logo?rev=c0ffee1',
      ]);
    });

    it('serves an SVG logo with its type, a year of caching and nosniff', async () => {
      host.served = { body: catalogueFile(webTemplate('uptime-kuma')) };

      const res = await logo('uptime-kuma').buffer(true);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('image/svg+xml');
      expect(res.headers['cache-control']).toBe(
        'public, max-age=31536000, immutable',
      );
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(Buffer.from(res.body as Buffer).toString('utf8')).toBe(SQUARE_SVG);
    });

    it('serves an SVG opened directly under a policy that runs no script', async () => {
      const scripted =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><script>alert(document.cookie)</script><circle cx="32" cy="32" r="30"/></svg>';
      const folder = webTemplate('uptime-kuma');
      host.served = {
        body: catalogueFile({
          ...folder,
          files: { ...folder.files, 'logo.svg': scripted },
        }),
      };

      const res = await logo('uptime-kuma').buffer(true);

      expect(res.status).toBe(200);
      expect(res.headers['content-security-policy']).toBe(
        "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      );
    });

    it('serves a PNG logo as image/png, byte for byte, with no SVG policy', async () => {
      const logoPng = png(64, 64);
      const rest = Object.fromEntries(
        Object.entries(webTemplate('uptime-kuma').files).filter(
          ([path]) => path !== 'logo.svg',
        ),
      );
      host.served = {
        body: catalogueZip([
          { id: 'uptime-kuma', files: { ...rest, 'logo.png': logoPng } },
        ]),
      };

      const res = await logo('uptime-kuma').buffer(true);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['content-security-policy']).toBeUndefined();
      expect(
        Buffer.from(res.body as Buffer).equals(
          Buffer.from(logoPng.base64, 'base64'),
        ),
      ).toBe(true);
    });

    it('answers 404 for a Template the catalogue does not hold', async () => {
      host.served = { body: catalogueFile(webTemplate('uptime-kuma')) };

      const res = await logo('no-such-template');

      expect(res.status).toBe(404);
    });

    it('answers 404 for a Template the check hides', async () => {
      host.served = {
        body: catalogueFile(
          webTemplate('uptime-kuma'),
          webTemplate('from-the-future', { cloudgate: '99.0.0' }),
        ),
      };

      const res = await logo('from-the-future');

      expect(res.status).toBe(404);
    });
  });
});
