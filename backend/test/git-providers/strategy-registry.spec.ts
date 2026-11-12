import { sourceTypeEnum } from '../../src/git-providers/git-provider.schema';
import { getGitProviderStrategy } from '../../src/git-providers/git-provider.strategy';

describe('getGitProviderStrategy', () => {
  it.each(['git', 'raw', 'docker', 'drop'] as const)(
    'resolves the %s strategy by its sourceType',
    (sourceType) => {
      expect(getGitProviderStrategy(sourceType).sourceType).toBe(sourceType);
    },
  );

  /**
   * The drop strategy, as a set-level claim rather than one more `it.each`
   * row.
   *
   * `drop` was the member with no strategy, and the raise was how a `drop`
   * Application deployed: it did not. Enumerating the enum rather than listing
   * the eight names is what makes the *next* member fail here — the old
   * `it.each(['git', 'raw', 'docker'])` above passed for years while `drop`,
   * `github`, `gitlab`, `gitea` and `bitbucket` went unchecked, and the one
   * test that mentioned `drop` asserted the defect as though it were the
   * design.
   */
  it('has a strategy for every source type a row can hold', () => {
    const missing = sourceTypeEnum.enumValues.filter((sourceType) => {
      try {
        getGitProviderStrategy(sourceType);
        return false;
      } catch {
        return true;
      }
    });

    expect(missing).toEqual([]);
  });

  it('throws for a sourceType with no registered strategy', () => {
    // Unreachable from `sourceTypeEnum` — the raise is now a guard
    // against a caller casting something else in, which is why the input has
    // to be cast to reach it at all.
    expect(() =>
      getGitProviderStrategy(
        'mercurial' as (typeof sourceTypeEnum.enumValues)[number],
      ),
    ).toThrow(
      'No git-provider strategy registered for source type "mercurial"',
    );
  });
});
