/**
 * The two decisions `.github/workflows/release-cli.yml` makes before it
 * publishes anything (CLI spec, Release), here so they are unit-tested rather
 * than read off a CI log:
 *
 * - `releaseFromTag`: the pushed `cli-v<version>` tag must name exactly the
 *   version in `cli/package.json`, and a version with a prerelease part goes to
 *   the `next` dist-tag, every other to `latest`.
 * - `changelogSection`: the GitHub Release's text is that version's section of
 *   `cli/CHANGELOG.md`, and a version with no section fails before the publish,
 *   so every published version gets its Release.
 *
 * Run by Node directly (its type stripping), so it imports nothing but Node:
 *
 *   node cli/scripts/release.ts check <tag>    # prints version=, dist-tag=, prerelease=
 *   node cli/scripts/release.ts notes <version> # prints the section
 */
import { readFileSync } from 'node:fs';
import { argv, exit, stderr, stdout } from 'node:process';
import { fileURLToPath } from 'node:url';

export interface Release {
  version: string;
  distTag: 'latest' | 'next';
  prerelease: boolean;
}

/**
 * semver 2.0.0's own grammar, without build metadata: npm drops `+…` from a
 * published version, so a tag carrying it could never match what npm shows.
 */
const NUMBER = '(?:0|[1-9]\\d*)';
const IDENTIFIER = `(?:${NUMBER}|\\d*[A-Za-z-][0-9A-Za-z-]*)`;
const TAG = new RegExp(
  `^cli-v(${NUMBER}\\.${NUMBER}\\.${NUMBER}(?:-${IDENTIFIER}(?:\\.${IDENTIFIER})*)?)$`,
);

export function releaseFromTag(tag: string, packageVersion: string): Release {
  const match = TAG.exec(tag);
  if (!match) {
    throw new Error(
      `${tag} is not a cli-v<version> tag (for example cli-v0.1.0 or cli-v0.1.0-beta.1)`,
    );
  }
  const version = match[1];
  if (version !== packageVersion) {
    throw new Error(
      `tag ${tag} says ${version} but cli/package.json says ${packageVersion}`,
    );
  }
  const prerelease = version.includes('-');
  return { version, distTag: prerelease ? 'next' : 'latest', prerelease };
}

/**
 * The text under `## <version>` (anything after the version on that line, such
 * as a date, is allowed) up to the next `## ` heading or the end of the file,
 * trimmed. `###` entries inside the section are part of it.
 */
export function changelogSection(changelog: string, version: string): string {
  const lines = changelog.split(/\r?\n/);
  const isHeading = (line: string) => line.startsWith('## ');
  const start = lines.findIndex(
    (line) =>
      isHeading(line) &&
      (line === `## ${version}` || line.startsWith(`## ${version} `)),
  );
  if (start === -1) {
    throw new Error(
      `cli/CHANGELOG.md has no "## ${version}" section; move the Unreleased entries under that heading`,
    );
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex(isHeading);
  const section = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
  if (section === '') {
    throw new Error(`the "## ${version}" section of cli/CHANGELOG.md is empty`);
  }
  return section;
}

function main(args: string[]): void {
  const [action, value] = args;
  const here = (path: string) =>
    readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
  if (action === 'check' && value) {
    const { version } = JSON.parse(here('../package.json')) as {
      version: string;
    };
    const release = releaseFromTag(value, version);
    stdout.write(
      `version=${release.version}\ndist-tag=${release.distTag}\nprerelease=${release.prerelease}\n`,
    );
    return;
  }
  if (action === 'notes' && value) {
    stdout.write(`${changelogSection(here('../CHANGELOG.md'), value)}\n`);
    return;
  }
  throw new Error(
    'usage: node cli/scripts/release.ts check <tag> | notes <version>',
  );
}

if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
  try {
    main(argv.slice(2));
  } catch (error) {
    stderr.write(`Error: ${(error as Error).message}\n`);
    exit(1);
  }
}
