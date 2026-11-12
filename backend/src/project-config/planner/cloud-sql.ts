import { machineFor } from '../../cloud-accounts/aws/definitions/database-class';
import {
  CLOUD_SQL_BACKUP_RETENTION,
  CLOUD_SQL_INSTANCE_ADDRESS,
} from '../../cloud-accounts/gcp/definitions/cloud-sql-definition';
import { cloudSqlNativeColumns } from '../../native/gcp-console-owned';
import { nativeTierOf } from '../../native/gcp-size';
import { sizeOverrideLine } from '../../native/size-override';
import { valueAt } from '../../native/lay';
import type {
  MachineTable,
  MachineType,
} from '../../cloud-accounts/aws/definitions/database-class';
import type { RdsPostgresVersion } from '../../cloud-accounts/aws/definitions/postgres-version';
import {
  CLOUD_SQL_ENGINES,
  cloudSqlDatabaseVersion,
} from '../../cloud-accounts/gcp/definitions/cloud-sql-engines';
import type { CloudSqlEngine } from '../../cloud-accounts/gcp/definitions/cloud-sql-engines';
import { defaultDatabaseIdentifier } from '../format/config-wire';
import type { Size } from '../format/config-size';
import type { MysqlEntry, PostgresEntry } from '../project-config.types';
import { backupDays, retentionRefusal } from './google-backups';
import { savedSize, sizeText } from './cloud-postgres';
import { fixedWhenMadeRefusals } from './cloud-change-fields';
import type { CloudChangeFields } from './cloud-change-fields';
import type {
  CloudSqlChange,
  CloudSqlCreate,
  FieldDiff,
  MajorUpgrade,
  PlanNote,
  PlanRefusal,
  SavedService,
} from './plan.types';

/** An entry Cloud SQL makes: a `postgres`, or a `mysql`. */
type CloudSqlEntry = PostgresEntry | MysqlEntry;

const GIB = 1024;

/**
 * The two shared-core machines, at Compute Engine's real figures:
 * the bottom of the ladder, outside Cloud SQL's SLA, Enterprise edition only.
 */
const SHARED_CORE: MachineTable = {
  types: [
    { name: 'db-f1-micro', vcpu: 0.2, memoryMb: 0.6 * GIB },
    { name: 'db-g1-small', vcpu: 0.5, memoryMb: 1.7 * GIB },
  ],
  smallest: { name: 'db-f1-micro', vcpu: 0.2, memoryMb: 0.6 * GIB },
};

/**
 * Cloud SQL's rules for an Enterprise custom shape (facts established on GCP):
 * 1 or an even number of vCPUs up to 96, memory in 256 MB steps, at least
 * 3.75 GB in all and 0.9 GB per vCPU, at most 6.5 GB per vCPU.
 */
const CUSTOM = {
  maxVcpu: 96,
  maxMemoryMb: 624 * GIB,
  minMemoryMb: 3.75 * GIB,
  minPerVcpuMb: 0.9 * GIB,
  maxPerVcpuMb: 6.5 * GIB,
  stepMb: 256,
};

const LARGEST: MachineType = custom(CUSTOM.maxVcpu, CUSTOM.maxMemoryMb);

function custom(vcpu: number, memoryMb: number): MachineType {
  return { name: `db-custom-${vcpu}-${memoryMb}`, vcpu, memoryMb };
}

/** A vCPU count Cloud SQL takes: 1, or the even count at least `count`. */
const allowedVcpu = (count: number) => (count <= 1 ? 1 : count + (count % 2));

/**
 * The machine a size runs on: by the shared rule, the smallest at
 * least as large in both CPU and memory — a shared-core machine when one
 * holds it, else the custom shape it rounds up to. Memory over 6.5 GB per
 * vCPU raises the vCPU count rather than refusing; only a size above
 * 96 vCPU / 624 GB refuses, naming that shape.
 */
function machineOf(
  name: string,
  size: Size | undefined,
):
  | { readonly ok: true; readonly machine: MachineType }
  | { readonly ok: false; readonly refusal: PlanRefusal } {
  const shared = machineFor(SHARED_CORE, name, size);
  if (shared.ok) return { ok: true, machine: shared.machine };
  // A missing size always has one (the smallest), so this size is set.
  const asked = size as Size;
  let vcpu = allowedVcpu(Math.ceil(asked.cpu));
  if (asked.memoryMb > vcpu * CUSTOM.maxPerVcpuMb) {
    vcpu = allowedVcpu(Math.ceil(asked.memoryMb / CUSTOM.maxPerVcpuMb));
  }
  const memoryMb =
    Math.ceil(
      Math.max(asked.memoryMb, CUSTOM.minMemoryMb, vcpu * CUSTOM.minPerVcpuMb) /
        CUSTOM.stepMb,
    ) * CUSTOM.stepMb;
  if (vcpu > CUSTOM.maxVcpu || memoryMb > CUSTOM.maxMemoryMb) {
    return {
      ok: false,
      refusal: {
        at: `${name}.size`,
        message: `${name}: size ${asked.cpu} CPU / ${gigabytes(asked.memoryMb)} is above the largest Cloud SQL machine Cloudgate chooses, ${LARGEST.name} (${wording(LARGEST)})`,
      },
    };
  }
  return { ok: true, machine: custom(vcpu, memoryMb) };
}

const isShared = (machine: MachineType) =>
  SHARED_CORE.types.some((one) => one.name === machine.name);

/** `1.7 GB`, `3.75 GB`: Google's figure, to two places. */
function gigabytes(memoryMb: number): string {
  return `${Math.round((memoryMb / GIB) * 100) / 100} GB`;
}

/** `shared CPU, 1.7 GB, no SLA` or `1 vCPU, 3.75 GB`. */
function wording(machine: MachineType): string {
  return isShared(machine)
    ? `shared CPU, ${gigabytes(machine.memoryMb)}, no SLA`
    : `${machine.vcpu} vCPU, ${gigabytes(machine.memoryMb)}`;
}

/**
 * **The committed tier table** (ADR-0044 rule 12): Google's published
 * vCPU and memory of the Cloud SQL tiers a `native.gcp` `settings.tier` may
 * name beyond the ones Cloudgate chooses, so a plan's size line can say
 * what a native tier is (`pg-1 medium → db-perf-optimized-N-4 (4 vCPU,
 * 32 GB), set by native`). A tier not in it, nor a custom shape, is still
 * open and still runs: its line names it alone, and Google judges it at the
 * Cloud run. Never chosen from a `size`: {@link machineOf} chooses.
 */
const KNOWN_TIERS: readonly MachineType[] = [
  ...[1, 2, 4, 8, 16, 32, 64, 96].map((vcpu) =>
    known(`db-n1-standard-${vcpu}`, vcpu, 3.75),
  ),
  ...[2, 4, 8, 16, 32, 64, 96].map((vcpu) =>
    known(`db-n1-highmem-${vcpu}`, vcpu, 6.5),
  ),
  ...[2, 4, 8, 16, 32, 48, 64, 80, 96, 128].map((vcpu) =>
    known(`db-perf-optimized-N-${vcpu}`, vcpu, 8),
  ),
];

function known(name: string, vcpu: number, gibPerVcpu: number): MachineType {
  return { name, vcpu, memoryMb: vcpu * gibPerVcpu * GIB };
}

/**
 * A tier as a plan line names it: a shared-core machine or a
 * custom shape (`db-custom-4-16384`) read from its name, else one the
 * committed tier table knows, else `null`.
 */
function knownTier(tier: string): MachineType | null {
  const shared = SHARED_CORE.types.find((one) => one.name === tier);
  if (shared) return shared;
  const shape = /^db-custom-(\d+)-(\d+)$/.exec(tier);
  if (shape) return custom(Number(shape[1]), Number(shape[2]));
  return KNOWN_TIERS.find((one) => one.name === tier) ?? null;
}

/** `4 vCPU, 32 GB` for a tier the planner knows, else `null`. */
export function cloudSqlTierText(tier: string): string | null {
  const machine = knownTier(tier);
  return machine ? wording(machine) : null;
}

/**
 * `pg-1 small → db-g1-small (shared CPU, 1.7 GB, no SLA: for testing)`, or
 * with no size `pg-1 no size → db-f1-micro (smallest: shared CPU, 0.6 GB,
 * no SLA)`.
 */
function machineLine(
  name: string,
  machine: MachineType,
  sizeName: string | null,
  smallest: boolean,
): string {
  if (smallest) {
    return `${name} no size → ${machine.name} (smallest: ${wording(machine)})`;
  }
  const shown = isShared(machine)
    ? `${wording(machine)}: for testing`
    : wording(machine);
  return `${name}${sizeName ? ` ${sizeName}` : ''} → ${machine.name} (${shown})`;
}

function suffixNote(
  engine: CloudSqlEngine,
  name: string,
  version: RdsPostgresVersion,
): PlanNote[] {
  if (version.droppedSuffix === null) return [];
  return [
    {
      kind: 'cloud-version-suffix',
      configName: name,
      message: `${name}.version: ${version.written} runs as ${engine.label} ${version.major} on Cloud SQL; the image suffix ${version.droppedSuffix} is dropped`,
    },
  ];
}

/**
 * What the config wants of a postgres on Cloud SQL beyond its size and
 * version: whether point-in-time recovery is on, and, on a create,
 * the backups a `native.gcp` count makes it with.
 */
export interface CloudSqlWanted {
  readonly pointInTimeRecovery: boolean;
  /**
   * The daily backups `native.gcp` sets it keeping, which wins over
   * Cloudgate's default on a create. Absent when native sets none; on a
   * made instance the console's column holds it once its Apply writes it,
   * so a change reads none from here.
   */
  readonly backupRetentionDays?: number;
  /**
   * The tier `native.gcp` sets, which wins over the size, on a
   * create and a change alike. Absent when native sets none.
   */
  readonly tier?: string;
}

/**
 * The one place the planner reads point-in-time recovery's wanted value
 * (the Google Cloud buckets spec "Plan lines"): `native.gcp`'s open setting
 * `settings.backup_configuration.point_in_time_recovery_enabled`,
 * or a mysql's `binary_log_enabled`, its engine's switch for it
 * (the other engine's is refused by name, `google-locks.ts`), where
 * `false` keeps it off and so suppresses the restart; on when the entry
 * says nothing, or with no entry (Cloudgate's own definition, which a key
 * taken out returns to). Every create and change reads it here.
 */
export function cloudSqlWanted(entry?: CloudSqlEntry): CloudSqlWanted {
  const native = entry?.native?.gcp;
  const instance =
    native && Object.hasOwn(native, CLOUD_SQL_INSTANCE_ADDRESS)
      ? native[CLOUD_SQL_INSTANCE_ADDRESS]
      : undefined;
  const argument = entry
    ? CLOUD_SQL_ENGINES[entry.kind].pointInTimeRecoveryArgument
    : null;
  const turned = argument
    ? valueAt(instance, ['settings', 'backup_configuration', argument])
    : undefined;
  const { backupRetentionDays } = cloudSqlNativeColumns(native);
  const tier = nativeTierOf(native);
  return {
    pointInTimeRecovery: typeof turned === 'boolean' ? turned : true,
    ...(backupRetentionDays !== undefined ? { backupRetentionDays } : {}),
    ...(tier ? { tier } : {}),
  };
}

/** `on` / `off`, as a plan line names a switch. */
const onOff = (on: boolean) => (on ? 'on' : 'off');

/**
 * The mark a point-in-time recovery flip carries, either way: Google
 * restarts Postgres twice to turn its write-ahead log archiving on or off,
 * in the same form as for a machine change, and like it confirmed by approving
 * the plan alone. Turning it off restarts it twice too: a live walk saw two
 * shutdowns each way on Postgres 18, about 13 s
 * offline off and about 10 s on, inside the mark's "about 15 s". MySQL restarts once for
 * its binary log, either way, as a live walk saw.
 */
const pointInTimeRecoveryMark = (engine: CloudSqlEngine, name: string) =>
  `restarts ${name} ${engine.pointInTimeRecoveryRestart}`;

/**
 * A `postgres` a plan creates on Google Cloud (the Google Cloud databases spec): its size
 * on a Cloud SQL machine and its version by the shared rule, each refused
 * before the plan is stored when Cloud SQL could not make it, and the lines
 * that name the machine with its real CPU and memory. It is made with 7
 * days of automated backups and point-in-time recovery on, the
 * retention its Backups tab edits after: setting both at create restarts
 * nothing.
 *
 * A `mysql` is the same create with MySQL's parameters
 * (`CLOUD_SQL_ENGINES`): 8.4 when it has no `version`, 8.0, a 9.x and a
 * pinned 8.4 minor refused by name, and its user refused here when it is
 * `root`; one longer than MySQL's 32 characters is refused before, as the
 * config is read.
 */
export function cloudSqlCreate(
  name: string,
  entry: CloudSqlEntry,
  wanted: CloudSqlWanted,
):
  | {
      readonly ok: true;
      readonly cloudSql: CloudSqlCreate;
      readonly notes: PlanNote[];
    }
  | { readonly ok: false; readonly refusals: PlanRefusal[] } {
  const engine = CLOUD_SQL_ENGINES[entry.kind];
  const sizing = machineOf(name, entry.size);
  const version = engine.version(
    name,
    entry.dockerImage ?? engine.defaultImage,
  );
  const login = {
    user: entry.databaseUser ?? engine.defaultUser(name),
    database: entry.databaseName ?? defaultDatabaseIdentifier(name),
  };
  const userRefusal = engine.userRefusal(name, login.user);
  // A tier its `native.gcp` sets wins over the size: a size no
  // machine Cloudgate chooses holds is not refused, since it is not what
  // runs on Google Cloud.
  const nativeTier = wanted.tier ?? null;
  const chosen = sizing.ok ? sizing.machine : null;
  const sizeName = entry.size?.name ?? null;
  const smallest = entry.size === undefined && !nativeTier;
  const size: CloudSqlCreate['size'] | null = nativeTier
    ? {
        name: sizeName,
        tier: nativeTier,
        machine: cloudSqlTierText(nativeTier),
        smallest: false,
        native: true,
      }
    : chosen
      ? {
          name: sizeName,
          tier: chosen.name,
          machine: wording(chosen),
          smallest,
        }
      : null;
  if (!size || !version.ok || userRefusal) {
    return {
      ok: false,
      refusals: [
        ...(sizing.ok || nativeTier ? [] : [sizing.refusal]),
        ...(version.ok ? [] : [version.refusal]),
        ...(userRefusal ? [userRefusal] : []),
      ],
    };
  }
  const sizeLine =
    chosen && !size.native
      ? machineLine(name, chosen, sizeName, smallest)
      : sizeOverrideLine(name, sizeName, size.tier, size.machine);
  // A backup count `native.gcp` sets wins over Cloudgate's default.
  const backups =
    wanted.backupRetentionDays ?? CLOUD_SQL_BACKUP_RETENTION.default;
  return {
    ok: true,
    notes: suffixNote(engine, name, version.version),
    cloudSql: {
      size,
      version: {
        written: version.version.written,
        major: version.version.major,
        databaseVersion: cloudSqlDatabaseVersion(engine, version.version),
      },
      login,
      backupRetentionDays: backups,
      pointInTimeRecovery: wanted.pointInTimeRecovery,
      lines: [
        sizeLine,
        `${name} backups: ${backupDays(backups)}, point-in-time recovery ${onOff(wanted.pointInTimeRecovery)}`,
      ],
    },
  };
}

/**
 * What a change to a Cloud SQL instance does with each field a plan compares
 * (`cloud-change-fields.ts`): its user and database are fixed when it is
 * made.
 */
export const CLOUD_SQL_CHANGE_FIELDS: CloudChangeFields = {
  description: 'row',
  size: 'moves',
  version: 'moves',
  database: 'fixed',
  user: 'fixed',
};

/**
 * A change to a `postgres` on Cloud SQL: its machine moves with a
 * new `size`, marked as the restart it is; a size landing on the machine it
 * runs on changes nothing on GCP, and the plan says so. A tier its
 * `native.gcp` sets wins over the size, with the same mark; taken
 * out, it falls back to the size, or with none stays where it is. A newer major is a
 * major upgrade, which Apply confirms by the Service's name; an older one
 * refuses, as on AWS. A backup retention edited on its Backups tab since
 * the last Apply moves in place, with no restart; one outside
 * Cloud SQL's 1 to 365 days refuses. Its user and database are fixed when
 * it is made, so changing either refuses, naming the field, as on AWS; on
 * one whose Cloud run never made it (`unmade`), the run again makes it
 * with them.
 *
 * One made before backups (no backups written by an Apply) is caught up by
 * its next plan: backups at its Backups tab's retention, deletion
 * protection and retained backups on delete, in place with no mark. Any
 * flip of point-in-time recovery from what the last Apply wrote to what is
 * `wanted`, either way and for any reason, carries the restart mark, with
 * no typed confirmation: its engine's, twice for Postgres, once for
 * MySQL.
 *
 * A `mysql` is the same change by the same rules, with MySQL's
 * parameters (`CLOUD_SQL_ENGINES`).
 */
export function cloudSqlChange(
  name: string,
  entry: CloudSqlEntry,
  found: Extract<SavedService, { serviceType: 'postgres' | 'mysql' }>,
  fields: readonly FieldDiff[],
  wanted: CloudSqlWanted,
): {
  readonly refusals: PlanRefusal[];
  readonly notes: PlanNote[];
  readonly cloudSql: CloudSqlChange | null;
  readonly majorUpgrade: MajorUpgrade | null;
} {
  const engine = CLOUD_SQL_ENGINES[entry.kind];
  // An instance whose Cloud run failed before Cloudgate saved where it
  // answers is run again: the step's read plans what is left from its state
  // (the live walk), and that run makes it with the user and database the
  // row then holds, so neither is fixed yet.
  const unmade = found.cloudSql?.unmade === true;
  const refusals: PlanRefusal[] = unmade
    ? []
    : fixedWhenMadeRefusals(name, fields, CLOUD_SQL_CHANGE_FIELDS, 'Cloud SQL');
  const notes: PlanNote[] = [];
  const lines: string[] = [];
  // The tier it runs on, as its last Apply saved it, else its
  // caps' machine for one saved before that.
  const saved = machineOf(
    name,
    savedSize(found.settings.cpuLimit, found.settings.memoryLimit),
  );
  const runsOn = found.cloudSql?.tier ?? (saved.ok ? saved.machine.name : null);

  let tier: CloudSqlChange['tier'] = null;
  const sizeDiff = fields.find((diff) => diff.field === 'size');
  // Where it goes (ADR-0044 rule 12): to the tier its `native.gcp`
  // sets, which wins; else to its size's; else, with no size, it stays
  // where it is, so a native tier taken out never shrinks it.
  let to: { readonly name: string; readonly machine: string | null } | null =
    runsOn ? { name: runsOn, machine: cloudSqlTierText(runsOn) } : null;
  let sized: MachineType | null = null;
  if (entry.size !== undefined) {
    const sizing = machineOf(name, entry.size);
    if (sizing.ok) {
      sized = sizing.machine;
      to = { name: sized.name, machine: wording(sized) };
    } else if (!wanted.tier) {
      refusals.push(sizing.refusal);
    }
  }
  if (wanted.tier) {
    to = { name: wanted.tier, machine: cloudSqlTierText(wanted.tier) };
  }
  if (to && runsOn && to.name !== runsOn) {
    const sizeName = entry.size?.name ?? null;
    tier = {
      from: runsOn,
      to: to.name,
      machine: to.machine,
      sizeName,
      ...(wanted.tier ? { native: true as const } : {}),
    };
    lines.push(
      `${
        wanted.tier || !sized
          ? sizeOverrideLine(name, sizeName, to.name, to.machine)
          : machineLine(name, sized, sizeName, false)
      }, from ${runsOn}`,
      `restarts ${name}: under a minute offline`,
    );
  } else if (sizeDiff && runsOn && to?.name === runsOn) {
    notes.push({
      kind: 'cloud-same-class',
      configName: name,
      message: `${name}.size: ${sizeText(sizeDiff.from)} → ${sizeText(sizeDiff.to)} runs on ${runsOn} either way: no change on GCP`,
    });
  }

  let version: CloudSqlChange['version'] = null;
  let majorUpgrade: MajorUpgrade | null = null;
  const versionDiff = fields.find((diff) => diff.field === 'version');
  if (versionDiff) {
    const before = engine.version(name, String(versionDiff.from));
    const after = engine.version(name, String(versionDiff.to));
    if (!after.ok) {
      refusals.push(after.refusal);
    } else if (before.ok) {
      const was = before.version;
      const now = after.version;
      if (now.major < was.major) {
        refusals.push({
          at: `${name}.version`,
          message: `${name}.version: "${now.written}" is older than ${engine.label} ${was.major}, which ${name} runs on Cloud SQL, and Cloud SQL cannot move an instance back to an older major version; keep version: "${was.written}"`,
        });
      } else {
        notes.push(...suffixNote(engine, name, now));
        if (now.major > was.major) {
          majorUpgrade = { from: was.written, to: now.written };
          version = {
            from: was.written,
            to: now.written,
            databaseVersion: cloudSqlDatabaseVersion(engine, now),
          };
        }
      }
    }
  }

  let backupRetentionDays: CloudSqlChange['backupRetentionDays'] = null;
  let catchUp: CloudSqlChange['catchUp'];
  let pointInTimeRecovery: CloudSqlChange['pointInTimeRecovery'];
  const backups = found.cloudSql;
  const refusal = backups
    ? retentionRefusal(
        name,
        backups.backupRetentionDays,
        CLOUD_SQL_BACKUP_RETENTION,
        'Cloud SQL',
      )
    : null;
  if (refusal) {
    refusals.push(refusal);
  } else if (backups) {
    const { applied } = backups;
    if (!applied) {
      catchUp = { backupRetentionDays: backups.backupRetentionDays };
      lines.push(
        `${name} backups: off → ${backupDays(catchUp.backupRetentionDays)}, deletion protection: off → on`,
      );
    } else if (backups.backupRetentionDays !== applied.backupRetentionDays) {
      backupRetentionDays = {
        from: applied.backupRetentionDays,
        to: backups.backupRetentionDays,
      };
      lines.push(
        `${name} backups: ${backupDays(backupRetentionDays.from)} → ${backupDays(backupRetentionDays.to)}`,
      );
    }
    // Off on one made before backups; as its last Apply wrote it, on
    // unless said otherwise, on one made with them.
    const from = applied ? (applied.pointInTimeRecovery ?? true) : false;
    if (from !== wanted.pointInTimeRecovery) {
      pointInTimeRecovery = { from, to: wanted.pointInTimeRecovery };
      lines.push(
        `${name} point-in-time recovery: ${onOff(from)} → ${onOff(pointInTimeRecovery.to)}`,
        pointInTimeRecoveryMark(engine, name),
      );
    }
  }

  return {
    refusals,
    notes,
    cloudSql:
      tier ||
      version ||
      backupRetentionDays ||
      catchUp ||
      pointInTimeRecovery ||
      unmade
        ? {
            tier,
            version,
            ...(backupRetentionDays ? { backupRetentionDays } : {}),
            ...(catchUp ? { catchUp } : {}),
            ...(pointInTimeRecovery ? { pointInTimeRecovery } : {}),
            lines,
          }
        : null,
    majorUpgrade,
  };
}
