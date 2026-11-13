import { missingSource } from '../../src/deployments/missing-source';
import type { SourceColumns } from '../../src/deployments/missing-source';

// `source_type` defaults to `github`, so a row nobody has pointed
// anywhere claims a GitHub source with no repository behind it. A deploy of
// that row used to be queued and fail at the worker with "has no GitHub
// provider linked", which sends the operator to the wrong screen. This is the
// rule the deploy path now refuses on, one case per source type.

const empty: SourceColumns = {
  sourceType: 'github',
  repository: null,
  gitlabRepository: null,
  giteaRepository: null,
  bitbucketRepository: null,
  customGitUrl: null,
  dockerImage: null,
  dropBuildPath: null,
  dropUploaded: false,
};

describe('missingSource', () => {
  it.each([
    // The fresh-create row: its type is the column default, so it is not named.
    ['github', 'no source is chosen'],
    ['gitlab', 'no GitLab repository is chosen'],
    ['gitea', 'no Gitea repository is chosen'],
    ['bitbucket', 'no Bitbucket repository is chosen'],
    ['git', 'no git URL is set'],
    ['docker', 'no Docker image is set'],
    ['drop', 'no files have been uploaded'],
  ] as const)('names what a fresh %s row is missing', (sourceType, said) => {
    expect(missingSource({ ...empty, sourceType })).toBe(said);
  });

  it.each([
    ['github', { repository: 'shop' }],
    ['gitlab', { gitlabRepository: 'shop' }],
    ['gitea', { giteaRepository: 'shop' }],
    ['bitbucket', { bitbucketRepository: 'shop' }],
    ['git', { customGitUrl: 'git@example.com:acme/shop.git' }],
    ['docker', { dockerImage: 'nginx:1.27' }],
    ['drop', { dropBuildPath: '/', dropUploaded: true }],
  ] as const)('passes a %s row whose source is set', (sourceType, set) => {
    expect(missingSource({ ...empty, sourceType, ...set })).toBeNull();
  });

  it('holds a drop row whose build path a plan wrote, before any upload, as having no files', () => {
    // A folder source (ADR-0080): the plan names the subfolder; only an
    // upload puts files on the build host.
    expect(
      missingSource({
        ...empty,
        sourceType: 'drop',
        dropBuildPath: 'apps/web',
      }),
    ).toBe('no files have been uploaded');
  });

  it('reads a blank column as unset, the way the console clears one', () => {
    expect(missingSource({ ...empty, repository: '   ' })).toBe(
      'no source is chosen',
    );
  });

  it('passes a raw compose stack, whose source is its own file', () => {
    expect(missingSource({ sourceType: 'raw' })).toBeNull();
  });

  it("does not read another provider's column", () => {
    // A stack switched from GitHub to GitLab keeps its old GitHub columns; the
    // GitLab one is what the deploy will clone from.
    expect(
      missingSource({ ...empty, sourceType: 'gitlab', repository: 'x' }),
    ).toBe('no GitLab repository is chosen');
  });
});
