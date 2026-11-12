import type { Cloud, CloudAccount } from "@/lib/api/endpoints/cloud-accounts";
import type { Server } from "@/lib/api/endpoints/servers";
import type { DeployTargetRefusals } from "@/lib/api/endpoints/templates";

import {
  PLATFORM_HOST_VALUE,
  cloudAccountOf,
  deployTargetOptions,
} from "../environment/deploy-target";

/** One Deploy target a new Project's `production` Environment can be on. */
export interface NewProjectTarget {
  /** Its `deploy-target.ts` Picker value. */
  value: string;
  label: string;
  detail?: string;
  /** The Cloud account's cloud, whose region is asked; null off a cloud. */
  cloud: Cloud | null;
  /** Why it cannot take the template; null when it can. */
  reason: string | null;
}

/**
 * The Deploy targets the new-Project form offers (#1376): the ones the
 * Environment form offers, each with the setup form's answer for its kind,
 * so one that cannot take the template is greyed out with the reason.
 */
export function newProjectTargets(
  servers: readonly Server[] | undefined,
  cloudAccounts: readonly CloudAccount[] | undefined,
  refusals: DeployTargetRefusals,
  { platformHost }: { platformHost: boolean },
): NewProjectTarget[] {
  return deployTargetOptions(servers, cloudAccounts, { platformHost }).map(
    (option) => {
      const accountId = cloudAccountOf(option.value);
      const cloud =
        accountId === null
          ? null
          : ((cloudAccounts ?? []).find(
              (account) => account.cloudAccountId === accountId,
            )?.cloud ?? "aws");
      return {
        ...option,
        cloud,
        reason:
          cloud !== null
            ? refusals[cloud]
            : option.value === PLATFORM_HOST_VALUE
              ? refusals.platformHost
              : refusals.server,
      };
    },
  );
}
