import {
  uploadApplicationDropSchema,
  updateApplicationSchema,
} from '../../src/applications/dto/application.dto';

/**
 * A Service's build path is joined onto its checkout
 * (`buildAppDirectoryIn`), and on a cloud static site the folder under it is
 * copied off the platform host into the customer's bucket, so a build path of
 * `../../..` copied the host's own directories. Every build-path column is held
 * to "inside the repository" on save; `/` is the repository root, as the
 * console's placeholder and the column's default spell it.
 */
describe('updateApplicationSchema build paths', () => {
  const COLUMNS = [
    'buildPath',
    'gitlabBuildPath',
    'giteaBuildPath',
    'bitbucketBuildPath',
    'customGitBuildPath',
    'dropBuildPath',
  ] as const;

  const issuesOf = (column: string, value: string) => {
    const result = updateApplicationSchema.safeParse({ [column]: value });
    return result.success ? [] : result.error.issues;
  };

  describe.each(COLUMNS)('%s', (column) => {
    it.each([
      ['a parent segment', '../../..'],
      ['a parent segment after a folder', 'apps/../../etc'],
      ['a parent segment under the root slash', '/../etc'],
      ['a trailing parent segment', 'apps/..'],
      ['a command substitution', 'apps/$(id)'],
      ['a backtick', 'apps/`id`'],
      ['a double quote', 'apps/"x'],
      ['a backslash', 'apps\\x'],
      ['a newline', 'apps\nrm'],
    ])('is refused with %s, naming the column', (_name, value) => {
      const issues = issuesOf(column, value);
      expect(issues).toHaveLength(1);
      expect(issues[0].path).toEqual([column]);
      expect(issues[0].message).toContain(column);
    });

    it.each(['/', '/apps/web', 'apps/web', './apps/web', 'apps/web/', 'a..b'])(
      'accepts %j',
      (value) => {
        expect(issuesOf(column, value)).toEqual([]);
      },
    );

    it('accepts null', () => {
      expect(
        updateApplicationSchema.safeParse({ [column]: null }).success,
      ).toBe(true);
    });
  });
});

describe('uploadApplicationDropSchema', () => {
  it('refuses a dropBuildPath that leaves the archive, naming it', () => {
    const result = uploadApplicationDropSchema.safeParse({
      dropBuildPath: '../../etc',
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].message).toContain('dropBuildPath');
  });

  it('accepts a folder in the archive, and no folder at all', () => {
    expect(
      uploadApplicationDropSchema.safeParse({ dropBuildPath: '/frontend' })
        .success,
    ).toBe(true);
    expect(uploadApplicationDropSchema.safeParse({}).success).toBe(true);
  });
});
