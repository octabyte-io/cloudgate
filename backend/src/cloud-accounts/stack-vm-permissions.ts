import {
  holdsStackVms as awsHoldsStackVms,
  setupNames,
  stackVmActionsMissing,
} from './aws/setup-template';
import type { CloudKind } from './cloud-account.schema';
import { byCloud } from './cloud-provider';
import type { PerCloud } from './cloud-provider';
import {
  holdsStackVms as googleHoldsStackVms,
  stackVmApisMissing,
  stackVmPermissionsMissing,
} from './gcp/deploy-role';

/**
 * **The Stack VM gap** (ADR-0070, #1366): a Cloud account whose role was
 * last checked at a version older than Stack VMs (AWS's policy version 4,
 * Google's role version 7) lacks what a Stack VM needs — the cloud's
 * tunnel and the right to make the VM, its disk, its snapshots and its
 * identity. One name and one fix for it, for the two places that say so:
 * the connect check ("Check now"), and a plan that would create a Stack VM
 * in that account, which it refuses rather than make a Stack VM Cloudgate
 * could never reach.
 *
 * Read from the version tables alone, as "permissions out of date" is:
 * nothing asks the cloud.
 */

/** The gap's name, as a sentence names it. */
export const STACK_VM_GAP: PerCloud<string> = {
  aws: 'the Stack VM permissions (Session Manager sessions to the Stack VMs Cloudgate marks, and making and removing a Stack VM with its volumes, daily snapshot policy, role and instance profile)',
  gcp: "the Stack VM permissions (IAP tunnelling to the Stack VMs, and making and removing a Stack VM with its disks, snapshot schedule and the network's Cloud Router)",
};

/** How an operator closes the gap, for this Cloud account (its tag value is its id). */
export function stackVmGapFix(
  cloud: CloudKind,
  cloudAccountId: string,
): string {
  return byCloud(cloud, {
    aws: () => {
      const name = setupNames({
        accountId: '',
        tagValue: cloudAccountId,
      }).deployStackVmPolicyName;
      return `Update the role from the Cloud account's new setup template, which adds them as the managed policy ${name}, then Check now`;
    },
    gcp: () =>
      "Run the Cloud account's new setup script in Cloud Shell, which updates the role and turns on IAP's API, then Check now",
  })();
}

/** Whether a role held to `version` holds what a Stack VM needs. */
export function holdsStackVms(cloud: CloudKind, version: number): boolean {
  return byCloud(cloud, { aws: awsHoldsStackVms, gcp: googleHoldsStackVms })(
    version,
  );
}

/**
 * What a role last checked at `checkedVersion` lacks for a Stack VM: the
 * actions (on Google Cloud, permissions, then the APIs that are off), or
 * an empty list when it holds them.
 */
export function stackVmPermissionsLacking(
  cloud: CloudKind,
  checkedVersion: number,
): string[] {
  return byCloud(cloud, {
    aws: () => stackVmActionsMissing(checkedVersion),
    gcp: () => [
      ...stackVmPermissionsMissing(checkedVersion),
      ...stackVmApisMissing(checkedVersion),
    ],
  })();
}
