import {
  KNOWN_AFTER_APPLY,
  SENSITIVE,
  STAND_IN_TEXT,
  changedLeafPaths,
  maskCovers,
  overlaps,
  pathText,
  renderValue,
  valueAt,
} from '../../aws/plan-reader/plan-values';
import type { Path } from '../../aws/plan-reader/plan-values';
import type { StepAction } from '../../aws/plan-reader/plan-lines';
import type {
  AdoptLine,
  DriftEntry,
  NoStateNote,
  PlanReading,
  RawLine,
} from '../../aws/plan-reader/read-plan';
import type {
  TofuChange,
  TofuModule,
  TofuResourceChange,
  TofuShowJson,
} from '../../aws/plan-reader/tofu-show.types';
import type { FoundByName } from '../../google-cloud.port';
import { PRIVATE_LINK_LINE } from '../definitions/private-link';
import {
  fixedName,
  isPrivateLinkPiece,
  privateAddressLine,
  resourceLabel,
  summaryLine,
  variableName,
} from './plan-lines';
import { googleStackVmOutages, joinedAttachmentId } from './stack-vm-lines';
import type { Outage } from '../../aws/plan-reader/database-lines';

export type { FoundByName };

/** What the plan reader knows about the step beyond the plan file itself. */
export interface GooglePlanReadContext {
  /** The Service's config name, which the Cloud Run service's own name (its key) is not. */
  readonly serviceName?: string;
  /** The config's size name, shown beside the Cloud Run pair the plan asks for. */
  readonly sizeName?: string;
  /** This deploy's variable names. */
  readonly variableNames?: readonly string[];
  /** The image this deploy builds, shown as "new image, built by this deploy". */
  readonly imageRef?: string;
  /** The Environment network's stand-in names the definition was written with. */
  readonly standIns?: readonly string[];
}

/** Label keys whose value is the Cloudgate mark, for a kind with no `description` (S5). */
const MARK_LABELS = [
  'cloudgate-cloud-account',
  'cloudgate-environment',
  'cloudgate-state',
];

/** Reload's revision label (S9): set by a direct call, never drift. */
const RELOAD_LABEL = 'cloudgate-reload';

/**
 * Fields the reader never looks at (S9). Google's label and
 * annotation echoes (`effective_labels`, `terraform_labels`,
 * `effective_annotations`) move whenever the provider or Google fills them
 * in, the way AWS's `tags: null → {}` did. On a Cloud Run service, the
 * console's `client`/`client_version`, Stop's service-level `scaling` and
 * `launch_stage`, the revision template's copy range and Reload's label
 * are set outside the definition by design, so none of them is a change,
 * nor drift.
 */
const ECHOES = [
  'effective_labels',
  'terraform_labels',
  'effective_annotations',
];
const CLOUD_RUN_OWN = ['client', 'client_version', 'scaling', 'launch_stage'];

/**
 * The Cloud Run kinds those fields are noise on: a service, a Worker's
 * worker pool, whose `scaling` is its instance count, Stop's and
 * Start's, so a stopped Worker is never drift, and a Cron service's job
 * which the console and gcloud stamp alike.
 */
const CLOUD_RUN_TYPES: ReadonlySet<string> = new Set([
  'google_cloud_run_v2_service',
  'google_cloud_run_v2_worker_pool',
  'google_cloud_run_v2_job',
]);

/**
 * Fields whose value is never printed, whatever the masks say: a variable's
 * value (sensitive by the provider's schema, named here too so a provider
 * that dropped the flag would not leak it), and the self-signed default
 * certificate's key.
 */
const NEVER_SHOWN: Readonly<Record<string, readonly string[]>> = {
  google_secret_manager_secret_version: ['secret_data', 'secret_data_wo'],
  google_certificate_manager_certificate: ['self_managed'],
  // A Cloud SQL user's password, and the instance's root one.
  google_sql_user: ['password', 'password_wo'],
  google_sql_database_instance: ['root_password', 'root_password_wo'],
  // A bucket's HMAC key's secret, sensitive by the provider's schema.
  google_storage_hmac_key: ['secret'],
};

/** A replace of these is not downtime: a new secret version rolls a new revision (S1). */
const REPLACE_WITHOUT_DOWNTIME = new Set([
  'google_secret_manager_secret_version',
]);

/**
 * An image-only plan's one changed field: a container's image (S19), a
 * level deeper in a Cron service's job, whose template holds its task's.
 */
const IMAGE_PATH = /^template\.\d+\.(template\.\d+\.)?containers\.\d+\.image$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One value (or mask) with the fields the reader never looks at taken out. */
function withoutNoise(type: string, value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  const kept: Record<string, unknown> = { ...value };
  for (const key of ECHOES) delete kept[key];
  if (!CLOUD_RUN_TYPES.has(type)) return kept;
  for (const key of CLOUD_RUN_OWN) delete kept[key];
  if (Array.isArray(kept.template)) {
    kept.template = kept.template.map((template: unknown) => {
      if (!isPlainObject(template)) return template;
      // The revision template's copy range, and Reload's label.
      const rest: Record<string, unknown> = { ...template };
      delete rest.scaling;
      if (isPlainObject(rest.labels)) {
        const labels = { ...rest.labels };
        delete labels[RELOAD_LABEL];
        rest.labels = labels;
      }
      return rest;
    });
  }
  return kept;
}

function quiet(change: TofuResourceChange): TofuResourceChange {
  const c = change.change;
  const strip = (value: unknown) => withoutNoise(change.type, value);
  const quieter: TofuChange = {
    ...c,
    before: strip(c.before),
    after: strip(c.after),
    after_unknown: strip(c.after_unknown),
    before_sensitive: strip(c.before_sensitive),
    after_sensitive: strip(c.after_sensitive),
  };
  return { ...change, change: quieter };
}

function actionOf(change: TofuResourceChange): StepAction | null {
  const actions = change.change.actions;
  if (actions.includes('create') && actions.includes('delete'))
    return 'replace';
  if (actions.includes('create')) return 'create';
  if (actions.includes('delete')) return 'destroy';
  if (actions.includes('update')) return 'change';
  if (actions.includes('forget')) return 'change';
  return null;
}

function isCurrentManaged(change: TofuResourceChange): boolean {
  return change.mode !== 'data' && !change.deposed;
}

/** Every address in the refreshed state, with the Google ids and names it is known by. */
function stateIds(show: TofuShowJson): Map<string, Set<string>> {
  const ids = new Map<string, Set<string>>();
  const walk = (module: TofuModule | undefined) => {
    for (const resource of module?.resources ?? []) {
      if (resource.mode === 'data') continue;
      const known = new Set<string>();
      for (const key of ['id', 'name', 'self_link', 'email']) {
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
 * Reads one Google state's `tofu show -json` plan into what a Plan step
 * shows and decides on, in the same shape as the AWS reader's
 * {@link PlanReading} so a cloud plan step holds either (S17): summary
 * lines, raw lines, totals, **Drift**, adopt lines, "found in Google Cloud,
 * in no state" notes, and whether a deploy may apply it on its own. Pure:
 * the caller ran `tofu` and the port's search by name. In `adopt` and
 * `noState`, `arn` holds Google's full resource name, the id an import takes.
 *
 * **Drift works as on AWS**: a field is drift only when the
 * refresh saw it move *and* the plan changes it back. The fields Google or
 * Cloudgate's own direct calls move are taken out before anything is
 * compared (see {@link ECHOES}), so they are never a change, never drift and
 * never shown.
 *
 * **Adopt by name** (S4): Google never renames a thing, so the fixed name is
 * the mark. A thing found by the name of something the plan would create is
 * adopted only when its `description` names the same ids as the one the plan
 * writes (or, for a secret, its labels do); with another description it is
 * "found, not Cloudgate's" and never adopted.
 */
export function readGooglePlan(input: {
  readonly show: TofuShowJson;
  readonly nameSearch: readonly FoundByName[];
  readonly context: GooglePlanReadContext;
}): PlanReading {
  const { show, nameSearch, context } = input;
  const standIns = new Set(context.standIns ?? []);
  const shown = (show.resource_changes ?? []).filter(isCurrentManaged);
  const changes = shown.map(quiet);
  const driftSeen = new Map(
    (show.resource_drift ?? [])
      .filter(isCurrentManaged)
      .map((drift) => [drift.address, quiet(drift)]),
  );
  const inState = stateIds(show);

  const { adopt, noState } = sortFound(changes, nameSearch, inState, context);
  const adopted = new Set(adopt.map((line) => line.address));
  const summaryContext = {
    serviceName: context.serviceName,
    sizeName: context.sizeName,
    imageRef: context.imageRef,
    networkMadeOrRemoved: changes.some(
      (change) =>
        change.type === 'google_compute_network' &&
        (actionOf(change) === 'create' || actionOf(change) === 'destroy'),
    ),
    staticSite: changes.some(
      (change) => change.type === 'google_compute_backend_bucket',
    ),
    instanceMadeOrRemoved: changes.some(
      (change) =>
        change.type === 'google_sql_database_instance' &&
        (actionOf(change) === 'create' || actionOf(change) === 'destroy'),
    ),
    // An Existing database's endpoint and zone: each fold their
    // address and record into their own line.
    endpointMadeOrRemoved: changes.some(
      (change) =>
        change.type === 'google_compute_forwarding_rule' &&
        (actionOf(change) === 'create' || actionOf(change) === 'destroy'),
    ),
    zoneMadeOrRemoved: changes.some(
      (change) =>
        change.type === 'google_dns_managed_zone' &&
        (actionOf(change) === 'create' || actionOf(change) === 'destroy'),
    ),
    secretsMadeOrRemoved: new Set(
      changes
        .filter(
          (change) =>
            change.type === 'google_secret_manager_secret' &&
            (actionOf(change) === 'create' || actionOf(change) === 'destroy'),
        )
        .map(variableName),
    ),
  };

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
  let imageChanged = false;
  let otherChanged = false;
  let linkMade = false;
  const linkLines: string[] = [];

  changes.forEach((change, index) => {
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
      return;
    }
    if (!action) return;

    const { before, after, after_unknown } = change.change;
    const planned = changedLeafPaths(before, after, after_unknown);
    // Only what the reader never looks at moved: no change at all.
    if (action === 'change' && planned.length === 0) return;
    const relevant = planned.filter((p) => !maskCovers(after_unknown, p));
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
    if (driftOnly) return;

    counts[action]++;
    // The line reads the plan as printed: a create's copy range is the
    // definition's own, not noise.
    const line = summaryLine(shown[index], action, summaryContext);
    // The private link's pieces are listed together, after the network's
    // own line, whatever their types sort as (Memorystore's firewall rule).
    if (line) (isPrivateLinkPiece(change) ? linkLines : summary).push(line);
    outages.push(
      ...googleStackVmOutages(
        shown[index],
        action,
        resourceLabel(change, context),
        context.serviceName,
      ),
    );
    // A database instance's own address, listed under it.
    const address = privateAddressLine(
      shown[index],
      action,
      context.serviceName,
    );
    if (address) summary.push(address);
    if (action === 'create' && isPrivateLinkPiece(change)) linkMade = true;
    for (const field of namesHolding(after, standIns)) standInFields.add(field);

    const imageOnly =
      CLOUD_RUN_TYPES.has(change.type) &&
      action === 'change' &&
      relevant.length > 0 &&
      relevant.every((p) => IMAGE_PATH.test(pathText(p)));
    if (imageOnly) imageChanged = true;
    else otherChanged = true;
  });

  summary.push(...linkLines);
  // What the private link is for, said once beside its pieces.
  if (linkMade) summary.push(PRIVATE_LINK_LINE);
  if (standInFields.size > 0) {
    const names = [...standInFields].sort().map((field) => `\`${field}\``);
    summary.push(
      `Environment network names (${names.join(', ')}): ${STAND_IN_TEXT}`,
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
    imageOnly:
      drift.length === 0 && adopt.length === 0 && imageChanged && !otherChanged,
    ...(outages.length > 0 ? { outages } : {}),
  };
}

/** The attribute names, at any depth, whose value holds a stand-in name. */
function namesHolding(
  value: unknown,
  standIns: ReadonlySet<string>,
  key?: string,
): string[] {
  if (standIns.size === 0) return [];
  if (typeof value === 'string') {
    return key !== undefined &&
      [...standIns].some((standIn) => value.includes(standIn))
      ? [key]
      : [];
  }
  if (Array.isArray(value))
    return value.flatMap((item) => namesHolding(item, standIns, key));
  if (isPlainObject(value))
    return Object.entries(value).flatMap(([k, v]) =>
      namesHolding(v, standIns, k),
    );
  return [];
}

/**
 * The drift on one planned change, or null: the AWS reader's rule. A resource
 * the refresh found gone and the plan creates is "will
 * be made again"; otherwise each field the refresh saw move and the plan
 * moves back is listed with both values.
 */
function readDrift(
  change: TofuResourceChange,
  action: StepAction,
  driftSeen: ReadonlyMap<string, TofuResourceChange>,
  standIns: ReadonlySet<string>,
  context: GooglePlanReadContext,
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
  const planned = changedLeafPaths(before, after, after_unknown);
  const paths = changedLeafPaths(seen.change.before, seen.change.after).filter(
    (p) => planned.some((q) => overlaps(p, q)) && !maskCovers(after_unknown, p),
  );
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
 * Whether a thing found by name carries the mark the plan would write (S4):
 * the same `description`, or — for a kind with none, a secret or a Cloud
 * SQL instance — the same
 * Cloudgate labels. A plan that knows neither cannot vouch for it.
 */
function carriesMark(change: TofuResourceChange, found: FoundByName): boolean {
  const planned = change.change.after;
  const description = valueAt(planned, ['description']);
  if (typeof description === 'string' && description !== '')
    return found.description === description;
  // A Cloud SQL instance carries its labels in its settings.
  const labels =
    valueAt(planned, ['labels']) ??
    valueAt(planned, ['settings', '0', 'user_labels']);
  if (!isPlainObject(labels) || !found.labels) return false;
  return MARK_LABELS.every(
    (key) =>
      typeof labels[key] === 'string' && found.labels?.[key] === labels[key],
  );
}

/**
 * Sorts the port's finds by name (S4). A find the state
 * already holds — by one of the ids or names the state knows — is nothing
 * new. A find with the fixed name of something the plan would create is
 * adopted (imported on Apply) when it carries the same mark, once per
 * address, and is "found, not Cloudgate's" when it does not. Anything else
 * is "found in Google Cloud, in no state", a note the operator removes by
 * hand. A plan that already imports shows that import as an adopt too.
 */
function sortFound(
  changes: readonly TofuResourceChange[],
  nameSearch: readonly FoundByName[],
  inState: ReadonlyMap<string, ReadonlySet<string>>,
  context: GooglePlanReadContext,
): { adopt: AdoptLine[]; noState: NoStateNote[] } {
  const adopt: AdoptLine[] = [];
  const noState: NoStateNote[] = [];
  const adoptLine = (change: TofuResourceChange, id: string): AdoptLine => ({
    address: change.address,
    resourceType: change.type,
    arn: id,
    line: `${resourceLabel(change, context)}: found in Google Cloud, taken back into Cloudgate's record`,
  });

  for (const change of changes) {
    const id = change.change.importing?.id;
    if (id !== undefined) adopt.push(adoptLine(change, id));
  }
  const creates = changes.filter(
    (change) => actionOf(change) === 'create' && !inState.has(change.address),
  );
  const held = (found: FoundByName) =>
    [...inState.values()].some(
      (ids) => ids.has(found.id) || ids.has(found.name),
    );

  for (const found of nameSearch) {
    if (held(found)) continue;
    const create = creates.find(
      (change) =>
        change.type === found.resourceType && fixedName(change) === found.name,
    );
    if (create && carriesMark(create, found)) {
      if (!adopt.some((line) => line.address === create.address))
        adopt.push(adoptLine(create, found.id));
      continue;
    }
    noState.push({
      arn: found.id,
      address: create?.address ?? null,
      line: create
        ? `${resourceLabel(create, context)}: found in Google Cloud, not Cloudgate's: \`${found.name}\` carries another mark, so it is not adopted; remove it by hand`
        : `found in Google Cloud, in no state: ${found.id}`,
    });
  }
  adopt.push(...joinedAttachments(creates, adopt, adoptLine));
  return { adopt, noState };
}

/**
 * A Stack VM's snapshot attachment, taken back with the data disk and the
 * schedule it joins when both are: Google lists no attachment of its own,
 * so no search finds it, and making one that is there fails.
 */
function joinedAttachments(
  creates: readonly TofuResourceChange[],
  adopt: readonly AdoptLine[],
  adoptLine: (change: TofuResourceChange, id: string) => AdoptLine,
): AdoptLine[] {
  const disk = adopt.find(
    (line) => line.resourceType === 'google_compute_disk',
  );
  const policy = adopt.find(
    (line) => line.resourceType === 'google_compute_resource_policy',
  );
  if (!disk || !policy) return [];
  const policyName = policy.arn.split('/').pop() ?? '';
  return creates
    .filter(
      (change) =>
        change.type === 'google_compute_disk_resource_policy_attachment' &&
        !adopt.some((line) => line.address === change.address),
    )
    .flatMap((change) => {
      const id = joinedAttachmentId(disk.arn, policyName);
      return id ? [adoptLine(change, id)] : [];
    });
}
