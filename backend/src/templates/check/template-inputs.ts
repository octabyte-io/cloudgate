import {
  LISTED_NAMES,
  VARIABLE_LISTS,
} from '../../project-config/planner/fields';
import type { ConfigLink } from '../../project-config/project-config.types';
import type { Template } from './template-check';
import { domainCounts } from './template-domains';
import { REFERENCE_FORMS, referencesIn } from './template-references';
import type { TemplateReference } from './template-references';
import type { TemplateReading } from './template-rules';
import type { InputRule } from './template-yaml';

/**
 * Which names a template's `inputs` must give a rule (ADR-0064): every name
 * `cloudgate.yaml` lists without a link, in any of its variable lists, and
 * every `${NAME}` the compose file uses without a default. Nothing else may
 * have one.
 *
 * "Nothing else" is read as the ADR writes it, so an input that exists only
 * to be referred to by another (a `jwt`'s signing secret no Service reads, a
 * password only a `value` spells out) is refused too: a value nothing lists
 * has no Service whose `env` it could be saved in. The one loosening is a
 * compose variable that has a default: a rule for it is used, not extra,
 * since the stack's `env` then fills in what the default would have.
 */

/** Where each name is used, for the reason that names it. */
interface Uses {
  /** Listed name → the first entry that lists it. */
  readonly listed: ReadonlyMap<string, string>;
  /** Wired name → the first entry that wires it, and from what. */
  readonly wired: ReadonlyMap<string, { entry: string; link: ConfigLink }>;
}

function usesIn({ template }: TemplateReading): Uses {
  const listed = new Map<string, string>();
  const wired = new Map<string, { entry: string; link: ConfigLink }>();
  for (const [name, entry] of Object.entries(template.config.services)) {
    if (entry.managed === 'console') continue;
    for (const list of VARIABLE_LISTS) {
      for (const variable of LISTED_NAMES[list](entry)) {
        if (!listed.has(variable)) listed.set(variable, name);
      }
    }
    for (const [variable, link] of Object.entries(entry.links ?? {})) {
      if (!wired.has(variable)) wired.set(variable, { entry: name, link });
    }
  }
  return { listed, wired };
}

/**
 * A compose part never takes an Output (ADR-0064): a console-managed entry
 * links nothing, so a `${NAME}` that `cloudgate.yaml` wires on an own entry
 * could never be filled in for the stack. Copying the Output into the
 * stack's `env` instead was rejected in the ADR, since it drifts after a
 * password change.
 */
export function composeOutputRule(reading: TemplateReading): string | null {
  const { wired } = usesIn(reading);
  for (const name of reading.compose?.variables.needs ?? []) {
    const wiring = wired.get(name);
    if (wiring) {
      const { entry, link } = wiring;
      return `docker-compose.yml uses \${${name}}, which ${entry} wires from ${link.source}.${link.output} in cloudgate.yaml; a compose part never takes an Output`;
    }
  }
  return null;
}

/** Exactly one rule for each name that needs one, and none for any other. */
export function inputNamesRule(reading: TemplateReading): string | null {
  const { inputs } = reading.template;
  const { listed, wired } = usesIn(reading);
  const compose = reading.compose?.variables;

  for (const name of Object.keys(inputs)) {
    const wiring = wired.get(name);
    if (wiring) {
      const { entry, link } = wiring;
      return `template.yaml: inputs has a rule for ${name}, which ${entry} wires from ${link.source}.${link.output} in cloudgate.yaml; a Wired variable takes no rule`;
    }
  }
  for (const [name, entry] of listed) {
    if (!(name in inputs)) {
      return `template.yaml: inputs has no rule for ${name}, which ${entry} lists in cloudgate.yaml`;
    }
  }
  for (const name of compose?.needs ?? []) {
    if (!(name in inputs)) {
      return `template.yaml: inputs has no rule for ${name}, which docker-compose.yml uses`;
    }
  }
  for (const name of Object.keys(inputs)) {
    if (!listed.has(name) && !compose?.mentions.has(name)) {
      return `template.yaml: inputs has a rule for ${name}, which neither cloudgate.yaml nor docker-compose.yml uses`;
    }
  }
  return null;
}

/**
 * What each rule refers to holds: a `jwt`'s signing input exists, an asked
 * value's own default passes its own check, every `{{…}}` in a fixed value is
 * a reference to an input or to one Domain, no input shares a name with a
 * Domain, and no input reaches itself through others.
 */
export function inputReferencesRule({
  template,
}: TemplateReading): string | null {
  const { inputs } = template;
  const domains = domainCounts(template);
  for (const [name, rule] of Object.entries(inputs)) {
    const problem =
      'secret' in rule && !(rule.secret in inputs)
        ? ` is signed with ${rule.secret}, which is not an input`
        : 'ask' in rule
          ? askProblem(rule.ask)
          : 'value' in rule
            ? valueProblem(rule.value, inputs, domains)
            : null;
    if (problem) return `template.yaml: inputs.${name}${problem}`;
  }
  for (const name of Object.keys(inputs)) {
    if (domains.has(name)) {
      return `template.yaml: ${name} is both an input and a Domain, so {{${name}}} and {{domains.${name}.url}} would read alike; rename the input`;
    }
  }
  const loop = loopIn(inputs);
  return loop
    ? `template.yaml: inputs refer to each other in a loop: ${loop.join(' → ')}`
    : null;
}

type AskRule = Extract<InputRule, { ask: unknown }>['ask'];

/**
 * An asked value's own pattern compiles, and its default passes its check;
 * the problem follows the input's name, from its first `.` or space.
 */
function askProblem(ask: AskRule): string | null {
  if (ask.pattern !== undefined) {
    try {
      new RegExp(ask.pattern, 'u');
    } catch (error) {
      return `.ask.pattern is not a valid pattern: ${(error as Error).message}`;
    }
  }
  if (ask.default === undefined) return null;
  const problem = askedValueProblem(ask, ask.default);
  return problem ? `.ask.default ${problem}` : null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Whether `value` passes an asked value's one check, as a predicate to follow
 * its field's name, or null when it does. A `pattern` must match the whole
 * value, as an HTML `pattern` attribute does, so `[A-Z]{4}` does not take
 * `ABCDE`. Exported for the setup form's check on what the user types, so
 * the check here and the one there cannot drift.
 */
export function askedValueProblem(ask: AskRule, value: string): string | null {
  switch (ask.format) {
    case 'email':
      return EMAIL.test(value)
        ? null
        : 'must be an email address, as its format says';
    case 'url':
      return isHttpUrl(value)
        ? null
        : 'must be an http or https address, as its format says';
    case 'number':
      return value.trim() !== '' && Number.isFinite(Number(value))
        ? null
        : 'must be a number, as its format says';
  }
  if (ask.pattern !== undefined) {
    return new RegExp(`^(?:${ask.pattern})$`, 'u').test(value)
      ? null
      : `must match its pattern, ${ask.pattern}`;
  }
  return null;
}

function isHttpUrl(value: string): boolean {
  try {
    return ['http:', 'https:'].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

/** The first `{{…}}` in a fixed value that refers to nothing it may. */
function valueProblem(
  value: string,
  inputs: Template['inputs'],
  domains: ReadonlyMap<string, number>,
): string | null {
  for (const { written, reference } of referencesIn(value)) {
    const problem = referenceProblem(written, reference, inputs, domains);
    if (problem) return ` ${problem}`;
  }
  return null;
}

/**
 * Why one `{{…}}` refers to nothing it may, or null. Shared with config file
 * text, which reads only what is shaped like a reference; a fixed value has
 * no other use for braces, so there every `{{…}}` must be one.
 */
export function referenceProblem(
  written: string,
  reference: TemplateReference | null,
  inputs: Template['inputs'],
  domains: ReadonlyMap<string, number>,
): string | null {
  if (reference === null) {
    return `has ${written}, which is not a reference: write ${REFERENCE_FORMS}`;
  }
  if (reference.kind === 'input') {
    return reference.name in inputs
      ? null
      : `refers to ${written}, which is not an input`;
  }
  const count = domains.get(reference.name) ?? 0;
  if (count === 0) {
    return `refers to ${written}, but ${reference.name} has no Domain: a Domain is a compose service listed in domains, or an own web`;
  }
  if (count > 1) {
    return `refers to ${written}, but ${reference.name} has ${count} Domains, so it names none of them`;
  }
  return null;
}

/** The inputs a rule reads: a fixed value's `{{NAME}}`s, a jwt's secret. */
function readsOf(rule: InputRule): string[] {
  if ('secret' in rule) return [rule.secret];
  if (!('value' in rule)) return [];
  return referencesIn(rule.value).flatMap(({ reference }) =>
    reference?.kind === 'input' ? [reference.name] : [],
  );
}

/** The first loop among the inputs, from where it starts back to itself. */
function loopIn(inputs: Template['inputs']): string[] | null {
  const done = new Set<string>();
  const visit = (name: string, path: string[]): string[] | null => {
    const at = path.indexOf(name);
    if (at !== -1) return [...path.slice(at), name];
    if (done.has(name) || !(name in inputs)) return null;
    for (const next of readsOf(inputs[name])) {
      const loop = visit(next, [...path, name]);
      if (loop) return loop;
    }
    done.add(name);
    return null;
  };
  for (const name of Object.keys(inputs)) {
    const loop = visit(name, []);
    if (loop) return loop;
  }
  return null;
}
