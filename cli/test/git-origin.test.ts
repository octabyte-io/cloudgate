import { describe, expect, it } from 'vitest';

import { configMatchesFolder, repositoryOf } from '../src/git-origin.js';

describe('repositoryOf', () => {
  it('reads owner/repo from the remote URLs git hosts hand out', () => {
    expect(repositoryOf('git@github.com:Octabyte-io/Shop.git')).toBe(
      'octabyte-io/shop',
    );
    expect(repositoryOf('https://github.com/acme/shop')).toBe('acme/shop');
    expect(repositoryOf('https://gitlab.com/group/sub/repo.git')).toBe(
      'group/sub/repo',
    );
    expect(repositoryOf('ssh://git@git.acme.dev:2222/acme/shop.git')).toBe(
      'acme/shop',
    );
  });

  it('answers nothing for a remote with no path', () => {
    expect(repositoryOf('/srv/git')).toBeUndefined();
    expect(repositoryOf('')).toBeUndefined();
  });
});

describe('configMatchesFolder', () => {
  const folder = { repository: 'acme/shop', prefix: 'apps/api/' };

  it('matches a config kept in this repository at or above the folder', () => {
    expect(
      configMatchesFolder(
        { kind: 'repository', repository: 'Acme/Shop', path: 'cloudgate.yaml' },
        folder,
      ),
    ).toBe(true);
    expect(
      configMatchesFolder(
        {
          kind: 'repository',
          repository: 'acme/shop',
          path: 'apps/api/cloudgate.yaml',
        },
        folder,
      ),
    ).toBe(true);
  });

  it('does not match a config beside the folder, in another repository, or kept by Cloudgate', () => {
    expect(
      configMatchesFolder(
        {
          kind: 'repository',
          repository: 'acme/shop',
          path: 'apps/web/cloudgate.yaml',
        },
        folder,
      ),
    ).toBe(false);
    expect(
      configMatchesFolder(
        { kind: 'repository', repository: 'acme/blog', path: 'cloudgate.yaml' },
        folder,
      ),
    ).toBe(false);
    expect(configMatchesFolder({ kind: 'cloudgate' }, folder)).toBe(false);
    expect(configMatchesFolder(null, folder)).toBe(false);
  });
});
