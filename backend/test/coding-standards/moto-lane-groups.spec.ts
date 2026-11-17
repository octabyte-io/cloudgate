import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parse } from 'yaml';

/**
 * The release's moto lane runs its suites as parallel jobs, one per group in
 * `e2e.yml`'s `moto` matrix, each running only the paths its group names.
 * A `*.moto-spec.ts` in no group would never run anywhere, and a release
 * would publish without it; a path in a group that is not a suite would fail
 * that job with "No tests found". So the groups' paths, together, are
 * exactly the moto suites on disk, each in one group.
 */
const BACKEND = resolve(__dirname, '../..');
const WORKFLOW = resolve(BACKEND, '../.github/workflows/e2e.yml');

function motoSuites(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return motoSuites(path);
    return entry.name.endsWith('.moto-spec.ts')
      ? [relative(BACKEND, path)]
      : [];
  });
}

type Group = { name: string; suites: string };

function groupedPaths(): string[] {
  const workflow = parse(readFileSync(WORKFLOW, 'utf8')) as {
    jobs: { moto: { strategy: { matrix: { group: Group[] } } } };
  };
  return workflow.jobs.moto.strategy.matrix.group.flatMap((group) =>
    group.suites.split(/\s+/).filter(Boolean),
  );
}

describe('.github/workflows/e2e.yml and its moto matrix groups', () => {
  it('name every moto suite on disk, each in exactly one group', () => {
    const grouped = groupedPaths();
    expect([...grouped].sort()).toEqual(
      motoSuites(join(BACKEND, 'test')).sort(),
    );
    expect(new Set(grouped).size).toBe(grouped.length);
  });
});
