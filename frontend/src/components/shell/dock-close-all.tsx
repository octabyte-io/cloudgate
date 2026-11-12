import { Modal } from "@/components/console/modal";
import { Button } from "@/components/ui/button";

/**
 * "Close N shells?" — closing the panel with more than one tab open ends every
 * one, so it asks first. One tab closes without asking, as it always did.
 * With logs among them it says tabs, and that the logs end too.
 */
export function DockCloseAll({
  open,
  count,
  logs = 0,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  /** Every tab, shells and logs. */
  count: number;
  /** How many of them are logs. */
  logs?: number;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const noun = logs > 0 ? "tabs" : "shells";
  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      {open ? (
        <>
          <Modal.Header
            title={`Close ${count} ${noun}?`}
            description={
              logs > 0
                ? "Every shell and log in the Dock ends, and anything running in the shells stops. To end only one, close its tab."
                : "Every shell in the Dock ends, and anything running in them stops. To end only one, close its tab."
            }
          />
          <Modal.Footer>
            <Modal.Gap />
            <Modal.Close render={<Button type="button">Cancel</Button>} />
            <Button type="button" variant="dngr" onClick={onConfirm}>
              {`Close ${count} ${noun}`}
            </Button>
          </Modal.Footer>
        </>
      ) : null}
    </Modal>
  );
}
