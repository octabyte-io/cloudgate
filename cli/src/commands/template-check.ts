import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { checkCatalogue, encodeCatalogue } from 'cloudgate-template-check';

import type { Command } from '../command.js';
import { CliError, usageError } from '../errors.js';
import { EXIT } from '../exit-codes.js';
import { isFolder, templateFoldersAt } from '../template-folders.js';

/**
 * `cloudgate template check <path>`: runs the Template check an Instance runs
 * on its catalogue (ADR-0062, ADR-0072), here, with no Instance and no key,
 * so `cg-templates` CI merges only what Cloudgate itself accepts. The check
 * is the backend's own, bundled in (`template-check.d.ts`); this command only
 * reads files and reports. CI catches mistakes early but never replaces the
 * Instance's own check.
 *
 * A path is a `catalogue.zip`, one template folder (it holds a
 * `template.yaml`), or a folder of template folders. A folder is made into a
 * catalogue.zip first, exactly as `template pack` publishes it, so a folder
 * and the zip built from it get the same answer: the website's `index.md`
 * and `screenshots/` are left out, and any other file the zip may not hold
 * refuses it whole.
 */
export const templateCheck: Command = {
  name: 'template check',
  group: 'TEMPLATES',
  summary: 'Check templates as Cloudgate will read them',
  help: `Check templates as Cloudgate will read them.

USAGE
  cloudgate template check <path>

  <path> is a catalogue.zip, a template folder, or a folder of template
  folders. A folder is checked as the catalogue.zip it would be packed
  into: its website files (index.md, screenshots/) are skipped, and any
  other file a template does not have refuses the whole catalogue (exit 1).
  Otherwise prints each template with ✓, or ✗ and why Cloudgate would hide
  it, and exits 1 if any is hidden. Makes no request: the check is this
  CLI's copy of Cloudgate ${__CLOUDGATE_CHECK_VERSION__}'s own.
`,
  options: {},
  maxPositionals: 1,
  run({ cwd, out, positionals }) {
    const [given] = positionals;
    if (given === undefined) {
      throw usageError(
        'cloudgate template check needs a path',
        'Run cloudgate template check --help.',
      );
    }
    const path = resolve(cwd, given);
    const result = checkCatalogue(catalogueAt(path), {
      cloudgateVersion: __CLOUDGATE_CHECK_VERSION__,
    });
    if (!result.ok) throw new CliError(result.reason, EXIT.failed);

    for (const template of result.offered) out.data(`✓ ${template.id}\n`);
    for (const { id, reason } of result.hidden) {
      out.data(`✗ ${id}: ${reason}\n`);
    }
    return Promise.resolve(result.hidden.length === 0 ? EXIT.ok : EXIT.failed);
  },
};

/** The catalogue.zip a path holds, or the one its folders would be packed as. */
function catalogueAt(path: string): Uint8Array {
  if (!isFolder(path)) return readFileSync(path);
  // A folder on disk is not yet a catalogue commit.
  return encodeCatalogue(templateFoldersAt(path, 'unpublished'));
}
