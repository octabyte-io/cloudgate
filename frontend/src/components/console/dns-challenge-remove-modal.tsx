import { useState } from "react";

import { FormError } from "@/components/console/field";
import { Modal } from "@/components/console/modal";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api/error-message";

/**
 * Remove a machine's DNS-01 setup.
 *
 * No typed name, on `DeleteResourceModal`'s argument: it is put back in a
 * minute from the card beside it. What it does say is what stops working,
 * because that is not visible from the card.
 *
 * **The refusal stays in the dialog, in the footer beside the button.** The
 * route answers 409 while anything on this machine still issues its
 * certificate through the resolver — an Application's previews with the
 * DNS-01 switch on, a Domain or forward auth naming `letsencrypt-dns` — and its
 * message names each, which is what tells the reader what to change first.
 */
export function DnsChallengeRemoveModal({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Runs the delete. Throws to show the refusal in place. */
  onConfirm: () => Promise<void>;
}) {
  const [refusal, setRefusal] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        setRefusal(null);
        onOpenChange(next);
      }}
    >
      <Modal.Header
        title="Remove the DNS-01 setup?"
        description="Traefik on this machine restarts without the letsencrypt-dns resolver."
      />
      <Modal.Body>
        <p className="text-body text-tx-2">
          The provider and its credentials are deleted, and the{" "}
          <code className="font-mono">letsencrypt-dns</code>{" "}
          resolver is taken out of this machine&rsquo;s <code className="font-mono">traefik.yml</code>.
          A certificate it issued is no longer renewed. It is refused while an
          Application&rsquo;s previews, a Domain or forward auth on this machine
          still names <code className="font-mono">letsencrypt-dns</code>; turn
          those off first. Domains using{" "}
          <code className="font-mono">letsencrypt</code> are not affected.
        </p>
      </Modal.Body>
      <Modal.Footer>
        <FormError message={refusal ?? undefined} className="basis-full" />
        <Modal.Gap />
        <Modal.Close render={<Button type="button">Keep it</Button>} />
        <Button
          type="button"
          variant="dngr"
          disabled={pending}
          aria-busy={pending || undefined}
          onClick={async () => {
            setRefusal(null);
            setPending(true);
            try {
              await onConfirm();
            } catch (error) {
              setRefusal(errorMessage(error));
            } finally {
              setPending(false);
            }
          }}
        >
          Remove DNS-01 setup
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
