import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { checkCatalogue, encodeCatalogue } from 'cloudgate-template-check';

import type { Command } from '../command.js';
import { CliError, usageError } from '../errors.js';
import { EXIT } from '../exit-codes.js';
import { isFolder, templateFoldersAt } from '../template-folders.js';

/**
 * `cloudgate template pack <folder> <out>`: builds the `catalogue.zip` a
 * `cg-templates` release publishes (ADR-0072) with Cloudgate's own builder,
 * the `encodeCatalogue` an Instance's check is written against, so CI never
 * keeps a second zip writer that could drift from what Cloudgate reads.
 *
 * It runs `template check`'s check on the bytes first and writes nothing
 * unless every template would be offered: a zip refused whole would leave
 * every install on its last good copy, and a hidden template is one CI
 * should have stopped at review, not one to ship and have installs hide.
 *
 * One revision for every template, from `--revision`, rather than each
 * folder's last commit: working that out needs git, which this CLI does not
 * read, and the release's own commit names a version every template is at.
 * Per-folder revisions can come later as their own flag if CI needs them.
 */
export const templatePack: Command = {
  name: 'template pack',
  group: 'TEMPLATES',
  summary: 'Build the catalogue.zip a release publishes',
  help: `Build the catalogue.zip a cg-templates release publishes.

USAGE
  cloudgate template pack <folder> <out> [--revision <sha>]

  <folder> is a template folder or a folder of template folders, found as
  template check finds them. Checks them first, exactly as template check
  does, and writes nothing (exit 1) if the catalogue is refused or any
  template would be hidden. Otherwise writes the catalogue.zip to <out>,
  leaving the website files (index.md, screenshots/) and test-values.yaml
  out, and prints each template packed. The check and the zip are this CLI's copy of Cloudgate
  ${__CLOUDGATE_CHECK_VERSION__}'s own.

FLAGS
  --revision <sha>   The revision every template is published at, usually
                     the release's commit (default unpublished)
`,
  options: {
    revision: { type: 'string' },
  },
  maxPositionals: 2,
  run({ cwd, out, positionals, values }) {
    const [givenFolder, givenOut] = positionals;
    if (givenFolder === undefined || givenOut === undefined) {
      throw usageError(
        'cloudgate template pack needs a folder and the file to write',
        'Run cloudgate template pack --help.',
      );
    }
    const folder = resolve(cwd, givenFolder);
    const target = resolve(cwd, givenOut);
    if (!isFolder(folder)) {
      throw usageError(
        `${folder} is not a folder`,
        'Pack a template folder or a folder of template folders.',
      );
    }
    const revision =
      typeof values.revision === 'string' ? values.revision : 'unpublished';

    const folders = templateFoldersAt(folder, revision);
    // An empty catalogue is a sound zip, and publishing one would take
    // every template away from every install that reads the release.
    if (folders.length === 0) {
      throw new CliError(
        `${folder} holds no template folder; ${target} was not written`,
        EXIT.failed,
      );
    }
    const bytes = encodeCatalogue(folders);
    const result = checkCatalogue(bytes, {
      cloudgateVersion: __CLOUDGATE_CHECK_VERSION__,
    });
    if (!result.ok) {
      throw new CliError(
        `${result.reason}; ${target} was not written`,
        EXIT.failed,
      );
    }
    if (result.hidden.length > 0) {
      for (const { id, reason } of result.hidden) {
        out.data(`✗ ${id}: ${reason}\n`);
      }
      throw new CliError(
        `${result.hidden.length} of ${folders.length} templates would be hidden; ${target} was not written`,
        EXIT.failed,
        'Run cloudgate template check on the folder, and fix what it names.',
      );
    }

    writeFileSync(target, bytes);
    for (const template of result.offered) out.data(`✓ ${template.id}\n`);
    out.note(
      `✓ Packed ${result.offered.length} template${result.offered.length === 1 ? '' : 's'} into ${target}`,
    );
    return Promise.resolve(EXIT.ok);
  },
};
