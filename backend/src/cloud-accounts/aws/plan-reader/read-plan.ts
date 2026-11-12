import { addressOfTag } from '../definitions/tags';
import {
  KNOWN_AFTER_APPLY,
  SENSITIVE,
  STAND_IN_TEXT,
  changedLeafPaths,
  changedPaths,
  fieldsHolding,
  maskCovers,
  overlaps,
  pathText,
  renderValue,
  valueAt,
} from './plan-values';
import { cacheLines, cacheOutages } from './cache-lines';
import { databaseLines, databaseOutages } from './database-lines';
import { stackVmLines, stackVmOutages } from './stack-vm-lines';
import type { Outage } from './database-lines';
import { resourceLabel, summaryLine, variableName } from './plan-lines';
import type { Path } from './plan-values';
import type { StepAction, SummaryContext } from './plan-lines';
import type {
  TofuModule,
  TofuResourceChange,
  TofuShowJson,
} from './tofu-show.types';

/** The tag naming a resource's place in its state, the one adopt matches on. */
export const ADDRESS_TAG = 'cloudgate:address';

/** One resource the tag search (`tag:GetResources`) found by this state's tag. */
export interface FoundResource {
  readonly arn: string;
  readonly tags: Readonly<Record<string, string>>;
}

/** What the plan reader knows about the step beyond the plan file itself. */
export interface PlanReadContext {
  /** The Service's config name, which the ECS service's own name (ids only) is not. */
  readonly serviceName?: string;
  /** The region the plan is in: a NAT gateway's line prices it there. */
  readonly region?: string;
  /** The config's size name, shown beside the Fargate pair the plan asks for. */
  readonly sizeName?: string;
  /** The entry has no size: a database's class is the smallest, and says so. */
  readonly noSize?: boolean;
  /** A database's class or node type is its `native.aws`'s: its line says so. */
  readonly nativeMachine?: boolean;
  /** The halves of the task's Fargate pair its `native.aws` sets, each marked. */
  readonly nativePair?: SummaryContext['nativePair'];
  /** This deploy's variable names; their SSM changes keep a plan image-only. */
  readonly variableNames?: readonly string[];
  /** The image this deploy builds, shown as "new image, built by this deploy". */
  readonly imageRef?: string;
  /** The Environment network's stand-in ids the definition was written with. */
  readonly standIns?: readonly string[];
}

export type RawAction = StepAction | 'adopt';

/** One AWS resource under "Show N AWS resources": its type, address, action and changed field names. */
export interface RawLine {
  readonly address: string;
  readonly resourceType: string;
  readonly action: RawAction;
  /** Names only, never values. */
  readonly fields: string[];
  readonly briefDowntime: boolean;
  /** Whether the change puts back a hand change rather than applying the config. */
  readonly drift: boolean;
}

export interface DriftField {
  readonly field: string;
  readonly hand: string;
  readonly cloudgate: string;
}

export interface DriftEntry {
  readonly address: string;
  readonly resourceType: string;
  readonly line: string;
  /** Deleted by hand: "will be made again". */
  readonly deleted: boolean;
  /** Only a replace puts it back: red, with brief downtime. */
  readonly replaceForcing: boolean;
  readonly fields: DriftField[];
}

export interface AdoptLine {
  readonly address: string;
  readonly resourceType: string;
  /** What the Apply imports at `address`. */
  readonly arn: string;
  readonly line: string;
}

export interface NoStateNote {
  readonly arn: string;
  readonly address: string | null;
  readonly line: string;
}

export interface PlanCounts {
  readonly create: number;
  readonly change: number;
  readonly destroy: number;
  readonly replace: number;
  readonly drift: number;
  readonly adopt: number;
  readonly briefDowntime: number;
}

export interface PlanReading {
  readonly summary: string[];
  readonly raw: RawLine[];
  readonly counts: PlanCounts;
  readonly drift: DriftEntry[];
  readonly adopt: AdoptLine[];
  readonly noState: NoStateNote[];
  readonly imageOnly: boolean;
  /**
   * What takes a database offline or may drop a cache's
   * connections, each also among `summary`'s lines; absent when
   * nothing does, so a reading without one is as before.
   */
  readonly outages?: Outage[];
}

/**
 * A replace of these is not downtime: a task definition replace is the new
 * revision every deploy makes, which ECS rolls onto, and an SSM
 * parameter is read only when a task starts.
 */
const REPLACE_WITHOUT_DOWNTIME = new Set([
  'aws_ecs_task_definition',
  'aws_ssm_parameter',
]);

/**
 * Fields whose value is never printed, whatever the masks say: a variable's
 * value (sensitive by the provider's schema, and named here too so a provider
 * that dropped the flag would not leak it), and the ECS service's `triggers`,
 * which holds the keyed digest of every variable value — kept only in the
 * encrypted state.
 */
const NEVER_SHOWN: Readonly<Record<string, readonly string[]>> = {
  aws_ssm_parameter: ['value', 'insecure_value'],
  aws_ecs_service: ['triggers'],
};

/** What the service update of an image-only plan may touch. */
const IMAGE_ONLY_SERVICE_FIELDS = new Set(['task_definition', 'triggers']);

function actionOf(change: TofuResourceChange): StepAction | null {
  const actions = change.change.actions;
  if (actions.includes('create') && actions.includes('delete'))
    return 'replace';
  if (actions.includes('create')) return 'create';
  if (actions.includes('delete')) return 'destroy';
  if (actions.includes('update')) return 'change';
  // `forget` (a `removed` block) is never written by Cloudgate; were it to
  // appear it is shown as a change rather than hidden.
  if (actions.includes('forget')) return 'change';
  return null;
}

function isCurrentManaged(change: TofuResourceChange): boolean {
  return change.mode !== 'data' && !change.deposed;
}

/** Every address in the refreshed state, with the AWS ids it is known by. */
function stateIds(show: TofuShowJson): Map<string, Set<string>> {
  const ids = new Map<string, Set<string>>();
  const walk = (module: TofuModule | undefined) => {
    for (const resource of module?.resources ?? []) {
      if (resource.mode === 'data') continue;
      const known = new Set<string>();
      for (const key of ['arn', 'id']) {
        const value = resource.values?.[key];
        if (typeof value === 'string') known.add(value);
      }
      ids.set(resource.address, known);
    }
    for (const child of module?.child_modules ?? []) walk(child);
  };
  walk(show.prior_state?.values?.root_module);
  return ids;
}

function topLevel(paths: readonly Path[]): string[] {
  return [...new Set(paths.map((path) => path[0]).filter(Boolean))].sort();
}

/**
 * Reads one state's `tofu show -json` plan into what a Plan step shows and
 * decides on: summary lines, raw AWS lines, totals, **Drift**,
 * adopt lines, "found in AWS, in no state" notes, and whether a deploy may
 * apply it on its own. Pure: the caller ran `tofu` and the tag search.
 *
 * **Drift is a hand change the plan puts back.** `resource_drift` alone says
 * what the refresh saw move, and the moto trial showed it marking every
 * untouched resource (`tags: null → {}`, a certificate's `status`, a target
 * group's `load_balancer_arns`). `resource_changes` alone cannot tell a hand
 * change from a config change. So a field is drift only when both agree: the
 * refresh saw it move *and* the plan changes it back. Computed values the
 * config does not set are never changed back, so they drop out, as does tag
 * noise once `null`, `{}` and `[]` read as one value.
 *
 * Nothing here prints a value a mask marks sensitive, nor the fields in
 * {@link NEVER_SHOWN}; variables appear by name only. The result is
 * plain JSON, stored in a plan's steps and returned by MCP `get_plan` as is.
 */
export function readPlan(input: {
  readonly show: TofuShowJson;
  readonly tagSearch: readonly FoundResource[];
  readonly context: PlanReadContext;
}): PlanReading {
  const { show, tagSearch, context } = input;
  const standIns = new Set(context.standIns ?? []);
  const variables = new Set(context.variableNames ?? []);
  const changes = (show.resource_changes ?? []).filter(isCurrentManaged);
  const driftSeen = new Map(
    (show.resource_drift ?? [])
      .filter(isCurrentManaged)
      .map((drift) => [drift.address, drift]),
  );
  const inState = stateIds(show);
  const taskDefinition = changes.find(
    (change) => change.type === 'aws_ecs_task_definition',
  );
  const summaryContext = {
    serviceName: context.serviceName,
    region: context.region,
    sizeName: context.sizeName,
    noSize: context.noSize,
    nativeMachine: context.nativeMachine,
    nativePair: context.nativePair,
    imageRef: context.imageRef,
    taskDefinition: (taskDefinition?.change.after ??
      taskDefinition?.change.before) as Record<string, unknown> | undefined,
  };

  const { adopt, noState } = sortFound(changes, tagSearch, inState, context);
  const adopted = new Set(adopt.map((line) => line.address));

  const summary: string[] = [];
  const raw: RawLine[] = [];
  const drift: DriftEntry[] = [];
  const counts = {
    create: 0,
    change: 0,
    destroy: 0,
    replace: 0,
    drift: 0,
    adopt: 0,
    briefDowntime: 0,
  };
  const standInFields = new Set<string>();
  const outages: Outage[] = [];
  let variablesChanged = false;
  let imageOnly = { revision: false, serviceUpdate: false, other: false };

  for (const change of changes) {
    const action = actionOf(change);
    if (adopted.has(change.address)) {
      raw.push({
        address: change.address,
        resourceType: change.type,
        action: 'adopt',
        fields: [],
        briefDowntime: false,
        drift: false,
      });
      counts.adopt++;
      continue;
    }
    if (!action) continue;

    const { before, after } = change.change;
    const planned = changedPaths(before, after, change.change.after_unknown);
    // A computed attribute known only after apply moves because something
    // else did — every one of them on a replace, a parameter's `version`
    // when its value is put back — so it neither makes nor unmakes drift.
    const relevant = planned.filter(
      (p) => !maskCovers(change.change.after_unknown, p),
    );
    const found = readDrift(change, action, driftSeen, standIns, context);
    const driftOnly =
      found !== null &&
      (found.deleted ||
        relevant.every((p) => found.paths.some((d) => overlaps(d, p))));
    const briefDowntime =
      action === 'replace' &&
      (!REPLACE_WITHOUT_DOWNTIME.has(change.type) ||
        (found?.entry.replaceForcing ?? false));

    const fields =
      action === 'change'
        ? topLevel(planned)
        : action === 'replace'
          ? topLevel(
              change.change.replace_paths?.map((p) => p.map(String)) ??
                relevant,
            )
          : [];
    raw.push({
      address: change.address,
      resourceType: change.type,
      action,
      fields,
      briefDowntime,
      drift: found !== null,
    });
    if (found) drift.push(found.entry);
    if (briefDowntime) counts.briefDowntime++;
    if (driftOnly) continue;

    counts[action]++;
    const line = summaryLine(change, action, summaryContext);
    if (line) summary.push(line);
    summary.push(...databaseLines(change, action, summaryContext));
    summary.push(...cacheLines(change, action, summaryContext));
    summary.push(...stackVmLines(change, action, summaryContext));
    outages.push(...databaseOutages(change, action, summaryContext));
    outages.push(...cacheOutages(change, action, summaryContext));
    outages.push(...stackVmOutages(change, action, summaryContext));
    for (const field of fieldsHolding(after, standIns))
      standInFields.add(field);
    // The digest of every value moved, so the service rolls its tasks.
    // Its `discovery` trigger moving is a changed discovery service, which
    // that one's own line says.
    if (
      change.type === 'aws_ecs_service' &&
      action === 'change' &&
      planned.some(
        (p) => p[0] === 'triggers' && (p.length === 1 || p[1] === 'variables'),
      )
    ) {
      variablesChanged = true;
    }
    imageOnly = imageOnlyStep(change, action, fields, variables, imageOnly);
  }

  if (variablesChanged)
    summary.push('variables changed, tasks will be replaced');
  if (standInFields.size > 0) {
    const names = [...standInFields].sort().map((field) => `\`${field}\``);
    summary.push(
      `Environment network ids (${names.join(', ')}): ${STAND_IN_TEXT}`,
    );
  }
  counts.drift = drift.length;

  return {
    summary,
    raw,
    counts,
    drift,
    adopt,
    noState,
    // A Cron service has no ECS service: its new revision alone is
    // what its deploy writes, and its runs start from it.
    imageOnly:
      drift.length === 0 &&
      adopt.length === 0 &&
      !imageOnly.other &&
      imageOnly.revision &&
      (imageOnly.serviceUpdate ||
        !changes.some((change) => change.type === 'aws_ecs_service')),
    ...(outages.length > 0 ? { outages } : {}),
  };
}

/**
 * A deploy applies on its own only a new task definition revision, the
 * service update to use it, and the SSM changes its own variables cause:
 * an added or changed parameter is one of this deploy's
 * variables, and a removed one is a variable this deploy no longer has, which
 * the next deploy destroys. OpenTofu lists the revision as a replace;
 * any other replace, create or destroy is not this shape.
 */
function imageOnlyStep(
  change: TofuResourceChange,
  action: StepAction,
  fields: readonly string[],
  variables: ReadonlySet<string>,
  so: { revision: boolean; serviceUpdate: boolean; other: boolean },
): { revision: boolean; serviceUpdate: boolean; other: boolean } {
  switch (change.type) {
    case 'aws_ecs_task_definition':
      return action === 'replace'
        ? { ...so, revision: true }
        : { ...so, other: true };
    case 'aws_ecs_service':
      return action === 'change' &&
        fields.includes('task_definition') &&
        fields.every((field) => IMAGE_ONLY_SERVICE_FIELDS.has(field))
        ? { ...so, serviceUpdate: true }
        : { ...so, other: true };
    case 'aws_ssm_parameter': {
      const ours = variables.has(variableName(change));
      const caused =
        ((action === 'create' || action === 'change') && ours) ||
        (action === 'destroy' && !ours);
      return caused ? so : { ...so, other: true };
    }
    default:
      return { ...so, other: true };
  }
}

/**
 * The drift on one planned change, or null. A resource the refresh found gone
 * and the plan creates is "will be made again"; otherwise each field the
 * refresh saw move and the plan moves back is listed with both values.
 */
function readDrift(
  change: TofuResourceChange,
  action: StepAction,
  driftSeen: ReadonlyMap<string, TofuResourceChange>,
  standIns: ReadonlySet<string>,
  context: PlanReadContext,
): { entry: DriftEntry; paths: Path[]; deleted: boolean } | null {
  const seen = driftSeen.get(change.address);
  if (!seen) return null;
  const label = resourceLabel(change, context);
  const base = { address: change.address, resourceType: change.type };

  const goneByHand =
    seen.change.actions.includes('delete') &&
    !seen.change.actions.includes('create');
  if (goneByHand) {
    if (action !== 'create') return null;
    return {
      entry: {
        ...base,
        line: `${label}: will be made again`,
        deleted: true,
        replaceForcing: false,
        fields: [],
      },
      paths: [],
      deleted: true,
    };
  }

  const { before, after, after_unknown } = change.change;
  const movedBack = (
    moved: (b: unknown, a: unknown, u?: unknown) => Path[],
  ) => {
    const planned = moved(before, after, after_unknown);
    return moved(seen.change.before, seen.change.after).filter(
      (p) =>
        planned.some((q) => overlaps(p, q)) && !maskCovers(after_unknown, p),
    );
  };
  // A list holding any value known only after apply is covered whole by
  // the mask, so a hand change inside it — the OAC in a distribution's
  // `origin`, beside the `response_completion_timeout` AWS computes
  // — is read again field by field before it is called no drift.
  let paths = movedBack(changedPaths);
  if (paths.length === 0) paths = movedBack(changedLeafPaths);
  if (paths.length === 0) return null;

  const hidden = NEVER_SHOWN[change.type] ?? [];
  const show = (value: unknown, mask: unknown, path: Path) =>
    hidden.includes(path[0]) || maskCovers(mask, path)
      ? SENSITIVE
      : renderValue(value, standIns);
  const replaceForcing =
    action === 'replace' &&
    (change.change.replace_paths ?? []).some((r) =>
      paths.some((p) => overlaps(p, r.map(String))),
    );

  return {
    entry: {
      ...base,
      line: `${label}: changed outside Cloudgate, will be put back${replaceForcing ? ', brief downtime' : ''}`,
      deleted: false,
      replaceForcing,
      fields: paths.map((path) => ({
        field: pathText(path),
        hand: show(valueAt(before, path), change.change.before_sensitive, path),
        cloudgate: maskCovers(after_unknown, path)
          ? KNOWN_AFTER_APPLY
          : show(valueAt(after, path), change.change.after_sensitive, path),
      })),
    },
    paths,
    deleted: false,
  };
}

/**
 * Sorts the tag search's finds. A find the state already holds
 * — at its address, by one of the ids the state knows it by — is nothing new,
 * nor is an older revision of a task definition the state holds.
 * A find at an address the plan would create is adopted (imported on Apply)
 * instead, once per address. Everything else is "found in AWS, in no state",
 * a note the operator removes by hand. A plan that already imports (an
 * `import` block, `change.importing`) shows that import as an adopt too.
 */
function sortFound(
  changes: readonly TofuResourceChange[],
  tagSearch: readonly FoundResource[],
  inState: ReadonlyMap<string, ReadonlySet<string>>,
  context: PlanReadContext,
): { adopt: AdoptLine[]; noState: NoStateNote[] } {
  const adopt: AdoptLine[] = [];
  const noState: NoStateNote[] = [];
  const adoptLine = (change: TofuResourceChange, arn: string): AdoptLine => ({
    address: change.address,
    resourceType: change.type,
    arn,
    line: `${resourceLabel(change, context)}: found in AWS, taken back into Cloudgate's record`,
  });

  for (const change of changes) {
    const id = change.change.importing?.id;
    if (id !== undefined) adopt.push(adoptLine(change, id));
  }
  const creates = new Map(
    changes
      .filter(
        (change) =>
          actionOf(change) === 'create' && !inState.has(change.address),
      )
      .map((change) => [change.address, change]),
  );

  for (const resource of tagSearch) {
    const tagged = resource.tags[ADDRESS_TAG];
    const address = tagged !== undefined ? addressOfTag(tagged) : null;
    const held = address !== null ? inState.get(address) : undefined;
    if (held && (held.size === 0 || held.has(resource.arn))) continue;
    // Every deploy registers a new revision and leaves the last one
    // inactive with the same tags: an older revision is no stray.
    if (held && address?.startsWith('aws_ecs_task_definition.')) continue;
    // With no address tag — made untagged, it carries only the provider's
    // default tags, as a static site's function does — a find is the
    // state's own when the state holds its ARN.
    if (
      address === null &&
      [...inState.values()].some((ids) => ids.has(resource.arn))
    ) {
      continue;
    }
    const create = address !== null && !held ? creates.get(address) : undefined;
    if (create && !adopt.some((line) => line.address === address)) {
      adopt.push(adoptLine(create, resource.arn));
      continue;
    }
    noState.push({
      arn: resource.arn,
      address,
      line: `found in AWS, in no state: ${resource.arn}`,
    });
  }
  return { adopt, noState };
}
