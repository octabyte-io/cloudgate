import { Modal } from "@/components/console/modal";
import { Button } from "@/components/ui/button";

/**
 * One action per step, and the last one is `dngr` — the only place in this flow
 * where the button's colour is the warning.
 */
export function RestoreFooter({
  step,
  ready,
  named,
  confirmed,
  running,
  onBack,
  onNext,
}: {
  step: "file" | "target" | "confirm";
  /** A dump and a destination are both in hand. */
  ready: boolean;
  named: boolean;
  confirmed: boolean;
  running: boolean;
  onBack: () => void;
  onNext: () => void;
}) {
  return (
    <Modal.Footer>
      {step !== "file" ? (
        <Button type="button" onClick={onBack}>
          Back
        </Button>
      ) : null}
      <Modal.Gap />
      <Modal.Close render={<Button type="button">Cancel</Button>} />
      {step === "file" ? (
        <Button type="button" variant="pri" disabled={!ready} onClick={onNext}>
          Continue
        </Button>
      ) : step === "target" ? (
        <Button type="button" variant="pri" disabled={!named} onClick={onNext}>
          Continue
        </Button>
      ) : (
        <Button
          type="submit"
          variant="dngr"
          disabled={!confirmed || running}
          aria-busy={running || undefined}
        >
          Replace the contents
        </Button>
      )}
    </Modal.Footer>
  );
}
