import type { BuildType } from '../../src/builders/build-strategy';
import {
  getBuildProgram,
  getBuildStrategy,
} from '../../src/builders/build-strategy';

describe('getBuildStrategy', () => {
  /**
   * The six, and **only** six. This list used to open with `'drop'`,
   * which passed here and could not happen anywhere else: `buildTypeEnum` was
   * declared twice, the seven-member declaration was the one this map was built
   * from, and the six-member one was the `application.build_type` column's. So
   * the registry answered for a `buildType` no row could carry and no migration
   * had ever created. The list is written out rather than derived from
   * `BuildType` on purpose — a registry spec that reads its expectation off the
   * type it is checking asserts nothing about the map.
   */
  it.each([
    'nixpacks',
    'heroku_buildpacks',
    'paketo_buildpacks',
    'dockerfile',
    'static',
    'railpack',
  ] as const)('resolves the %s strategy by its buildType', (buildType) => {
    expect(getBuildStrategy(buildType).buildType).toBe(buildType);
  });

  // `drop` names a *source* (`sourceTypeEnum`, and
  // `git-providers/strategies/drop.strategy.ts`), never a builder: now
  // an uploaded archive is built by whichever of the six the row names.
  it.each(['drop', 'compose'] as const)(
    'throws for a buildType with no registered strategy: %s',
    (buildType) => {
      expect(() => getBuildStrategy(buildType as BuildType)).toThrow(
        `No build strategy registered for build type "${buildType}"`,
      );
    },
  );
});

describe('getBuildProgram', () => {
  it('dispatches to the strategy matching the buildType', () => {
    const { command } = getBuildProgram({
      buildType: 'paketo_buildpacks',
      appName: 'api',
      buildAppDirectory: '/apps/api/code',
      buildNonce: 'nonce123456',
    });

    expect(command).toContain(
      'pack build api --path /apps/api/code --builder paketobuildpacks/builder-jammy-full',
    );
  });
});
