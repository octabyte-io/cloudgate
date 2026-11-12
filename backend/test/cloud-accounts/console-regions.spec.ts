import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AWS_REGIONS } from '../../src/cloud-accounts/aws/regions';
import { GOOGLE_REGIONS } from '../../src/cloud-accounts/gcp/regions';

/**
 * The console offers the regions a cloud Deploy target may name from its own
 * copy of the API's lists, kept in step by hand. A region missing
 * there is one the console cannot offer; one there and not here is one it
 * offers and the API refuses. This holds the two copies equal, so a region
 * added on one side only is red rather than found by an operator.
 */

const CONSOLE_FILE = 'frontend/src/features/environment/deploy-target.ts';

const consoleSource = readFileSync(
  join(__dirname, '..', '..', '..', CONSOLE_FILE),
  'utf8',
);

/** The string entries of the console's `export const <name> = [...] as const`. */
function consoleList(name: string): string[] {
  const found = new RegExp(
    `export const ${name} = \\[([^\\]]*)\\] as const;`,
  ).exec(consoleSource);
  if (!found) throw new Error(`${CONSOLE_FILE} has no ${name} list`);
  return [...found[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

describe('frontend/src/features/environment/deploy-target.ts regions', () => {
  it("offers exactly the API's AWS regions, in its order", () => {
    expect(consoleList('AWS_REGIONS')).toEqual([...AWS_REGIONS]);
  });

  it("offers exactly the API's Google Cloud regions, in its order", () => {
    expect(consoleList('GOOGLE_REGIONS')).toEqual([...GOOGLE_REGIONS]);
  });
});
