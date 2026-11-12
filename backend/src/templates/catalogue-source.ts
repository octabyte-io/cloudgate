/**
 * Where this instance reads its **Template catalogue** from, or why it reads
 * none (ADR-0062, ADR-0066).
 */

/**
 * The official catalogue: the newest `cg-templates` release's one
 * `catalogue.zip` (ADR-0072; ADR-0062's `catalogue.json` before it).
 */
export const DEFAULT_TEMPLATES_URL =
  'https://github.com/octabyte-io/cg-templates/releases/latest/download/catalogue.zip';

/**
 * ADR-0066's sentence, word for word: what the startup log and the templates
 * screen say while only the old setting is set.
 */
export const OLD_TEMPLATES_SETTING_MESSAGE =
  '`CLOUDGATE_TEMPLATES_BASE_URL` is no longer read. Set `CLOUDGATE_TEMPLATES_URL`, or remove the old setting to use the official catalogue.';

/** What the templates screen says on `CLOUDGATE_TEMPLATES_URL=off`. */
export const TEMPLATES_OFF_MESSAGE =
  'Templates are turned off on this instance: CLOUDGATE_TEMPLATES_URL is off. Remove the setting to use the official catalogue, or set it to the address of a catalogue.zip.';

export type CatalogueSource =
  | { readonly on: true; readonly url: string }
  | { readonly on: false; readonly message: string };

/**
 * The catalogue address from the two settings, as validated by `env.schema.ts`.
 *
 * - `CLOUDGATE_TEMPLATES_URL` set: it wins, `off` included, whatever the old
 *   setting says.
 * - Only `CLOUDGATE_TEMPLATES_BASE_URL` set: off. Its operator may have
 *   pointed it at an internal mirror on a network that blocks GitHub, and
 *   switching them to the official catalogue would override that choice.
 * - Neither: the official catalogue.
 */
export function catalogueSource(settings: {
  readonly url: string | undefined;
  readonly oldBaseUrl: string | undefined;
}): CatalogueSource {
  if (settings.url === 'off') {
    return { on: false, message: TEMPLATES_OFF_MESSAGE };
  }
  if (settings.url) return { on: true, url: settings.url };
  if (settings.oldBaseUrl) {
    return { on: false, message: OLD_TEMPLATES_SETTING_MESSAGE };
  }
  return { on: true, url: DEFAULT_TEMPLATES_URL };
}
