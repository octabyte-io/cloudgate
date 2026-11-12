import { useState } from "react";

import { FormError } from "@/components/console/field";
import { Modal } from "@/components/console/modal";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api/error-message";
import type { ApiKey } from "@/lib/api/endpoints/users";

import { useDeleteApiKey } from "./use-account";

/**
 * Revoke one key.
 *
 * No typed confirmation, on `delete-resource-modal.tsx`'s rule: revoking a key
 * destroys nothing but the key, and a new one is two clicks away. What the
 * dialog does say is the part people get wrong — the damage is to *whatever is
 * using it*, and that thing will not report a helpful error, it will start
 * getting 401s at three in the morning.
 */
export function DeleteApiKeyModal({
  apiKey,
  open,
  onOpenChange,
}: {
  apiKey: ApiKey | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const remove = useDeleteApiKey();
  const [refusal, setRefusal] = useState<string | null>(null);

  if (!apiKey) return null;
  const name = apiKey.name ?? "this key";

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        setRefusal(null);
        onOpenChange(next);
      }}
    >
      <Modal.Header
        title={`Revoke ${name}?`}
        description="It stops working immediately."
      />
      <Modal.Body>
        <p className="text-body wrap-anywhere text-tx-2">
          {/* `{" "}` on **both** sides of the inline element. F10, F11, F12 and
              F15 each paid for this once; the space before an element survives
              and the space after it does not, so the two look the same in the
              source and only one of them reaches the screen. */}
          Anything still using{" "}
          <strong className="font-medium text-tx">{name}</strong>{" "}
          starts being refused as soon as this is done — a pipeline, a cron, a
          script on somebody&rsquo;s machine. Nothing here can tell you which.
        </p>
        <FormError message={refusal ?? undefined} />
      </Modal.Body>
      <Modal.Footer>
        <Modal.Gap />
        <Modal.Close render={<Button type="button">Keep it</Button>} />
        <Button
          type="button"
          variant="dngr"
          disabled={remove.isPending}
          aria-busy={remove.isPending || undefined}
          onClick={async () => {
            setRefusal(null);
            try {
              await remove.mutateAsync(apiKey.id);
              toast.done(`${name} is revoked.`);
              onOpenChange(false);
            } catch (error) {
              setRefusal(errorMessage(error));
            }
          }}
        >
          Revoke key
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
