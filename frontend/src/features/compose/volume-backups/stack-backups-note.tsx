import { MetaStrip } from "@/components/console/meta-strip";
import type { ComposeType } from "@/lib/api/endpoints/compose";

/**
 * The Volume backups list's note on a Compose stack (#163): one sentence
 * each, shown only while it holds.
 *
 * - **A swarm `stack`.** A Swarm volume is local to each node, and the tar
 *   runs on the stack's Server, so a copy on any other node is never read
 *   (out of scope in spec #162).
 * - **Not deployed yet.** The service → volume picker is the record of the
 *   last successful deploy (`GET /compose/:id/volumes`), so before one it
 *   offers only Other volume; the backend's sentence says why.
 */
export function StackBackupsNote({
  composeType,
  unavailableReason,
}: {
  composeType: ComposeType;
  unavailableReason: string | null;
}) {
  return (
    <MetaStrip className="grid gap-1">
      <p>
        A Deployment leaves a volume where it is, so{" "}
        <strong>nothing else here copies one off its Server</strong>.
      </p>
      {composeType === "stack" ? (
        <p>
          On a swarm stack, only the copy of a volume on this stack’s Server is
          backed up.
        </p>
      ) : null}
      {unavailableReason ? <p>{unavailableReason}</p> : null}
    </MetaStrip>
  );
}
