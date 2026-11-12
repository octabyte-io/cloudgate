import type { ComposeSourceType, CreateComposeDto } from './dto/compose.dto';

/**
 * The `sourceType` a create stores: the one given, else `raw` for a non-empty
 * compose file, else `undefined` so the insert takes the column's `github`.
 *
 * **What broke (#1338).** The create schema had no `sourceType`, so every
 * stack was stored `github`, and one created with a pasted file was refused
 * at deploy ("no source is chosen") with the file never read. The console hid
 * it behind a second `PATCH {sourceType: 'raw'}` whose failure it swallowed.
 *
 * **Inferred, not refused.** A create takes no repository fields, so a
 * non-empty file with no `sourceType` can only mean `raw`; refusing it would
 * break every API caller that creates with a file today, to protect rows that
 * could not deploy anyway. An empty file stays `github` because the console's
 * "From a repository" create sends exactly that and is pointed at a
 * repository afterwards. Whitespace-only counts as empty: it is not a file
 * anyone pasted.
 */
export function sourceTypeOnCreate(
  data: Pick<CreateComposeDto, 'composeFile' | 'sourceType'>,
): ComposeSourceType | undefined {
  if (data.sourceType) return data.sourceType;
  return data.composeFile?.trim() ? 'raw' : undefined;
}
