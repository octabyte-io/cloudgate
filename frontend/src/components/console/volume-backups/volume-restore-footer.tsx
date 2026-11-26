import { Modal } from "@/components/console/modal";
import { Button } from "@/components/ui/button";

/**
 * One action per step, with the last one `dngr` because it unpacks a tarball **over**
 * a live volume.
 *
 * The Next buttons are `aria-disabled` rather than `disabled`: F03's inert rule keeps
 * them in the tab order with their reason on the step behind them, so somebody
 * arriving by keyboard finds out why rather than finding nothing.
 */
export function VolumeRestoreFooter({
  step,
  canLeaveChoose,
  canLeaveTarget,
  confirmed,
  pending,
  volumeName,
  onBack,
  onNext,
  onRestore,
}: {
  step: "choose" | "target" | "confirm";
  canLeaveChoose: boolean;
  canLeaveTarget: boolean;
  /** The volume's name has been typed back correctly. */
  confirmed: boolean;
  pending: boolean;
  volumeName: string;
  onBack: () => void;
  onNext: () => void;
  onRestore: () => void;
}) {
  return (
    <Modal.Footer>
      {step !== "choose" ? (
        <Button type="button" onClick={onBack}>
          Back
        </Button>
      ) : null}
      <Modal.Gap />
      <Modal.Close render={<Button type="button">Cancel</Button>} />

      {step === "choose" ? (
        <Button
          type="button"
          variant="pri"
          aria-disabled={!canLeaveChoose || undefined}
          onClick={() => canLeaveChoose && onNext()}
        >
          Next
        </Button>
      ) : null}

      {step === "target" ? (
        <Button
          type="button"
          variant="pri"
          aria-disabled={!canLeaveTarget || undefined}
          onClick={() => canLeaveTarget && onNext()}
        >
          Next
        </Button>
      ) : null}

      {step === "confirm" ? (
        <Button
          type="button"
          variant="dngr"
          aria-disabled={!confirmed || undefined}
          disabled={pending}
          aria-busy={pending || undefined}
          onClick={onRestore}
        >
          Replace {volumeName || "the volume"}
        </Button>
      ) : null}
    </Modal.Footer>
  );
}
