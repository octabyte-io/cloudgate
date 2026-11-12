import { Modal } from "@/components/console/modal";
import { Button } from "@/components/ui/button";
import type { Agent } from "@/lib/api/endpoints/agents";

import { ConnectPanel } from "./connect-panel";

/**
 * The row's Connect action: the reveal's snippets again, for a second machine.
 *
 * **It cannot show the key, and says so first.** Cloudgate keeps a hash, so
 * the one thing an operator who lost the key needs from here is where the new
 * one comes from — Add key, on the same row — not a hunt for a Reveal button
 * that cannot exist.
 */
export function ConnectAgentModal({
  agent,
  open,
  onOpenChange,
}: {
  agent: Agent;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Modal open={open} onOpenChange={onOpenChange} wide>
      <Modal.Header
        title={`Connect ${agent.name}`}
        description={`Configuration for a coding client that will act as ${agent.name}, with one of its keys.`}
      />
      <Modal.Body>
        <p className="rounded-lg border border-warn-line bg-warn-tint px-3.5 py-2.5 text-meta text-tx">
          A key can’t be recovered: Cloudgate keeps only a hash of it. If you no
          longer have one, use <strong className="font-medium">Add key</strong>{" "}
          on {agent.name}’s row to make a new one.
        </p>
        <ConnectPanel />
      </Modal.Body>
      <Modal.Footer>
        <Modal.Gap />
        <Modal.Close render={<Button type="button">Done</Button>} />
      </Modal.Footer>
    </Modal>
  );
}
