import { relative } from 'node:path';

import type { Command } from '../command.js';
import { usageError } from '../errors.js';
import { EXIT } from '../exit-codes.js';
import {
  findNearestLink,
  isProjectFolder,
  WORKING_COPY_FILE,
} from '../folder-link.js';
import { connectToInstance } from '../target-session.js';
import {
  downloadProjectConfig,
  mayReplaceWorkingCopy,
  saveWorkingCopy,
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
  the Project folder (made by cloudgate link --whole-project) and records
  its version. A ${WORKING_COPY_FILE} edited since it was downloaded is asked
  about first; with no terminal it is refused unless --yes is given.

FLAGS
  --yes                  Replace an edited ${WORKING_COPY_FILE} without asking
`,
  options: { yes: { type: 'boolean' } },
  maxPositionals: 0,
  async run(context) {
    const { cwd, out, values } = context;
    const found = findNearestLink(cwd);
    if (found === undefined) {
      throw usageError(
        'this folder is not in a Project folder',
        'Run cloudgate link --whole-project at the root of the Project first.',
      );
    }
    const { folder, link } = found;
    if (!isProjectFolder(link)) {
      throw usageError(
        `this folder is linked to the Service ${link.names.service} of Project ${link.names.project}, not to a whole Project`,
        'Run cloudgate config pull in the Project folder, or cloudgate link --whole-project to make one.',
      );
    }

    const { client } = await connectToInstance(context, found);
    const downloaded = await out.withSpinner(
      'Downloading the Project config…',
      () =>
        downloadProjectConfig(
          client.inOrganization(link.organizationId, link.names.organization),
          { id: link.projectId, name: link.names.project },
        ),
    );
    const shown =
      folder === cwd
        ? WORKING_COPY_FILE
        : `${relative(cwd, folder)}/${WORKING_COPY_FILE}`;
    if (
      !(await mayReplaceWorkingCopy(
        context,
        folder,
        link.workingCopy,
        downloaded,
        values.yes === true,
      ))
    ) {
      out.note(`Kept ${shown}. Nothing changed.`);
      return EXIT.ok;
    }
    saveWorkingCopy(folder, link, downloaded);
    out.note(
      `✓ Saved the Project config, version ${downloaded.version}, as ${shown}`,
    );
    return EXIT.ok;
  },
};
