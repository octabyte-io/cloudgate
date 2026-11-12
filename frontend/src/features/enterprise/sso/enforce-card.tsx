import { useState } from "react";

import { Card } from "@/components/console/card";
import { Modal } from "@/components/console/modal";
import { QAList, QARow } from "@/components/console/qa-row";
import { Skeleton } from "@/components/console/skeleton";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import type { SsoProvider } from "@/lib/api/endpoints/sso";

import { useEnforceSso, useSetEnforceSso } from "./use-sso";

/**
 * The switch that removes password sign-in.
 *
 * **This is the most dangerous control in the console and it is not close.**
 * `enforceSSO` is a single `web_server_settings` row — instance-wide, every
 * Organization on this deployment — and F06's sign-in screen renders **no
 * password form at all** when it is on, not a disabled one. So turning it on
 * with a provider that does not actually work locks everybody out of a running
 * instance, including whoever pressed it, with no screen left to turn it back
 * off from.
 *
 * Three things follow, and each is doing a job:
 *
 * 1. **It confirms**, and the dialog says what it does rather than asking
 *    whether you are sure. `DangerZone`'s first rule — the consequence is read
 *    while deciding *and* while committing.
 * 2. **It refuses to turn on with no provider registered**, in place, with the
 *    reason. That is not a guess about intent: with no provider there is
 *    provably no way in, and `PATCH /sso/enforce` does not check.
 * 3. **It says the scope out loud.** The route delegates to
 *    `SettingsService.updateEnforceSso`, which takes **instance
 *    authority** — an owner or admin of the *instance* organization, not of
 *    whichever Organization the caller is acting in — with **no licence
 *    check**, the one control in the Enterprise group that works unlicensed.
 *    This once said "owner-or-admin", and the difference matters: the column is
 *    on the `webServerSettings` singleton, so the looser gate let any second
 *    licensed Organization's owner remove password sign-in for every
 *    Organization on the instance. The unlicensed half is unchanged, and is
 *    worse rather than better: an unlicensed instance answers `GET
 *    /sso/show-sign-in` with `false` (it reads `hasAnyValidLicense`), so the
 *    SSO button does not render either, and enforcement with no button is a
 *    door with no handles.
 */
export function EnforceCard({ providers }: { providers: SsoProvider[] }) {
  const enforced = useEnforceSso();
  const setEnforced = useSetEnforceSso();
  const [confirming, setConfirming] = useState(false);

  const on = enforced.data?.enforced === true;
  const blocked = !on && providers.length === 0;

  async function apply(next: boolean) {
    try {
      await setEnforced.mutateAsync(next);
      toast.done(
        next
          ? "Password sign-in is off. Everyone signs in through an identity provider now."
          : "Password sign-in is back on.",
      );
    } catch (error) {
      toast.error(error);
    }
  }

  return (
    <>
      <Card>
        <Card.Header
          title="How people sign in"
          sub="This one is instance-wide — it applies to every Organization on this deployment, not only yours."
          headingLevel={2}
        />
        <Card.Body>
          <QAList>
            <QARow
              title="Require single sign-on"
              description={
                blocked
                  ? "No provider is registered yet, so turning this on would leave nobody a way in. Add one first."
                  : "The sign-in screen stops offering a password form — it is not disabled, it is not rendered. Anyone without an account at one of your identity providers cannot get in, including you."
              }
              action={
                enforced.isPending ? (
                  <Skeleton className="h-4.5 w-8 rounded-pill" />
                ) : (
                  <Switch
                    checked={on}
                    disabled={setEnforced.isPending || blocked}
                    aria-label="Require single sign-on for everyone on this instance"
                    onCheckedChange={(next) => {
                      // Turning it *off* restores a way in and needs no
                      // ceremony. Turning it on removes one.
                      if (next) setConfirming(true);
                      else void apply(false);
                    }}
                  />
                )
              }
            />
          </QAList>
        </Card.Body>
      </Card>

      {confirming ? (
        <Modal open onOpenChange={(next) => !next && setConfirming(false)}>
          <Modal.Header
            title="Turn off password sign-in for everyone?"
            description="This applies to every Organization on this instance."
          />
          <Modal.Body className="grid gap-3">
            <div className="rounded-lg border border-bad-line bg-bad-tint p-3 text-ui text-tx">
              The sign-in screen will offer no password form at all. Everyone —
              including you, and including members of other Organizations on
              this deployment — signs in through an identity provider or not at
              all.
            </div>
            <p className="text-body text-tx-2">
              Before you do it, sign in through{" "}
              {providers.length === 1 ? (
                <strong className="font-medium text-tx">
                  {providers[0].providerId}
                </strong>
              ) : (
                "one of your providers"
              )}{" "}
              in another browser and confirm it works. If it does not, the way
              back is a database change — nothing in the console can turn this
              off once nobody can sign in.
            </p>
          </Modal.Body>
          <Modal.Footer>
            <Button type="button" onClick={() => setConfirming(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="dngr"
              disabled={setEnforced.isPending}
              aria-busy={setEnforced.isPending || undefined}
              onClick={async () => {
                await apply(true);
                setConfirming(false);
              }}
            >
              Require single sign-on
            </Button>
          </Modal.Footer>
        </Modal>
      ) : null}
    </>
  );
}
