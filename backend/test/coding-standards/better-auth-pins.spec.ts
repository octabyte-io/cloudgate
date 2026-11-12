import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The better-auth pins census gate. The property, stated once:
 *
 * > every `better-auth` and `@better-auth/*` dependency, in the backend and the
 * > console, is pinned exactly, and they are all pinned to the same version
 *
 * **Why lockstep.** `@better-auth/api-key`, `@better-auth/scim` and
 * `@better-auth/sso` each declare `better-auth` and `@better-auth/core` at
 * their own version as peers, and the console's client plugins
 * (`apiKeyClient`, `ssoClient`, `organizationClient`) have to match the
 * server's route and type shapes. A bump that moves some of the pins leaves
 * peer ranges unmet and can put two better-auth copies in the workspace.
 *
 * **What broke.** The ticket named two pins in one file; there were seven
 * across two. This gate makes the next partial bump red.
 *
 * **Why exact.** A caret lets `pnpm install` move one package without the
 * others, which is the partial bump by another route.
 */

const repoRoot = join(__dirname, '..', '..', '..');

const MANIFESTS = ['backend/package.json', 'frontend/package.json'] as const;

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

/** `better-auth` itself, or any package in the `@better-auth` scope. */
const BETTER_AUTH = /^(better-auth|@better-auth\/.+)$/;

/** A plain `major.minor.patch`, with no range operator in front of it. */
const EXACT = /^\d+\.\d+\.\d+$/;

interface Pin {
  manifest: string;
  name: string;
  version: string;
}

function pins(): Pin[] {
  const found: Pin[] = [];
  for (const manifest of MANIFESTS) {
    const json = JSON.parse(
      readFileSync(join(repoRoot, manifest), 'utf8'),
    ) as Partial<
      Record<(typeof DEPENDENCY_FIELDS)[number], Record<string, string>>
    >;
    for (const field of DEPENDENCY_FIELDS) {
      for (const [name, version] of Object.entries(json[field] ?? {})) {
        if (BETTER_AUTH.test(name)) found.push({ manifest, name, version });
      }
    }
  }
  return found;
}

const show = ({ manifest, name, version }: Pin) =>
  `${manifest} ${name}@${version}`;

describe('backend/package.json and frontend/package.json better-auth pins', () => {
  it('finds every pin the two manifests carry', () => {
    // The floor: an empty census passes both assertions below, so a rename
    // of a manifest or a field would otherwise turn this gate off silently.
    expect(pins().length).toBeGreaterThanOrEqual(7);
  });

  it('pins every better-auth package to an exact version', () => {
    expect(
      pins()
        .filter(({ version }) => !EXACT.test(version))
        .map(show),
    ).toEqual([]);
  });

  it('pins every better-auth package to the same version', () => {
    const found = pins();
    const [first] = found;
    expect(
      found.filter(({ version }) => version !== first.version).map(show),
    ).toEqual([]);
  });
});
