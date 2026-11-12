import type { ServerAudit } from "@/lib/api/endpoints/servers";
import type { Tone } from "@/lib/design/status";

/**
 * **What the readiness script found, as findings rather than as booleans.**
 *
 * `GET /servers/:id/audit` answers with six facts about the host, and a screen that
 * rendered them as six ticks and crosses would be accurate and useless: a cross
 * beside "isNetworkInstalled" tells an operator nothing they can act on. So each
 * fact becomes a finding that says three things — what was checked, what the answer
 * means, and **what to do about it** — which is the phase brief's instruction for
 * this tab and the standing rule about errors saying how to fix them.
 *
 * The split between the two tabs is the brief's: the four facts about *what setup
 * installed* are Infrastructure's, and the two about *what the SSH user is allowed
 * to do* are Access's. One query, two readings, one cache key.
 *
 * Almost every fix is the same one — **run setup** — and that is worth saying
 * rather than hiding, because it is the actual answer and the script is idempotent:
 * every step in `serverSetupCommand` checks before it acts. The two that setup
 * cannot fix are the two about privilege, and those are the ones where the sentence
 * has to be different.
 */

export type AuditFinding = {
  /** What was checked, as a thing rather than a field name. */
  title: string;
  /** The answer, in the shortest true form. Shown beside the title. */
  reading: string;
  /** `ok` when the host is ready; `warn` or `bad` when it is not. */
  tone: Tone;
  /** What this means and what to do. Absent when there is nothing to do. */
  fix?: string;
};

/** The four facts about what setup put on the machine. */
export function installationFindings(audit: ServerAudit): AuditFinding[] {
  const dockerVersion =
    audit.docker.version && audit.docker.version !== "0.0.0"
      ? audit.docker.version
      : null;

  return [
    {
      title: "Docker",
      reading: audit.docker.enabled
        ? (dockerVersion ?? "installed, version unknown")
        : "not installed",
      tone: audit.docker.enabled ? "ok" : "bad",
      fix: audit.docker.enabled
        ? undefined
        : "Nothing can be deployed here until Docker is on the machine. Run setup — it installs Docker from get.docker.com — or install it yourself and check again.",
    },
    {
      title: "Swarm",
      reading: audit.isSwarmActive ? "active" : "not initialised",
      tone: audit.isSwarmActive ? "ok" : "bad",
      // Every service Cloudgate deploys is a Swarm service, so this one is not a
      // nicety: `docker service create` fails outright without it.
      fix: audit.isSwarmActive
        ? undefined
        : "Cloudgate deploys Swarm services, so a Server with no Swarm cannot run anything. Run setup to do `docker swarm init` on this host.",
    },
    {
      title: "Overlay network",
      reading: audit.isNetworkInstalled
        ? "cloudgate-network is present"
        : "cloudgate-network is missing",
      tone: audit.isNetworkInstalled ? "ok" : "bad",
      fix: audit.isNetworkInstalled
        ? undefined
        : "Services join this network so they can reach each other and Traefik can reach them. Run setup to create it as an attachable overlay.",
    },
    {
      title: "Platform directory",
      reading: audit.isMainDirectoryInstalled
        ? "/etc/cloudgate exists"
        : "/etc/cloudgate is missing",
      tone: audit.isMainDirectoryInstalled ? "ok" : "warn",
      fix: audit.isMainDirectoryInstalled
        ? undefined
        : "Cloudgate keeps build logs, cloned code and Traefik's own configuration here. Run setup to create it and hand it to the SSH user.",
    },
  ];
}

/** The two facts about what the SSH user may do. Setup cannot fix either. */
export function privilegeFindings(audit: ServerAudit): AuditFinding[] {
  const root = audit.privilegeMode === "root";
  const sudo = audit.privilegeMode === "sudo";

  return [
    {
      title: "Privilege",
      reading: root
        ? "signing in as root"
        : sudo
          ? "passwordless sudo"
          : "neither root nor sudo",
      tone: root || sudo ? "ok" : "bad",
      // The setup script's own first act is to check this and `exit 1`, so this is
      // the finding that decides whether the rest of the tab can be acted on.
      fix:
        root || sudo
          ? undefined
          : "Setup refuses to run without one of the two — its first check exits when the user is not root and `sudo -n true` fails. Either point this Server at root, or give this user passwordless sudo on the machine.",
    },
    {
      title: "Docker group",
      reading: audit.isDockerGroupMember ? "a member" : "not a member",
      tone: audit.isDockerGroupMember ? "ok" : root ? "ok" : "warn",
      fix:
        audit.isDockerGroupMember || root
          ? undefined
          : "Every docker command Cloudgate runs here goes through sudo instead, which works but leaves files owned by root. `usermod -aG docker <user>` on the machine, then sign the session out and in.",
    },
  ];
}

/** Is this host ready to take a deployment? The three findings that must be `ok`. */
export function isReady(audit: ServerAudit): boolean {
  return (
    audit.docker.enabled && audit.isSwarmActive && audit.isNetworkInstalled
  );
}
