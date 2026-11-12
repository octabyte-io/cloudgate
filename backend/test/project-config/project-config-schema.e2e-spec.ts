import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import Ajv from 'ajv';
import request from 'supertest';
import { App } from 'supertest/types';
import { parse } from 'yaml';

import { createTestApp, TestAppContext } from '../utils/test-app';

jest.setTimeout(120_000);

/** The same prototype-shaped sample the parser's unit spec reads. */
const SAMPLE = parse(
  readFileSync(join(__dirname, 'cloudgate.sample.yaml'), 'utf8'),
  { logLevel: 'error' },
) as Record<string, unknown>;

/**
 * The served JSON Schema is checked with Ajv, a validator independent of Zod,
 * so this proves what an editor will see, not what Zod thinks it said.
 * A sample the parser accepts and this schema refuses, or an unknown field
 * this schema lets through, is the parser and the schema drifting apart.
 */
describe('Project config JSON Schema (e2e)', () => {
  let ctx: TestAppContext;
  let server: App;
  let res: request.Response;
  let schema: Record<string, unknown>;

  beforeAll(async () => {
    ctx = await createTestApp();
    server = ctx.app.getHttpServer() as App;
    // No cookie and no API key: an editor fetching the schema has neither.
    res = await request(server).get('/schema/project-config/v1.json');
    schema = res.body as Record<string, unknown>;
  }, 120_000);

  afterAll(async () => {
    await ctx?.teardown();
  });

  it('serves the schema without a session', () => {
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(schema.$schema).toBe('http://json-schema.org/draft-07/schema#');
  });

  it('accepts the prototype-shaped sample', () => {
    const validate = new Ajv({ strict: false }).compile(schema);
    expect(validate(SAMPLE)).toBe(true);
  });

  it('rejects an unknown field', () => {
    const validate = new Ajv({ strict: false }).compile(schema);
    const services = SAMPLE.services as Record<string, Record<string, unknown>>;
    const withUnknown = {
      ...SAMPLE,
      services: { ...services, web: { ...services.web, replicas: 2 } },
    };
    expect(validate(withUnknown)).toBe(false);
  });

  it('accepts a link under env and refuses one under build_args or build_secrets', () => {
    const validate = new Ajv({ strict: false }).compile(schema);
    const web = (fields: Record<string, unknown>) => ({
      version: 1,
      services: { web: { kind: 'web', ...fields } },
    });
    const link = { DATABASE_URL: 'pg-1.url' };

    expect(validate(web({ env: ['NODE_ENV', link] }))).toBe(true);
    expect(validate(web({ build_args: [link] }))).toBe(false);
    expect(validate(web({ build_secrets: [link] }))).toBe(false);
    expect(validate(web({ env: [{ A: 'pg-1.url', B: 'pg-1.host' }] }))).toBe(
      false,
    );
    expect(validate(web({ env: [{ A: 'pg-1' }] }))).toBe(false);
  });

  it('accepts a mysql entry and rejects an unknown field on it, MariaDB only console-managed', () => {
    const validate = new Ajv({ strict: false }).compile(schema);
    const mysql = {
      kind: 'mysql',
      version: '8.4',
      database: 'shop',
      user: 'root',
      description: 'Orders',
      size: 'small',
      env: ['TZ'],
    };
    expect(validate({ version: 1, services: { db: mysql } })).toBe(true);
    expect(
      validate({ version: 1, services: { db: { ...mysql, charset: 'utf8' } } }),
    ).toBe(false);
    expect(
      validate({
        version: 1,
        services: { db: { ...mysql, user: 'u'.repeat(33) } },
      }),
    ).toBe(false);
    expect(
      validate({ version: 1, services: { db: { kind: 'mariadb' } } }),
    ).toBe(false);
    expect(
      validate({
        version: 1,
        services: { db: { kind: 'mariadb', managed: 'console' } },
      }),
    ).toBe(true);
  });

  it('accepts a web-private with its port, and rejects one with no port or an unknown field', () => {
    const validate = new Ajv({ strict: false }).compile(schema);
    const portless = {
      kind: 'web-private',
      source: { github: 'acme/api' },
      build: { type: 'dockerfile' },
      env: ['DATABASE_URL'],
    };
    const api = { ...portless, port: 4000 };
    const one = (entry: object) => ({ version: 1, services: { api: entry } });

    expect(validate(one(api))).toBe(true);
    expect(validate(one(portless))).toBe(false);
    expect(validate(one({ ...api, domain: 'api.example.com' }))).toBe(false);
  });

  it('accepts a worker, and rejects a port or an unknown field on one', () => {
    const validate = new Ajv({ strict: false }).compile(schema);
    const worker = {
      kind: 'worker',
      description: 'Sends the queued mail',
      source: { github: 'acme/jobs', path: '/jobs' },
      build: { type: 'dockerfile', dockerfile: 'Dockerfile' },
      command: 'node',
      args: ['worker.js'],
      size: 'small',
      env: ['QUEUE_URL'],
      build_args: ['NODE_ENV'],
      build_secrets: ['NPM_TOKEN'],
    };
    const config = (jobs: Record<string, unknown>) => ({
      version: 1,
      services: { jobs },
    });
    expect(validate(config(worker))).toBe(true);
    expect(validate(config({ kind: 'worker' }))).toBe(true);
    expect(validate(config({ ...worker, port: 3000 }))).toBe(false);
    expect(validate(config({ ...worker, replicas: 2 }))).toBe(false);
  });

  it('rejects an unknown version and a bad Config name', () => {
    const validate = new Ajv({ strict: false }).compile(schema);
    expect(validate({ ...SAMPLE, version: 2 })).toBe(false);
    expect(validate({ version: 1, services: { Web: { kind: 'redis' } } })).toBe(
      false,
    );
  });

  describe('a kind: cron entry', () => {
    const report = {
      kind: 'cron',
      command: 'node dist/report.js',
      schedule: '0 3 * * MON-FRI',
      timezone: 'Europe/Berlin',
      timeout: '30m',
      source: { github: 'acme/reports' },
      build: { type: 'dockerfile' },
      size: 'small',
      env: ['DATABASE_URL'],
    };
    const config = (entry: Record<string, unknown>) => ({
      version: 1,
      services: { report: entry },
    });

    it('accepts one', () => {
      const validate = new Ajv({ strict: false }).compile(schema);
      expect(validate(config(report))).toBe(true);
    });

    it('rejects an unknown field on it, and a port', () => {
      const validate = new Ajv({ strict: false }).compile(schema);
      expect(validate(config({ ...report, retries: 3 }))).toBe(false);
      expect(validate(config({ ...report, port: 3000 }))).toBe(false);
    });

    it('rejects one without its command or schedule', () => {
      const validate = new Ajv({ strict: false }).compile(schema);
      for (const field of ['command', 'schedule']) {
        const without: Record<string, unknown> = { ...report };
        delete without[field];
        expect(validate(config(without))).toBe(false);
      }
    });
  });

  describe('a kind: bucket entry', () => {
    const config = (entry: Record<string, unknown>) => ({
      version: 1,
      services: { uploads: entry },
    });

    it('accepts one with its kind and a description', () => {
      const validate = new Ajv({ strict: false }).compile(schema);
      expect(validate(config({ kind: 'bucket' }))).toBe(true);
      expect(
        validate(config({ kind: 'bucket', description: 'Product photos' })),
      ).toBe(true);
    });

    it('rejects a size, variable names, a region or versioning on it', () => {
      const validate = new Ajv({ strict: false }).compile(schema);
      for (const extra of [
        { size: 'small' },
        { env: ['AWS_REGION'] },
        { region: 'eu-west-1' },
        { versioning: true },
      ]) {
        expect(validate(config({ kind: 'bucket', ...extra }))).toBe(false);
      }
    });
  });
});
