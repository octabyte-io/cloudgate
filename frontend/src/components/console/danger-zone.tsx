import { useId, useState } from "react";

import { Card } from "@/components/console/card";
import { Field, FormError } from "@/components/console/field";
import { Modal } from "@/components/console/modal";
import { QAList, QARow } from "@/components/console/qa-row";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { PendingIcon } from "@/components/console/submit-button";
import { Input } from "@/components/ui/input";
import { errorMessage } from "@/lib/api/error-message";

/**
 * **One card for every action that destroys something, and one dialog shape
 * behind all of them** (F16).
 *
 * The phase brief asks for this by name, and the argument is not tidiness. F16
 * put eight irreversible controls on four screens — delete an Organization,
 * prune every unused Docker object, run every cleanup at once, restart the
 * instance on a new image, restart it on the same one, restart Traefik, drop the
 * deployment queue, remove the instance's SSH key (gone with the key itself)
 * — and the failure mode of writing eight dialogs is not that they look
 * different. It is that they end up
 * asking for **different amounts of care for the same amount of damage**, which
 * teaches the reader that the confirmation is decoration. Here the weight is
 * declared once, as data: an action either requires the thing's name typed or
 * it does not, and that decision sits beside every other one.
 *
 * ## The three rules the shape encodes
 *
 * 1. **The consequence is stated before the button, not after it.** Every row
 *    carries the sentence in the card, and the dialog repeats it in a `bad`-tinted
 *    block — because the row is what you read while deciding and the dialog is
 *    what you read while committing, and those are different moments.
 * 2. **Typed confirmation is for the irreversible, and only for it.**
 *    `delete-resource-modal.tsx` already argues the other half of this: requiring
 *    a typed name for something recoverable is how people learn to type names
 *    without reading them. So `confirm` is opt-in per action, and the ones that
 *    have it are the ones where there is no copy of the thing anywhere.
 * 3. **A control that cannot run says why, in place.** `unavailable` renders the
 *    reason on the row and turns the button off through `Button`'s `disabled`,
 *    which Base UI spells `aria-disabled` — F03's one inert rule, so it keeps its
 *    focus ring and its place in the tab order — and whose click it swallows.
 *    The button names the reason too, as its `title` and through
 *    `aria-describedby`, so "unavailable" is never heard without it. An update
 *    button on an up-to-date instance is the case this exists for: it would
 *    otherwise be a restart that sometimes silently does nothing.
 *
 * The refusal stays **in the dialog** rather than becoming a toast, on
 * `DeleteResourceModal`'s reasoning: the dialog is where the decision was made
 * and it is still open.
 */
export type DangerAction = {
  /** Stable across renders — it keys the row and the dialog. */
  id: string;
  /** What it does, as a thing you would do: "Delete this Organization". */
  title: React.ReactNode;
  /** What it costs, in one line, on the row. */
  description: React.ReactNode;
  /** The button on the row and in the dialog. Same words in both. */
  button: string;
  /**
   * What the dialog states before it acts. Defaults to `description`; pass this
   * when the dialog can say more than a row has space for — the Organization's
   * delete names its Projects, which is a list and not a line.
   */
  consequences?: React.ReactNode;
  /**
   * The line under the dialog's title. Defaults to "This cannot be undone.",
   * which is what nearly every action here is; pass this for one that
   * interrupts something rather than losing it — a restart.
   */
  caution?: React.ReactNode;
  /**
   * Require this exact string to be typed. Present only for actions with no
   * copy of the thing anywhere.
   */
  confirm?: {
    value: string;
    /** "Type <name> to confirm" is assembled from this. */
    noun: string;
  };
  /** Why this control cannot run right now. Renders it off, with the reason. */
  unavailable?: string;
  run: () => Promise<unknown>;
  /** The sentence in the toast afterwards. */
  done: string;
  onDone?: () => void;
};

export function DangerZone({
  actions,
  title = "Danger zone",
  sub,
}: {
  actions: DangerAction[];
  title?: string;
  sub?: React.ReactNode;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const open = actions.find((action) => action.id === openId) ?? null;

  return (
    <Card className="border-bad-line">
      <Card.Header title={title} sub={sub} headingLevel={2} />
      <Card.Body>
        <QAList>
          {actions.map((action) => (
            <DangerRow
              key={action.id}
              action={action}
              onOpen={() => setOpenId(action.id)}
            />
          ))}
        </QAList>
      </Card.Body>

      {/* One dialog, mounted at card level and keyed by the action. Keyed
          because `useState` inside it holds what was typed, and F09's sixth
          defect is exactly this: a dialog that stays mounted across a close
          keeps the previous attempt, so the next opening starts with somebody
          else's confirmation already satisfied. */}
      {open ? (
        <DangerModal
          key={open.id}
          action={open}
          open
          onOpenChange={(next) => {
            if (!next) setOpenId(null);
          }}
        />
      ) : null}
    </Card>
  );
}

function DangerRow({
  action,
  onOpen,
}: {
  action: DangerAction;
  onOpen: () => void;
}) {
  const reasonId = useId();
  const off = Boolean(action.unavailable);

  return (
    <QARow
      title={action.title}
      description={
        off ? (
          <>
            {action.description}{" "}
            <span id={reasonId} className="text-tx-3">
              {action.unavailable}
            </span>
          </>
        ) : (
          action.description
        )
      }
      action={
        <Button
          type="button"
          size="sm"
          variant="dngr"
          disabled={off}
          title={action.unavailable}
          aria-describedby={off ? reasonId : undefined}
          onClick={() => {
            if (off) return;
            onOpen();
          }}
        >
          {action.button}
        </Button>
      }
    />
  );
}

function DangerModal({
  action,
  open,
  onOpenChange,
}: {
  action: DangerAction;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [typed, setTyped] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const needsTyping = action.confirm !== undefined;
  const confirmed = !needsTyping || typed.trim() === action.confirm?.value;

  async function submit(event: React.SubmitEvent) {
    event.preventDefault();
    if (!confirmed || pending) return;
    setRefusal(null);
    setPending(true);
    try {
      await action.run();
      toast.done(action.done);
      onOpenChange(false);
      action.onDone?.();
    } catch (error) {
      setRefusal(errorMessage(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <Modal.Header
        title={action.button}
        description={action.caution ?? "This cannot be undone."}
      />
      <form method="post" noValidate onSubmit={submit}>
        <Modal.Body>
          <div className="rounded-lg border border-bad-line bg-bad-tint px-3.5 py-3 text-body text-tx">
            {action.consequences ?? action.description}
          </div>

          {action.confirm ? (
            <Field
              name="confirm"
              label={`Type ${action.confirm.value} to confirm`}
              error={
                typed !== "" && !confirmed
                  ? `That does not match the ${action.confirm.noun}.`
                  : undefined
              }
            >
              <Input
                value={typed}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                onChange={(event) => setTyped(event.target.value)}
              />
            </Field>
          ) : null}

          <FormError message={refusal ?? undefined} />
        </Modal.Body>
        <Modal.Footer>
          <Modal.Gap />
          <Modal.Close render={<Button type="button">Cancel</Button>} />
          <Button
            type="submit"
            variant="dngr"
            disabled={!confirmed || pending}
            aria-busy={pending || undefined}
          >
            {pending ? <PendingIcon /> : null}
            {action.button}
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
