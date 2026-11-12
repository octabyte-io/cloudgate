import type { CloudKind } from '../cloud-accounts/cloud-account.schema';
import { kindsOn } from '../project-config';
import type { ProjectConfig } from '../project-config';

/**
 * Where a Template can run, as the catalogue marks it: `server` (a Server or
 * the platform host) and each cloud whose Cloud account can make every entry.
 */
export type RunsOn = 'server' | CloudKind;

const CLOUDS: readonly CloudKind[] = ['aws', 'gcp'];

/**
 * The where-it-runs mark, worked out from the plan's own per-cloud kind table
 * (`kindsOn`), never from anything the template declares: a cloud is on the
 * list only when it makes every entry's kind, the compose part's included
 * (on its own Stack VM, ADR-0070). A Server makes every kind a config can
 * describe, so it is always first.
 */
export function whereItRuns(config: ProjectConfig): RunsOn[] {
  const kinds = Object.values(config.services).map((entry) => entry.kind);
  return [
    'server',
    ...CLOUDS.filter((cloud) => {
      const made: ReadonlySet<string> = kindsOn(cloud);
      return kinds.every((kind) => made.has(kind));
    }),
  ];
}
