import { describe, expect, it } from 'vitest';

import { changelogSection, releaseFromTag } from '../scripts/release.js';

describe('releaseFromTag', () => {
  it('publishes a plain version to latest', () => {
    expect(releaseFromTag('cli-v0.1.0', '0.1.0')).toEqual({
      version: '0.1.0',
      distTag: 'latest',
      prerelease: false,
    });
  });

  it('publishes a version with a prerelease part to next', () => {
    expect(releaseFromTag('cli-v0.0.2-beta.1', '0.0.2-beta.1')).toEqual({
      version: '0.0.2-beta.1',
      distTag: 'next',
      prerelease: true,
    });
  });

  it('refuses a tag that disagrees with the package version, naming both', () => {
    expect(() => releaseFromTag('cli-v0.0.3', '0.0.2')).toThrow(
      'tag cli-v0.0.3 says 0.0.3 but cli/package.json says 0.0.2',
    );
  });

  it.each([
    ['v0.0.2', 'not a cli-v<version> tag'],
    ['cli-0.0.2', 'not a cli-v<version> tag'],
    ['cli-v0.0', 'not a cli-v<version> tag'],
    ['cli-v00.1.0', 'not a cli-v<version> tag'],
    ['cli-v0.0.2-', 'not a cli-v<version> tag'],
    ['cli-v0.0.2+build.5', 'not a cli-v<version> tag'],
    ['refs/tags/cli-v0.0.2', 'not a cli-v<version> tag'],
  ])('refuses %s as %s', (tag, reason) => {
    expect(() => releaseFromTag(tag, '0.0.2')).toThrow(reason);
  });

  it('refuses a prerelease tag for the plain version it precedes', () => {
    expect(() => releaseFromTag('cli-v0.0.2-beta.1', '0.0.2')).toThrow(
      'says 0.0.2-beta.1 but cli/package.json says 0.0.2',
    );
  });
});

const changelog = `# Changelog

The Cloudgate CLI's own changes.

## Unreleased

### Something not out yet

Not out.

## 0.0.2-beta.1

### \`cloudgate whoami\`

Prints who you are.

- **Exit codes.** 0, 1, 2, 3.

## 0.0.2

### Earlier

Older text.

## 0.0.1
`;

describe('changelogSection', () => {
  it("returns the version's section, without its heading, up to the next version", () => {
    expect(changelogSection(changelog, '0.0.2-beta.1')).toBe(
      '### `cloudgate whoami`\n\nPrints who you are.\n\n- **Exit codes.** 0, 1, 2, 3.',
    );
  });

  it('matches the whole version, not one it is a prefix of', () => {
    expect(changelogSection(changelog, '0.0.2')).toBe(
      '### Earlier\n\nOlder text.',
    );
  });

  it('reads the last section to the end of the file', () => {
    expect(
      changelogSection('# Changelog\n\n## 0.1.0\n\nLast one.\n', '0.1.0'),
    ).toBe('Last one.');
  });

  it('accepts a date after the version in the heading', () => {
    expect(changelogSection('## 0.1.0 (2026-11-03)\n\nDated.\n', '0.1.0')).toBe(
      'Dated.',
    );
  });

  it('reads a version with dots literally', () => {
    expect(() => changelogSection('## 0x1y0\n\nNo.\n', '0.1.0')).toThrow(
      'no "## 0.1.0" section',
    );
  });

  it('refuses a version with no section, naming the heading to add', () => {
    expect(() => changelogSection(changelog, '0.3.0')).toThrow(
      'cli/CHANGELOG.md has no "## 0.3.0" section',
    );
  });

  it('refuses a version whose section is empty', () => {
    expect(() => changelogSection(changelog, '0.0.1')).toThrow(
      'the "## 0.0.1" section of cli/CHANGELOG.md is empty',
    );
  });
});
