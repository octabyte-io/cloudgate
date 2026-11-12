import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';

import {
  WORKLOAD_PRESENCE_UNKNOWN_CODE,
  WORKLOAD_STILL_PRESENT_CODE,
  workloadKeptRefusal,
} from '../../src/common/workload-kept-refusal';

const backendRoot = join(__dirname, '..', '..');
const repoRoot = join(backendRoot, '..');

/** Every `new ConflictException(…)` in a file, as source text. */
function conflictThrows(path: string): string[] {
  const source = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'ConflictException'
    ) {
      found.push(node.getText(source));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('workloadKeptRefusal', () => {
  it('names a workload Docker still reports, and one it could not ask about, apart', () => {
    const present = workloadKeptRefusal('present', 'still running');
    const unknown = workloadKeptRefusal('unknown', 'not reached');

    expect(present.getStatus()).toBe(409);
    expect(present.getResponse()).toMatchObject({
      message: 'still running',
      code: WORKLOAD_STILL_PRESENT_CODE,
    });
    expect(unknown.getResponse()).toMatchObject({
      message: 'not reached',
      code: WORKLOAD_PRESENCE_UNKNOWN_CODE,
    });
  });

  /**
   * The console offers "Remove from Cloudgate anyway" on these codes and on
   * nothing else, so a Server Delete's refusal thrown as a bare
   * `ConflictException` would bring back an earlier bug: a 409 whose only way out is a
   * query parameter no control sends. The one exception is a Cron service's
   * run task on ECS, which is a cloud Delete (ADR-0038: its row stays until
   * the Cloud run ends, and the console offers Retry and Forget, not force).
   */
  it.each([
    ['applications/applications.service.ts', 1],
    ['databases/common/database-service.ts', 0],
    ['compose/compose.service.ts', 0],
  ])('leaves no forceable Delete refusal in %s uncoded', (file, cloudOnly) => {
    const bare = conflictThrows(join(backendRoot, 'src', file)).filter((text) =>
      text.includes('force=true'),
    );
    expect(bare).toHaveLength(cloudOnly);
    for (const text of bare) expect(text).toContain('AWS answers');
  });

  it("is mirrored in the console's own list of the codes it offers the force on", () => {
    const console_ = readFileSync(
      join(
        repoRoot,
        'frontend',
        'src',
        'lib',
        'api',
        'endpoints',
        'teardown.ts',
      ),
      'utf8',
    );
    for (const code of [
      WORKLOAD_STILL_PRESENT_CODE,
      WORKLOAD_PRESENCE_UNKNOWN_CODE,
    ]) {
      expect(console_).toMatch(new RegExp(`\\b${code}: "(present|unknown)"`));
    }
  });
});
