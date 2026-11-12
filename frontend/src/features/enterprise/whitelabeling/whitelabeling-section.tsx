"use client";

import { Card } from "@/components/console/card";
import { useBranding } from "@/lib/api/use-branding";
import { useInstanceMode } from "@/lib/api/use-instance-mode";
import type { Gate } from "@/lib/auth/use-permission";
import { timeExact } from "@/lib/format/time";
import { useArrival } from "@/components/console/use-arrival";
import { cn } from "@/lib/utils";

import { SectionFailed, SectionPending } from "../../settings/section-states";
import { lapsedOn } from "../license-lapse";
import { LicenseGate } from "../license-gate";
import { useLicenseStatus } from "../use-license";
import { BrandingCards } from "./branding-cards";

/**
 * **Branding: white-labeling, from a screen**.
 *
 * The backend had it all along — `GET /settings/whitelabeling` public,
 * `PATCH` gated — and nothing in the console read or wrote it, so an instance
 * rebranded over the API looked exactly as before.
 *
 * ## The gate, and the two it cannot see
 *
 * `LicenseGate`, like Single sign-on and Forward auth, because unlicensed the
 * write is refused outright and there is nothing useful to show: the stored
 * branding is what every page already renders. It asks the question every
 * other lock asks — **this Organization's** licence.
 *
 * The backend asks two different ones: whether the caller holds
 * **instance** authority (an owner or admin of the instance organization), and
 * whether **the instance organization** is licensed. On a one-Organization
 * instance those are the same answers. On a wider one, the first is answered
 * in the console: `BrandingCards` turns every Save off, with the reason, once
 * `useInstanceGate`'s read has been refused — so a licensed owner of a second
 * Organization sees the form and why it is not theirs to save, rather than a
 * lock that would claim their licence is the problem when it is not. The
 * second has no read the console can ask — `GET /license/status` answers for
 * the active Organization only — so an instance administrator whose *active*
 * Organization is licensed while the instance organization is not is still
 * refused on save, with the backend's sentence through `useApiForm`'s root
 * error. The cards say whose save counts before anyone presses it.
 *
 * ## A lapsed license is not the lock
 *
 * A license whose expiry has passed refuses the edit, but the backend keeps
 * the row and keeps serving it: every page still renders the branding as last
 * saved. So the lock — "nothing of the feature" — would be false here. Lapsed,
 * the section shows the saved values with every Save off and says why, the
 * way the Roles screen keeps showing roles a lapse stopped resolving.
 */
export function WhitelabelingSection() {
  const mode = useInstanceMode();
  const status = useLicenseStatus();
  const lapsed = mode.data === "hosted" ? null : lapsedOn(status.data);

  if (lapsed) {
    const refusal = `The license lapsed on ${timeExact(lapsed)}. The branding stays as last saved, and can be edited again once a license is active.`;
    return <BrandingContent lockedBy={{ allowed: false, refusal }} />;
  }

  return (
    <LicenseGate feature="branding" title="Branding" content={<BrandingContent />}>
      White-labeling puts your own name, logo, favicon and colors on this
      instance — in the browser tab, on the sign-in screen and across the
      console — and your own words on its error pages.
    </LicenseGate>
  );
}

function BrandingContent({ lockedBy }: { lockedBy?: Gate }) {
  const branding = useBranding();
  const arrival = useArrival(branding.isPending);

  if (branding.error) {
    return (
      <SectionFailed title="Branding" error={branding.error}>
        The branding is readable by anyone, signed in or not, so this is not
        about your role — the backend did not answer.
      </SectionFailed>
    );
  }

  if (branding.isPending) return <SectionPending title="Branding" rows={3} />;

  if (!lockedBy) {
    return (
      <div className={cn("grid gap-5.5", arrival)}>
        <BrandingCards branding={branding.data} />
      </div>
    );
  }

  return (
    <div className={cn("grid gap-5.5", arrival)}>
      <Card>
        <Card.Header title="Branding is read-only" headingLevel={2} />
        <Card.Body>
          <p className="text-body text-tx-2">{lockedBy.refusal}</p>
        </Card.Body>
      </Card>
      <BrandingCards branding={branding.data} lockedBy={lockedBy} />
    </div>
  );
}
