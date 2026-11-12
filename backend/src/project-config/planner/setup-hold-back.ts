import type { PlanInput, PlanNote, PlanRefusal } from './plan.types';
import { linkText } from './plan-links';

/** A plan's input with the parts it holds back taken out of its config. */
export interface HeldBack {
  /** The input to plan: the config without the held-back entries. */
  readonly input: PlanInput;
  /** One note per Setup record held back. */
  readonly notes: readonly PlanNote[];
  /** A link from an entry that is planned to one that is held back. */
  readonly refusals: readonly PlanRefusal[];
}

/**
 * **Holding a setup back** (ADR-0065, #1377). A Template set up in one
 * Environment adds its entries to the Project's config, which every
 * Environment plans. Where none of a Setup record's parts exists and no
 * Pending setup covers any of them, the template was never set up here: its
 * own-kind parts would be created with no values, and its console-managed
 * stack line has no stack to match. So every part is held back together,
 * as if the config did not list it, with one note, until the template is
 * set up in this Environment too.
 *
 * Holding back never destroys: a part that does not exist here has
 * nothing to destroy. A part that exists, or that a Pending setup covers,
 * holds nothing back, and the setup's parts plan as ordinary entries.
 */
export function holdBackSetups(input: PlanInput): HeldBack {
  const records = input.setupRecords ?? [];
  if (records.length === 0) return { input, notes: [], refusals: [] };
  const saved = new Set(input.saved.map((found) => found.configName));
  const covered = new Set(
    (input.pendingSetups ?? []).flatMap((setup) =>
      setup.parts.map((part) => part.configName),
    ),
  );
  const listed = input.config.services;

  const held = new Map<string, string>();
  const notes: PlanNote[] = [];
  for (const record of records) {
    const parts = record.configNames.filter((name) =>
      Object.hasOwn(listed, name),
    );
    if (parts.length === 0) continue;
    if (
      record.configNames.some((name) => saved.has(name) || covered.has(name))
    ) {
      continue;
    }
    for (const name of parts) held.set(name, record.templateId);
    notes.push({
      kind: 'setup-held-back',
      configName: parts[0],
      configNames: parts,
      templateId: record.templateId,
      setupName: record.setupName,
      message: `${listing(parts)} ${parts.length === 1 ? 'is' : 'are'} held back here: ${parts.length === 1 ? 'it was' : 'they were'} set up from the ${record.templateId} template in another Environment, and ${parts.length === 1 ? 'is' : 'are'} created here when the template is set up in this Environment`,
    });
  }
  if (held.size === 0) return { input, notes: [], refusals: [] };

  const refusals: PlanRefusal[] = [];
  for (const [name, entry] of Object.entries(listed)) {
    if (held.has(name) || entry.managed === 'console') continue;
    for (const [variable, link] of Object.entries(entry.links ?? {})) {
      const templateId = held.get(link.source);
      if (templateId === undefined) continue;
      const at = `${name}.env.${variable}`;
      refusals.push({
        at,
        message: `${at} links to ${linkText(link)}, but ${link.source} is held back in this Environment until the ${templateId} template is set up here`,
      });
    }
  }

  return {
    input: {
      ...input,
      config: {
        ...input.config,
        services: Object.fromEntries(
          Object.entries(listed).filter(([name]) => !held.has(name)),
        ),
      },
    },
    notes,
    refusals,
  };
}

/** `a`, `a and b`, `a, b and c`. */
function listing(names: readonly string[]): string {
  return names.length === 1
    ? names[0]
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
