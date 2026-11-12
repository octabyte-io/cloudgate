import { CONFIG_NAME_REGEX } from '../../project-config';

/**
 * A setup's Config names (ADR-0065 "Names"): the setup name, a hyphen and
 * the template's own name for each part (`ghost-app`, `ghost-db`), so one
 * setup's parts read as belonging together.
 */

/**
 * One part's Config name. A part named like the template is not doubled:
 * the `ghost` template's `ghost` part is `ghost`, not `ghost-ghost`, and
 * set up as `blog` it is `blog`.
 */
export function partConfigName(
  setupName: string,
  templateId: string,
  part: string,
): string {
  return part === templateId ? setupName : `${setupName}-${part}`;
}

export type PickedNames =
  | {
      readonly ok: true;
      readonly setupName: string;
      /** Each part's Config name, by the template's own name for it. */
      readonly names: ReadonlyMap<string, string>;
    }
  | { readonly ok: false; readonly reason: string };

/** How far `-2`, `-3`, … goes before setup gives up and asks for a name. */
const MAX_SUFFIX = 99;

/**
 * The setup name the parts are made under, and their Config names. When any
 * resulting name is `taken` (in the config, or by a Service or a Pending
 * setup in any Environment), the setup name as a whole takes `-2`, `-3`, …,
 * never one part alone: `app` and `db-2` would hide that they are one setup.
 * Refused when the wanted name, or a name it makes, is not a Config name.
 */
export function pickSetupName(
  wanted: string,
  templateId: string,
  parts: readonly string[],
  taken: ReadonlySet<string>,
): PickedNames {
  if (!CONFIG_NAME_REGEX.test(wanted)) {
    return {
      ok: false,
      reason: `The setup name ${JSON.stringify(wanted)} is not a Config name: use lowercase letters, digits and hyphens, starting with a letter`,
    };
  }
  for (let suffix = 1; suffix <= MAX_SUFFIX; suffix += 1) {
    const setupName = suffix === 1 ? wanted : `${wanted}-${suffix}`;
    const names = new Map(
      parts.map((part) => [part, partConfigName(setupName, templateId, part)]),
    );
    const tooLong = [...names.values()].find(
      (name) => !CONFIG_NAME_REGEX.test(name),
    );
    if (tooLong) {
      return {
        ok: false,
        reason: `The setup name ${JSON.stringify(setupName)} makes ${tooLong}, which is longer than a Config name may be; choose a shorter one`,
      };
    }
    if ([...names.values()].every((name) => !taken.has(name))) {
      return { ok: true, setupName, names };
    }
  }
  return {
    ok: false,
    reason: `Every name from ${wanted} to ${wanted}-${MAX_SUFFIX} is taken in this Project; choose another setup name`,
  };
}
