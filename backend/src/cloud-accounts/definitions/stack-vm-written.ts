import type { CloudKind } from '../cloud-account.schema';
import type { TofuShowJson } from '../aws/plan-reader/tofu-show.types';
import type { StackVmChange } from '../../project-config/planner/plan.types';
import type { StackVmSettings } from './stack-vm';
import { stackVmPinsOn } from './stack-vm-pins';
import type { StackVmPins } from './stack-vm-pins';

/**
 * **What a Stack VM's definition is written from** (#1368), the same for
 * a plan's read and its Apply's Cloud run, whatever the cloud: the
 * stack's settings as the change leaves them.
 */

/**
 * A stack's Stack VM settings once a change is applied: the machine type,
 * size, data disk and cloud block the change moves to, and an approved
 * "replace VM"'s new pins. What the stack page set (`console`) stays: it
 * is the setting the next plan compares with again. What the Apply writes
 * to the row before its Cloud run, and what the plan's read writes the
 * definition from.
 */
export function stackVmSettingsAfter(
  settings: StackVmSettings,
  change: StackVmChange,
): StackVmSettings {
  return {
    made: settings.made,
    ...(settings.console ? { console: settings.console } : {}),
    machineType: change.machineType,
    sizeName: change.sizeName,
    dataDiskGb: change.dataDiskGb,
    snapshotDays: change.snapshotDays,
    ...(change.native ? { native: change.native } : {}),
    ...(change.nativeGcp ? { nativeGcp: change.nativeGcp } : {}),
    ...(change.replace ? { replaceWith: change.replace.to } : {}),
  };
}

/** What a Stack VM's definition is written with, from its settings. */
export interface StackVmWritten {
  readonly machineType: string;
  readonly dataDiskGb: number;
  readonly snapshotDays: number;
  /** Its recorded image; `null` to look up the pinned one, made anew. */
  readonly imageId: string | null;
  /** Its recorded zone; `null` before it is made. */
  readonly zone: string | null;
  /** What its first boot installs: the new pins on a replace, else its own. */
  readonly pins: StackVmPins;
  /** Whether its run makes it anew (`-replace`): an approved "replace VM". */
  readonly replace: boolean;
}

/**
 * A Stack VM's definition input from its settings: before it is made,
 * Cloudgate's pins now; once made, the image, zone and pins it was made
 * with, so nothing it runs moves unseen; on an approved replace, the new
 * pins and a fresh lookup of the pinned image, in the same zone, beside
 * the same data disk.
 */
export function stackVmWritten(
  settings: StackVmSettings,
  cloud: CloudKind,
): StackVmWritten {
  const { made, replaceWith } = settings;
  const replace = !!replaceWith && made !== null;
  return {
    machineType: settings.machineType,
    dataDiskGb: settings.dataDiskGb,
    snapshotDays: settings.snapshotDays,
    imageId: replace ? null : (made?.imageId ?? null),
    zone: made?.zone ?? null,
    pins: replaceWith ?? made?.pins ?? stackVmPinsOn(cloud),
    replace,
  };
}

/**
 * A plan that would make a Stack VM's data disk smaller than it is in the
 * cloud, as a disk grown by hand there reads: the size it is and the size
 * the plan asks for, or `null`. A data disk only grows (ADR-0070), so the
 * read refuses such a plan rather than show a shrink AWS refuses, or a
 * replace that loses the disk on Google Cloud.
 */
export function shrunkDataDisk(
  show: TofuShowJson,
  diskType: 'aws_ebs_volume' | 'google_compute_disk',
): { readonly fromGb: number; readonly toGb: number } | null {
  for (const change of show.resource_changes ?? []) {
    if (change.type !== diskType || change.mode === 'data') continue;
    const before = change.change.before as { size?: unknown } | null;
    const after = change.change.after as { size?: unknown } | null;
    if (
      typeof before?.size === 'number' &&
      typeof after?.size === 'number' &&
      after.size < before.size
    ) {
      return { fromGb: before.size, toGb: after.size };
    }
  }
  return null;
}

/** Why a read refuses a plan that would shrink a Stack VM's data disk. */
export function shrunkDataDiskReason(
  name: string,
  shrunk: { readonly fromGb: number; readonly toGb: number },
): string {
  return `${name}'s Stack VM data disk is ${shrunk.fromGb} GB in its cloud, larger than the ${shrunk.toGb} GB Cloudgate records, and a data disk never shrinks. Grow it to ${shrunk.fromGb} GB on the stack's page, then Check for changes`;
}

/**
 * Whether a plan of a Stack VM that exists would delete its data disk:
 * only its stack's Delete may, keeping a final snapshot (ADR-0070). A
 * change or a "replace VM" read that would is refused.
 */
export function losesDataDisk(
  show: TofuShowJson,
  diskType: 'aws_ebs_volume' | 'google_compute_disk',
): boolean {
  return (show.resource_changes ?? []).some(
    (change) =>
      change.type === diskType &&
      change.mode !== 'data' &&
      change.change.actions.includes('delete'),
  );
}

/**
 * Why a read refuses a change to a Stack VM that exists: a data disk
 * it would shrink or delete. `null` when the plan keeps it.
 */
export function dataDiskRefusal(
  name: string,
  show: TofuShowJson,
  diskType: 'aws_ebs_volume' | 'google_compute_disk',
): string | null {
  const shrunk = shrunkDataDisk(show, diskType);
  if (shrunk) return shrunkDataDiskReason(name, shrunk);
  if (losesDataDisk(show, diskType)) {
    return `${name}'s Stack VM data disk would be deleted by this change, so it is refused: only the stack's Delete removes it. Check for changes, and if it is still refused, say what changed it`;
  }
  return null;
}
