import { parseProjectConfig } from '../../src/project-config';
import type { ProjectConfig } from '../../src/project-config';
import { whereItRuns } from '../../src/templates/where-it-runs';

function config(text: string): ProjectConfig {
  const result = parseProjectConfig(text);
  if (!result.ok) throw new Error(result.refusal.message);
  return result.config;
}

/**
 * The where-it-runs mark, from the plan's own per-cloud kind table: the
 * clouds that make every entry, after a Server, which makes every kind.
 */
describe('whereItRuns', () => {
  it('names every cloud that makes all of its kinds, a compose part included', () => {
    expect(
      whereItRuns(
        config(`version: 1
services:
  app: { kind: compose, managed: console }
  db:
    kind: postgres
    version: "16"
`),
      ),
    ).toEqual(['server', 'aws', 'gcp']);
  });

  it('names only a Server when an entry is of a kind no cloud makes', () => {
    expect(
      whereItRuns(
        config(`version: 1
services:
  app:
    kind: web
    source: { image: "ghost:5.96" }
  db: { kind: mongo, managed: console }
`),
      ),
    ).toEqual(['server']);
  });
});
