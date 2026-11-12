import type { TabSubject } from "../tab-registry";

/**
 * Why a Service has no **Shell** tab, shared by the three service
 * scopes because the reasons are the Service's, not its kind's.
 *
 * - **A Cloud account.** A Service there runs no container Cloudgate can
 *   `docker exec` into: its copies are the cloud's (an Application's
 *   `cloudPlace`, a database's `cloudAccountId`).
 * - **A role without `service:update`.** A shell writes inside the workload,
 *   so the socket asks for that action (ADR-0008, as amended) and
 *   would refuse anyone else. `shellAllowed` is `false` only when the role is
 *   known not to hold it.
 *
 * `noun` is what the Service is called in the sentence: "Application",
 * "database", "Compose stack".
 */
export function noShell(noun: string) {
  return (subject: TabSubject): string | null => {
    if (subject.cloudPlace != null || subject.cloudAccountId != null) {
      return `Only a Service on a Server or on this host has a Shell tab. This ${noun} runs in a Cloud account, so there is no container of it to open a shell in.`;
    }
    if (subject.shellAllowed === false) {
      return `Your role in this Organization cannot open a shell in this ${noun}: a shell writes inside it, which takes the update action on Services. Ask an owner or an admin to do it, or to change your role.`;
    }
    return null;
  };
}
