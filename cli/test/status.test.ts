import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { run } from '../src/run.js';

/**
 * `cloudgate status` driven as a whole run, against an Instance that `fetch`
 * stands in for (the way `run.test.ts` drives every command). What the built
 * command reads from a real Instance is the CLI e2e suite's job.
 */

const instance = 'https://cloud.acme.dev';
const now = new Date('2026-11-03T12:00:00Z');

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type Routes = Record<string, unknown>;

/**
 * A folder linked to `configName` in staging of Project shop, and an Instance
 * answering the target lookup plus `routes` (path → body, or a Response).
 */
async function status(
  configName: string,
  routes: Routes,
  argv: string[] = [],
): Promise<{ code: number; stdout: string; stderr: string; asked: string[] }> {
  const cwd = mkdtempSync(join(tmpdir(), 'cloudgate-status-'));
  mkdirSync(join(cwd, '.cloudgate'));
  writeFileSync(
    join(cwd, '.cloudgate', 'link.json'),
    JSON.stringify({
      instance,
      organizationId: 'org_1',
      projectId: 'prj_1',
      environmentId: 'env_s',
      serviceConfigName: configName,
      names: {
        organization: 'Shop Inc',
        project: 'shop',
        environment: 'staging',
        service: configName,
      },
    }),
  );
  const lookup: Routes = {
    '/settings/about': {
      product: 'cloudgate',
      version: '9.9.9',
      apiUrl: 'https://api.cloud.acme.dev',
    },
    '/organizations': [{ id: 'org_1', name: 'Shop Inc' }],
    '/projects': [{ projectId: 'prj_1', name: 'shop', env: 'SECRET=1' }],
    '/environments?projectId=prj_1': [
      { environmentId: 'env_s', name: 'staging' },
    ],
    '/environments/env_s': {
      environmentId: 'env_s',
      name: 'staging',
      services: [
        {
          serviceType: 'application',
          serviceId: 'app_1',
          name: 'Shop API',
          configName: 'api',
        },
        {
          serviceType: 'compose',
          serviceId: 'cmp_1',
          name: 'Shop stack',
          configName: 'stack',
        },
        {
          serviceType: 'postgres',
          serviceId: 'pg_1',
          name: 'Shop DB',
          configName: 'db',
        },
      ],
    },
  };
  const out = { stdout: '', stderr: '' };
  const asked: string[] = [];
  const code = await run({
    argv: ['status', ...argv],
    env: { CLOUDGATE_KEY: 'cg_secret' },
    cwd,
    prompter: {
      choose: () => Promise.reject(new Error('asked a question')),
      confirm: () => Promise.reject(new Error('asked a question')),
      secret: () => Promise.reject(new Error('asked a question')),
      text: () => Promise.reject(new Error('asked a question')),
    },
    stdinIsTTY: false,
    stdoutIsTTY: false,
    stderrIsTTY: false,
    stdout: (text) => (out.stdout += text),
    stderr: (text) => (out.stderr += text),
    fetch: (input) => {
      const path = (input as string).slice(`${instance}/backend`.length);
      asked.push(path);
      const body = { ...lookup, ...routes }[path];
      if (body instanceof Response) return Promise.resolve(body);
      return Promise.resolve(
        body === undefined
          ? json({ statusCode: 404, message: 'Not found' }, 404)
          : json(body),
      );
    },
    now: () => now,
  });
  return { code, ...out, asked };
}

/** An uploaded Application, running, with one Domain and one Deployment. */
const runningApi: Routes = {
  '/applications/app_1': {
    applicationId: 'app_1',
    applicationStatus: 'running',
    sourceType: 'drop',
    env: 'STRIPE_KEY=sk_live_1',
    buildSecrets: 'NPM_TOKEN=npm_1',
  },
  '/applications/app_1/domains': [
    { domainId: 'dom_1', host: 'api-staging.shop.example', path: '/' },
  ],
  '/applications/app_1/deployments': [
    {
      deploymentId: 'dpl_new',
      status: 'done',
      createdAt: '2026-11-03T11:56:00.000Z',
    },
    {
      deploymentId: 'dpl_old',
      status: 'error',
      createdAt: '2026-11-02T11:56:00.000Z',
    },
  ],
};

describe('status', () => {
  it("prints an Application's facts as aligned columns", async () => {
    const result = await status('api', runningApi);

    expect({ code: result.code, stderr: result.stderr }).toEqual({
      code: 0,
      stderr: `Using instance ${instance}\n`,
    });
    expect(result.stdout).toBe(
      [
        'Service      api (Application)',
        'Environment  staging',
        'Project      shop',
        `Instance     ${instance}`,
        'State        running',
        'Source       uploaded files',
        'Domains      api-staging.shop.example',
        'Latest       Deployment dpl_new  done  4 minutes ago',
        '',
      ].join('\n'),
    );
    expect(result.stderr).toContain(`Using instance ${instance}`);
    // The Application's variable values are never printed.
    expect(result.stdout + result.stderr).not.toMatch(/sk_live|npm_1/);
  });

  it('prints the same facts as JSON alone on stdout with --json', async () => {
    const result = await status('api', runningApi, ['--json']);

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      instance,
      organization: { id: 'org_1', name: 'Shop Inc' },
      project: { id: 'prj_1', name: 'shop' },
      environment: { id: 'env_s', name: 'staging' },
      service: {
        id: 'app_1',
        configName: 'api',
        name: 'Shop API',
        kind: 'application',
      },
      state: 'running',
      source: { type: 'uploaded' },
      domains: ['api-staging.shop.example'],
      latestDeployment: {
        id: 'dpl_new',
        status: 'done',
        createdAt: '2026-11-03T11:56:00.000Z',
      },
    });
    expect(result.stdout).not.toMatch(/sk_live|npm_1|SECRET/);
  });

  it('reports a stopped Compose stack with no Deployment yet, and exits 0', async () => {
    const result = await status('stack', {
      '/compose/cmp_1': {
        composeId: 'cmp_1',
        composeStatus: 'stopped',
        sourceType: 'github',
        owner: 'shop',
        repository: 'stack',
        env: 'DB_PASSWORD=hunter2',
      },
      '/compose/cmp_1/domains': [
        { host: 'shop.example', path: '/' },
        { host: 'shop.example', path: '/admin' },
      ],
      '/compose/cmp_1/deployments': [],
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      [
        'Service      stack (Compose stack)',
        'Environment  staging',
        'Project      shop',
        `Instance     ${instance}`,
        'State        stopped',
        'Source       github shop/stack',
        'Domains      shop.example, shop.example/admin',
        'Latest       no Deployment yet',
        '',
      ].join('\n'),
    );
    expect(result.stdout).not.toContain('hunter2');
  });

  it('reports a Database by its image, asking no Domains or Deployments read', async () => {
    const result = await status(
      'db',
      {
        '/postgres/pg_1': {
          postgresId: 'pg_1',
          applicationStatus: 'done',
          dockerImage: 'postgres:18',
          databasePassword: 'pg_secret',
        },
      },
      ['--json'],
    );

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      service: { configName: 'db', kind: 'postgres' },
      state: 'done',
      source: { type: 'image', image: 'postgres:18' },
      domains: [],
      latestDeployment: null,
    });
    expect(result.stdout).not.toContain('pg_secret');
    expect(result.asked.filter((path) => path.startsWith('/postgres'))).toEqual(
      ['/postgres/pg_1'],
    );
  });

  it('still exits 0 when the last Deployment failed', async () => {
    const result = await status('api', {
      ...runningApi,
      '/applications/app_1': {
        applicationStatus: 'error',
        sourceType: 'docker',
        dockerImage: 'ghcr.io/shop/api:1',
      },
      '/applications/app_1/deployments': [
        {
          deploymentId: 'dpl_bad',
          status: 'error',
          createdAt: '2026-11-01T12:00:00.000Z',
        },
      ],
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('State        error\n');
    expect(result.stdout).toContain('Source       image ghcr.io/shop/api:1\n');
    expect(result.stdout).toContain(
      'Latest       Deployment dpl_bad  error  2 days ago\n',
    );
  });

  it('exits 1 with the error and hint when the key may not read the Service', async () => {
    const result = await status('api', {
      ...runningApi,
      '/applications/app_1': json(
        { statusCode: 403, error: 'Forbidden', message: 'Forbidden resource' },
        403,
      ),
    });

    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(
      'Error: Forbidden resource\nAsk an owner of Shop Inc for access.\n',
    );
  });
});
