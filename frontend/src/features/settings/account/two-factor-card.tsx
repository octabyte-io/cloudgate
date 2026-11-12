import { useState } from "react";

import { Card } from "@/components/console/card";
import { CopyButton } from "@/components/console/copy-button";
import { QAList, QARow } from "@/components/console/qa-row";
import { StatusPill } from "@/components/console/status-pill";
import { Button } from "@/components/ui/button";
import type { UserProfile } from "@/lib/api/endpoints/users";

import { DisableTwoFactorModal } from "./disable-two-factor-modal";
import { EnrolTwoFactorModal } from "./enrol-two-factor-modal";

/**
 * Two-factor, which is really two states and one three-step enrolment.
 *
 * **The state is `user.twoFactorEnabled`, and it does not move when you press
 * "Turn on".** better-auth's `enableTwoFactor` mints a secret and hands back the
 * TOTP URI and the backup codes, and leaves the flag **false**; `verifyTOTP`
 * is what sets it (the port registers `twoFactor()` with no
 * `skipVerificationOnEnable`, which is the option that would collapse the two).
 * That is the right design — an account is not protected by a secret nobody has
 * successfully typed a code from — and it means the middle of the enrolment is a
 * real state: a secret exists, the codes have been shown once, and two-factor is
 * off. `EnrolTwoFactorModal` is built around that fact and says so at the point
 * where closing the dialog would throw the codes away.
 *
 * `verifyTOTP` also **rotates the session** — it deletes the current one and
 * issues a new cookie — which is exactly why these three routes go through
 * `users.controller.ts` rather than the auth client: Nest forwards the
 * `Set-Cookie`, and a call that did not would leave this browser holding a token
 * the server has already deleted.
 */
export function TwoFactorCard({ profile }: { profile: UserProfile }) {
  const [enrolling, setEnrolling] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const enabled = profile.twoFactorEnabled === true;

  return (
    <Card>
      <Card.Header
        title="Two-factor"
        sub="A code from an authenticator app, on top of your password."
        headingLevel={2}
        actions={
          // A `mark`, not a `status`: on and off are not `applicationStatus`
          // values, and borrowing `running` / `idle` would put a service's
          // vocabulary on an account setting. The escape hatch exists for
          // exactly this — a state whose words are its own.
          <StatusPill
            mark={
              enabled
                ? { glyph: "●", tone: "ok", label: "On" }
                : { glyph: "○", tone: "mute", label: "Off" }
            }
          />
        }
      />
      <Card.Body>
        <QAList>
          {enabled ? (
            <QARow
              title="Two-factor is on for this account"
              description="Signing in asks for a six-digit code after your password. A backup code works in its place."
              action={
                <Button
                  type="button"
                  size="sm"
                  variant="dngr"
                  onClick={() => setDisabling(true)}
                >
                  Turn off
                </Button>
              }
            />
          ) : (
            <QARow
              title="Turn on two-factor"
              description="You will scan a code into an authenticator app, save ten backup codes, and type one code back to prove it works."
              action={
                <Button
                  type="button"
                  size="sm"
                  variant="pri"
                  onClick={() => setEnrolling(true)}
                >
                  Turn on
                </Button>
              }
            />
          )}
        </QAList>
      </Card.Body>

      {/* Keyed so every opening mounts a fresh enrolment. F09's sixth defect:
          a dialog that stays mounted across a close keeps its state, and here
          that state is a *previous secret's* backup codes. */}
      {enrolling ? (
        <EnrolTwoFactorModal
          key="enrol"
          open
          onOpenChange={setEnrolling}
        />
      ) : null}
      {disabling ? (
        <DisableTwoFactorModal
          key="disable"
          open
          onOpenChange={setDisabling}
        />
      ) : null}
    </Card>
  );
}

/** Ten codes, laid out so they can be read across and copied in one go. */
export function BackupCodes({ codes }: { codes: string[] }) {
  return (
    <div className="rounded-lg border border-warn-line bg-warn-tint p-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-body font-medium text-tx">
          Save these backup codes now
        </p>
        <CopyButton value={codes.join("\n")} label="backup codes" />
      </div>
      <p className="mt-1 text-meta text-tx-2">
        Each one signs you in once if you lose the authenticator. This is the
        only time they are shown — closing this box does not bring them back.
      </p>
      <ul className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-ui text-tx sm:grid-cols-3">
        {codes.map((code) => (
          <li key={code} className="tabular-nums">
            {code}
          </li>
        ))}
      </ul>
    </div>
  );
}
