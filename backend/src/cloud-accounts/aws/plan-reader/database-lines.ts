import {
  RDS_CLASSES,
  RDS_KNOWN_CLASSES,
  formatMachine,
  machineKnown,
} from '../definitions/database-class';
import { sizeOverrideLine } from '../../../native/size-override';
import { RDS_ENGINES, rdsEngineNamed } from '../definitions/rds-engines';
import type { RdsEngine } from '../definitions/rds-engines';
import type { StepAction, SummaryContext } from './plan-lines';
import type { TofuResourceChange, TofuShowJson } from './tofu-show.types';

/**
 * A change that takes a database offline (the AWS databases spec "Plan lines for a cloud
 * database"), kept as data beside its line so a client can show it
 * apart: a `restart` (a new class, or a new minor), or a `major-upgrade`,
 * which is also never undone and is confirmed by name at Apply.
 */
export interface Outage {
  readonly kind: 'restart' | 'major-upgrade';
  readonly serviceName: string;
  readonly line: string;
}

type Values = Record<string, unknown>;

function valuesOf(value: unknown): Values {
  return value && typeof value === 'object' ? (value as Values) : {};
}

/** `17.4`: the version AWS reports it runs, else the one asked for. */
function versionOf(values: Values): string | null {
  const actual = values.engine_version_actual;
  if (typeof actual === 'string' && actual !== '') return actual;
  const asked = values.engine_version;
  return typeof asked === 'string' && asked !== '' ? asked : null;
}

/**
 * The engine an instance's values name: a `mysql`'s lines say
 * MySQL and read `8.4` as its major, a `postgres`'s say PostgreSQL.
 */
function engineOf(values: Values): RdsEngine {
  return rdsEngineNamed(values.engine) ?? RDS_ENGINES.postgres;
}

const days = (count: number) => `${count} ${count === 1 ? 'day' : 'days'}`;

/**
 * The plain words for a database's planned change (the AWS databases spec "Plan lines
 * for a cloud database"): the size beside the class AWS will
 * run, with its CPU and memory; on a create what it starts with — storage,
 * backup retention and the version; on a change each value that moves, and
 * the outage it brings (`databaseOutages`). Every value is read from the
 * plan, so a line never claims what the definition did not ask for.
 */
export function databaseLines(
  change: TofuResourceChange,
  action: StepAction,
  context: SummaryContext,
): string[] {
  if (change.type !== 'aws_db_instance') return [];
  const values = valuesOf(change.change.after ?? change.change.before);
  const name = context.serviceName ?? change.name;
  if (action === 'destroy') return [`${name}: destroy`];
  if (action === 'change') return changeLines(change, name, context);

  const lines: string[] = [];
  const line = classLine(values, name, context);
  if (line) lines.push(line);
  if (action !== 'create') return lines;

  const storage = values.allocated_storage;
  const ceiling = values.max_allocated_storage;
  if (typeof storage === 'number') {
    const type =
      typeof values.storage_type === 'string' ? ` ${values.storage_type}` : '';
    lines.push(
      `${name} storage: ${storage} GB${type}` +
        (typeof ceiling === 'number' && ceiling > storage
          ? `, grows to ${ceiling} GB`
          : ''),
    );
  }
  const retention = values.backup_retention_period;
  if (typeof retention === 'number') {
    lines.push(`${name} backups: kept ${days(retention)}`);
  }
  const version = values.engine_version;
  if (typeof version === 'string') {
    const { label } = engineOf(values);
    lines.push(
      values.auto_minor_version_upgrade === false
        ? `${name} version: ${label} ${version}, pinned, no automatic minor upgrades`
        : `${name} version: ${label} ${version}, RDS's default minor, minor upgrades automatic`,
    );
  }
  return lines;
}

/**
 * `pg-1 small → db.t4g.micro (2 vCPU, 1 GB)`, the size beside its class;
 * a class `native.aws` sets beside the size it wins over,
 * `pg-1 medium → db.r7g.xlarge (4 vCPU, 32 GB), set by native`, its CPU and
 * memory when the committed class table knows it.
 */
function classLine(
  values: Values,
  name: string,
  context: SummaryContext,
): string | null {
  const instanceClass = values.instance_class;
  if (typeof instanceClass !== 'string') return null;
  const machine = machineKnown(RDS_CLASSES, RDS_KNOWN_CLASSES, instanceClass);
  if (context.nativeMachine) {
    return sizeOverrideLine(
      name,
      context.sizeName ?? null,
      instanceClass,
      machine ? formatMachine(machine) : null,
    );
  }
  const size = context.sizeName ?? (context.noSize ? 'no size' : null);
  const shown = machine
    ? `${instanceClass} (${formatMachine(machine)})`
    : instanceClass;
  return `${name}${size ? ` ${size}` : ''} → ${shown}${context.noSize ? ' (smallest)' : ''}`;
}

/**
 * A change's lines: each value that moves, from what it is to what it will
 * be, then its outage. Storage growth, Multi-AZ and retention carry no mark
 * (the AWS databases spec US14): RDS makes them with the instance online.
 */
function changeLines(
  change: TofuResourceChange,
  name: string,
  context: SummaryContext,
): string[] {
  const before = valuesOf(change.change.before);
  const after = valuesOf(change.change.after);
  const moved = (field: string) => before[field] !== after[field];
  const lines: string[] = [];
  if (moved('instance_class')) {
    const line = classLine(after, name, context);
    if (line) {
      lines.push(
        typeof before.instance_class === 'string'
          ? `${line}, from ${before.instance_class}`
          : line,
      );
    }
  }
  if (moved('allocated_storage')) {
    lines.push(
      `${name} storage: ${String(before.allocated_storage)} GB → ${String(after.allocated_storage)} GB`,
    );
  }
  if (moved('max_allocated_storage')) {
    lines.push(
      `${name} storage grows to: ${String(before.max_allocated_storage)} GB → ${String(after.max_allocated_storage)} GB`,
    );
  }
  if (moved('multi_az')) {
    lines.push(
      after.multi_az === true
        ? `${name} Multi-AZ: off → on, a standby in a second zone`
        : `${name} Multi-AZ: on → off`,
    );
  }
  if (
    moved('backup_retention_period') &&
    typeof before.backup_retention_period === 'number' &&
    typeof after.backup_retention_period === 'number'
  ) {
    lines.push(
      `${name} backups: kept ${days(before.backup_retention_period)} → ${days(after.backup_retention_period)}`,
    );
  }
  for (const outage of databaseOutages(change, 'change', context)) {
    lines.push(outage.line);
  }
  return lines;
}

/**
 * The outages a database's change brings (the AWS databases spec US11, US13): a
 * new class restarts it, a new minor restarts it, and a new major is a
 * major upgrade, named from the version AWS reports it runs. A create or a
 * destroy brings none: there is nothing running to take offline, or the
 * destroy says what it is.
 */
export function databaseOutages(
  change: TofuResourceChange,
  action: StepAction,
  context: SummaryContext,
): Outage[] {
  if (change.type !== 'aws_db_instance' || action !== 'change') return [];
  const name = context.serviceName ?? change.name;
  const before = valuesOf(change.change.before);
  const after = valuesOf(change.change.after);
  const restart: Outage = {
    kind: 'restart',
    serviceName: name,
    line: `restarts ${name}: a few minutes offline`,
  };
  const outages: Outage[] = [];
  const running = versionOf(before);
  const asked =
    typeof after.engine_version === 'string' ? after.engine_version : null;
  const versionMoved =
    asked !== null &&
    before.engine_version !== after.engine_version &&
    running !== null &&
    !running.startsWith(`${asked}.`) &&
    running !== asked;
  const engine = engineOf(after);
  const major = (version: string) => engine.majorOf(version) ?? 0;
  if (versionMoved && major(asked) > major(running)) {
    outages.push({
      kind: 'major-upgrade',
      serviceName: name,
      line: `${name} major upgrade: ${engine.label} ${running} → ${asked}, offline during the upgrade, cannot be undone`,
    });
  } else if (versionMoved || before.instance_class !== after.instance_class) {
    outages.push(restart);
  }
  return outages;
}

/**
 * The version an RDS instance runs, PostgreSQL's or MySQL's, read from the state a plan
 * refreshed: what AWS reports, or `null` for an instance not made
 * yet. A downgrade is refused naming it.
 */
export function runningPostgresVersion(show: TofuShowJson): string | null {
  const instance = (show.resource_changes ?? []).find(
    (change) => change.type === 'aws_db_instance' && change.mode !== 'data',
  );
  if (!instance || instance.change.before === null) return null;
  return versionOf(valuesOf(instance.change.before));
}
