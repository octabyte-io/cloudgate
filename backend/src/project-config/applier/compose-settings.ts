import type { UpdateComposeDto } from '../../compose/dto/compose.dto';
import type { ResolvedConnection } from '../git-connections';
import { composeEntryFile } from '../planner/plan-environment';
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
 * `savedComposePath` is the stack's stored path, `null` for a stack the
 * plan makes: an entry with no `file` keeps a saved `./docker-compose.yml`
 * and otherwise names none (`composeEntryFile`, ADR-0091).
 */
export function composeSettings(
  entry: ComposeEntry,
  source: {
    readonly connection: ResolvedConnection | null;
    readonly isNewRepository: boolean;
  } | null,
  savedComposePath: string | null,
): UpdateComposeDto {
  const file = composeEntryFile(entry, savedComposePath);
  return {
    // Stored as a console create stores one, from the code directory; no
    // file named is `null`, which each deploy finds (ADR-0091).
    composePath: file === null ? null : `./${file}`,
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
