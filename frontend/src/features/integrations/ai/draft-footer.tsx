import { Modal } from "@/components/console/modal";
import { Button } from "@/components/ui/button";

/**
 * One action per step, and no action on the middle one — choosing a suggestion *is*
 * the step, so a button beside it would be a second way to do the same thing.
 *
 * Back is offered from step two onwards and unwinds exactly one decision, which is
 * why it clears the chosen suggestion before the list: a single Back that dropped
 * both would send somebody who wanted a different stack all the way to the prompt.
 */
export function DraftFooter({
  step,
  asking,
  deploying,
  canAsk,
  onBack,
  onAsk,
  onDeploy,
}: {
  step: number;
  asking: boolean;
  deploying: boolean;
  /** Long enough a prompt, and a provider to send it to. */
  canAsk: boolean;
  onBack: () => void;
  onAsk: () => void;
  onDeploy: () => void;
}) {
  return (
    <Modal.Footer>
      {step > 0 ? (
        <Button type="button" onClick={onBack}>
          Back
        </Button>
      ) : null}
      <Modal.Gap />
      <Modal.Close render={<Button type="button">Cancel</Button>} />
      {step === 0 ? (
        <Button
          type="button"
          variant="pri"
          onClick={onAsk}
          disabled={asking || !canAsk}
          aria-busy={asking || undefined}
        >
          {asking ? "Asking…" : "Ask for suggestions"}
        </Button>
      ) : step === 2 ? (
        <Button
          type="button"
          variant="pri"
          onClick={onDeploy}
          disabled={deploying}
          aria-busy={deploying || undefined}
        >
          Create this stack
        </Button>
      ) : null}
    </Modal.Footer>
  );
}
