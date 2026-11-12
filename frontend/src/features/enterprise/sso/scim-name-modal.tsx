import { useState } from "react";

import { Field } from "@/components/console/field";
import { Modal } from "@/components/console/modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorMessage } from "@/lib/api/error-message";

/** The first of the two states: name it. */
export function ScimNameModal({
  pending,
  onClose,
  onSubmit,
}: {
  pending: boolean;
  onClose: () => void;
  onSubmit: (providerId: string) => Promise<void>;
}) {
  const [providerId, setProviderId] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);

  return (
    <Modal open onOpenChange={(next) => !next && onClose()}>
      <Modal.Header
        title="Add a SCIM provider"
        description="You will be given a token once. Have somewhere to paste it before you continue."
      />
      <form
        method="post"
        noValidate
        onSubmit={async (event) => {
          event.preventDefault();
          if (pending) return;
          // Said under the field rather than by a disabled button.
          if (providerId.trim() === "") {
            setRefusal(
              "Name the provider, in lower case letters, numbers and dashes.",
            );
            return;
          }
          setRefusal(null);
          try {
            await onSubmit(providerId.trim());
          } catch (error) {
            setRefusal(errorMessage(error));
          }
        }}
      >
        <Modal.Body className="grid gap-3">
          <Field
            name="providerId"
            label="Provider id"
            error={refusal ?? undefined}
            hint="Lower case letters, numbers and dashes. It has to be unique across this whole instance, not only your Organization, and it cannot be changed — it becomes part of the token and part of every account it creates."
          >
            <Input
              value={providerId}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
              onChange={(event) => setProviderId(event.target.value)}
            />
          </Field>
        </Modal.Body>
        <Modal.Footer>
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="pri"
            disabled={pending}
            aria-busy={pending || undefined}
          >
            Create the token
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
