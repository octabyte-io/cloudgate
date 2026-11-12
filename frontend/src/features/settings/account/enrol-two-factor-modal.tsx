import { useState } from "react";

import { CopyButton } from "@/components/console/copy-button";
import { Field, FormError } from "@/components/console/field";
import { Modal } from "@/components/console/modal";
import { PasswordInput } from "@/components/console/password-input";
import { QrCode } from "@/components/console/qr-code";
import { Stepper } from "@/components/console/stepper";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorMessage } from "@/lib/api/error-message";
import { usersApi, type TwoFactorEnrollment } from "@/lib/api/endpoints/users";
import { useInvalidate } from "@/lib/api/use-invalidate";
import { BackupCodes } from "./two-factor-card";

/**
 * Turning two-factor on, in the three steps the backend actually has.
 *
 * The steps are not a presentation choice — they are the two requests plus the
 * one moment in between where the only copy of the backup codes is on screen:
 *
 * 1. **Your password.** `enableTwoFactor` refuses without it (better-auth's own
 *    `shouldRequirePassword`), which is right: someone who walked up to an
 *    unlocked laptop should not be able to bind an authenticator to the account.
 * 2. **The secret and the codes.** The response is the *only* time either is
 *    readable. Nothing stores the backup codes in plain text and no route hands
 *    them out again.
 * 3. **A code back.** Until this succeeds `user.twoFactorEnabled` is still
 *    **false** — the secret is stored and unverified, and signing out here would
 *    leave the account exactly as it was, minus ten codes nobody wrote down.
 *
 * **Step 2 is why this dialog does not dismiss on a click outside.** Every other
 * modal in the console does, because every other one is recoverable. Losing this
 * one costs the codes.
 *
 * The paste rule is F06's, and it is paid for here too: authenticator apps show
 * the code as `902 112`, people copy what they see, and a strict six-digit field
 * would reject the thing the app told them to type. Spaces come out before the
 * code goes anywhere.
 */
export function EnrolTwoFactorModal({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const invalidate = useInvalidate();
  const [enrolment, setEnrolment] = useState<TwoFactorEnrollment | null>(null);
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const step = enrolment === null ? 0 : 1;

  async function begin(event: React.SubmitEvent) {
    event.preventDefault();
    if (pending) return;
    setRefusal(null);
    setPending(true);
    try {
      setEnrolment(await usersApi.enableTwoFactor(password));
      setPassword("");
    } catch (error) {
      setRefusal(errorMessage(error));
    } finally {
      setPending(false);
    }
  }

  async function finish(event: React.SubmitEvent) {
    event.preventDefault();
    if (pending) return;
    setRefusal(null);
    setPending(true);
    try {
      // The app renders it as "902 112" and that is what gets pasted. F06 paid
      // for this once already.
      await usersApi.verifyTwoFactor(code.replace(/\s+/g, ""));
      toast.done("Two-factor is on for your account.");
      await invalidate.session();
      onOpenChange(false);
    } catch (error) {
      setRefusal(errorMessage(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      // Once the codes are on screen there is no second chance to read them, so
      // from that step on a click outside stops closing this dialog. Escape and
      // the close button still do — see `Modal`'s `keepOpen`.
      keepOpen={enrolment !== null}
    >
      <Modal.Header
        title="Turn on two-factor"
        description="Two steps, and the second one is the one to slow down for."
      />

      <Modal.Body>
        {/* Two steps, not three, though the brief names three things. Scanning
            the code, saving the backup codes and typing a code back all happen
            on one panel and in one sitting, and a stepper that counted them
            separately would promise two screens that do not exist. */}
        <Stepper
          label="Turning on two-factor"
          steps={[
            { id: "password", label: "Confirm it is you", done: step > 0 },
            { id: "scan", label: "Scan, save and confirm" },
          ]}
          currentId={step === 0 ? "password" : "scan"}
        />

        {enrolment === null ? (
          <form noValidate id="two-factor-begin" method="post" onSubmit={begin}>
            <Field
              name="password"
              label="Your password"
              hint="Binding an authenticator to this account needs it."
              error={undefined}
            >
              <PasswordInput
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </Field>
          </form>
        ) : (
          <div className="grid gap-3.5">
            <div className="flex flex-wrap items-start gap-4">
              <QrCode
                value={enrolment.totpURI}
                label="Scan this with your authenticator app"
                className="flex-none"
              />
              <div className="min-w-0 flex-1 basis-52">
                <p className="text-body text-tx">
                  Scan this with an authenticator app.
                </p>
                <p className="mt-1 text-meta text-tx-2">
                  If the camera cannot see the screen, add the account by hand
                  with the setup key below.
                </p>
                <div className="mt-2.5 flex items-center gap-1.5">
                  <code className="min-w-0 flex-1 truncate rounded-md bg-panel-2 px-2 py-1.5 font-mono text-ui text-tx">
                    {secretOf(enrolment.totpURI)}
                  </code>
                  <CopyButton
                    value={secretOf(enrolment.totpURI)}
                    label="setup key"
                  />
                </div>
              </div>
            </div>

            <BackupCodes codes={enrolment.backupCodes} />

            <form noValidate id="two-factor-finish" method="post" onSubmit={finish}>
              <Field
                name="code"
                label="The six-digit code from the app"
                hint="Two-factor is not on until this is accepted."
              >
                <Input
                  value={code}
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  placeholder="000000"
                  onChange={(event) => setCode(event.target.value)}
                />
              </Field>
            </form>
          </div>
        )}

        <FormError message={refusal ?? undefined} />
      </Modal.Body>

      <Modal.Footer>
        <Modal.Gap />
        <Button type="button" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        {enrolment === null ? (
          <Button
            type="submit"
            form="two-factor-begin"
            variant="pri"
            disabled={password === "" || pending}
            aria-busy={pending || undefined}
          >
            Continue
          </Button>
        ) : (
          <Button
            type="submit"
            form="two-factor-finish"
            variant="pri"
            disabled={code.trim() === "" || pending}
            aria-busy={pending || undefined}
          >
            Turn on two-factor
          </Button>
        )}
      </Modal.Footer>
    </Modal>
  );
}

/**
 * The shared secret out of an `otpauth://` URI.
 *
 * Shown because a QR code is useless on the machine you are already reading it
 * on — enrolling a desktop password manager, or a phone whose camera cannot see
 * a screen, means typing the key. `URLSearchParams` rather than a regex, because
 * the URI is a URL and the parameter order is the issuer's business.
 */
function secretOf(totpUri: string): string {
  try {
    return new URL(totpUri).searchParams.get("secret") ?? totpUri;
  } catch {
    return totpUri;
  }
}
