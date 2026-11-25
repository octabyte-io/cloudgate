import { relative } from 'node:path';

import type { Command } from '../command.js';
import { EXIT } from '../exit-codes.js';
import { WORKING_COPY_FILE, WORKING_COPY_YML } from '../folder-link.js';
import { connectToInstance } from '../target-session.js';
import {
  downloadProjectConfig,
  findProjectFolder,
  mayReplaceWorkingCopy,
  saveWorkingCopy,
  workingCopyIn,
} from '../working-copy.js';

/**
 * `cloudgate config pull`: a fresh working copy of the Project config in
 * the nearest **Project folder** (ADR-0080), and the version it is recorded
 * at. A copy edited since its download is replaced only after asking in a
 * terminal, and without one only with `--yes`.
 */
export const configPull: Command = {
  name: 'config pull',
  group: 'THIS FOLDER',
  summary: "Replace this Project folder's cloudgate.yaml with Cloudgate's",
  help: `Replace this Project folder's ${WORKING_COPY_FILE} with the Project config.

USAGE
  cloudgate config pull [--yes]

  Downloads the Project config kept in Cloudgate into ${WORKING_COPY_FILE} at
  the Project folder (made by cloudgate link --whole-project), or into
  ${WORKING_COPY_YML} when that is the copy there, and records its version.
  A copy edited since it was downloaded is asked about first; with no
  terminal it is refused unless --yes is given.

FLAGS
  --yes                  Replace an edited copy without asking
`,
  options: { yes: { type: 'boolean' } },
  maxPositionals: 0,
  async run(context) {
    const { cwd, out, values } = context;
    const found = findProjectFolder(cwd, 'config pull');
    const { folder, link } = found;
    const { client } = await connectToInstance(context, found);
    const downloaded = await out.withSpinner(
      'Downloading the Project config…',
      () =>
        downloadProjectConfig(
          client.inOrganization(link.organizationId, link.names.organization),
          { id: link.projectId, name: link.names.project },
        ),
    );
    const shown = (name: string) =>
      folder === cwd ? name : `${relative(cwd, folder)}/${name}`;
    if (
      !(await mayReplaceWorkingCopy(
        context,
        folder,
        link.workingCopy,
        downloaded,
        values.yes === true,
      ))
    ) {
      out.note(
        `Kept ${shown(workingCopyIn(folder, out).name)}. Nothing changed.`,
      );
      return EXIT.ok;
    }
    const { name } = saveWorkingCopy(folder, link, downloaded);
    out.note(
      `✓ Saved the Project config, version ${downloaded.version}, as ${shown(name)}`,
    );
    return EXIT.ok;
  },
};
