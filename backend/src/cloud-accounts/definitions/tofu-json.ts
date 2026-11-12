// What every cloud's OpenTofu definitions share: the JSON
// they are written in, the state's schema, and the escapes, references
// and variable names inside them. The provider blocks are each cloud's own.

/** A JSON object in OpenTofu's JSON syntax, written as `main.tf.json`. */
export type TofuDefinition = Record<string, unknown>;

/**
 * The schema the `pg` backend keeps every state in (ADR-0036 item 2).
 * Cloudgate's migrations create it and its table, so `tofu` creates nothing;
 * which state a run reads is its workspace name, chosen by the run.
 */
export const INFRASTRUCTURE_STATE_SCHEMA = 'infrastructure_state';

/** `${address.attribute}`, an OpenTofu reference inside a JSON string. */
export function ref(address: string, attribute: string): string {
  return `\${${address}.${attribute}}`;
}

/**
 * A string from outside Cloudgate (a config's `command` or `args`) made safe
 * to put in a definition. In OpenTofu's JSON syntax every string is a
 * template, so a `${…}` or `%{…}` an operator wrote would be evaluated, or
 * refuse the plan, instead of reaching the container as written.
 */
export function literal(value: string): string {
  // A function replacer: in a replacement string `$$` is itself an escape
  // for one `$`, which would undo the doubling.
  return value.replace(/\$\{/g, () => '$${').replace(/%\{/g, () => '%%{');
}

/**
 * The `tofu` variable that carries one value. An OpenTofu identifier holds
 * letters, digits, `_` and `-`, so the two other characters a name may have
 * are written as `-` and their hex code (`.` is `-2e`, `-` itself `-2d`),
 * which keeps two names from ever sharing one.
 */
export function valueVariable(name: string): string {
  return `variable_value_${name.replace(/[^A-Za-z0-9_]/g, (character) => `-${character.charCodeAt(0).toString(16)}`)}`;
}

/**
 * The definition as the file `tofu` reads, keys sorted at every level so the
 * same input always writes the same bytes: a stored plan fixture stays valid
 * and a reviewer can diff two of them.
 */
export function renderDefinition(definition: TofuDefinition): string {
  return `${JSON.stringify(sortKeys(definition), null, 2)}\n`;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(object)
        .sort()
        .map((key) => [key, sortKeys(object[key])]),
    );
  }
  return value;
}
