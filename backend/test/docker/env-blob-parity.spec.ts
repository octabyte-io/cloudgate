import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'dotenv';
import { prepareEnvironmentVariables } from '../../src/docker/docker.utils';

/**
 * The console reads a variable block with its own port of dotenv's grammar
 * (`frontend/src/lib/format/env-blob.ts`), because it cannot import this
 * package. The two readings are held together by one fixture table, which the
 * console's `env-blob.test.ts` runs through `parseEnvBlob` and this spec runs
 * through the deploy's own reading (the console listed a multi-line
 * quoted value as its first line, the container got all of it).
 *
 * If this reds after a `dotenv` upgrade, the grammar moved: re-copy its `LINE`
 * into `env-blob.ts` and fix the fixture row, so both sides move together.
 */
type Fixture = { name: string; blob: string; vars: Record<string, string> };

const fixtures = JSON.parse(
  readFileSync(
    join(__dirname, '../../../frontend/src/lib/format/env-blob.fixtures.json'),
    'utf8',
  ),
) as Fixture[];

describe('frontend/src/lib/format/env-blob.fixtures.json — the deploy reads every row as the console does', () => {
  it('has rows to read', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  it.each(fixtures)('dotenv.parse: $name', ({ blob, vars }) => {
    const parsed = parse(blob);
    expect(parsed).toEqual(vars);
    expect(Object.keys(parsed)).toEqual(Object.keys(vars));
  });

  it.each(fixtures.filter((f) => !f.blob.includes('${{')))(
    'prepareEnvironmentVariables: $name',
    ({ blob, vars }) => {
      expect(prepareEnvironmentVariables(blob)).toEqual(
        Object.entries(vars).map(([key, value]) => `${key}=${value}`),
      );
    },
  );
});
