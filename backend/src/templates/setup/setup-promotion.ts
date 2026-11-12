import { partConfigName } from './setup-names';

/** A Setup record, as far as setting its template up again reads it. */
export interface RecordedSetup {
  readonly setupRecordId: string;
  readonly templateId: string;
  readonly setupName: string;
  readonly configNames: readonly string[];
}

/** The Setup record a setup in one more Environment takes its names from. */
export interface PromotedSetup {
  readonly setupRecordId: string;
  readonly setupName: string;
  /** Each part's Config name, by the template's own name for it. */
  readonly names: ReadonlyMap<string, string>;
}

/**
 * **Setting a template up in one more Environment** (ADR-0065, #1377): the
 * Setup record of the same template under the same setup name, when none of
 * its Config names is in this Environment yet (no Service, no Pending
 * setup). Its names are reused as they are, never renamed to `-2`: the
 * config already lists them for the Project, and this Environment holds
 * them back until now. `null` when no record fits, and setup names the
 * parts as a new setup; so does a revision whose parts no longer make
 * exactly the record's names.
 */
export function promotedSetup(
  records: readonly RecordedSetup[],
  wanted: {
    readonly templateId: string;
    readonly setupName: string;
    readonly parts: readonly string[];
  },
  here: ReadonlySet<string>,
): PromotedSetup | null {
  for (const record of records) {
    if (
      record.templateId !== wanted.templateId ||
      record.setupName !== wanted.setupName ||
      record.configNames.some((name) => here.has(name))
    ) {
      continue;
    }
    const names = new Map(
      wanted.parts.map((part) => [
        part,
        partConfigName(record.setupName, record.templateId, part),
      ]),
    );
    const made = new Set(names.values());
    if (
      made.size !== record.configNames.length ||
      !record.configNames.every((name) => made.has(name))
    ) {
      continue;
    }
    return {
      setupRecordId: record.setupRecordId,
      setupName: record.setupName,
      names,
    };
  }
  return null;
}
