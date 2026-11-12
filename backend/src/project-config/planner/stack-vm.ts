import { AWS_STACK_VMS } from '../../cloud-accounts/aws/definitions/stack-vm-machines';
import { GOOGLE_STACK_VMS } from '../../cloud-accounts/gcp/definitions/stack-vm-machines';
import {
  formatMachine,
  machineFor,
} from '../../cloud-accounts/aws/definitions/database-class';
import type { CloudKind } from '../../cloud-accounts/cloud-account.schema';
import { byCloud } from '../../cloud-accounts/cloud-provider';
import type { PerCloud } from '../../cloud-accounts/cloud-provider';
import {
  STACK_VM_DATA_DISK_GB,
  STACK_VM_DEFAULT_SIZE,
  STACK_VM_SNAPSHOT_DAYS,
  stackVmMonthly,
} from '../../cloud-accounts/definitions/stack-vm';
import type {
  StackVmCloud,
  StackVmSettings,
} from '../../cloud-accounts/definitions/stack-vm';
import { stackVmSnapshotMonthlyUsd } from '../../cloud-accounts/definitions/stack-vm-final-snapshot';
import { formatUsd } from '../../cloud-accounts/aws/final-snapshot';
import { SIZES } from '../format/config-size';
import type { Size, SizeName } from '../format/config-size';
import type { ComposeEntry } from '../project-config.types';
import {
  STACK_VM_GAP,
  stackVmGapFix,
  stackVmPermissionsLacking,
} from '../../cloud-accounts/stack-vm-permissions';
import {
  movedPins,
  stackVmPinsOn,
} from '../../cloud-accounts/definitions/stack-vm-pins';
import type { StackVmPins } from '../../cloud-accounts/definitions/stack-vm-pins';
import type {
  FieldDiff,
  PlanInput,
  PlanRefusal,
  SavedStackVm,
  StackVmChange,
  StackVmCreate,
  StackVmDestroy,
} from './plan.types';

/** How each cloud names a Cloud account's permissions version. */
const VERSION_WORD: PerCloud<string> = {
  aws: 'policy version',
  gcp: 'role version',
};

/**
 * Why a Stack VM cannot be made in this Cloud account, or `null` (#1366):
 * its role was last checked at a version that lacks what a Stack VM needs
 * (`stack-vm-permissions.ts`), so the Stack VM would be one Cloudgate
 * could neither make whole nor reach. Names what is missing and the fix.
 */
export function stackVmGapRefusal(
  name: string,
  place: { readonly cloud: CloudKind; readonly cloudAccountId: string },
  account: PlanInput['cloudAccount'],
): PlanRefusal | null {
  if (!account) return null;
  const lacking = stackVmPermissionsLacking(place.cloud, account.policyVersion);
  if (lacking.length === 0) return null;
  return {
    at: `${name}.kind`,
    message: `${name}: a Stack VM cannot be made in Cloud account ${account.name}, whose role was last checked at ${byCloud(place.cloud, VERSION_WORD)} ${account.policyVersion}: it lacks ${byCloud(place.cloud, STACK_VM_GAP)}: ${lacking.join(', ')}. ${stackVmGapFix(place.cloud, place.cloudAccountId)}, and plan again`,
  };
}

/** Each cloud's Stack VMs (ADR-0070): AWS's (#1359) and Google Cloud's (#1362). */
const STACK_VM_CLOUDS: Partial<PerCloud<StackVmCloud>> = {
  aws: AWS_STACK_VMS,
  gcp: GOOGLE_STACK_VMS,
};

/** The address of a Stack VM's machine on AWS, which `native.aws` names. */
export const AWS_STACK_VM_ADDRESS = 'aws_instance.stack_vm';

/** The address of a Stack VM's machine on Google Cloud, which `native.gcp` names. */
export const GOOGLE_STACK_VM_ADDRESS = 'google_compute_instance.stack_vm';

/**
 * Where each cloud's `native` block sets the Stack VM's machine type: the
 * block's key, the machine's address and the argument naming the type.
 */
const NATIVE_MACHINE: PerCloud<{
  readonly block: 'aws' | 'gcp';
  readonly address: string;
  readonly argument: string;
}> = {
  aws: {
    block: 'aws',
    address: AWS_STACK_VM_ADDRESS,
    argument: 'instance_type',
  },
  gcp: {
    block: 'gcp',
    address: GOOGLE_STACK_VM_ADDRESS,
    argument: 'machine_type',
  },
};

/** The non-empty native block of the cloud a Stack VM's read and run lay. */
function laidBlock(
  entry: ComposeEntry,
  cloud: CloudKind,
): Readonly<Record<string, Record<string, unknown>>> | undefined {
  const block = entry.native?.[byCloud(cloud, NATIVE_MACHINE).block];
  return block && Object.keys(block).length > 0 ? block : undefined;
}

/** The machine type an entry's native block sets on its cloud, or `undefined`. */
function nativeMachineTypeOf(
  block: Readonly<Record<string, Record<string, unknown>>> | undefined,
  cloud: CloudKind,
): string | undefined {
  const { address, argument } = byCloud(cloud, NATIVE_MACHINE);
  const type = block?.[address]?.[argument];
  return typeof type === 'string' && type !== '' ? type : undefined;
}

/**
 * A Compose stack's Stack VM in a Cloud account (ADR-0070): its machine
 * type, its price in the region and the plan's lines for it.
 *
 * - **Size.** The entry's `size`, else the Template minimum the step is
 *   given, else `medium`, on the smallest machine type at least as large in
 *   both CPU and memory, from the cloud's fixed list (`machineFor`, a cloud
 *   database's rule). A size above the largest refuses, naming the entry.
 * - **Native.** A machine type the entry's cloud block sets
 *   (`native.aws`'s `instance_type`, `native.gcp`'s `machine_type`) wins
 *   over the size (ADR-0044), its line saying so.
 * - **Price.** From the cloud's coded rate table: the machine's hourly
 *   × 730, the data disk per GB-month and a snapshot estimate. A region
 *   or a type the table does not price plans with no price, and says so.
 */
export function stackVmCreate(
  name: string,
  entry: ComposeEntry,
  place: { readonly cloud: CloudKind; readonly region: string },
  templateMinimum: SizeName | undefined,
):
  | { readonly ok: true; readonly stackVm: StackVmCreate }
  | { readonly ok: false; readonly refusals: PlanRefusal[] } {
  return startingStackVm(
    name,
    place,
    entry.size,
    templateMinimum,
    laidBlock(entry, place.cloud),
  );
}

/**
 * The Stack VM of a Template's compose part, created from its Pending
 * setup in a Cloud Environment (#1379): console-managed, so the config
 * gives it no `size` and no `native` block, and it starts at the
 * template's minimum size, else `medium` (ADR-0070 "Machine").
 */
export function templateStackVmCreate(
  name: string,
  place: { readonly cloud: CloudKind; readonly region: string },
  templateMinimum: SizeName | undefined,
):
  | { readonly ok: true; readonly stackVm: StackVmCreate }
  | { readonly ok: false; readonly refusals: PlanRefusal[] } {
  return startingStackVm(name, place, undefined, templateMinimum, undefined);
}

/** A new Stack VM at its entry's size, else a Template minimum, else `medium`. */
function startingStackVm(
  name: string,
  place: { readonly cloud: CloudKind; readonly region: string },
  size: Size | undefined,
  templateMinimum: SizeName | undefined,
  native: Readonly<Record<string, Record<string, unknown>>> | undefined,
):
  | { readonly ok: true; readonly stackVm: StackVmCreate }
  | { readonly ok: false; readonly refusals: PlanRefusal[] } {
  const cloud = STACK_VM_CLOUDS[place.cloud];
  if (!cloud) {
    return {
      ok: false,
      refusals: [
        {
          at: `${name}.kind`,
          message: `${name}: a Stack VM is not made on this cloud yet`,
        },
      ],
    };
  }
  const starting: { size: Size; from: 'entry' | 'template' | 'default' } = size
    ? { size, from: 'entry' }
    : templateMinimum
      ? {
          size: { name: templateMinimum, ...SIZES[templateMinimum] },
          from: 'template',
        }
      : {
          size: {
            name: STACK_VM_DEFAULT_SIZE,
            ...SIZES[STACK_VM_DEFAULT_SIZE],
          },
          from: 'default',
        };
  return sizedStackVm(name, cloud, place, starting, {
    native,
    dataDiskGb: STACK_VM_DATA_DISK_GB,
  });
}

/**
 * The Stack VM of a console-managed stack the console created in a Cloud
 * Environment (#1372): its size is its console setting, as a described
 * stack's is its entry's `size`, else `medium`; its data disk the one the
 * console grew it to, else 20 GB. It has no `native` block, which only a
 * config entry carries. Made for the row the console wrote, whose id its
 * read and Apply use.
 *
 * #1368's resize compares the same console setting with the machine a
 * made Stack VM runs: {@link consoleStackVmSize} is that wanted size.
 */
export function consoleStackVmCreate(
  name: string,
  found: { readonly serviceId: string; readonly stackVm: SavedStackVm },
):
  | { readonly ok: true; readonly stackVm: StackVmCreate }
  | { readonly ok: false; readonly refusals: PlanRefusal[] } {
  const cloud = STACK_VM_CLOUDS[found.stackVm.cloud];
  if (!cloud) {
    return {
      ok: false,
      refusals: [
        {
          at: name,
          message: `${name}: a Stack VM is not made on this cloud yet`,
        },
      ],
    };
  }
  const made = sizedStackVm(
    name,
    cloud,
    { cloud: found.stackVm.cloud, region: found.stackVm.region },
    consoleStackVmSize(found.stackVm),
    {
      native: undefined,
      dataDiskGb: Math.max(
        found.stackVm.dataDiskGb,
        found.stackVm.consoleDataDiskGb ?? 0,
      ),
    },
  );
  return made.ok
    ? {
        ok: true,
        stackVm: { ...made.stackVm, consoleStackId: found.serviceId },
      }
    : made;
}

/**
 * The size a console-managed stack's Stack VM is wanted at: its console
 * setting, or `medium` when none was set (ADR-0070 "Machine").
 */
export function consoleStackVmSize(stackVm: SavedStackVm): {
  readonly size: Size;
  readonly from: 'console' | 'default';
} {
  const name = stackVm.consoleSize ?? STACK_VM_DEFAULT_SIZE;
  return {
    size: { name, ...SIZES[name] },
    from: stackVm.consoleSize ? 'console' : 'default',
  };
}

/** A Stack VM at a starting size: its machine type, price and lines. */
function sizedStackVm(
  name: string,
  cloud: StackVmCloud,
  place: { readonly cloud: CloudKind; readonly region: string },
  starting: { size: Size; from: StackVmCreate['size']['from'] },
  laid: {
    readonly native:
      Readonly<Record<string, Record<string, unknown>>> | undefined;
    readonly dataDiskGb: number;
  },
):
  | { readonly ok: true; readonly stackVm: StackVmCreate }
  | { readonly ok: false; readonly refusals: PlanRefusal[] } {
  const { native, dataDiskGb } = laid;
  const nativeType = nativeMachineTypeOf(native, place.cloud);
  const sizeName = starting.size.name ?? null;

  let size: StackVmCreate['size'];
  if (nativeType) {
    const known = cloud.known.find((one) => one.name === nativeType);
    size = {
      name: sizeName,
      from: 'native',
      machineType: nativeType,
      machine: known ? formatMachine(known) : null,
    };
  } else {
    const sizing = machineFor(cloud.machines, name, starting.size);
    if (!sizing.ok) return { ok: false, refusals: [sizing.refusal] };
    size = {
      name: sizeName,
      from: starting.from,
      machineType: sizing.machine.name,
      machine: formatMachine(sizing.machine),
    };
  }

  const monthly = stackVmMonthly(
    cloud,
    place.region,
    size.machineType,
    dataDiskGb,
  );
  return {
    ok: true,
    stackVm: {
      size,
      region: place.region,
      dataDiskGb,
      snapshotDays: STACK_VM_SNAPSHOT_DAYS,
      monthly,
      lines: [
        machineLine(name, size, place.region),
        costLine(
          name,
          monthly,
          place.region,
          size.machineType,
          cloud,
          dataDiskGb,
        ),
        `${name} Stack VM data disk: ${dataDiskGb} GB for its volumes, snapshotted daily, each snapshot kept ${STACK_VM_SNAPSHOT_DAYS} days`,
      ],
      // Its cloud's block, which its read and Cloud run lay.
      ...(native
        ? byCloud<Pick<StackVmCreate, 'native' | 'nativeGcp'>>(place.cloud, {
            aws: { native },
            gcp: { nativeGcp: native },
          })
        : {}),
    },
  };
}

/** `analytics Stack VM: medium → t3.small (2 vCPU, 2 GB) in eu-west-1`. */
function machineLine(
  name: string,
  size: StackVmCreate['size'],
  region: string,
): string {
  const machine = size.machine
    ? `${size.machineType} (${size.machine})`
    : size.machineType;
  const sized = size.name ?? 'its size';
  switch (size.from) {
    case 'native':
      return `${name} Stack VM: ${sized} → ${machine}, set by native, in ${region}`;
    case 'default':
      return `${name} Stack VM: no size, starts at ${sized} → ${machine} in ${region}`;
    case 'template':
      return `${name} Stack VM: the template's minimum, ${sized} → ${machine} in ${region}`;
    case 'console':
      return `${name} Stack VM: ${sized}, set in the console → ${machine} in ${region}`;
    case 'entry':
      return `${name} Stack VM: ${sized} → ${machine} in ${region}`;
  }
}

function costLine(
  name: string,
  monthly: StackVmCreate['monthly'],
  region: string,
  machineType: string,
  cloud: StackVmCloud,
  dataDiskGb: number,
): string {
  if (!monthly) {
    const what = cloud.rates[region] ? `${machineType} in ${region}` : region;
    return `${name} Stack VM cost: Cloudgate's rate table has no price for ${what}; see ${cloud.pricing}`;
  }
  return `${name} Stack VM cost: about ${formatUsd(monthly.totalUsd)} a month (machine ${formatUsd(monthly.machineUsd)}, ${dataDiskGb} GB data disk ${formatUsd(monthly.diskUsd)}, daily snapshots about ${formatUsd(monthly.snapshotsUsd)})`;
}

/**
 * The Stack VM settings a stack the console creates in a Cloud Environment
 * is written with (#1372): `medium`, on its cloud's machine type for it,
 * with the starting data disk, nothing made yet and no console setting.
 * The Environment's plan makes it; `null` on a cloud that makes none.
 */
export function newConsoleStackVm(cloud: CloudKind): StackVmSettings | null {
  const table = STACK_VM_CLOUDS[cloud];
  if (!table) return null;
  const sizing = machineFor(table.machines, 'stack', {
    name: STACK_VM_DEFAULT_SIZE,
    ...SIZES[STACK_VM_DEFAULT_SIZE],
  });
  if (!sizing.ok) return null;
  return {
    machineType: sizing.machine.name,
    sizeName: STACK_VM_DEFAULT_SIZE,
    dataDiskGb: STACK_VM_DATA_DISK_GB,
    snapshotDays: STACK_VM_SNAPSHOT_DAYS,
    made: null,
  };
}

/** A stack's Stack VM as its page shows it (#1372). */
export interface StackVmFacts {
  readonly cloud: CloudKind;
  readonly region: string;
  /** Whether its Apply made it; until then the plan that makes it waits. */
  readonly made: boolean;
  /** The machine type it runs, or is planned to start at. */
  readonly machineType: string;
  /** `2 vCPU, 2 GB`; `null` for a type the machine list does not know. */
  readonly machine: string | null;
  /** The size it was planned at, when a size picked its machine type. */
  readonly sizeName: SizeName | null;
  /** The data disk it has, which only grows. */
  readonly dataDiskGb: number;
  readonly snapshotDays: number;
  /** What the stack page set, which its next plan applies. */
  readonly console: {
    readonly sizeName: SizeName | null;
    readonly dataDiskGb: number | null;
  };
  /** Its monthly price from the rate table, `null` when it has none. */
  readonly monthlyUsd: number | null;
}

/** A stack's Stack VM as its page shows it: the machine with its CPU and memory. */
export function stackVmFacts(
  place: { readonly cloud: CloudKind; readonly region: string },
  settings: StackVmSettings,
): StackVmFacts {
  const table = STACK_VM_CLOUDS[place.cloud];
  const known = table?.known.find((one) => one.name === settings.machineType);
  const monthly = table
    ? stackVmMonthly(
        table,
        place.region,
        settings.machineType,
        settings.dataDiskGb,
      )
    : null;
  return {
    cloud: place.cloud,
    region: place.region,
    made: settings.made !== null,
    machineType: settings.machineType,
    machine: known ? formatMachine(known) : null,
    sizeName: settings.sizeName,
    dataDiskGb: settings.dataDiskGb,
    snapshotDays: settings.snapshotDays,
    console: {
      sizeName: settings.console?.sizeName ?? null,
      dataDiskGb: settings.console?.dataDiskGb ?? null,
    },
    monthlyUsd: monthly?.totalUsd ?? null,
  };
}

/** What each cloud's Stack VM is made of, as its destroy line names it. */
const STACK_VM_PARTS: PerCloud<{
  readonly parts: string;
  readonly where: string;
}> = {
  aws: {
    parts:
      'the EC2 instance, its load balancer rules and target group, its security group, its IAM role and instance profile, and its Data Lifecycle Manager policy with its daily snapshots',
    where: 'AWS',
  },
  gcp: {
    parts:
      'the Compute Engine instance, its load balancer backend, its firewall rules, its service account, and its snapshot schedule with its daily snapshots',
    where: 'Google Cloud',
  },
};

/**
 * A Stack VM stack's destroy (ADR-0070 "Delete", #1367): everything in the
 * stack's Infrastructure state goes — its VM, load balancer rules and
 * target, security or firewall rules, cloud identity, and its snapshot
 * policy or schedule with its daily snapshots — and its data disk is kept
 * as a final snapshot, priced from the cloud's rate table by the disk's
 * size as it has grown, unless the Apply ticks "also delete its data".
 * The snapshot's name is the plan store's, which knows the day.
 */
export function stackVmDestroy(
  name: string,
  saved: SavedStackVm,
): StackVmDestroy {
  const { parts, where } = byCloud(saved.cloud, STACK_VM_PARTS);
  const cloud = STACK_VM_CLOUDS[saved.cloud];
  const finalSnapshotMonthlyUsd = stackVmSnapshotMonthlyUsd(
    saved.cloud,
    saved.region,
    saved.dataDiskGb,
  );
  const disk = `${name} data disk (${saved.dataDiskGb} GB, its volumes)`;
  const ticked = `"also delete its data" is ticked`;
  return {
    cloud: saved.cloud,
    region: saved.region,
    dataDiskGb: saved.dataDiskGb,
    finalSnapshotMonthlyUsd,
    lines: [
      `${name} Stack VM goes from ${saved.region} with everything in its Infrastructure state: ${parts}`,
      finalSnapshotMonthlyUsd === null
        ? `${disk}: kept as a final snapshot unless ${ticked}; Cloudgate's rate table has no snapshot price for ${saved.region}${cloud ? `, see ${cloud.pricing}` : ''}`
        : `${disk}: kept as a final snapshot, about ${formatUsd(finalSnapshotMonthlyUsd)} a month until you delete it in ${where}, unless ${ticked}; then nothing of it is kept`,
    ],
  };
}
/**
 * What a plan asks of a stack's Stack VM that exists (#1368): the size
 * and the cloud block of its entry, or of its console when it is
 * console-managed, and the data disk its console asks for.
 */
export interface StackVmAsked {
  /**
   * The size asked: a repository-described stack's entry `size`, a
   * console-managed one's console setting. Absent, it keeps the machine
   * type it was made on.
   */
  readonly size?: Size;
  /** The cloud block that lays over it: the entry's, or the one last laid. */
  readonly native?: Readonly<Record<string, Record<string, unknown>>>;
  /** The data disk asked for, never smaller than it is. Absent: as it is. */
  readonly dataDiskGb?: number;
}

/** `t3.small (2 vCPU, 2 GB)`, or the type alone when the list does not know it. */
function machineText(cloud: StackVmCloud, machineType: string): string {
  const known = cloud.known.find((one) => one.name === machineType);
  return known ? `${machineType} (${formatMachine(known)})` : machineType;
}

const PIN_NAMES: Record<keyof StackVmPins, string> = {
  image: 'image',
  dockerEngine: 'Docker',
  composePlugin: 'compose',
};

/**
 * **A Stack VM that exists, changed** (ADR-0070 "Machine", "Data",
 * "Upkeep"; #1368): what its definition is written from after this plan,
 * and its lines, or `null` when nothing moves.
 *
 * - **Resize.** A new size, or a machine type its cloud block sets, picks
 *   a new machine type by the create's rule; its line says it restarts the
 *   Stack VM, and the cost line shows the old and the new price. No size
 *   keeps the machine type it was made on.
 * - **Grow.** A larger data disk grows in place with no restart; a smaller
 *   one is refused, naming the stack: a data disk only grows.
 * - **Replace VM.** Once Cloudgate's pins (the Ubuntu image, Docker,
 *   compose) have moved past the ones it was made with, a "replace VM"
 *   line makes it again at the new ones, its data disk kept. Never before
 *   it is made, and applied only as an approved line.
 *
 * With `drift`, a Stack VM nothing moves is still returned, lineless, so
 * "Check for changes" reads it.
 */
export function stackVmChange(
  name: string,
  place: { readonly cloud: CloudKind; readonly region: string },
  saved: SavedStackVm,
  asked: StackVmAsked,
  drift: boolean,
):
  | {
      readonly ok: true;
      readonly change: StackVmChange | null;
      readonly fields: readonly FieldDiff[];
    }
  | { readonly ok: false; readonly refusals: PlanRefusal[] } {
  const cloud = STACK_VM_CLOUDS[place.cloud];
  if (!cloud) {
    return {
      ok: false,
      refusals: [
        {
          at: `${name}.kind`,
          message: `${name}: a Stack VM is not made on this cloud yet`,
        },
      ],
    };
  }

  const dataDiskGb = asked.dataDiskGb ?? saved.dataDiskGb;
  if (dataDiskGb < saved.dataDiskGb) {
    return {
      ok: false,
      refusals: [
        {
          at: name,
          message: `${name}: its Stack VM data disk is ${saved.dataDiskGb} GB, and a data disk only grows; ${dataDiskGb} GB is refused`,
        },
      ],
    };
  }

  // The machine type: its cloud block's, else its size's, else the one
  // it was made on (one its block set returns to `medium`).
  const nativeType = nativeMachineTypeOf(asked.native, place.cloud);
  let machineType: string;
  let sizeName: SizeName | null;
  if (nativeType) {
    machineType = nativeType;
    sizeName = asked.size?.name ?? saved.sizeName;
  } else if (asked.size) {
    const sizing = machineFor(cloud.machines, name, asked.size);
    if (!sizing.ok) return { ok: false, refusals: [sizing.refusal] };
    machineType = sizing.machine.name;
    sizeName = asked.size.name ?? null;
  } else if (saved.sizeName !== null) {
    machineType = saved.machineType;
    sizeName = saved.sizeName;
  } else {
    const sizing = machineFor(cloud.machines, name, {
      name: STACK_VM_DEFAULT_SIZE,
      ...SIZES[STACK_VM_DEFAULT_SIZE],
    });
    if (!sizing.ok) return { ok: false, refusals: [sizing.refusal] };
    machineType = sizing.machine.name;
    sizeName = STACK_VM_DEFAULT_SIZE;
  }

  const savedBlock = byCloud(place.cloud, {
    aws: saved.native,
    gcp: saved.nativeGcp,
  });
  const nativeMoved =
    JSON.stringify(asked.native ?? {}) !== JSON.stringify(savedBlock ?? {});
  const resized = machineType !== saved.machineType;
  const grown = dataDiskGb > saved.dataDiskGb;
  const moved = saved.pins
    ? movedPins(saved.pins, stackVmPinsOn(place.cloud))
    : [];

  const before = stackVmMonthly(
    cloud,
    place.region,
    saved.machineType,
    saved.dataDiskGb,
  );
  const after = stackVmMonthly(cloud, place.region, machineType, dataDiskGb);
  const lines: string[] = [];
  if (resized) {
    lines.push(
      `${name} Stack VM: ${machineText(cloud, saved.machineType)} → ${machineText(cloud, machineType)}${nativeType ? ', set by native' : ''}, restarts the Stack VM`,
    );
  } else if (nativeMoved) {
    lines.push(
      `${name} Stack VM: its native block changes, read from its cloud before it applies`,
    );
  }
  if (grown) {
    lines.push(
      `${name} Stack VM data disk: ${saved.dataDiskGb} GB → ${dataDiskGb} GB, grown in place with no restart; a data disk never shrinks`,
    );
  }
  if (resized || grown) {
    lines.push(
      before && after
        ? `${name} Stack VM cost: about ${formatUsd(before.totalUsd)} → about ${formatUsd(after.totalUsd)} a month`
        : `${name} Stack VM cost: Cloudgate's rate table has no price for ${cloud.rates[place.region] ? `${machineType} in ${place.region}` : place.region}; see ${cloud.pricing}`,
    );
  }
  if (moved.length > 0) {
    const pins = moved
      .map(
        (one) =>
          `${PIN_NAMES[one.pin]} ${one.from ?? '(not recorded)'} → ${one.to}`,
      )
      .join(', ');
    lines.push(
      `${name} Stack VM: replace VM, from Cloudgate's new pins: ${pins}`,
      `${name} Stack VM data disk: kept, with its volumes; the stack is down while the new Stack VM boots`,
    );
  }

  const fields: FieldDiff[] =
    resized && asked.size && (asked.size.name ?? null) !== saved.sizeName
      ? [{ field: 'size', from: saved.sizeName, to: asked.size.name ?? null }]
      : [];
  if (lines.length === 0 && !drift) return { ok: true, change: null, fields };
  return {
    ok: true,
    fields,
    change: {
      machineType,
      sizeName,
      dataDiskGb,
      snapshotDays: saved.snapshotDays,
      monthly: after,
      ...(resized
        ? {
            resize: {
              from: { machineType: saved.machineType, monthly: before },
              to: { machineType, monthly: after },
            },
          }
        : {}),
      ...(grown
        ? { grow: { fromGb: saved.dataDiskGb, toGb: dataDiskGb } }
        : {}),
      ...(moved.length > 0 && saved.pins
        ? { replace: { from: saved.pins, to: stackVmPinsOn(place.cloud) } }
        : {}),
      lines,
      ...(asked.native
        ? byCloud<Pick<StackVmChange, 'native' | 'nativeGcp'>>(place.cloud, {
            aws: { native: asked.native },
            gcp: { nativeGcp: asked.native },
          })
        : {}),
    },
  };
}

/** The cloud block a stack's entry lays on its Stack VM, or `undefined`. */
export function stackVmNativeOf(
  entry: ComposeEntry,
  cloud: CloudKind,
): Readonly<Record<string, Record<string, unknown>>> | undefined {
  return laidBlock(entry, cloud);
}
