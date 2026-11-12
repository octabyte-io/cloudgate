import { addressMovePatch } from '../../src/project-config/existing-database-address';
import type { MovedLinker } from '../../src/project-config/existing-database-address';
import { outputsMovedBy } from '../../src/project-config/outputs';
import type { PlanStep } from '../../src/project-config/planner/plan.types';

const lookup: PlanStep = {
  action: 'change',
  configName: 'pg-1',
  kind: 'postgres',
  serviceType: 'postgres',
  serviceId: 'pg-id',
  name: 'pg-1',
  fields: [],
  existing: { identifier: 'acme-prod', version: null },
  cloudRead: { status: 'reading' },
};

const linker = (configName: string, because: string[]): MovedLinker => ({
  serviceType: 'application',
  serviceId: `${configName}-id`,
  configName,
  name: configName,
  because,
});

const outline = {
  services: {
    'pg-1': { kind: 'postgres', managed: false as const },
    web: { kind: 'web', managed: false as const },
    api: { kind: 'web', managed: false as const },
    admin: { kind: 'web', managed: 'console' as const },
  },
};

describe('outputsMovedBy, an Existing database found at a new address', () => {
  const at = { host: 'a.rds.amazonaws.com', port: 5432 };

  it('changes url and host with the host, url and port with the port', () => {
    expect(
      outputsMovedBy('postgres', at, { ...at, host: 'b.rds.amazonaws.com' }),
    ).toEqual(['url', 'host']);
    expect(outputsMovedBy('postgres', at, { ...at, port: 5433 })).toEqual([
      'url',
      'port',
    ]);
    expect(outputsMovedBy('postgres', at, { host: 'b', port: 5433 })).toEqual([
      'url',
      'host',
      'port',
    ]);
  });

  it('changes nothing at the same host and port', () => {
    expect(outputsMovedBy('postgres', at, { ...at })).toEqual([]);
  });
});

describe('addressMovePatch', () => {
  it('redeploys a linking Service the plan leaves alone, after every step', () => {
    const patch = addressMovePatch(
      [lookup],
      [linker('web', ['pg-1.url'])],
      outline,
    );

    expect(patch.because.size).toBe(0);
    expect(patch.append).toEqual([
      {
        action: 'redeploy',
        configName: 'web',
        kind: 'web',
        serviceType: 'application',
        serviceId: 'web-id',
        name: 'web',
        because: ['pg-1.url'],
      },
    ]);
  });

  it('gives the reason to a step that deploys it anyway, once', () => {
    const change: PlanStep = {
      action: 'change',
      configName: 'api',
      kind: 'web',
      serviceType: 'application',
      serviceId: 'api-id',
      name: 'api',
      fields: [{ field: 'port', from: 3000, to: 8080 }],
      because: ['pg-1.url'],
    };

    const patch = addressMovePatch(
      [lookup, change],
      [linker('api', ['pg-1.url', 'pg-1.host'])],
      outline,
    );

    expect(patch.append).toEqual([]);
    expect(patch.because.get(1)).toEqual(['pg-1.url', 'pg-1.host']);
  });

  it('redeploys a cloud Service the plan only reads for Drift, beside that read', () => {
    const drift: PlanStep = {
      action: 'change',
      configName: 'web',
      kind: 'web',
      serviceType: 'application',
      serviceId: 'web-id',
      name: 'web',
      fields: [],
      cloudRead: { status: 'reading' },
    };

    const patch = addressMovePatch(
      [lookup, drift],
      [linker('web', ['pg-1.url'])],
      outline,
    );

    expect(patch.because.size).toBe(0);
    expect(patch.append).toMatchObject([
      { action: 'redeploy', configName: 'web', because: ['pg-1.url'] },
    ]);
  });

  it('leaves out a Service the plan destroys, and one the config does not describe', () => {
    const destroy: PlanStep = {
      action: 'destroy',
      configName: 'web',
      kind: 'web',
      serviceType: 'application',
      serviceId: 'web-id',
      name: 'web',
    };

    const patch = addressMovePatch(
      [lookup, destroy],
      [linker('web', ['pg-1.url']), linker('admin', ['pg-1.url'])],
      outline,
    );

    expect(patch.append).toEqual([]);
    expect(patch.because.size).toBe(0);
  });
});
