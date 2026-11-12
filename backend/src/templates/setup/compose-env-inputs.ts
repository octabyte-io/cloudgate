import { parse } from 'yaml';

import { composeVariables } from '../check';

/**
 * The inputs a Template's compose part writes into its stack's `.env`
 * (ADR-0064), in the order its compose file first reads them: every input
 * the file reads, with or without a default, so an answer to
 * `${TZ:-Etc/UTC}` is written and wins over the default (#1406). One read
 * only with a default and made blank is left out, so the compose default
 * still applies, `${X-d}` included.
 *
 * One rule for setup, which stores these as the compose part's values, and
 * for `cloudgate template try`, which writes them into its `.env` (spec #5):
 * kept apart from the setup service so the CLI can bundle it
 * (`cli-bundle.ts`).
 */
export function composeEnvInputs(
  composeFile: string | null,
  inputs: Readonly<Record<string, unknown>>,
  values: Readonly<Record<string, string>>,
): string[] {
  if (composeFile === null) return [];
  const read = composeVariables(
    parse(composeFile, { logLevel: 'error', maxAliasCount: 100 }),
  );
  return [...read.mentions].filter(
    (name) =>
      Object.hasOwn(inputs, name) &&
      (read.needs.has(name) || (values[name] ?? '') !== ''),
  );
}
