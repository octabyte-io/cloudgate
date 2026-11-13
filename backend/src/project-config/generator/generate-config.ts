import { stringify } from 'yaml';

import {
  describedEntrySchema,
  gitUrlCarriesCredentials,
  SOURCE_PROVIDERS,
} from '../format/config-schema';
import { sizeWireSchema } from '../format/config-size';
import { postgresReservesRole } from '../format/config-wire';
import { parseProjectConfig } from '../format/parse-config';
import {
  canonical,
  comparedView,
  comparesNativeDocker,
  configKindOf,
  kindOf,
  planEnvironment,
} from '../planner/plan-environment';
import type { View } from '../planner/plan-environment';
import {
  ONLY_WHEN_STATED,
  VARIABLE_KEYS,
  VARIABLE_LISTS,
} from '../planner/fields';
import type {
  ConfigKind,
  DeployTarget,
  SavedService,
} from '../planner/plan.types';
import { isNetworkStep, movesConsoleStackVm } from '../planner/cloud-steps';
import {
  NATIVE_DOCKER_KEYS,
  nativeDockerBlockOf,
  nativeDockerRefusals,
} from '../../native/docker-native';
import type { NativeDockerBlock } from '../../native/docker-native';

/** One Environment of the Project, as the generator reads it. */
export interface GeneratorEnvironment {
  /** Its name, for the comments; never matched on. */
  readonly name: string;
  readonly deployTarget: DeployTarget;
  readonly saved: readonly SavedService[];
}

export interface GeneratorInput {
  /** Every Environment of the Project, in the order the comments name them. */
  readonly environments: readonly GeneratorEnvironment[];
  /**
   * The URL this instance serves the JSON Schema at, as an operator's editor
   * reaches it; `null` writes no `$schema` comment (there is no default host).
   */
  readonly schemaUrl: string | null;
  /**
   * The Config names the stored config already describes. A MySQL or a
   * Compose stack is described only when its entry already is: no generated
   * config hands one over, but a console Save of one its operator handed
   * over keeps it described rather than listing it `managed: console` again.
   */
  readonly described?: ReadonlySet<string>;
}

/** A wire entry being written, in the order its keys are written. */
type Wire = Record<string, unknown>;

type Entry =
  | {
      readonly configName: string;
      readonly wire: Wire;
      readonly notes: string[];
    }
  | {
      readonly configName: string;
      readonly console: string;
      readonly why: string;
    };

/**
 * The Generator: a Project's config written from the saved
 * settings of every Environment, so that its first plan in each changes
 * nothing. A pure function — no database, no clock.
 *
 * - A Service every Environment has, of an expressible kind, on whose
 *   config-owned fields they all agree, is described. Its variable names are
 *   the union across Environments (a name one lacks is a note there, never a
 *   change); its size is the matching name, else the custom pair, else left
 *   out (caps it cannot write stay as they are). Its seven Swarm settings
 *   are written under `native.docker` less the kind's defaults.
 * - Any other Service is listed `managed: console`, with a comment saying
 *   why: a kind version 1 cannot describe, a Service in only some
 *   Environments, Environments disagreeing on its kind or a config-owned
 *   field (its size and a postgres's `database` and `user` among them) or
 *   one of the seven Swarm settings, a git URL carrying a credential (never copied into the text), or a
 *   setting version 1 cannot write.
 * - Then the planner runs against every Environment, with the text as the
 *   stored config it would be, and any entry still showing a difference is
 *   demoted too, until every plan is empty but for a console-managed
 *   stack's Stack VM, which the plan makes and moves whatever the config
 *   says (`movesConsoleStackVm`).
 */
export function generateProjectConfig(input: GeneratorInput): string {
  const entries = generateEntries(
    input.environments,
    input.described ?? new Set(),
  );

  for (;;) {
    const text = render(entries, input.schemaUrl);
    const parsed = parseProjectConfig(text);
    if (!parsed.ok) {
      throw new Error(
        `The generated Project config does not parse: ${parsed.refusal.message}`,
      );
    }
    const residual = new Map<string, Set<string>>();
    const add = (name: string, what: string) =>
      residual.set(name, (residual.get(name) ?? new Set()).add(what));

    for (const environment of input.environments) {
      const outcome = planEnvironment({
        config: parsed.config,
        saved: environment.saved,
        deployTarget: environment.deployTarget,
        context: { previous: parsed.config },
      });
      if (!outcome.ok) {
        for (const refusal of outcome.refusals) {
          if (refusal.at === null) throw new Error(refusal.message);
          add(refusal.at.split('.')[0], `a refusal in ${environment.name}`);
        }
        continue;
      }
      for (const step of outcome.steps) {
        if (isNetworkStep(step)) continue;
        if (movesConsoleStackVm(step, parsed.config)) continue;
        const fields =
          step.action === 'destroy'
            ? 'a destroy'
            : step.action === 'redeploy'
              ? 'a redeploy'
              : step.fields.map((diff) => diff.field).join(', ') || step.action;
        add(step.configName, `${fields} in ${environment.name}`);
      }
    }
    if (residual.size === 0) return text;

    for (const [name, what] of residual) {
      const at = entries.findIndex((entry) => entry.configName === name);
      const entry = entries[at];
      if (at < 0 || 'console' in entry) {
        throw new Error(
          `A console-managed entry still plans a change: ${name}`,
        );
      }
      entries[at] = {
        configName: name,
        console: String(entry.wire.kind),
        why: `Cloudgate could not describe it so that its first plan changes nothing (${[...what].join('; ')})`,
      };
    }
  }
}

// ── Entries ──

function generateEntries(
  environments: readonly GeneratorEnvironment[],
  described: ReadonlySet<string>,
): Entry[] {
  const names = new Set<string>();
  for (const environment of environments) {
    for (const found of environment.saved) names.add(found.configName);
  }
  return [...names]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => entryFor(name, environments, described));
}

function entryFor(
  configName: string,
  environments: readonly GeneratorEnvironment[],
  described: ReadonlySet<string>,
): Entry {
  const present = environments.flatMap((environment) => {
    const found = environment.saved.find((s) => s.configName === configName);
    return found ? [{ environment: environment.name, found }] : [];
  });
  const consoleManaged = (why: string, kind = kindOf(present[0].found)) => ({
    configName,
    console: kind,
    why,
  });

  const kinds = [...new Set(present.map(({ found }) => kindOf(found)))];
  if (kinds.length > 1) {
    return consoleManaged(
      `Its Environments disagree on its kind (${present
        .map(({ environment, found }) => `${kindOf(found)} in ${environment}`)
        .join(', ')}), and the config holds one kind for every Environment`,
    );
  }
  const kind = configKindOf(present[0].found);
  // A MySQL can be described as `kind: mysql`, but its operator hands it over by
  // removing `managed: console`, never an upgrade or a generated config
  // (the Server kinds spec, US8): the line and its comment stay as they were. One the
  // stored config already describes stays described. A Compose stack the
  // same way (ADR-0069).
  if (
    kind === null ||
    ((kind === 'mysql' || kind === 'compose') && !described.has(configName))
  ) {
    return consoleManaged(
      `Version 1 cannot describe a ${kinds[0]} Service, so the console keeps it`,
    );
  }
  if (present.length < environments.length) {
    const missing = environments
      .map((environment) => environment.name)
      .filter((name) => !present.some((p) => p.environment === name));
    return consoleManaged(
      `It exists only in the ${list(present.map((p) => p.environment))} ${plural(present.length, 'Environment')}, not in ${list(missing)}, and the config describes a Service for every Environment`,
    );
  }

  const bases: Wire[] = [];
  for (const { found } of present) {
    const base = baseEntry(kind, found);
    if (typeof base === 'string') return consoleManaged(base);
    bases.push(base);
  }
  const compared = present.map(({ found }) => comparedView(found)!);
  const views = compared.map(({ view }) => view);
  // Every config-owned field is held once for every Environment, a size
  // and a postgres's database and user among them (US10).
  const differing = compared[0].fields.find(
    (field) => !agreed(views.map((view) => view[field] ?? null)).agreed,
  );
  if (differing !== undefined) {
    return consoleManaged(
      `Its Environments disagree on ${differing}, which the config holds once for every Environment`,
    );
  }

  const notes: string[] = [];
  const { description, ...rest } = bases[0];
  const ordered: Wire = { kind };
  if (description !== undefined) ordered.description = description;

  // The Environments agree on these; each is written only when it can be,
  // since leaving one out leaves each Environment's own.
  const { size } = views[0];
  if (size !== null && size !== undefined) {
    if (sizeWireSchema.safeParse(size).success) {
      ordered.size = size;
    } else {
      notes.push(
        'size is left out: its caps cannot be written as a size, so they stay as they are',
      );
    }
  }
  Object.assign(ordered, rest);

  // A user PostgreSQL reserves never ran, and the config refuses it,
  // so the console keeps the Service rather than the text failing to parse.
  const user = views[0].user;
  if (
    kind === 'postgres' &&
    typeof user === 'string' &&
    postgresReservesRole(user)
  ) {
    return consoleManaged(
      `Its user ${user} is a role name PostgreSQL reserves, which the config refuses`,
    );
  }

  if (kind === 'postgres' || kind === 'mysql') {
    for (const field of ['database', 'user'] as const) {
      const value = views[0][field];
      if (typeof value === 'string' && value !== '') ordered[field] = value;
    }
  }

  for (const list of VARIABLE_LISTS) {
    const union = new Set<string>();
    for (const { found } of present) {
      if ('variables' in found) {
        for (const key of VARIABLE_KEYS[list](found.variables)) union.add(key);
      }
    }
    if (union.size > 0) ordered[list] = [...union];
  }

  // A link is never made by generating: only the links an applied
  // config already gave this Service are written back, so a config written
  // again from saved settings still plans nothing. Environments that hold
  // different links disagree, which the plan check below finds.
  const applied = Object.entries(
    present.find(({ found }) => found.links)?.found.links ?? {},
  );
  if (applied.length > 0) {
    ordered.env = [
      ...((ordered.env as string[] | undefined) ?? []),
      ...applied.map(([name, link]) => ({
        [name]: `${link.source}.${link.output}`,
      })),
    ];
  }

  const docker = nativeDockerOf(configName, kind, present);
  if (typeof docker === 'string') return consoleManaged(docker);
  if (docker !== undefined) ordered.native = { docker };

  const valid = describedEntrySchema.safeParse(ordered);
  if (!valid.success) {
    return consoleManaged(
      `Its ${valid.error.issues[0].path.join('.') || 'settings'} cannot be written in version 1, so the console keeps it`,
    );
  }
  return { configName, wire: ordered, notes };
}

/**
 * The `native.docker` a described Service is written with: the seven
 * Swarm settings each Environment whose plan compares them stores, less the
 * kind's defaults, which are never written. Every such Environment must
 * store the same value of each of the seven, or the Service is
 * console-managed with the setting named, since the block is one for every
 * Environment and the generator never picks a winner. A stored value the
 * plan would refuse (a database stored start-first, a reserved label) is
 * never written either: the console keeps the Service, saying why.
 * Placement, networks, ports, mode and replicas are not among the seven, so
 * none is ever written.
 */
function nativeDockerOf(
  configName: string,
  kind: ConfigKind,
  present: readonly { readonly found: SavedService }[],
): NativeDockerBlock | undefined | string {
  const blocks = present
    .filter(({ found }) => comparesNativeDocker(found, kind))
    .map(({ found }) => nativeDockerBlockOf(kind, found.docker));
  if (blocks.length === 0) return undefined;
  const differing = NATIVE_DOCKER_KEYS.find(
    (name) => !agreed(blocks.map((block) => block?.[name] ?? null)).agreed,
  );
  if (differing !== undefined) {
    return `Its Environments disagree on its Swarm setting ${differing}, which native.docker holds once for every Environment`;
  }
  const [refused] = nativeDockerRefusals(configName, kind, blocks[0]);
  if (refused !== undefined) {
    return `Its stored Swarm settings cannot be written as they are (${refused.message.slice(configName.length + 1)})`;
  }
  return blocks[0];
}

/**
 * One Environment's entry for a Service, without the fields written once
 * from every Environment (the only-when-stated size and a postgres's
 * database and user, and the variable names): each
 * config-owned field that differs from what a console create leaves it at.
 * Or why this Environment's Service cannot be written, as a sentence.
 */
function baseEntry(kind: ConfigKind, found: SavedService): Wire | string {
  const compared = comparedView(found)!;
  const { view, defaults } = compared;
  const wire: Wire = {};

  for (const field of compared.fields) {
    if (ONLY_WHEN_STATED.has(field)) continue;
    const value = view[field] ?? null;

    if (field === 'version') {
      const prefix = `${kind}:`;
      const image = typeof value === 'string' ? value : '';
      const tag = image.startsWith(prefix) ? image.slice(prefix.length) : '';
      if (!/^[\w][\w.-]{0,127}$/.test(tag)) {
        return `Its image is not ${prefix}<version>, which is all version 1 can write, so the console keeps it`;
      }
      wire.version = tag;
      continue;
    }

    if (field === 'source') {
      const source = sourceWire(value as View | null);
      if (typeof source === 'string') return source;
      if (source !== null) wire.source = source;
      continue;
    }

    // A `web-private`'s port is required, and is what its callers are given;
    // a `worker` compares no `port`, so only its build type is kept.
    const always =
      (kind === 'web' || kind === 'web-private' || kind === 'worker') &&
      (field === 'port' || field === 'build.type');
    if (!always && canonical(value) === canonical(defaults[field] ?? null)) {
      continue;
    }
    if (value === null) continue;
    setPath(wire, field, value);
  }
  return wire;
}

function sourceWire(source: View | null): Wire | null | string {
  if (source === null) return null;
  if (typeof source.git === 'string') {
    if (gitUrlCarriesCredentials(source.git)) {
      return 'Its git URL carries a credential, which Cloudgate never copies into a config, so the console keeps it; give it a URL without the credential first';
    }
    return withPath({ git: source.git }, source.path);
  }
  if (typeof source.image === 'string') return { image: source.image };
  // Uploaded files built from a subfolder (ADR-0080).
  if (typeof source.folder === 'string') return { folder: source.folder };
  const provider = SOURCE_PROVIDERS.find((p) => typeof source[p] === 'string');
  if (!provider) {
    return 'Its source is set in the console (an upload or raw text), which version 1 cannot name, so the console keeps it';
  }
  return withPath({ [provider]: source[provider] }, source.path);
}

function withPath(source: Wire, path: unknown): Wire {
  return typeof path === 'string' && path !== '/'
    ? { ...source, path }
    : source;
}

function setPath(wire: Wire, field: string, value: unknown) {
  const [head, tail] = field.split('.');
  if (tail === undefined) {
    wire[head] = value;
    return;
  }
  const inner = (wire[head] ??= {}) as Wire;
  inner[tail] = value;
}

function agreed(values: readonly unknown[]): {
  agreed: boolean;
  value: unknown;
} {
  const first = values[0] ?? null;
  return {
    agreed: values.every((value) => canonical(value) === canonical(first)),
    value: first,
  };
}

function list(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

// ── Text ──

const HEADER = [
  'Generated by Cloudgate from this Project’s saved settings, so that its',
  'first plan in every Environment changes nothing. A Service listed with',
  'managed: console stays managed in the console; remove that line and',
  'describe the Service to hand it to the config, and each Environment’s',
  'plan shows what that changes.',
];

function render(entries: readonly Entry[], schemaUrl: string | null): string {
  const lines: string[] = [];
  if (schemaUrl !== null) {
    lines.push(`# yaml-language-server: $schema=${schemaUrl}`, '#');
  }
  lines.push(...HEADER.map((line) => `# ${line}`));
  lines.push('version: 1');
  if (entries.length === 0) {
    lines.push('services: {}');
    return `${lines.join('\n')}\n`;
  }
  lines.push('services:');
  for (const entry of entries) {
    const comments =
      'console' in entry ? [`${entry.why}.`] : entry.notes.map((n) => `${n}.`);
    for (const comment of comments) {
      lines.push(...wrap(comment, 74).map((line) => `  # ${line}`));
    }
    const body =
      'console' in entry
        ? { kind: entry.console, managed: 'console' }
        : entry.wire;
    const yaml = stringify({ [entry.configName]: body }, { lineWidth: 0 });
    lines.push(
      ...yaml
        .trimEnd()
        .split('\n')
        .map((line) => `  ${line}`),
    );
  }
  return `${lines.join('\n')}\n`;
}

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line && line.length + word.length + 1 > width) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}
