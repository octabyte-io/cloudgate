import type {
  MachineTable,
  MachineType,
} from '../aws/definitions/database-class';
import type { SizeName } from '../../project-config/format/config-size';
import type { NativeAwsBlock } from '../../native/aws-native';
import type { NativeGcpBlock } from '../../native/gcp-native';
import type { StackVmPins } from './stack-vm-pins';

/**
 * **A Stack VM, whatever its cloud** (ADR-0070): what every cloud's Stack VM
 * shares, and the one shape each cloud fills in for the planner. A cloud
 * that makes Stack VMs adds its own {@link StackVmCloud} beside AWS's
 * (`aws/definitions/stack-vm-machines.ts`), and nothing here changes.
 */

/** The size a stack with none starts at (ADR-0070 "Machine"). */
export const STACK_VM_DEFAULT_SIZE: SizeName = 'medium';

/** The data disk a Stack VM starts with, which only grows (ADR-0070 "Data"). */
export const STACK_VM_DATA_DISK_GB = 20;

/** How many days the cloud keeps each daily snapshot of the data disk. */
export const STACK_VM_SNAPSHOT_DAYS = 7;

/** The hours a plan prices a month at: the clouds' own 730. */
export const HOURS_PER_MONTH = 730;

/**
 * What one region charges for a Stack VM's parts, in US dollars: each
 * machine type's hourly price, the data disk per GB-month and its
 * snapshots per GB-month. Coded, as a final backup's price and the
 * network's fixed costs are: the plan has no live price feed (#1357,
 * "Open point 2"). An estimate, and said as one.
 */
export interface StackVmRates {
  readonly machineHourlyUsd: Readonly<Record<string, number>>;
  readonly diskUsdPerGbMonth: number;
  readonly snapshotUsdPerGbMonth: number;
}

/** A Stack VM's monthly price, each part to the cent. */
export interface StackVmMonthly {
  readonly machineUsd: number;
  readonly diskUsd: number;
  /**
   * The daily snapshots' estimate: about one disk's worth, since each
   * snapshot after the first holds only what changed.
   */
  readonly snapshotsUsd: number;
  readonly totalUsd: number;
}

/** One cloud's Stack VMs, as the planner reads them. */
export interface StackVmCloud {
  /** What a plan line calls the cloud's price pages when it has no price. */
  readonly pricing: string;
  /** The machine types a size picks from, smallest first. */
  readonly machines: MachineTable;
  /** Every machine type a plan line can name with its CPU and memory, a native one included. */
  readonly known: readonly MachineType[];
  /** The rates of each region the table prices; a region missing has no price. */
  readonly rates: Readonly<Record<string, StackVmRates>>;
}

const cents = (usd: number) => Math.round(usd * 100) / 100;

/**
 * A Stack VM's monthly price in a region (ADR-0070 "Cost"): the machine at
 * its hourly price × 730, the data disk per GB-month and the snapshot
 * estimate; `null` when the rate table has no price for the region or
 * the machine type.
 */
export function stackVmMonthly(
  cloud: StackVmCloud,
  region: string,
  machineType: string,
  diskGb: number = STACK_VM_DATA_DISK_GB,
): StackVmMonthly | null {
  const rates = cloud.rates[region];
  const hourly = rates?.machineHourlyUsd[machineType];
  if (!rates || hourly === undefined) return null;
  const machineUsd = cents(hourly * HOURS_PER_MONTH);
  const diskUsd = cents(diskGb * rates.diskUsdPerGbMonth);
  const snapshotsUsd = cents(diskGb * rates.snapshotUsdPerGbMonth);
  return {
    machineUsd,
    diskUsd,
    snapshotsUsd,
    totalUsd: cents(machineUsd + diskUsd + snapshotsUsd),
  };
}

/**
 * A stack's Stack VM as its row keeps it (`compose.stack_vm`): what its
 * definition is written from, and what its Apply recorded of what it made.
 */
export interface StackVmSettings {
  /** The cloud's machine type it runs: the size's, or its `native`'s. */
  readonly machineType: string;
  /** The size it was planned at, when one picked the machine type. */
  readonly sizeName: SizeName | null;
  readonly dataDiskGb: number;
  readonly snapshotDays: number;
  /** Its entry's `native.aws`, checked, which every run lays. */
  readonly native?: NativeAwsBlock;
  /** On Google Cloud, its entry's `native.gcp`, checked, which every run lays. */
  readonly nativeGcp?: NativeGcpBlock;
  /**
   * What the stack page set (#1372): a console-managed stack's size, which
   * its plans size the Stack VM to as a described stack's entry `size`
   * does, and the data disk grown to, which never shrinks. Its next plan
   * shows the change; nothing here is applied until that plan is. Absent
   * until set.
   */
  readonly console?: {
    readonly sizeName?: SizeName;
    readonly dataDiskGb?: number;
  };
  /**
   * An approved "replace VM" its Cloud run is to make (#1368): the pins
   * the new Stack VM is made with. Set by the Apply that approved it, and
   * dropped once the run records the new Stack VM. Absent otherwise.
   */
  readonly replaceWith?: Required<StackVmPins>;
  /**
   * The image it was made from, and the Docker and compose pins its first
   * boot installed: recorded by the Apply that made it, `null` until then.
   */
  readonly made: {
    readonly imageId: string;
    readonly pins: StackVmPins;
    /** Its instance: the EC2 instance id, or the Compute Engine instance's name. */
    readonly instanceId: string;
    readonly privateIp: string;
    /** Its data disk: the EBS volume id, or the persistent disk's name. */
    readonly dataVolumeId: string;
    /**
     * The zone it and its data disk are in, which never moves: a replaced
     * Stack VM is made in it again, beside its disk. Recorded on Google
     * Cloud from the first, and on AWS since #1368.
     */
    readonly zone?: string;
  } | null;
  /**
   * On Google Cloud, the ports whose backend its last Domain run made in
   * its state (#1371): the network's URL map names only these, so a run of
   * the network never names a backend that is not there.
   */
  readonly routedPorts?: readonly number[];
}
