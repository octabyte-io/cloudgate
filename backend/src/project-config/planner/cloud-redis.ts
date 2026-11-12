import {
  ELASTICACHE_NODE_TYPES,
  formatMachine,
  machineFor,
} from '../../cloud-accounts/aws/definitions/database-class';
import { valkeyVersion } from '../../cloud-accounts/aws/definitions/redis-version';
import type { ValkeyVersion } from '../../cloud-accounts/aws/definitions/redis-version';
import { olderValkey } from '../../cloud-accounts/aws/plan-reader/cache-lines';
import type { RedisEntry } from '../project-config.types';
import {
  elastiCacheMachineText,
  nativeNodeTypeOf,
} from '../../native/aws-size';
import type { NativeAwsBlock } from '../../native/aws-native';
import { machineMove, savedSize } from './cloud-postgres';
import type { CloudChangeFields } from './cloud-change-fields';
import type {
  CloudRedisChange,
  CloudRedisCreate,
  ElastiCacheSettingChange,
  FieldDiff,
  MajorUpgrade,
  PlanNote,
  PlanRefusal,
  SavedService,
} from './plan.types';

/** What a console create leaves a redis's version at. */
const DEFAULT_IMAGE = 'redis:8';

/**
 * A `redis` a plan creates in a Cloud account: its size on an
 * ElastiCache node type by the one rule RDS's class follows, and its
 * version by Valkey's rule, each refused before the plan is stored when AWS
 * would refuse it. A version of 7 or lower, which runs as Valkey 7.2, and
 * an image suffix the cloud drops are noted.
 *
 * A node type its `native` block sets wins over its size, as an
 * RDS class does (`cloudRdsCreate`).
 */
export function cloudRedisCreate(
  name: string,
  entry: RedisEntry,
  native?: NativeAwsBlock | null,
):
  | {
      readonly ok: true;
      readonly cache: CloudRedisCreate;
      readonly notes: PlanNote[];
    }
  | { readonly ok: false; readonly refusals: PlanRefusal[] } {
  const nativeType = nativeNodeTypeOf(native);
  const sizing = machineFor(ELASTICACHE_NODE_TYPES, name, entry.size);
  const version = valkeyVersion(name, entry.dockerImage ?? DEFAULT_IMAGE);
  const size: CloudRedisCreate['size'] | null = nativeType
    ? {
        name: entry.size?.name ?? null,
        nodeType: nativeType,
        machine: elastiCacheMachineText(nativeType),
        smallest: false,
        native: true,
      }
    : sizing.ok
      ? {
          name: sizing.sizeName,
          nodeType: sizing.machine.name,
          machine: formatMachine(sizing.machine),
          smallest: sizing.smallest,
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

  const { written, engineVersion, parameterFamily } = version.version;
  return {
    ok: true,
    notes: versionNotes(name, version.version),
    cache: {
      size,
      version: { written, engineVersion, parameterFamily },
    },
  };
}

/**
 * A version of 7 or lower, which runs as Valkey 7.2, and an image suffix
 * the cloud drops, each noted.
 */
function versionNotes(name: string, version: ValkeyVersion): PlanNote[] {
  const { written, engineVersion } = version;
  const notes: PlanNote[] = [];
  if (version.raisedToOldest) {
    notes.push({
      kind: 'cloud-version-oldest',
      configName: name,
      message: `${name}.version: redis ${written} → Valkey ${engineVersion} (oldest on AWS)`,
    });
  }
  if (version.droppedSuffix !== null) {
    notes.push({
      kind: 'cloud-version-suffix',
      configName: name,
      message: `${name}.version: ${written} runs as Valkey ${engineVersion} on ElastiCache; the image suffix ${version.droppedSuffix} is dropped`,
    });
  }
  return notes;
}

/**
 * What a change to an ElastiCache replication group does with each field a plan compares
 * (`cloud-change-fields.ts`): none is fixed when it is made.
 */
export const ELASTICACHE_CHANGE_FIELDS: CloudChangeFields = {
  description: 'row',
  size: 'moves',
  version: 'moves',
};

/**
 * A change to a `redis` on ElastiCache: what moves on its
 * replication group, each move checked as ElastiCache would check it.
 *
 * - **Its node type** moves with a new `size`, or with the console's node
 *   type when the entry has none. A size that lands on the type it already
 *   runs on changes nothing on AWS, and the plan says so. A node type its
 *   `native.aws` sets wins over both, as an RDS class does.
 * - **Its version** moves with the config's. A newer major is a major
 *   upgrade, which Apply confirms by the Service's name; an older version
 *   is refused, naming the Valkey it runs, since ElastiCache cannot go back.
 * - **The console's settings** (the replica, snapshot retention) move when
 *   they differ from what the last Apply wrote.
 *
 * Anything that moves makes the step read AWS, so its lines and outage
 * marks are the plan's own (`cache-lines.ts`). Its description and
 * variables change as on a Server.
 */
export function cloudRedisChange(
  name: string,
  entry: RedisEntry,
  found: Extract<SavedService, { serviceType: 'redis' }>,
  fields: readonly FieldDiff[],
): {
  readonly refusals: PlanRefusal[];
  readonly notes: PlanNote[];
  readonly cache: CloudRedisChange | null;
  readonly majorUpgrade: MajorUpgrade | null;
} {
  const refusals: PlanRefusal[] = [];
  const notes: PlanNote[] = [];
  const onConsole = found.elasticache;
  const applied = onConsole?.applied ?? onConsole ?? null;
  const runsOn = elastiCacheNodeTypeOf(name, {
    nodeType: applied?.nodeType ?? null,
    cpuLimit: found.settings.cpuLimit,
    memoryLimit: found.settings.memoryLimit,
  });

  const moved = machineMove({
    name,
    table: ELASTICACHE_NODE_TYPES,
    size: entry.size,
    console: onConsole?.nodeType ?? null,
    native: nativeNodeTypeOf(entry.native?.aws),
    runsOn,
    sizeDiff: fields.find((diff) => diff.field === 'size'),
    machineText: elastiCacheMachineText,
  });
  const nodeType: CloudRedisChange['nodeType'] = moved.move;
  if (moved.refusal) refusals.push(moved.refusal);
  if (moved.note) notes.push(moved.note);

  let version: CloudRedisChange['version'] = null;
  let majorUpgrade: MajorUpgrade | null = null;
  const versionDiff = fields.find((diff) => diff.field === 'version');
  if (versionDiff) {
    const before = valkeyVersion(name, String(versionDiff.from));
    const after = valkeyVersion(name, String(versionDiff.to));
    if (!after.ok) {
      refusals.push(after.refusal);
    } else if (before.ok) {
      const was = before.version;
      const now = after.version;
      if (olderValkey(now.engineVersion, was.engineVersion)) {
        refusals.push({
          at: `${name}.version`,
          message: `${name}.version: "${now.written}" is older than Valkey ${was.engineVersion}, which ${name} runs on ElastiCache, and ElastiCache cannot move a cache back to an older version; keep version: "${was.written}"`,
        });
      } else {
        if (now.major > was.major) {
          majorUpgrade = { from: was.written, to: now.written };
        }
        notes.push(...versionNotes(name, now));
        if (now.engineVersion !== was.engineVersion) {
          version = {
            from: was.written,
            to: now.written,
            engineVersion: now.engineVersion,
            parameterFamily: now.parameterFamily,
          };
        }
      }
    }
  }

  const settings: ElastiCacheSettingChange[] = [];
  if (onConsole && applied) {
    if (onConsole.replica !== applied.replica) {
      settings.push({
        setting: 'replica',
        from: applied.replica,
        to: onConsole.replica,
      });
    }
    if (onConsole.snapshotRetentionDays !== applied.snapshotRetentionDays) {
      settings.push({
        setting: 'snapshotRetentionDays',
        from: applied.snapshotRetentionDays,
        to: onConsole.snapshotRetentionDays,
      });
    }
  }

  // A cache whose Cloud run failed before making it is run again.
  const moves =
    onConsole?.unmade === true ||
    nodeType !== null ||
    version !== null ||
    settings.length > 0;
  return {
    refusals,
    notes,
    cache: moves ? { nodeType, version, settings } : null,
    majorUpgrade,
  };
}

/**
 * The node type a redis on ElastiCache runs on, from its saved row:
 * the one Cloudgate chose for an entry with no size, else its size's by the
 * node-type rule. `null` for a size no type holds, which its plan refused.
 */
export function elastiCacheNodeTypeOf(
  name: string,
  row: {
    nodeType: string | null;
    cpuLimit: string | null;
    memoryLimit: string | null;
  },
): string | null {
  if (row.nodeType) return row.nodeType;
  const sizing = machineFor(
    ELASTICACHE_NODE_TYPES,
    name,
    savedSize(row.cpuLimit, row.memoryLimit),
  );
  return sizing.ok ? sizing.machine.name : null;
}
