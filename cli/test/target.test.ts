import { describe, expect, it } from 'vitest';

import { CliError } from '../src/errors.js';
import type { FolderLink } from '../src/folder-link.js';
import { resolveTarget, targetInputs } from '../src/target.js';
import type { TargetCatalog, TargetLevel } from '../src/target.js';

/**
 * What an Instance holds, as the lookup reads it: two Organizations; in Shop
 * Inc a Project `shop` with three Environments, whose Services differ.
 * The Service's display name differs from its Config name on purpose, so a
 * test can tell which one matched.
 */
function catalog(
  organizations = [
    { id: 'org_1', name: 'Shop Inc' },
    { id: 'org_2', name: 'Acme' },
  ],
): TargetCatalog & { calls: string[] } {
  const calls: string[] = [];
  const projects: Record<string, { id: string; name: string }[]> = {
    org_1: [
      { id: 'prj_1', name: 'shop' },
      { id: 'prj_2', name: 'Blog' },
    ],
    org_2: [{ id: 'prj_9', name: 'shop' }],
  };
  const environments: Record<string, { id: string; name: string }[]> = {
    prj_1: [
      { id: 'env_s', name: 'staging' },
      { id: 'env_p', name: 'production' },
      { id: 'env_q', name: 'qa' },
    ],
    prj_2: [{ id: 'env_b', name: 'main' }],
    prj_9: [{ id: 'env_9', name: 'staging' }],
  };
  const service = (id: string, configName: string, name: string) => ({
    id,
    name: configName,
    displayName: name,
    kind: 'application',
  });
  const services: Record<string, ReturnType<typeof service>[]> = {
    env_s: [
      service('app_s_api', 'api', 'Shop API'),
      service('app_s_web', 'web', 'Web'),
    ],
    env_p: [service('app_p_api', 'api', 'Shop API')],
    env_q: [service('app_q_web', 'web', 'Web')],
    env_b: [service('app_b', 'blog', 'Blog')],
    env_9: [service('app_9', 'api', 'Acme API')],
  };
  return {
    calls,
    organizations: () => {
      calls.push('organizations');
      return Promise.resolve(organizations);
    },
    projects: (organizationId) => {
      calls.push(`projects ${organizationId}`);
      return Promise.resolve(projects[organizationId] ?? []);
    },
    environments: (organizationId, projectId) => {
      calls.push(`environments ${organizationId} ${projectId}`);
      return Promise.resolve(environments[projectId] ?? []);
    },
    services: (organizationId, environmentId) => {
      calls.push(`services ${organizationId} ${environmentId}`);
      return Promise.resolve(services[environmentId] ?? []);
    },
  };
}

const link: FolderLink = {
  instance: 'https://cloudgate.octabyte.app',
  organizationId: 'org_1',
  projectId: 'prj_1',
  environmentId: 'env_s',
  serviceConfigName: 'api',
  names: {
    organization: 'Shop Inc',
    project: 'shop',
    environment: 'staging',
    service: 'api',
  },
};

async function refusal(promise: Promise<unknown>): Promise<CliError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(CliError);
    return error as CliError;
  }
  throw new Error('expected a refusal');
}

describe('targetInputs', () => {
  it('takes a flag over its variable, and the variable over the link', () => {
    const inputs = targetInputs({
      values: { env: 'production' },
      env: { CLOUDGATE_ENV: 'qa', CLOUDGATE_SERVICE: 'web' },
      link,
    });

    expect(inputs.environment).toEqual({ value: 'production', from: 'flag' });
    expect(inputs.service).toEqual({ value: 'web', from: 'env' });
    expect(inputs.project).toEqual({ value: 'prj_1', from: 'link' });
    expect(inputs.organization).toEqual({ value: 'org_1', from: 'link' });
  });

  it('takes the variables with no flags, and the link with neither', () => {
    expect(
      targetInputs({
        values: {},
        env: {
          CLOUDGATE_ORG: 'Acme',
          CLOUDGATE_PROJECT: 'shop',
          CLOUDGATE_ENV: 'staging',
          CLOUDGATE_SERVICE: 'api',
        },
      }),
    ).toEqual({
      organization: { value: 'Acme', from: 'env' },
      project: { value: 'shop', from: 'env' },
      environment: { value: 'staging', from: 'env' },
      service: { value: 'api', from: 'env' },
    });
    expect(targetInputs({ values: {}, env: {}, link })).toEqual({
      organization: { value: 'org_1', from: 'link' },
      project: { value: 'prj_1', from: 'link' },
      environment: { value: 'env_s', from: 'link' },
      service: { value: 'api', from: 'link' },
    });
  });

  it('treats an empty flag or variable as not given', () => {
    expect(
      targetInputs({
        values: { env: ' ' },
        env: { CLOUDGATE_ENV: '' },
        link,
      }).environment,
    ).toEqual({ value: 'env_s', from: 'link' });
  });

  it("drops the link's Project and Environment once a level above them is named otherwise, keeping its Config name", () => {
    expect(
      targetInputs({ values: { project: 'Blog' }, env: {}, link }),
    ).toEqual({
      organization: { value: 'org_1', from: 'link' },
      project: { value: 'Blog', from: 'flag' },
      service: { value: 'api', from: 'link' },
    });
    expect(
      targetInputs({ values: {}, env: { CLOUDGATE_ORG: 'Acme' }, link }),
    ).toEqual({
      organization: { value: 'Acme', from: 'env' },
      service: { value: 'api', from: 'link' },
    });
  });
});

describe('resolveTarget', () => {
  it('finds each level by its id', async () => {
    const target = await resolveTarget(
      targetInputs({ values: {}, env: {}, link }),
      catalog(),
    );

    expect(target).toEqual({
      organization: { id: 'org_1', name: 'Shop Inc' },
      project: { id: 'prj_1', name: 'shop' },
      environment: { id: 'env_s', name: 'staging' },
      service: {
        id: 'app_s_api',
        configName: 'api',
        name: 'Shop API',
        kind: 'application',
      },
    });
  });

  it('finds each level by its name, ignoring case, and a Service by its Config name', async () => {
    const target = await resolveTarget(
      targetInputs({
        values: {
          org: 'shop inc',
          project: 'SHOP',
          env: 'Production',
          service: 'API',
        },
        env: {},
      }),
      catalog(),
    );

    expect(target.organization.id).toBe('org_1');
    expect(target.project.id).toBe('prj_1');
    expect(target.environment.id).toBe('env_p');
    expect(target.service.id).toBe('app_p_api');
  });

  it("does not take a Service's display name for its Config name", async () => {
    const refused = await refusal(
      resolveTarget(
        targetInputs({ values: { service: 'Shop API' }, env: {}, link }),
        catalog(),
      ),
    );
    expect(refused.message).toContain('Shop API');
    expect(refused.exitCode).toBe(1);
  });

  it("re-finds the link's Config name in the Environment --env names", async () => {
    const target = await resolveTarget(
      targetInputs({ values: { env: 'production' }, env: {}, link }),
      catalog(),
    );

    expect(target.environment).toEqual({ id: 'env_p', name: 'production' });
    expect(target.service).toMatchObject({
      id: 'app_p_api',
      configName: 'api',
    });
  });

  it('refuses --env where the Config name is missing, naming both', async () => {
    const refused = await refusal(
      resolveTarget(
        targetInputs({ values: { env: 'qa' }, env: {}, link }),
        catalog(),
      ),
    );

    expect(refused.exitCode).toBe(1);
    expect(refused.message).toMatch(/"api"/);
    expect(refused.message).toMatch(/qa/);
  });

  it('refuses a name that matches nothing, naming it and where it looked', async () => {
    const refused = await refusal(
      resolveTarget(
        targetInputs({ values: { org: 'org_1', project: 'nope' }, env: {} }),
        catalog(),
      ),
    );

    expect(refused.exitCode).toBe(1);
    expect(refused.message).toBe('no Project "nope" in Organization Shop Inc');
    expect(refused.hint).toContain('shop, Blog');
  });

  it('refuses a name two of a level share, asking for the id instead', async () => {
    const refused = await refusal(
      resolveTarget(
        targetInputs({ values: { org: 'Shop Inc' }, env: {} }),
        catalog([
          { id: 'org_1', name: 'Shop Inc' },
          { id: 'org_3', name: 'shop inc' },
        ]),
      ),
    );

    expect(refused.exitCode).toBe(2);
    expect(refused.message).toContain('org_1');
    expect(refused.message).toContain('org_3');
  });

  it('with no one to ask, refuses naming the first missing flag and its variable', async () => {
    const refused = await refusal(
      resolveTarget(
        targetInputs({ values: { org: 'org_1' }, env: {} }),
        catalog(),
      ),
    );

    expect(refused.exitCode).toBe(2);
    expect(refused.message).toBe(
      'no Project. Pass --project or set CLOUDGATE_PROJECT.',
    );
  });

  it('skips the Organization when there is only one', async () => {
    const refused = await refusal(
      resolveTarget(
        targetInputs({ values: {}, env: {} }),
        catalog([{ id: 'org_1', name: 'Shop Inc' }]),
      ),
    );

    expect(refused.message).toBe(
      'no Project. Pass --project or set CLOUDGATE_PROJECT.',
    );
  });

  it('asks for each missing level in order, offering what the level holds', async () => {
    const asked: { level: TargetLevel; offered: string[] }[] = [];
    const answers: Record<TargetLevel, string> = {
      organization: 'org_1',
      project: 'prj_1',
      environment: 'env_q',
      service: 'app_q_web',
    };

    const target = await resolveTarget(
      targetInputs({ values: {}, env: {} }),
      catalog(),
      {
        choose: (level, candidates) => {
          asked.push({ level, offered: candidates.map((c) => c.name) });
          return Promise.resolve(
            candidates.find((c) => c.id === answers[level])!,
          );
        },
      },
    );

    expect(asked).toEqual([
      { level: 'organization', offered: ['Shop Inc', 'Acme'] },
      { level: 'project', offered: ['shop', 'Blog'] },
      { level: 'environment', offered: ['staging', 'production', 'qa'] },
      { level: 'service', offered: ['web'] },
    ]);
    expect(target.service.id).toBe('app_q_web');
  });

  it('refuses an Environment with no Service, pointing to the console', async () => {
    const empty = catalog();
    empty.services = () => Promise.resolve([]);

    const refused = await refusal(
      resolveTarget(
        targetInputs({
          values: { org: 'org_1', project: 'prj_1', env: 'env_s' },
          env: {},
        }),
        empty,
        { choose: () => Promise.reject(new Error('never asked')) },
      ),
    );

    expect(refused.exitCode).toBe(1);
    expect(refused.message).toBe(
      'Environment staging of Project shop has no Services',
    );
    expect(refused.hint).toMatch(/console/);
  });
});
