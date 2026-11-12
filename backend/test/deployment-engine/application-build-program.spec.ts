import { buildAppDirectoryIn } from '../../src/deployment-engine/application-build-program';
import { makeApp } from './application.fixture';

/**
 * The save refuses a build path that leaves the repository; a row saved
 * before that rule existed is refused here, when the build reads it, so it
 * cannot run.
 */
describe('buildAppDirectoryIn', () => {
  it('joins the build path onto the checkout, `/` being its root', () => {
    expect(buildAppDirectoryIn('/c/code', makeApp({ buildPath: '/' }))).toBe(
      '/c/code',
    );
    expect(
      buildAppDirectoryIn('/c/code', makeApp({ buildPath: '/apps/web/' })),
    ).toBe('/c/code/apps/web');
  });

  it.each([
    ['github', { buildPath: '../../..' }],
    ['git', { customGitBuildPath: 'apps/../../..' }],
    ['drop', { dropBuildPath: '/../etc' }],
  ] as const)(
    'refuses a %s build path saved with a parent segment, naming it',
    (sourceType, columns) => {
      const application = makeApp({ sourceType, ...columns });
      expect(() => buildAppDirectoryIn('/c/code', application)).toThrow(
        /Cannot deploy: the build path '.*' leads outside the repository/,
      );
    },
  );
});
