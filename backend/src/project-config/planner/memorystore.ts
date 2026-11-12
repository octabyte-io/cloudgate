import { valkeyVersion } from '../../cloud-accounts/aws/definitions/redis-version';
import { MEMORYSTORE_BACKUP_RETENTION } from '../../cloud-accounts/gcp/definitions/memorystore-definition';
import type {
  ValkeyOffer,
  ValkeyVersion,
} from '../../cloud-accounts/aws/definitions/redis-version';
import { olderValkey } from '../../cloud-accounts/aws/plan-reader/cache-lines';
import type { Size } from '../format/config-size';
import type { RedisEntry } from '../project-config.types';
import { memorystoreNativeColumns } from '../../native/gcp-console-owned';
import { nativeMemorystoreNodeTypeOf } from '../../native/gcp-size';
import { sizeOverrideLine } from '../../native/size-override';
import { backupDays, retentionRefusal } from './google-backups';
import { savedSize, sizeText } from './cloud-postgres';
import type { CloudChangeFields } from './cloud-change-fields';
import type {
  FieldDiff,
  MajorUpgrade,
  MemorystoreChange,
  MemorystoreCreate,
  PlanNote,
  PlanRefusal,
  SavedService,
} from './plan.types';

/** What a console create leaves a redis's version at. */
const DEFAULT_IMAGE = 'redis:8';

const GIB = 1024;

/**
 * Memorystore for Valkey by the shared version rule: its versions,
 * newest last within each major, written to Google as `VALKEY_<major>_<minor>`.
 */
export const MEMORYSTORE_VALKEY: ValkeyOffer = {
  versions: ['7.2', '8.0', '9.0', '9.1'],
  runner: 'Memorystore',
  product: 'Memorystore for Valkey',
};

interface NodeType {
  /** `node_type`, as the provider takes it: `CUSTOM_PICO`. */
  readonly name: string;
  /** Default writable memory, in MiB as a size's are (1 GB = 1024). */
  readonly writableMb: number;
}

const nodeType = (name: string, writableGb: number): NodeType => ({
  name,
  writableMb: writableGb * GIB,
});

/**
 * The node types Cloudgate chooses from for a `redis` (facts established
 * on GCP), smallest first, with Google's default writable memory. Not
 * `SHARED_CORE_NANO`, which has no SLA, nor `HIGHCPU_MEDIUM`, which is sold
 * for CPU: a size never lands on either; `native` reaches them.
 */
const NODE_TYPES: readonly NodeType[] = [
  nodeType('CUSTOM_PICO', 1.08),
  nodeType('CUSTOM_MICRO', 2),
  nodeType('CUSTOM_MINI', 3),
  nodeType('STANDARD_SMALL', 5.2),
  nodeType('HIGHMEM_MEDIUM', 10.4),
  nodeType('STANDARD_LARGE', 20.8),
  nodeType('HIGHMEM_XLARGE', 46.4),
  nodeType('HIGHMEM_2XLARGE', 88),
];

/**
 * A node type's default writable memory in GB, the most a backup
 * of it can hold; `null` for one Cloudgate does not choose.
 */
export function memorystoreWritableGb(name: string | null): number | null {
  const found = NODE_TYPES.find((type) => type.name === name);
  return found ? Math.round((found.writableMb / GIB) * 100) / 100 : null;
}

const SMALLEST = NODE_TYPES[0];
const LARGEST = NODE_TYPES[NODE_TYPES.length - 1];

/** `custom-pico`, as Google's console and the plan name a node type. */
const shownName = (name: string) => name.toLowerCase().replace(/_/g, '-');
const shown = (type: NodeType) => shownName(type.name);

/** A node type Cloudgate chooses, by its `node_type`, or `null`. */
const chosenType = (name: string) =>
  NODE_TYPES.find((one) => one.name === name) ?? null;

/** `1.08 GB`: Google's figure. */
const writable = (type: NodeType) =>
  `${Math.round((type.writableMb / GIB) * 100) / 100} GB`;

/**
 * The node type a size runs on: the shared rule's "smallest at least
 * as large", by memory only, so CPU never pushes a cache onto a bigger
 * node. No size is `custom-pico`; one above `highmem-2xlarge` refuses,
 * naming it.
 */
function nodeTypeOf(
  name: string,
  size: Size | undefined,
):
  | { readonly ok: true; readonly type: NodeType }
  | { readonly ok: false; readonly refusal: PlanRefusal } {
  if (!size) return { ok: true, type: SMALLEST };
  const type = NODE_TYPES.find((one) => one.writableMb >= size.memoryMb);
  if (type) return { ok: true, type };
  return {
    ok: false,
    refusal: {
      at: `${name}.size`,
      message: `${name}: size ${size.cpu} CPU / ${Math.round((size.memoryMb / GIB) * 100) / 100} GB is above the largest Memorystore node type Cloudgate chooses, ${shown(LARGEST)} (${writable(LARGEST)})`,
    },
  };
}

const nodeCount = (highAvailability: boolean) => (highAvailability ? 2 : 1);

/** `1 node`, `2 nodes`. */
const counted = (nodes: number) => `${nodes} ${nodes === 1 ? 'node' : 'nodes'}`;

/**
 * `redis small → custom-pico (1.08 GB, 1 node)`, or with no size
 * `redis no size → custom-pico (smallest: 1.08 GB, 1 node)`.
 */
function nodeLine(
  name: string,
  type: NodeType,
  sizeName: string | null,
  smallest: boolean,
  nodes: number,
): string {
  const memory = `${writable(type)}, ${counted(nodes)}`;
  if (smallest) return `${name} no size → ${shown(type)} (smallest: ${memory})`;
  return `${name}${sizeName ? ` ${sizeName}` : ''} → ${shown(type)} (${memory})`;
}

/** `46.4 GB` for a node type Cloudgate chooses, else `null`. */
function writableOf(name: string): string | null {
  const type = chosenType(name);
  return type ? writable(type) : null;
}

/**
 * The size line of a node type its `native.gcp` sets:
 * `redis medium → highmem-xlarge (46.4 GB, 1 node), set by native`, its
 * writable memory when Cloudgate chooses it too.
 */
function nativeNodeLine(
  name: string,
  nodeType: string,
  sizeName: string | null,
  nodes: number,
): string {
  const memory = writableOf(nodeType);
  return sizeOverrideLine(
    name,
    sizeName,
    shownName(nodeType),
    `${memory ? `${memory}, ` : ''}${counted(nodes)}`,
  );
}

function versionOf(name: string, written: string) {
  return valkeyVersion(name, written, MEMORYSTORE_VALKEY);
}

/** `VALKEY_9_1`. */
const engineVersion = (version: ValkeyVersion) =>
  `VALKEY_${version.engineVersion.replace('.', '_')}`;

/** `9.1`, from `VALKEY_9_1`. */
const engineMinor = (engine: string) =>
  engine.replace(/^VALKEY_/, '').replace('_', '.');

/**
 * The `engine_version` a redis's written version runs as on Memorystore
 * the same reading a plan makes, for a definition written from a
 * saved row.
 */
export function memorystoreEngineVersion(
  name: string,
  written: string,
):
  | { readonly ok: true; readonly engineVersion: string }
  | { readonly ok: false; readonly message: string } {
  const read = versionOf(name, written);
  return read.ok
    ? { ok: true, engineVersion: engineVersion(read.version) }
    : { ok: false, message: read.refusal.message };
}

/**
 * A version of 7 or lower, which runs as Valkey 7.2, and an image suffix
 * Memorystore drops, each noted.
 */
function versionNotes(name: string, version: ValkeyVersion): PlanNote[] {
  const notes: PlanNote[] = [];
  if (version.raisedToOldest) {
    notes.push({
      kind: 'cloud-version-oldest',
      configName: name,
      message: `${name}.version: redis ${version.written} → Valkey ${version.engineVersion} (oldest on GCP)`,
    });
  }
  if (version.droppedSuffix !== null) {
    notes.push({
      kind: 'cloud-version-suffix',
      configName: name,
      message: `${name}.version: ${version.written} runs as Valkey ${version.engineVersion} on Memorystore; the image suffix ${version.droppedSuffix} is dropped`,
    });
  }
  return notes;
}

/**
 * What `native.gcp` sets of a Memorystore create's console settings
 * native wins over the create's one node and day of backups.
 */
export interface MemorystoreWanted {
  readonly highAvailability?: boolean;
  readonly backupRetentionDays?: number;
  /**
   * The node type `native.gcp` sets, which wins over the size, on
   * a create and a change alike.
   */
  readonly nodeType?: string;
}

/** What an entry's `native.gcp` sets of its Memorystore's console settings. */
export function memorystoreWanted(entry: RedisEntry): MemorystoreWanted {
  const owned = memorystoreNativeColumns(entry.native?.gcp);
  const nodeType = nativeMemorystoreNodeTypeOf(entry.native?.gcp);
  return {
    ...(nodeType ? { nodeType } : {}),
    ...(owned.memorystoreHighAvailability !== undefined
      ? { highAvailability: owned.memorystoreHighAvailability }
      : {}),
    ...(owned.memorystoreBackupRetentionDays !== undefined
      ? { backupRetentionDays: owned.memorystoreBackupRetentionDays }
      : {}),
  };
}

/**
 * The note a plan carries once, on its first Memorystore create:
 * unlike ElastiCache, Memorystore never moves a minor by itself, so a
 * major alone keeps the minor it was made on, and a newer Google minor is
 * not a change.
 */
export function memorystoreMinorNote(name: string): PlanNote {
  return {
    kind: 'cloud-version-minor',
    configName: name,
    message: `${name}.version: Memorystore never moves a cache to a newer Valkey minor by itself; a version that names only its major keeps the minor it was made on`,
  };
}

/**
 * A `redis` a plan creates on Google Cloud (the Google Cloud databases spec): a Memorystore
 * for Valkey instance, one node, its size on a node type by memory and its
 * version by the shared Valkey rule, each refused before the plan is stored
 * when Memorystore could not make it, and the line naming the node type,
 * its writable memory and the node count. A high availability or a backup
 * count its `native.gcp` sets wins over the create's defaults.
 */
export function memorystoreCreate(
  name: string,
  entry: RedisEntry,
  wanted: MemorystoreWanted = {},
):
  | {
      readonly ok: true;
      readonly memorystore: MemorystoreCreate;
      readonly notes: PlanNote[];
    }
  | { readonly ok: false; readonly refusals: PlanRefusal[] } {
  const sizing = nodeTypeOf(name, entry.size);
  const version = versionOf(name, entry.dockerImage ?? DEFAULT_IMAGE);
  // A node type its `native.gcp` sets wins over the size, so a
  // size no node type Cloudgate chooses holds is not refused.
  const nativeType = wanted.nodeType ?? null;
  const chosen = sizing.ok ? sizing.type : null;
  const sizeName = entry.size?.name ?? null;
  const smallest = entry.size === undefined && !nativeType;
  const size: MemorystoreCreate['size'] | null = nativeType
    ? {
        name: sizeName,
        nodeType: nativeType,
        writableMemory: writableOf(nativeType),
        smallest: false,
        native: true,
      }
    : chosen
      ? {
          name: sizeName,
          nodeType: chosen.name,
          writableMemory: writable(chosen),
          smallest,
        }
      : null;
  if (!size || !version.ok) {
    return {
      ok: false,
      refusals: [
        ...(sizing.ok || nativeType ? [] : [sizing.refusal]),
        ...(version.ok ? [] : [version.refusal]),
      ],
    };
  }
  // High availability is a console setting on a made cache; a create is
  // off unless `native.gcp` sets it.
  const nodes = nodeCount(wanted.highAvailability ?? false);
  const backups =
    wanted.backupRetentionDays ?? MEMORYSTORE_BACKUP_RETENTION.default;
  return {
    ok: true,
    notes: versionNotes(name, version.version),
    memorystore: {
      size,
      nodes,
      version: {
        written: version.version.written,
        engineVersion: engineVersion(version.version),
      },
      // A day of backups from create, edited on its Backups tab after.
      backupRetentionDays: backups,
      lines: [
        chosen && !size.native
          ? nodeLine(name, chosen, sizeName, smallest, nodes)
          : nativeNodeLine(name, size.nodeType, sizeName, nodes),
        `${name} backups: ${backupDays(backups)}`,
      ],
    },
  };
}

/**
 * What a change to a Memorystore instance does with each field a plan compares
 * (`cloud-change-fields.ts`): none is fixed when it is made.
 */
export const MEMORYSTORE_CHANGE_FIELDS: CloudChangeFields = {
  description: 'row',
  size: 'moves',
  version: 'moves',
};

/**
 * A change to a `redis` on Memorystore, made in place: its
 * node type moves with a new `size`, marked as the resize it is; a size
 * landing on the type it runs on changes nothing on GCP, and the plan says
 * so. A node type its `native.gcp` sets wins over the size, as a
 * Cloud SQL tier does. High availability turned on or off on the console since the last
 * Apply adds or removes its replica, the line naming the node count
 * it moves to. A newer major is a major upgrade, shown apart and confirmed
 * by the Service's name at Apply; an older version refuses. Nothing in the
 * config moves high availability: it is the console's alone. An instance
 * whose Cloud run failed before saving where it answers is run again
 * moving nothing. A backup retention edited on its Backups tab
 * since the last Apply moves in place, 0 turning backups off; one
 * above 365 days refuses. One made before backups has none to move.
 */
export function memorystoreChange(
  name: string,
  entry: RedisEntry,
  found: Extract<SavedService, { serviceType: 'redis' }>,
  fields: readonly FieldDiff[],
  wanted: MemorystoreWanted = memorystoreWanted(entry),
): {
  readonly refusals: PlanRefusal[];
  readonly notes: PlanNote[];
  readonly memorystore: MemorystoreChange | null;
  readonly majorUpgrade: MajorUpgrade | null;
} {
  const refusals: PlanRefusal[] = [];
  const notes: PlanNote[] = [];
  const lines: string[] = [];
  // The node type it runs on, as its last Apply saved it, else its
  // caps' type for one saved before that.
  const saved = nodeTypeOf(
    name,
    savedSize(found.settings.cpuLimit, found.settings.memoryLimit),
  );
  const runsOn =
    found.memorystore?.nodeType ?? (saved.ok ? saved.type.name : null);
  const onConsole = found.memorystore?.highAvailability ?? false;
  const applied = found.memorystore?.applied?.highAvailability ?? onConsole;
  const nodes = nodeCount(onConsole);
  const highAvailability: MemorystoreChange['highAvailability'] =
    onConsole !== applied ? { from: applied, to: onConsole } : null;

  let nodeType: MemorystoreChange['nodeType'] = null;
  const sizeDiff = fields.find((diff) => diff.field === 'size');
  // Where it goes: to the node type its `native.gcp` sets, which
  // wins; else to its size's; else, with no size, it stays where it is.
  let to: string | null = runsOn;
  if (entry.size !== undefined) {
    const sizing = nodeTypeOf(name, entry.size);
    if (sizing.ok) to = sizing.type.name;
    else if (!wanted.nodeType) refusals.push(sizing.refusal);
  }
  if (wanted.nodeType) to = wanted.nodeType;
  const sizeName = entry.size?.name ?? null;
  if (to && runsOn && to !== runsOn) {
    nodeType = {
      from: runsOn,
      to,
      writableMemory: writableOf(to),
      sizeName,
      ...(wanted.nodeType ? { native: true as const } : {}),
    };
  } else if (sizeDiff && runsOn && to === runsOn) {
    notes.push({
      kind: 'cloud-same-class',
      configName: name,
      message: `${name}.size: ${sizeText(sizeDiff.from)} → ${sizeText(sizeDiff.to)} runs on ${shownName(runsOn)} either way: no change on GCP`,
    });
  }
  // The node type and node count it moves to, then each move's mark.
  if (to && runsOn && (nodeType || highAvailability)) {
    const from = [
      ...(nodeType ? [shownName(runsOn)] : []),
      ...(highAvailability ? [counted(nodeCount(highAvailability.from))] : []),
    ];
    const type = chosenType(to);
    const line = wanted.nodeType
      ? nativeNodeLine(name, to, sizeName, nodes)
      : type
        ? nodeLine(name, type, sizeName, false, nodes)
        : // One a native value left, which Cloudgate does not choose.
          `${name}${sizeName ? ` ${sizeName}` : ''} → ${shownName(to)} (${counted(nodes)})`;
    lines.push(`${line}, from ${from.join(', ')}`);
  }
  if (nodeType) {
    lines.push(`${name}: may drop connections briefly while it resizes`);
  }
  if (highAvailability) {
    lines.push(
      highAvailability.to
        ? `${name} high availability: off → on, one replica in another zone, added in place; about double the node cost`
        : `${name} high availability: on → off, its replica removed in place; one node`,
    );
  }

  let version: MemorystoreChange['version'] = null;
  let majorUpgrade: MajorUpgrade | null = null;
  const versionDiff = fields.find((diff) => diff.field === 'version');
  if (versionDiff) {
    const before = versionOf(name, String(versionDiff.from));
    const after = versionOf(name, String(versionDiff.to));
    if (!after.ok) {
      refusals.push(after.refusal);
    } else if (before.ok) {
      const was = before.version;
      const now = after.version;
      // What it runs, as its Apply made it: a major alone read today may
      // name a newer minor than the one it was made on.
      const saved = found.memorystore?.engineVersion;
      const runs = saved ? engineMinor(saved) : was.engineVersion;
      if (olderValkey(now.engineVersion, runs)) {
        refusals.push({
          at: `${name}.version`,
          message: `${name}.version: "${now.written}" is older than Valkey ${runs}, which ${name} runs on Memorystore, and Memorystore cannot move a cache back to an older version; keep version: "${was.written}"`,
        });
      } else {
        notes.push(...versionNotes(name, now));
        if (now.engineVersion !== runs) {
          version = {
            from: was.written,
            to: now.written,
            engineVersion: engineVersion(now),
          };
        }
        if (now.major > was.major) {
          majorUpgrade = { from: was.written, to: now.written };
          lines.push(
            `major upgrade ${was.major} → ${now.major}: may drop connections briefly, cannot be undone`,
          );
        } else if (version) {
          lines.push(`${name} version: Valkey ${runs} → ${now.engineVersion}`);
        }
      }
    }
  }

  let backupRetentionDays: MemorystoreChange['backupRetentionDays'] = null;
  // One made before backups has none written, so none on: its
  // retention is caught up as an edit from off, in place, as is done
  // for Cloud SQL; Memorystore's backups need no restart.
  const wrote = found.memorystore?.applied?.backupRetentionDays ?? 0;
  if (found.memorystore) {
    const days = found.memorystore.backupRetentionDays;
    const refusal = retentionRefusal(
      name,
      days,
      MEMORYSTORE_BACKUP_RETENTION,
      'Memorystore',
    );
    if (refusal) {
      refusals.push(refusal);
    } else if (days !== wrote) {
      backupRetentionDays = { from: wrote, to: days };
      lines.push(`${name} backups: ${backupDays(wrote)} → ${backupDays(days)}`);
    }
  }

  // An instance whose Cloud run failed before Cloudgate saved where it
  // answers is run again: the step's read plans what is left from its state
  // (the live walk).
  const unmade = found.memorystore?.unmade === true;
  return {
    refusals,
    notes,
    memorystore:
      nodeType || version || highAvailability || backupRetentionDays || unmade
        ? {
            nodeType,
            version,
            highAvailability,
            ...(backupRetentionDays ? { backupRetentionDays } : {}),
            lines,
          }
        : null,
    majorUpgrade,
  };
}
