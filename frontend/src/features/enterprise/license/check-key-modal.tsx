import { Modal } from "@/components/console/modal";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";

import { licensedFeaturesInline } from "../licensed-features";
import type { useValidateLicense } from "../use-license";

/**
 * **Checking a key can turn it off**, which is why it confirms first.
 *
 * `POST /license/validate` *writes the answer*: a `false` marks the row `invalid`
 * and the Organization loses its licensed sections. The refusal is honoured
 * immediately, because nothing else revalidates a key and a revoked one would
 * otherwise stay enabled. So this is a control with consequences, and the
 * dialog says what a `false` would cost — including the part that catches people out, that anyone
 * holding a custom role is denied every action until they are moved to a built-in
 * one.
 *
 * **Which is why a failed check has to say that nothing was recorded**
 * The dialog has
 * just promised that a refusal takes effect immediately and revokes four
 * sections, and the toast for every failure said only `Failed to validate
 * license key` — indistinguishable from the refusal that *does* revoke. The
 * reasonable reading was "my Organization is about to go dark", and it was
 * wrong.
 *
 * ## Only a *completed* check writes anything, and "refused" is said twice
 *
 * This is the trap in the wording, and it is worth reading the service before
 * editing either sentence. `LicenseService.validate` calls `callRemote` and runs
 * its `update` **after** it returns, so every rejection — unreachable, a
 * license-server error, *and* a non-ok body carrying the server's own refusal —
 * leaves the row untouched. Only `200 {"valid": false}` reaches the `update` and
 * marks the Organization unlicensed.
 *
 * So the licence server can say "no" in two wire shapes and Cloudgate honours
 * exactly one of them. Both surface here with the word *refused* in them — one
 * from `mutateAsync` resolving `false`, one from `LicenseApiClient`'s refusal
 * class — and only the first revokes. `"Nothing was recorded"` is therefore true
 * on **every** rejection including that second one, but true is not enough:
 * beside a line reading "the license server refused this license key" it reads
 * as a contradiction. What resolves it is naming the mechanism rather than
 * asserting the outcome — *the check did not complete*, which is why a refusal
 * that arrived as an error did not take effect.
 *
 * Three outcomes, three sentences: confirmed, refused-and-revoked, and
 * failed-and-unchanged. The first line of the last one is the backend's own
 * account of which failure it was, through `errorMessage()`; the description is
 * this screen's, because only this screen knows what it had just threatened.
 * `check-key-modal.test.tsx` pins all three apart, the refusal-shaped rejection
 * included.
 */
export function CheckKeyModal({
  validate,
  onClose,
}: {
  validate: ReturnType<typeof useValidateLicense>;
  onClose: () => void;
}) {
  return (
    <Modal open onOpenChange={(next) => !next && onClose()}>
      <Modal.Header
        title="Check this key with the license server?"
        description="This records the answer, so a refusal takes effect immediately."
      />
      <Modal.Body className="grid gap-3">
        <p className="text-body text-tx-2">
          Cloudgate asks the license server whether this key is still valid and{" "}
          <strong className="text-tx">records the answer</strong>.
        </p>
        <div className="rounded-lg border border-warn-line bg-warn-tint p-3 text-ui text-tx">
          If the license server says no, this Organization is marked unlicensed
          straight away — {licensedFeaturesInline()} all stop working, and
          anyone holding a custom role is denied every action until
          they are moved to a built-in one.
        </div>
      </Modal.Body>
      <Modal.Footer>
        <Button type="button" onClick={onClose}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="pri"
          disabled={validate.isPending}
          aria-busy={validate.isPending || undefined}
          onClick={async () => {
            try {
              const valid = await validate.mutateAsync();
              onClose();
              if (valid) {
                toast.done("The license server confirmed this key.");
              } else {
                toast.warn(
                  "The license server refused this key. This Organization is now unlicensed.",
                );
              }
            } catch (error) {
              toast.error(error, {
                description:
                  "The check did not complete, so nothing was recorded — this Organization's license is exactly as it was. Only a completed check marks it unlicensed.",
              });
            }
          }}
        >
          Check the key
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
