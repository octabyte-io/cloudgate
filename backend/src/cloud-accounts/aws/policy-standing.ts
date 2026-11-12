import { AWS_POLICY_VERSION, requiredActions } from './setup-template';

/** Whether a Cloud account's role is held to the policy this Cloudgate needs. */
export interface PolicyStanding {
  /** The policy version this Cloudgate generates and checks against. */
  currentPolicyVersion: number;
  /** True when the last passing check held the role to an older version. */
  permissionsOutOfDate: boolean;
  /** The actions the current version adds over the checked one; empty when up to date. */
  missingActions: string[];
}

/**
 * "Permissions out of date" (the AWS spec): a newer Cloudgate whose
 * policy version needs more actions than the one a Cloud account's role was
 * last checked against. Read from the version table alone, never from AWS:
 * nothing checks a Cloud account in the background, so this is
 * what the console can say before a use fails on a denied action.
 *
 * The missing actions are the current version's minus the checked one's,
 * which is exact because a shipped version is never edited
 * (`setup-template.ts`). An action a newer version *drops* is not reported:
 * the role holding more than it needs breaks nothing.
 *
 * `current` and `actionsOf` are parameters only so the comparison can be
 * tested before a second version exists.
 */
export function policyStanding(
  checkedVersion: number,
  current: number = AWS_POLICY_VERSION,
  actionsOf: (version: number) => string[] = requiredActions,
): PolicyStanding {
  if (checkedVersion >= current) {
    return {
      currentPolicyVersion: current,
      permissionsOutOfDate: false,
      missingActions: [],
    };
  }
  const held = new Set(actionsOf(checkedVersion));
  return {
    currentPolicyVersion: current,
    permissionsOutOfDate: true,
    missingActions: actionsOf(current).filter((action) => !held.has(action)),
  };
}
