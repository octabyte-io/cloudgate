import { isMap, isScalar, parseDocument, YAMLMap } from 'yaml';
import type { Document } from 'yaml';

import { nativeDockerPathOf } from '../../native/docker-native';
import { parseProjectConfig } from '../format/parse-config';
import { generateProjectConfig } from '../generator/generate-config';
import type { GeneratorEnvironment } from '../generator/generate-config';
import { isNetworkStep, movesConsoleStackVm } from '../planner/cloud-steps';
import { isVariableList } from '../planner/fields';
import { canonical, planEnvironment } from '../planner/plan-environment';
import type { DeployTarget, SavedService } from '../planner/plan.types';
import type { ProjectConfig } from '../project-config.types';

/** `parseDocument` states its `logLevel` (`yaml-parse-log-level.spec.ts`). */
const DOCUMENT_OPTIONS = { logLevel: 'error' } as const;

/**
 * A Cloudgate-kept config's text with the one entry a console Save touched
 * brought back in step with the saved settings, or `null` when the
 * text already agrees with them and nothing is rewritten — which is what a
 * Save of Cloudgate's own fields comes to.
 *
 * The entry is what the Generator would write for that Config name
 * from every Environment's settings, so the rules for what the config can
 * hold are stated once: a Service in only some Environments, or whose
 * Environments disagree, is listed `managed: console` with a comment saying
 * why. Only that entry is touched, through the `yaml` Document API, so every
 * other entry and comment stays as the operator wrote it:
 *
 * - a Service no Environment has any more loses its entry;
 * - a Service the config does not list gains the generated entry;
 * - a described entry's update has only **the fields this Save changed**
 *   rewritten (`edited`), to the edited Environment's values, keeping its own
 *   spelling and comments elsewhere; a variable list keeps its order, gaining
 *   new names at the end. Every other field stays as the config has it, so a
 *   difference still pending in another Environment (or this one) is kept
 *   for its next plan, and one Environment's change is the config's for every
 *   Environment, which their next plans show. If the changed fields cannot be
 *   written that way (a kind change, a value version 1 cannot hold), the
 *   entry is replaced by the generated one;
 * - such an update's Swarm settings are the entry's `native.docker`,
 *   as the generator writes it from the Service's stored ones, one
 *   changed setting at a time: a label by its key, a block's field, the
 *   stop grace period and the ulimits whole. One the Save put back to the kind's default is taken out
 *   of the file, with any map that leaves empty, never written as the
 *   default;
 * - on a create of a Service the entry already describes, the fields some
 *   Environment's plan would change are rewritten, as above, from the
 *   generated entry;
 * - a `managed: console` line stays as it is — the console keeps that
 *   Service and the config does not describe it — except on a create, which
 *   may complete a Service the line was waiting on (it now exists in every
 *   Environment), and then takes the generated entry, described or with its
 *   comment brought up to date.
 */
export function rewriteEntry(input: {
  readonly stored: string;
  readonly configName: string;
  readonly environments: readonly GeneratorEnvironment[];
  /** Whether the write created the Service. */
  readonly creating: boolean;
  /**
   * An update's Environment and the Service as it was before the write:
   * which fields the Save changed is what a plan of the stored entry finds
   * different between the two.
   */
  readonly edited?: {
    readonly environment: GeneratorEnvironment;
    readonly before: SavedService;
  };
}): string | null {
  const { stored, configName, environments } = input;
  const previous = parseProjectConfig(stored);
  if (!previous.ok) return null;
  const described = describedIn(previous.config);

  const generated = parseDocument(
    generateProjectConfig({ environments, schemaUrl: null, described }),
    DOCUMENT_OPTIONS,
  );
  const generatedServices = servicesOf(generated);
  const generatedAt = indexOf(generatedServices, configName);

  const doc = parseDocument(stored, DOCUMENT_OPTIONS);
  let services = servicesOf(doc);
  if (services === null) {
    services = new YAMLMap();
    doc.set('services', services);
  }
  const at = indexOf(services, configName);

  if (generatedAt < 0) {
    if (at < 0) return null;
    removeAt(services, at);
    return render(doc);
  }
  const generatedPair = generatedServices!.items[generatedAt];
  const comment = commentAt(generatedServices!, generatedAt);
  if (at < 0) {
    services.flow = false;
    services.items.push(generatedPair);
    setCommentAt(services, services.items.length - 1, comment);
    return render(doc);
  }

  const wanted = generatedPair.value as YAMLMap | null;
  const wantedJson = (wanted?.toJSON() ?? {}) as Record<string, unknown>;
  const entry = previous.config.services[configName];
  let dirty: readonly string[] | 'whole' | null;
  if (entry?.managed === 'console') {
    // Only a create revisits a console-managed line: the Service it adds may
    // be the one the others were waiting on.
    if (!input.creating) return null;
    const have: unknown = (
      services.items[at].value as YAMLMap | null
    )?.toJSON();
    const same =
      JSON.stringify(have) === JSON.stringify(wantedJson) &&
      commentAt(services, at) === comment;
    if (same) return null;
    dirty = 'whole';
  } else if (input.edited && !input.creating) {
    const changed = savedChange(previous.config, configName, input.edited);
    if (changed === null) return null;
    if (changed !== 'whole') {
      const merged = mergedSave(
        stored,
        configName,
        changed,
        input.edited,
        described,
      );
      if (merged !== null) return merged;
    }
    dirty = 'whole';
  } else {
    dirty = differingFields(previous.config, configName, environments);
  }
  if (dirty === null) return null;

  if (dirty !== 'whole' && wantedJson.managed !== 'console') {
    for (const field of dirty) mergeField(doc, configName, field, wantedJson);
    const merged = parseProjectConfig(render(doc));
    if (
      merged.ok &&
      differingFields(
        merged.config,
        configName,
        environments,
        previous.config,
      ) === null
    ) {
      return render(doc);
    }
  }

  // Replaced whole: its fields no longer fit what it was.
  const replaced = parseDocument(stored, DOCUMENT_OPTIONS);
  const replacedServices = servicesOf(replaced)!;
  const replacedAt = indexOf(replacedServices, configName);
  replacedServices.items[replacedAt].value = generatedPair.value;
  setCommentAt(replacedServices, replacedAt, comment);
  return render(replaced);
}

/**
 * The Config names `config` describes rather than lists `managed: console`,
 * which the generator keeps described.
 */
function describedIn(config: ProjectConfig): ReadonlySet<string> {
  return new Set(
    Object.entries(config.services)
      .filter(([, entry]) => entry.managed !== 'console')
      .map(([name]) => name),
  );
}

/**
 * The fields of `configName` that some Environment's plan of `config` would
 * change (as the planner names them), `'whole'` when its plan would create,
 * destroy or refuse it, or `null` when no Environment's plan touches it.
 */
function differingFields(
  config: ProjectConfig,
  configName: string,
  environments: readonly GeneratorEnvironment[],
  previous: ProjectConfig = config,
): readonly string[] | 'whole' | null {
  const fields = new Set<string>();
  for (const environment of environments) {
    const outcome = planEnvironment({
      config,
      saved: environment.saved,
      deployTarget: environment.deployTarget,
      context: { previous },
    });
    if (!outcome.ok) {
      if (
        outcome.refusals.some(
          (refusal) => refusal.at?.split('.')[0] === configName,
        )
      ) {
        return 'whole';
      }
      continue;
    }
    for (const step of outcome.steps) {
      if (isNetworkStep(step)) continue;
      if (movesConsoleStackVm(step, config)) continue;
      if (step.configName !== configName) continue;
      if (step.action !== 'change') return 'whole';
      for (const diff of step.fields) fields.add(diff.field);
    }
  }
  return fields.size > 0 ? [...fields] : null;
}

/**
 * The fields of `configName` a Save changed: what a plan of the stored entry
 * finds different before the write and after it, field by field (see
 * {@link movedFields}); `'whole'` for a kind change or a refusal, `null` when
 * nothing config-owned moved.
 */
function savedChange(
  config: ProjectConfig,
  configName: string,
  edited: NonNullable<Parameters<typeof rewriteEntry>[0]['edited']>,
): readonly string[] | 'whole' | null {
  const after = edited.environment.saved.find(
    (found) => found.serviceId === edited.before.serviceId,
  );
  if (!after) return 'whole';
  const fields = movedFields(
    config,
    configName,
    edited.environment.deployTarget,
    edited.before,
    after,
  );
  if (fields.length === 0) return null;
  return fields.some((field) => field === 'kind' || field === 'settings')
    ? 'whole'
    : fields;
}

/**
 * The stored text with `fields` of the entry set to what the edited
 * Environment now has (the entry the generator writes from that one
 * Environment), or `null` when that does not leave them agreeing there.
 */
function mergedSave(
  stored: string,
  configName: string,
  fields: readonly string[],
  edited: NonNullable<Parameters<typeof rewriteEntry>[0]['edited']>,
  described: ReadonlySet<string>,
): string | null {
  const own = parseDocument(
    generateProjectConfig({
      environments: [edited.environment],
      schemaUrl: null,
      described,
    }),
    DOCUMENT_OPTIONS,
  );
  const ownServices = servicesOf(own);
  const at = indexOf(ownServices, configName);
  if (at < 0) return null;
  const wanted = ((ownServices!.items[at].value as YAMLMap | null)?.toJSON() ??
    {}) as Record<string, unknown>;
  if (wanted.managed === 'console') return null;
  const doc = parseDocument(stored, DOCUMENT_OPTIONS);
  for (const field of fields) mergeField(doc, configName, field, wanted);
  const merged = parseProjectConfig(render(doc));
  if (!merged.ok) return null;
  const left = differingFields(merged.config, configName, [edited.environment]);
  if (left === 'whole') return null;
  if (left !== null && left.some((field) => fields.includes(field))) {
    return null;
  }
  return render(doc);
}

/**
 * The fields whose plan of one entry a settings write moved: what a plan of
 * the Service's one entry finds before the write and after it, field by
 * field (`kind` for a create or destroy, `settings` for a refusal). A value
 * the entry already has, a variable name it lists, and a removed key it
 * lists (a note, not a change) move nothing. The console Saves seam asks
 * this of a repository-kept file too.
 */
export function movedFields(
  config: ProjectConfig,
  configName: string,
  deployTarget: DeployTarget,
  before: SavedService,
  after: SavedService,
): string[] {
  // Planned alone, the entry's links would name sources this one-entry
  // config does not have, so they are left out of both plans alike. A link
  // Save still moves the entry's `env.<NAME>` line: the planner reads
  // the Service's applied links from the saved side.
  const only: ProjectConfig = {
    ...config,
    services: {
      [configName]: {
        ...config.services[configName],
        links: undefined,
      } as ProjectConfig['services'][string],
    },
  };
  const found = (saved: SavedService) => {
    const outcome = planEnvironment({
      config: only,
      saved: [saved],
      deployTarget,
      context: { previous: only },
    });
    const diffs = new Map<string, string>();
    if (!outcome.ok) {
      diffs.set('settings', canonical(outcome.refusals));
      return diffs;
    }
    for (const step of outcome.steps) {
      if (step.action === 'change') {
        for (const diff of step.fields) diffs.set(diff.field, canonical(diff));
      } else if (!isNetworkStep(step)) {
        diffs.set('kind', canonical([step.action, step.kind]));
      }
    }
    return diffs;
  };
  const was = found(before);
  const is = found(after);
  return [...new Set([...was.keys(), ...is.keys()])].filter(
    (field) => was.get(field) !== is.get(field),
  );
}

/** One field of the stored entry set to the generated entry's value. */
function mergeField(
  doc: Document,
  configName: string,
  field: string,
  wanted: Record<string, unknown>,
) {
  const native = nativeDockerPathOf(field);
  if (native) {
    mergeNative(doc, configName, ['native', 'docker', ...native], wanted);
    return;
  }
  const link = LINK_FIELD.exec(field);
  if (link) {
    mergeLink(doc, configName, link[1], wanted);
    return;
  }
  const path = ['services', configName, ...field.split('.')];
  if (isVariableList(field)) {
    const have = (
      doc.getIn(path) as { toJSON(): unknown } | undefined
    )?.toJSON() as (string | Record<string, string>)[] | undefined;
    const want = (wanted[field] as string[] | undefined) ?? [];
    // A link is the config's alone: the console's variables never
    // hold its name, so a Save of them keeps it as written.
    const kept = (have ?? []).filter(
      (name) => typeof name !== 'string' || want.includes(name),
    );
    const names = [...kept, ...want.filter((name) => !kept.includes(name))];
    if (names.length === 0) doc.deleteIn(path);
    else doc.setIn(path, names);
    return;
  }
  const value = field
    .split('.')
    .reduce<unknown>(
      (inner, key) =>
        inner && typeof inner === 'object'
          ? (inner as Record<string, unknown>)[key]
          : undefined,
      wanted,
    );
  if (value === undefined) {
    doc.deleteIn(path);
    const parent = doc.getIn(path.slice(0, -1));
    if (path.length > 3 && isMap(parent) && parent.items.length === 0) {
      doc.deleteIn(path.slice(0, -1));
    }
  } else {
    doc.setIn(path, value);
  }
}

/**
 * One Native setting of the stored entry, at a path under
 * `native`: set to the wanted entry's value, or taken out where it has none
 * (the kind's default), along with every map it leaves empty, so a Save
 * back to every default leaves no `native` behind. A label's key is one
 * path segment however many dots it has.
 */
function mergeNative(
  doc: Document,
  configName: string,
  path: readonly string[],
  wanted: Record<string, unknown>,
) {
  const value = path.reduce<unknown>(
    (inner, key) =>
      inner && typeof inner === 'object'
        ? (inner as Record<string, unknown>)[key]
        : undefined,
    wanted,
  );
  const at = ['services', configName, ...path];
  if (value !== undefined) {
    doc.setIn(at, value);
    return;
  }
  doc.deleteIn(at);
  for (let end = at.length - 1; end > 2; end--) {
    const parent = doc.getIn(at.slice(0, end));
    if (!isMap(parent) || parent.items.length > 0) break;
    doc.deleteIn(at.slice(0, end));
  }
}

/** A change step's line for one variable's link (`plan-links.ts`). */
const LINK_FIELD = /^env\.(.+)$/;

type EnvItem = string | Readonly<Record<string, string>>;

const variableOf = (item: EnvItem) =>
  typeof item === 'string' ? item : Object.keys(item)[0];

/**
 * One variable of the stored `env` list set to what the generated entry
 * has for it: a link Save turns its typed name into the link in
 * place, moves a link to another source, or drops it, and leaves every
 * other entry of the list as it was.
 */
function mergeLink(
  doc: Document,
  configName: string,
  variable: string,
  wanted: Record<string, unknown>,
) {
  const path = ['services', configName, 'env'];
  const have =
    ((doc.getIn(path) as { toJSON(): unknown } | undefined)?.toJSON() as
      EnvItem[] | undefined) ?? [];
  const want = (wanted.env as EnvItem[] | undefined) ?? [];
  const item = want.find((one) => variableOf(one) === variable);
  const at = have.findIndex((one) => variableOf(one) === variable);
  const next = [...have];
  if (item === undefined) {
    if (at >= 0) next.splice(at, 1);
  } else if (at >= 0) {
    next[at] = item;
  } else {
    next.push(item);
  }
  if (next.length === 0) doc.deleteIn(path);
  else doc.setIn(path, next);
}

function servicesOf(doc: Document): YAMLMap | null {
  const services = doc.get('services', true);
  return isMap(services) ? services : null;
}

function indexOf(services: YAMLMap | null, configName: string): number {
  if (services === null) return -1;
  return services.items.findIndex(
    (pair) => isScalar(pair.key) && pair.key.value === configName,
  );
}

/**
 * The comment above an entry. The `yaml` Document keeps the first entry's on
 * the map itself, every other one's on its key.
 */
function commentAt(services: YAMLMap, at: number): string | undefined {
  if (at === 0) return services.commentBefore ?? undefined;
  const key = services.items[at].key;
  return isScalar(key) ? (key.commentBefore ?? undefined) : undefined;
}

function setCommentAt(
  services: YAMLMap,
  at: number,
  comment: string | undefined,
) {
  if (at === 0) {
    services.commentBefore = comment;
    return;
  }
  const key = services.items[at].key;
  if (isScalar(key)) key.commentBefore = comment;
}

function removeAt(services: YAMLMap, at: number) {
  const next = services.items[at + 1]?.key;
  if (at === 0) {
    // The next entry's own comment moves up to where the first one's lives.
    services.commentBefore = isScalar(next)
      ? (next.commentBefore ?? undefined)
      : undefined;
    if (isScalar(next)) next.commentBefore = undefined;
  }
  services.items.splice(at, 1);
  if (services.items.length === 0) services.flow = true;
}

function render(doc: Document): string {
  return doc.toString({ lineWidth: 0 });
}
