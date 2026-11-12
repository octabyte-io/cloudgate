import { relative } from 'node:path';

import type { Command } from '../command.js';
import { EXIT } from '../exit-codes.js';
import { nearestLinkedFolder, removeLink } from '../folder-link.js';

/**
 * `cloudgate unlink`: deletes the Folder link this folder uses — its own, or
 * the nearest one above it — and makes no request. It picks no
 * Instance and needs no key, so it works offline and can never change
 * anything on a Cloudgate. Unlinking an unlinked folder is not an error.
 */
export const unlink: Command = {
  name: 'unlink',
  group: 'THIS FOLDER',
  summary: "Remove this folder's link",
  help: `Remove this folder's link.

USAGE
  cloudgate unlink

  Deletes the link this folder uses: its own .cloudgate/link.json, or the
  nearest one above it. Makes no request: nothing changes on the Instance.
`,
  options: {},
  maxPositionals: 0,
  run({ cwd, out }) {
    const folder = nearestLinkedFolder(cwd);
    if (folder === undefined || !removeLink(folder)) {
      out.note('This folder is not linked. Nothing to remove.');
      return Promise.resolve(EXIT.ok);
    }
    const where =
      folder === cwd
        ? "this folder's link"
        : `the link in ${relative(cwd, folder)}`;
    out.note(`✓ Removed ${where}. Nothing changed on the Instance.`);
    return Promise.resolve(EXIT.ok);
  },
};
