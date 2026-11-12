import { dropStrategy } from '../../src/git-providers/strategies/drop.strategy';
import { expectQuotedInCommand, SHELL_PAYLOAD } from '../utils/shell-safety';

/**
 * The `drop` source had no strategy at all — the enum
 * comment said it was "handled inline" and there was no inline branch — so
 * `getGitProviderStrategy('drop')` raised and every deploy of an uploaded zip
 * failed before its first shell step.
 *
 * What this strategy has to get right is unusual enough to be worth stating
 * before the assertions: its `outputPath` is the **source**, not a destination.
 * `ApplicationsService.uploadDrop` has already written the archive's entries
 * there on the build host, so the six sibling strategies' opening
 * `rm -rf <outputPath>` would delete the only copy of the operator's upload.
 */
describe('dropStrategy.cloneProgram', () => {
  const OUT = '/etc/cloudgate/applications/drop-app/code';

  it('guards the uploaded tree and reports it, without fetching or clearing anything', () => {
    const { command } = dropStrategy.cloneProgram({ outputPath: OUT });

    expect(command).toBe(
      `set -e;
if [ ! -d ${OUT} ]; then
  echo "❌ [Drop] No uploaded files found at '${OUT}'. This Application's source is a file upload, so there is nothing to build until an archive is posted to /applications/:id/drop.";
  exit 1;
fi
echo "📦 [Drop] Building the uploaded files already extracted at '${OUT}' ✅";`,
    );
  });

  /**
   * The negative that matters, and the one a reader of the other six strategies
   * would get wrong: a `drop` clone must not touch the tree. Asserted by name
   * rather than left to the `toBe` above, because the `toBe` would also red for
   * a wording change and this claim is about behaviour.
   */
  it('never removes, creates or overwrites the path it is handed', () => {
    const { command } = dropStrategy.cloneProgram({ outputPath: OUT });

    expect(command).not.toContain('rm -rf');
    expect(command).not.toContain('mkdir');
    expect(command).not.toContain('base64 -d');
    expect(command).not.toContain('git clone');
    expect(command).not.toContain('docker pull');
  });

  it('declares no environment, because a drop carries no credential', () => {
    expect(dropStrategy.cloneProgram({ outputPath: OUT }).env).toEqual({});
  });

  it('has no branches and no commit to describe', () => {
    expect(dropStrategy.listBranches({})).toBeNull();
    expect(dropStrategy.getCommitInfo({ outputPath: OUT })).toBeNull();
  });
});

describe('dropStrategy shell safety', () => {
  // The shell-safety rule, applied even though the path is machine-made
  // (`applicationsDirectory()` plus an `APP_NAME_REGEX` `appName`): a word that
  // happens to be safe and a word that is *made* safe read identically at the
  // next edit, and this one reaches a `[ -d … ]` test and two `echo`s.
  it('quotes the output path in the test and the messages', () => {
    const { command } = dropStrategy.cloneProgram({
      outputPath: `/apps/${SHELL_PAYLOAD}/code`,
    });

    expectQuotedInCommand(command);
  });
});
