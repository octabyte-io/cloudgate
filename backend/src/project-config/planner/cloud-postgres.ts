import {
  RDS_CLASSES,
  formatMachine,
  machineFor,
  machineNamed,
} from '../../cloud-accounts/aws/definitions/database-class';
import type {
  MachineTable,
  MachineType,
} from '../../cloud-accounts/aws/definitions/database-class';
import { RDS_ENGINES } from '../../cloud-accounts/aws/definitions/rds-engines';
import { nativeInstanceClassOf, rdsMachineText } from '../../native/aws-size';
import type { NativeAwsBlock } from '../../native/aws-native';
import { defaultDatabaseIdentifier } from '../format/config-wire';
import type { Size } from '../format/config-size';
import type { MysqlEntry, PostgresEntry } from '../project-config.types';
import { fixedWhenMadeRefusals } from './cloud-change-fields';
import type { CloudChangeFields } from './cloud-change-fields';
import type {
  CloudPostgresChange,
  CloudPostgresCreate,
  FieldDiff,
  MachineMove,
  MajorUpgrade,
  PlanNote,
  PlanRefusal,
  RdsSettingChange,
  SavedService,
} from './plan.types';

/**
 * A `postgres` a plan creates in a Cloud account: its size on an RDS
 * class, its version by RDS's rule and its master user and initial database,
 * each refused before the plan is stored when RDS would refuse it, so a
 * create never fails ten minutes in. A version written with an image suffix
 * is noted, since the cloud drops it.
 *
 * A `mysql` is the same create by the same rules, with MySQL's
 * parameters (`RDS_ENGINES`): 8.4 when it has no `version`, 8.0 and 9.x
 * refused by name, and MySQL's names, `root` refused. Its `database` is
 * always set, the Server's default when the entry has none.
 *
 * A class its `native` block sets wins over its size: the size
 * line names both, and a size no class Cloudgate chooses holds is not
 * refused, since it is not what runs on AWS. `native` is the block the
 * Environment lays, none for Cloudgate's own definition.
 */
export function cloudRdsCreate(
  name: string,
  entry: PostgresEntry | MysqlEntry,
  native?: NativeAwsBlock | null,
):
  | {
      readonly ok: true;
      readonly database: CloudPostgresCreate;
      readonly notes: PlanNote[];
    }
  | { readonly ok: false; readonly refusals: PlanRefusal[] } {
  const rds = RDS_ENGINES[entry.kind];
  const refusals: PlanRefusal[] = [];
  const nativeClass = nativeInstanceClassOf(native);
  const sizing = machineFor(RDS_CLASSES, name, entry.size);
  if (!sizing.ok && !nativeClass) refusals.push(sizing.refusal);
  const version = rds.version(name, entry.dockerImage ?? rds.defaultImage);
  if (!version.ok) refusals.push(version.refusal);
  const login = {
    user: entry.databaseUser ?? rds.defaultUser(name),
    database: entry.databaseName ?? defaultDatabaseIdentifier(name),
  };
  for (const refusal of [
    rds.nameRefusal(name, 'user', login.user),
    rds.nameRefusal(name, 'database', login.database),
  ]) {
    if (refusal) refusals.push(refusal);
  }
  const size: CloudPostgresCreate['size'] | null = nativeClass
    ? {
        name: entry.size?.name ?? null,
        instanceClass: nativeClass,
        machine: rdsMachineText(nativeClass),
        smallest: false,
        native: true,
      }
    : sizing.ok
      ? {
          name: sizing.sizeName,
          instanceClass: sizing.machine.name,
          machine: formatMachine(sizing.machine),
          smallest: sizing.smallest,
        }
      : null;
  if (!size || !version.ok || refusals.length > 0) {
    return { ok: false, refusals };
  }

  const notes: PlanNote[] = [];
  if (version.version.droppedSuffix !== null) {
    notes.push({
      kind: 'cloud-version-suffix',
      configName: name,
      message: `${name}.version: ${version.version.written} runs as ${rds.label} ${version.version.engineVersion} on RDS; the image suffix ${version.version.droppedSuffix} is dropped`,
    });
  }
  return {
    ok: true,
    notes,
    database: {
      size,
      version: {
        written: version.version.written,
        engineVersion: version.version.engineVersion,
        autoMinorUpgrade: version.version.autoMinorUpgrade,
      },
      login,
    },
  };
}

/**
 * What a change to an RDS instance does with each field a plan compares
 * (`cloud-change-fields.ts`): its user and database are fixed when it is
 * made.
 */
export const RDS_CHANGE_FIELDS: CloudChangeFields = {
  description: 'row',
  size: 'moves',
  version: 'moves',
  database: 'fixed',
  user: 'fixed',
};

/**
 * A change to a `postgres` that runs on RDS, or a `mysql`
 * by the same rules and MySQL's parameters: what moves on the
 * instance, each move checked as RDS would check it.
 *
 * - **Its class** moves with a new `size`, or with the console's class when
 *   the entry has none. A size that lands on the class it already runs on
 *   changes nothing on AWS, and the plan says so. A class its `native.aws`
 *   sets wins over both; taken out, it falls back to the size, or
 *   with none stays where it is, the console's.
 * - **Its version** moves with the config's. A newer major is a major
 *   upgrade, which Apply confirms by the Service's name; an older one is
 *   refused, naming the version it runs, since RDS cannot go back.
 * - **The console's settings** (storage, its ceiling, Multi-AZ, backup
 *   retention) move when they differ from what the last Apply wrote.
 * - Its master user and initial database are fixed when the instance is
 *   made, so changing either refuses, naming the field.
 *
 * Anything that moves makes the step read AWS, so its lines and outage
 * marks are the plan's own (`database-lines.ts`).
 */
export function cloudRdsChange(
  name: string,
  entry: PostgresEntry | MysqlEntry,
  found: Extract<SavedService, { serviceType: 'postgres' | 'mysql' }>,
  fields: readonly FieldDiff[],
): {
  readonly refusals: PlanRefusal[];
  readonly notes: PlanNote[];
  readonly database: CloudPostgresChange | null;
  readonly majorUpgrade: MajorUpgrade | null;
} {
  const engine = RDS_ENGINES[entry.kind];
  const refusals: PlanRefusal[] = fixedWhenMadeRefusals(
    name,
    fields,
    RDS_CHANGE_FIELDS,
    'RDS',
  );
  const notes: PlanNote[] = [];
  const rds = found.rds;
  const applied = rds?.applied ?? rds ?? null;
  const runsOn = rdsClassOf(name, {
    instanceClass: applied?.instanceClass ?? null,
    cpuLimit: found.settings.cpuLimit,
    memoryLimit: found.settings.memoryLimit,
  });

  const moved = machineMove({
    name,
    table: RDS_CLASSES,
    size: entry.size,
    console: rds?.instanceClass ?? null,
    native: nativeInstanceClassOf(entry.native?.aws),
    runsOn,
    sizeDiff: fields.find((diff) => diff.field === 'size'),
    machineText: rdsMachineText,
  });
  const instanceClass: CloudPostgresChange['instanceClass'] = moved.move;
  if (moved.refusal) refusals.push(moved.refusal);
  if (moved.note) notes.push(moved.note);

  let version: CloudPostgresChange['version'] = null;
  let majorUpgrade: MajorUpgrade | null = null;
  for (const diff of fields) {
    switch (diff.field) {
      case 'version': {
        const before = engine.version(name, String(diff.from));
        const after = engine.version(name, String(diff.to));
        if (!after.ok) {
          refusals.push(after.refusal);
          break;
        }
        if (!before.ok) break;
        const was = before.version;
        const now = after.version;
        if (now.major < was.major) {
          refusals.push({
            at: `${name}.version`,
            message: `${name}.version: "${now.written}" is older than ${engine.label} ${was.engineVersion}, which ${name} runs on RDS, and RDS cannot move an instance back to an older major version; keep version: "${was.written}"`,
          });
          break;
        }
        if (now.major > was.major) {
          majorUpgrade = { from: was.written, to: now.written };
        }
        if (now.droppedSuffix !== null) {
          notes.push({
            kind: 'cloud-version-suffix',
            configName: name,
            message: `${name}.version: ${now.written} runs as ${engine.label} ${now.engineVersion} on RDS; the image suffix ${now.droppedSuffix} is dropped`,
          });
        }
        if (
          now.engineVersion !== was.engineVersion ||
          now.autoMinorUpgrade !== was.autoMinorUpgrade
        ) {
          version = {
            from: was.written,
            to: now.written,
            engineVersion: now.engineVersion,
            autoMinorUpgrade: now.autoMinorUpgrade,
          };
        }
        break;
      }
      default:
        break;
    }
  }

  const settings: RdsSettingChange[] = [];
  if (rds && applied) {
    for (const setting of [
      'storageGb',
      'maxStorageGb',
      'backupRetentionDays',
    ] as const) {
      if (rds[setting] !== applied[setting]) {
        settings.push({ setting, from: applied[setting], to: rds[setting] });
      }
    }
    if (rds.multiAz !== applied.multiAz) {
      settings.push({
        setting: 'multiAz',
        from: applied.multiAz,
        to: rds.multiAz,
      });
    }
  }

  // An instance whose Cloud run failed before making it is run again: the
  // step's read plans its create from its state.
  const moves =
    rds?.unmade === true ||
    instanceClass !== null ||
    version !== null ||
    settings.length > 0;
  return {
    refusals,
    notes,
    database: moves ? { instanceClass, version, settings } : null,
    majorUpgrade,
  };
}

/**
 * Where a database's machine goes on a change, one rule
 * for an RDS class and an ElastiCache node type: to the one its `native`
 * block sets, which wins; else to its size's; else, with no size, to the
 * console's. A move only when that differs from the one it runs on; a size
 * change that lands where it runs is noted instead. A size no machine holds
 * is refused, unless native sets the machine, so the size is not what runs.
 */
export function machineMove(input: {
  readonly name: string;
  readonly table: MachineTable;
  readonly size: Size | undefined;
  readonly console: string | null;
  readonly native: string | null;
  readonly runsOn: string | null;
  readonly sizeDiff: FieldDiff | undefined;
  readonly machineText: (machine: string) => string | null;
}): {
  readonly move: MachineMove | null;
  readonly note: PlanNote | null;
  readonly refusal: PlanRefusal | null;
} {
  const { name, runsOn, sizeDiff } = input;
  let to: { readonly name: string; readonly machine: string | null } | null =
    null;
  let sizeName: string | null = null;
  let refusal: PlanRefusal | null = null;
  if (input.size !== undefined) {
    const sizing = machineFor(input.table, name, input.size);
    if (sizing.ok) {
      to = {
        name: sizing.machine.name,
        machine: formatMachine(sizing.machine),
      };
    } else if (!input.native) {
      refusal = sizing.refusal;
    }
    sizeName = input.size.name ?? null;
  } else if (input.console) {
    // The console's machine stands where it is: one native handed
    // back that Cloudgate never chooses is no move to anything.
    const machine: MachineType | null = machineNamed(
      input.table,
      input.console,
    );
    to = machine
      ? { name: machine.name, machine: formatMachine(machine) }
      : null;
  }
  if (input.native) {
    to = { name: input.native, machine: input.machineText(input.native) };
  }
  if (to && runsOn && to.name !== runsOn) {
    return {
      move: {
        from: runsOn,
        to: to.name,
        machine: to.machine,
        sizeName,
        ...(input.native ? { native: true as const } : {}),
      },
      note: null,
      refusal,
    };
  }
  if (sizeDiff && runsOn && (to === null || to.name === runsOn)) {
    return {
      move: null,
      note: {
        kind: 'cloud-same-class',
        configName: name,
        message: `${name}.size: ${sizeText(sizeDiff.from)} → ${sizeText(sizeDiff.to)} runs on ${runsOn} either way: no change on AWS`,
      },
      refusal,
    };
  }
  return { move: null, note: null, refusal };
}

/**
 * The class a postgres or a mysql on RDS runs on, from its saved row: the one
 * Cloudgate chose for an entry with no size, else its size's by the class
 * rule. `null` for a size no class holds, which its plan already refused.
 */
export function rdsClassOf(
  name: string,
  row: {
    instanceClass: string | null;
    cpuLimit: string | null;
    memoryLimit: string | null;
  },
): string | null {
  if (row.instanceClass) return row.instanceClass;
  const sizing = machineFor(
    RDS_CLASSES,
    name,
    savedSize(row.cpuLimit, row.memoryLimit),
  );
  return sizing.ok ? sizing.machine.name : null;
}

/** A Service's saved caps as a Size, or `undefined` when it has none. */
export function savedSize(
  cpuLimit: string | null,
  memoryLimit: string | null,
): Size | undefined {
  const cpu = Number(cpuLimit);
  const bytes = Number(memoryLimit);
  if (!cpuLimit || !memoryLimit || !(cpu > 0) || !(bytes > 0)) {
    return undefined;
  }
  return { cpu: cpu / 1e9, memoryMb: bytes / (1024 * 1024) };
}

/** A size as a plan's field shows it: its name, or the pair. */
export function sizeText(value: unknown): string {
  if (value === null || value === undefined) return 'no size';
  if (typeof value === 'string') return value;
  const pair = value as { cpu?: unknown; memory?: unknown };
  return `{ cpu: ${String(pair.cpu)}, memory: ${String(pair.memory)} }`;
}
