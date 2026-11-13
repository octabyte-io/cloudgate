import type { CommandContext } from './command.js';
import { CliError } from './errors.js';
import { EXIT } from './exit-codes.js';
import type { ExitCode } from './exit-codes.js';
import type { Connection } from './target-session.js';

/**
 * "Create a new Project", as a first `cloudgate deploy` in a folder with no
 * link offers it (spec #14): a Project made from the CLI, in `organization`,
 * that makes `folder` its Project folder and deploys it.
 *
 * Not built yet: it says so and changes nothing, here or on the Instance.
 */
export function createProjectHere(
  context: CommandContext,
  connection: Connection,
  organization: { id: string; name: string },
  folder: string,
): Promise<ExitCode> {
  void [context, connection, organization, folder];
  return Promise.reject(
    new CliError(
      'creating a Project from the CLI is not here yet; nothing was changed',
      EXIT.failed,
      'Make the Project in the console, then run cloudgate deploy here again.',
    ),
  );
}
