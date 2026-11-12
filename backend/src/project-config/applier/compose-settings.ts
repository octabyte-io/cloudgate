import type { UpdateComposeDto } from '../../compose/dto/compose.dto';
import { DEFAULT_COMPOSE_FILE } from '../format/config-schema';
import type { ResolvedConnection } from '../git-connections';
import { composeFileValue } from '../planner/plan-environment';
import type { ComposeEntry } from '../project-config.types';
import { repositorySettings } from './service-settings';

/**
 * A `compose` entry as the columns `ComposeService.update` takes
 * (ADR-0069). Pure, like `service-settings.ts`: the Applier hands these to
 * the stack's own update path and never writes a column itself.
 *
 * Only the three fields the config owns are written — where the compose
 * file is, its path there and how it is deployed — and, when the
 * repository is new to the stack, the connection and branch it needs to
 * clone, which are Cloudgate's afterwards. Nothing of the file is here:
 * a plan never holds one.
 *
 * `source` is `null` when the plan does not change it, so a stack whose
 * file moved within its repository keeps its connection and branch.
 */
export function composeSettings(
  entry: ComposeEntry,
  source: {
    readonly connection: ResolvedConnection | null;
    readonly isNewRepository: boolean;
  } | null,
): UpdateComposeDto {
  return {
    // Stored as a console create stores one, from the code directory.
    composePath: `./${composeFileValue(entry.composePath ?? DEFAULT_COMPOSE_FILE)}`,
    composeType: entry.composeType ?? 'docker-compose',
    ...(source === null
      ? {}
      : repositorySettings(
          entry.source,
          source.connection,
          source.isNewRepository,
        )),
  };
}
