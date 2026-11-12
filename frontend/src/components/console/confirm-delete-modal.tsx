import { useRef, useState } from "react";

import { Field, FormError } from "@/components/console/field";
import { Modal } from "@/components/console/modal";
import { Button } from "@/components/ui/button";
import { PendingIcon } from "@/components/console/submit-button";
import { Input } from "@/components/ui/input";
import { errorMessage } from "@/lib/api/error-message";
import { workloadKeptBy } from "@/lib/api/endpoints/teardown";

/**
 * **Destroying one of the six named things, once** (F19).
 *
 * `DeleteResourceModal` already covers the small, recoverable row — a mount, a
 * schedule, a registry — and argues at length why it asks for *no* typed name.
 * This is the other half: a Project, an Environment, an Application's stack, a
 * database, a Server. F19 found five of these written out by hand, and the
 * problem was not that they looked different.
 *
 * They had **drifted on exactly the parts that decide whether a confirmation
 * works**, and `delete-server-modal.tsx` had drifted on all four at once:
 *
 * 1. **The typed name is cleared when the dialog closes.** Four of the five did
 *    this; the Server's did not. So closing a Server delete with the name typed
 *    and reopening it showed a dialog whose confirmation was **already
 *    satisfied** — a `dngr` button live on first paint, which is precisely the
 *    single mis-aimed click the typed name exists to prevent.
 * 2. **The refusal stays in the dialog.** `DeleteResourceModal` and `DangerZone`
 *    both state this rule and both give the same reason: the dialog is where the
 *    decision was made and it is still open, so a corner notification about a box
 *    you are looking at is one you have to go and find. The Server's sent its
 *    refusal to a toast and left the dialog open saying nothing. And it stays
 *    **in the footer**, beside the button: these bodies are long, the
 *    dialog scrolls under a sticky footer, and a refusal placed after the body
 *    rendered behind that footer — in the dialog, and still not seen.
 * 3. **There is a `form`, so Return submits.** Four had one. The Server's hung
 *    its action on the button's `onClick`, so the key you press after typing a
 *    name into a single text box did nothing.
 * 4. **A wrong name is an error on the field, not a hint under it.** A hint reads
 *    the same before and after you have got it wrong.
 *
 * None of those is visible in a screenshot, which is how five dialogs disagreed
 * about them for eleven phases.
 *
 * ## What stays with the caller
 *
 * The body. Every one of these dialogs earns its length by naming a consequence
 * only it knows — the Environments that cascade, the volume that survives, the
 * containers that keep running on a machine Cloudgate is about to forget. That
 * is the part worth writing five times. The machinery around it is not.
 *
 * ## Two later rules
 *
 * **First focus is the typed name**. Base UI focuses the first
 * tabbable element by default, and in the Compose dialog that was the
 * "Delete its volumes too" switch: one Space and the teardown took the data.
 * The field is the one control here that cannot destroy anything.
 *
 * **A Server Delete that kept the row can be forced from here**. When
 * the backend could not confirm the workload gone it answers 409 with a code
 * (`workloadKeptBy`), and the only way past that was a query parameter no
 * control sent. A caller that passes `forceRemove` gets a second step in the
 * same dialog: its own sentence for why it was kept, what forcing leaves
 * behind, and "Remove from Cloudgate anyway". A cloud Delete does not pass it:
 * its row stays by rule, with Retry and Forget (ADR-0038).
 */
export function ConfirmDeleteModal({
  open,
  onOpenChange,
  title,
  description = "This cannot be undone.",
  /** The exact string that has to be typed — the thing's own name. */
  confirmWord,
  /** What a wrong entry says: "That does not match the Project's name." */
  mismatch,
  /** The `dngr` button, in both the row that opened this and here. */
  button,
  /** Runs it. Throws to show the refusal in place. */
  onConfirm,
  forceRemove,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  confirmWord: string;
  mismatch: string;
  button: string;
  onConfirm: () => Promise<void>;
  /**
   * The second step after a Server Delete kept the row: what forcing
   * leaves behind, in the caller's words, and the forced Delete itself.
   */
  forceRemove?: {
    leftBehind: React.ReactNode;
    onConfirm: () => Promise<void>;
  };
  children: React.ReactNode;
}) {
  const [typed, setTyped] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const [kept, setKept] = useState<"present" | "unknown" | null>(null);
  // Which button is in flight, so only that one shows the spinner.
  const [inFlight, setInFlight] = useState<"delete" | "force" | null>(null);
  const running = inFlight !== null;
  const field = useRef<HTMLInputElement>(null);

  const confirmed = typed.trim() === confirmWord;

  async function run(action: () => Promise<void>, forcing: boolean) {
    if (!confirmed || running) return;
    setRefusal(null);
    setInFlight(forcing ? "force" : "delete");
    try {
      await action();
      // The caller closes on its own terms — several of these navigate away
      // afterwards, and closing here first would unmount mid-push.
    } catch (error) {
      const why = forceRemove && !forcing ? workloadKeptBy(error) : null;
      if (why) {
        setKept(why);
      } else {
        setRefusal(errorMessage(error));
      }
    } finally {
      setInFlight(null);
    }
  }

  function submit(event: React.SubmitEvent) {
    event.preventDefault();
    void run(onConfirm, false);
  }

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        setTyped("");
        setRefusal(null);
        setKept(null);
        onOpenChange(next);
      }}
      initialFocus={field}
    >
      <Modal.Header title={title} description={description} />
      <form method="post" noValidate onSubmit={submit}>
        <Modal.Body>
          {children}

          <Field
            name="confirm"
            label={`Type ${confirmWord} to confirm`}
            error={typed !== "" && !confirmed ? mismatch : undefined}
          >
            <Input
              ref={field}
              value={typed}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setTyped(event.target.value)}
            />
          </Field>
        </Modal.Body>
        <Modal.Footer>
          {/* In the sticky footer, on its own row above the buttons.
              At the end of the body it sat behind this footer whenever the
              caller's reading was long — the Server's is — so the press
              appeared to do nothing. Here it is on screen whenever the button
              that was pressed is. */}
          {kept && forceRemove ? (
            <KeptStep why={kept} leftBehind={forceRemove.leftBehind} />
          ) : null}
          <FormError message={refusal ?? undefined} className="basis-full" />
          <Modal.Gap />
          <Modal.Close render={<Button type="button">Cancel</Button>} />
          <Button
            type="submit"
            variant={kept ? "gh" : "dngr"}
            disabled={!confirmed || running}
            aria-busy={running || undefined}
          >
            {inFlight === "delete" ? <PendingIcon /> : null}
            {kept ? "Delete again" : button}
          </Button>
          {kept && forceRemove ? (
            <Button
              type="button"
              variant="dngr"
              disabled={!confirmed || running}
              aria-busy={running || undefined}
              onClick={() => void run(forceRemove.onConfirm, true)}
            >
              {inFlight === "force" ? <PendingIcon /> : null}
              Remove from Cloudgate anyway
            </Button>
          ) : null}
        </Modal.Footer>
      </form>
    </Modal>
  );
}

/**
 * Why the row was kept, in the console's words rather than the backend's,
 * which name the API's force parameter; then what forcing leaves.
 */
function KeptStep({
  why,
  leftBehind,
}: {
  why: "present" | "unknown";
  leftBehind: React.ReactNode;
}) {
  return (
    <div className="flex basis-full flex-col gap-2">
      <FormError
        message={
          why === "present"
            ? "Docker still reports it on its Server, so it was kept. Stop it, or wait for it to shut down, then delete again, or remove it from Cloudgate anyway."
            : "Cloudgate could not reach its Server to confirm it is gone, so it was kept. Delete again once the Server is reachable, or remove it from Cloudgate anyway."
        }
      />
      <div className="text-meta text-tx-2">{leftBehind}</div>
    </div>
  );
}
