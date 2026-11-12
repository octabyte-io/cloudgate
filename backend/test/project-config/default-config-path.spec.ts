import { ConflictException } from '@nestjs/common';

import { findDefaultPath } from '../../src/project-config/default-config-path';
import { readPlace } from '../../src/project-config/reader/repository-place';
import type { RepositoryPlace } from '../../src/project-config/reader/repository-place';
import { FakeConfigReader } from '../utils/fake-config-reader';

const TEXT = 'version: 1\nservices: {}\n';

const production = {
  environmentId: 'env-production',
  name: 'production',
  configBranch: null,
};
const staging = {
  environmentId: 'env-staging',
  name: 'staging',
  configBranch: 'staging',
};

const at = {
  gitProviderId: 'gp-1',
  providerType: 'github' as const,
  repository: 'acme/shop',
};

/** The refusal's body, or a failure when nothing was refused. */
async function refusal(
  found: Promise<unknown>,
): Promise<{ code: string; message: string }> {
  try {
    await found;
  } catch (error) {
    expect(error).toBeInstanceOf(ConflictException);
    return (error as ConflictException).getResponse() as {
      code: string;
      message: string;
    };
  }
  throw new Error('the default path was found');
}

describe('findDefaultPath', () => {
  let reader: FakeConfigReader;
  const read = (place: RepositoryPlace, ref: string | null) =>
    readPlace(reader, place, ref);

  beforeEach(() => {
    reader = new FakeConfigReader();
  });

  it('takes cloudgate.yaml when every Config branch has only it, answering each copy it read', async () => {
    const mainSha = reader.commit('acme/shop', TEXT);
    const stagingSha = reader.commit('acme/shop', TEXT, { branch: 'staging' });

    const found = await findDefaultPath([production, staging], at, read);

    expect(found.path).toBe('cloudgate.yaml');
    expect(found.copies.get('env-production')).toMatchObject({
      commitSha: mainSha,
      branch: 'main',
    });
    expect(found.copies.get('env-staging')).toMatchObject({
      commitSha: stagingSha,
      branch: 'staging',
    });
  });

  it('takes cloudgate.yml when every Config branch has only it', async () => {
    reader.commit('acme/shop', TEXT, { path: 'cloudgate.yml' });
    reader.commit('acme/shop', TEXT, {
      path: 'cloudgate.yml',
      branch: 'staging',
    });

    const found = await findDefaultPath([production, staging], at, read);

    expect(found.path).toBe('cloudgate.yml');
    expect(found.copies.get('env-staging')).toMatchObject({
      ok: true,
      fileUrl: expect.stringContaining('cloudgate.yml') as string,
    });
  });

  it('refuses a Config branch holding both names, naming the repository and branch', async () => {
    reader.commit('acme/shop', TEXT);
    reader.commit('acme/shop', TEXT, { branch: 'staging' });
    reader.commit('acme/shop', TEXT, {
      path: 'cloudgate.yml',
      branch: 'staging',
    });

    const refused = await refusal(
      findDefaultPath([production, staging], at, read),
    );

    expect(refused).toEqual({
      code: 'CONFIG_PATH_AMBIGUOUS',
      message:
        'Both cloudgate.yaml and cloudgate.yml are in acme/shop on branch staging; set Path to the one to use',
    });
  });

  it('refuses Environments whose Config branches hold different names, naming each branch and file', async () => {
    reader.commit('acme/shop', TEXT);
    reader.commit('acme/shop', TEXT, {
      path: 'cloudgate.yml',
      branch: 'staging',
    });

    const refused = await refusal(
      findDefaultPath([production, staging], at, read),
    );

    expect(refused.code).toBe('CONFIG_PATH_AMBIGUOUS');
    expect(refused.message).toContain('acme/shop');
    expect(refused.message).toContain(
      "the production Environment's branch main has only cloudgate.yaml",
    );
    expect(refused.message).toContain(
      "the staging Environment's branch staging has only cloudgate.yml",
    );
    expect(refused.message).toContain('set Path to the one to use');
  });

  it('refuses a Config branch with neither name as a missing file, naming both', async () => {
    reader.commit('acme/shop', TEXT);
    reader.commit('acme/shop', TEXT, { path: 'other.yaml', branch: 'staging' });

    const refused = await refusal(
      findDefaultPath([production, staging], at, read),
    );

    expect(refused.code).toBe('CONFIG_UNREADABLE');
    expect(refused.message).toContain(
      'There is no cloudgate.yaml or cloudgate.yml in acme/shop on branch staging',
    );
    expect(refused.message).toContain('staging Environment');
  });

  it('refuses a missing branch or an unreachable repository as before, without asking for cloudgate.yml', async () => {
    reader.commit('acme/shop', TEXT);

    const missing = await refusal(findDefaultPath([staging], at, read));
    expect(missing.code).toBe('CONFIG_UNREADABLE');
    expect(missing.message).toContain('has no branch staging');

    reader.setUnreachable('acme/shop');
    const unreachable = await refusal(findDefaultPath([production], at, read));
    expect(unreachable.code).toBe('CONFIG_UNREADABLE');
    expect(unreachable.message).toContain('cannot reach it');
    // Neither refusal fell back to the second name.
    expect(reader.calls.map((call) => call.path)).toEqual([
      'cloudgate.yaml',
      'cloudgate.yaml',
    ]);
  });

  it('takes cloudgate.yaml for a Project with no Environments, reading nothing', async () => {
    const found = await findDefaultPath([], at, read);

    expect(found.path).toBe('cloudgate.yaml');
    expect(found.copies.size).toBe(0);
    expect(reader.calls).toHaveLength(0);
  });
});
