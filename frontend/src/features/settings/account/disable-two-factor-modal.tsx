import { useState } from "react";

import { Field, FormError } from "@/components/console/field";
import { Modal } from "@/components/console/modal";
import { PasswordInput } from "@/components/console/password-input";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api/error-message";
import { usersApi } from "@/lib/api/endpoints/users";
import { useInvalidate } from "@/lib/api/use-invalidate";

/**
 * Turn two-factor off.
 *
 * **Not a `DangerZone` action, and the distinction is worth stating** because
 * this is the only weakening-your-own-security control in the phase that does
 * not get one. `DangerZone` is for actions that destroy something with no copy
 * anywhere; this destroys a *protection* and the account is otherwise untouched,
 * it is instantly reversible by enrolling again, and the password prompt is
 * already a stronger gate than a typed confirmation — a typed name proves you
 * read the dialog, a password proves you are the account holder, and only the
 * second one matters here.
 *
 * The backup codes go with the secret. Somebody who turns this off and back on
 * gets ten new ones, and the old sheet in their password manager is worthless —
 * which is worth saying here rather than being discovered later.
 *
 * **"Your remaining" and not a count**
 * It said "all
 * ten", which is true only until the first backup-code sign-in: each code works
 * once, so the sheet shrinks, and this dialog does not know by how much. What is
 * deleted is the `twoFactor` row, so whatever it still holds goes.
 */
export function DisableTwoFactorModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const invalidate = useInvalidate();
  const [password, setPassword] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: React.SubmitEvent) {
    event.preventDefault();
    if (pending) return;
    setRefusal(null);
    setPending(true);
    try {
      await usersApi.disableTwoFactor(password);
      toast.done("Two-factor is off for your account.");
      await invalidate.session();
      onOpenChange(false);
    } catch (error) {
      setRefusal(errorMessage(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <Modal.Header
        title="Turn off two-factor"
        description="Your password becomes the only thing between anyone and this account."
      />
      <form method="post" noValidate onSubmit={submit}>
        <Modal.Body>
          <div className="rounded-lg border border-warn-line bg-warn-tint px-3.5 py-3 text-body text-tx">
            The authenticator secret and your remaining backup codes are
            deleted. If you turn two-factor back on later you will scan a new
            code and get a new sheet — the one you saved will not work.
          </div>
          <Field
            name="password"
            label="Your password"
            hint="Turning it off needs it, the same way turning it on did."
          >
            <PasswordInput
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
          <FormError message={refusal ?? undefined} />
        </Modal.Body>
        <Modal.Footer>
          <Modal.Gap />
          <Modal.Close render={<Button type="button">Keep it on</Button>} />
          <Button
            type="submit"
            variant="dngr"
            disabled={password === "" || pending}
            aria-busy={pending || undefined}
          >
            Turn off two-factor
          </Button>
        </Modal.Footer>
      </form>
    </Modal>
  );
}
