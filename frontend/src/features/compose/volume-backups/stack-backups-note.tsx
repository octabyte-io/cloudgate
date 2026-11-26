import { MetaStrip } from "@/components/console/meta-strip";

/**
 * The Volume backups list's notes on a Compose stack (#163): one sentence
 * each, in a strip of its own, and each shown only while it holds
 * (design-system rule 8).
 *
 * - **Always.** The Application's own note: a Deployment replaces the
 *   containers and leaves the volumes, so losing the Server loses them
 *   unless a backup has run.
 * - **A swarm `stack`.** A Swarm volume is local to each node, and the tar
 *   runs on the stack's Server, so a copy on any other node is never read
 *   (out of scope in spec #162).
 * - **Not deployed yet.** The service → volume picker is the record of the
 *   last successful deploy (`GET /compose/:id/volumes`), so before one it
 *   offers only Other volume; the backend's sentence says why.
 */
export function StackBackupsNote({
  swarm,
  unavailableReason,
}: {
  /** A swarm `stack`, rather than `docker-compose`. */
  swarm: boolean;
  unavailableReason: string | null;
}) {
  return (
    <>
      <MetaStrip>
        A Deployment leaves a volume where it is, so{" "}
        <strong>nothing else here copies one off its Server</strong>.
      </MetaStrip>
      {swarm ? (
        <MetaStrip>
          On a swarm stack, only the copy of a volume on this stack’s Server is
          backed up.
        </MetaStrip>
      ) : null}
      {unavailableReason ? <MetaStrip>{unavailableReason}</MetaStrip> : null}
    </>
  );
}
