import type { ReactNode } from "react";

import type { DowngradeImpact } from "@/lib/api/endpoints/billing";
import { counted } from "@/lib/format/plural";

/** The line the list ends on when it listed anything. */
export const SETTINGS_KEPT =
  "All these settings are kept. Moving back to Business turns them on again.";

/**
 * **What moving to Starter stops, against what this Organization uses**
 * (`GET /billing/downgrade-impact`, ADR-0054): one line per paid
 * feature it uses, with the counts and the names, ending on
 * {@link SETTINGS_KEPT}. A feature never set up is left out, so an
 * Organization on Business for the Servers alone reads that nothing else
 * changes.
 *
 * Shared by the two confirms that move to Starter: the paid month's
 * `DowngradeConfirm` (`features/billing/`, `lead` "From <date>, on
 * Starter:") and the free trial's `TrialSwitchConfirm`, which moves at once
 * and is opened from the Billing page and the paid-feature pages alike.
 */
export function DowngradeImpactList({
  impact,
  lead,
}: {
  impact: DowngradeImpact;
  /** What the list opens on: "From 28 November, on Starter:". */
  lead: string;
}) {
  const stops = whatStops(impact);
  if (stops.length === 0) {
    return (
      <p className="text-ui text-tx">
        This Organization uses none of SSO, SCIM, custom roles or forward auth,
        so nothing else changes.
      </p>
    );
  }
  return (
    <>
      <p className="text-ui text-tx">{lead}</p>
      <ul aria-label="What stops" className="grid gap-2 text-ui text-tx">
        {stops.map((stop) => (
          <li key={stop.key} className="border-l-2 border-warn-line pl-2.5">
            {stop.text}
          </li>
        ))}
      </ul>
      <p className="text-meta text-tx-2">{SETTINGS_KEPT}</p>
    </>
  );
}

/** One line of the list: a paid feature this Organization uses, and what stops. */
interface Stop {
  key: "sso" | "scim" | "customRoles" | "forwardAuth";
  text: ReactNode;
}

const people = (n: number) => counted(n, "person", "people");

/** The features in use, in the order the pages are, each with its facts. */
export function whatStops(impact: DowngradeImpact): Stop[] {
  const stops: Stop[] = [];

  if (impact.ssoProviders > 0) {
    stops.push({
      key: "sso",
      text:
        impact.ssoOnlyPeople > 0 ? (
          <>
            SSO sign-in stops.{" "}
            <strong className="font-semibold">
              {people(impact.ssoOnlyPeople)}
            </strong>{" "}
            {impact.ssoOnlyPeople === 1 ? "signs" : "sign"}
            {
              " in only with SSO and will use “Forgot password” to set a password."
            }
          </>
        ) : (
          "SSO sign-in stops. Everyone can still sign in with a password."
        ),
    });
  }

  if (impact.scimProviders > 0) {
    stops.push({
      key: "scim",
      text: "SCIM can't add people. Removals from your directory still work.",
    });
  }

  const holders = impact.customRoleHolders;
  if (holders.length > 0) {
    stops.push({
      key: "customRoles",
      text: (
        <>
          Custom roles allow nothing.{" "}
          <strong className="font-semibold">{people(holders.length)}</strong>{" "}
          {holders.length === 1 ? "holds one" : "hold one"}:{" "}
          {holders.map((holder, index) => (
            <span key={`${holder.name}-${index}`}>
              {index > 0 ? ", " : null}
              {holder.name} ({holder.role})
            </span>
          ))}
          .
        </>
      ),
    });
  }

  if (impact.protectedApps > 0) {
    const n = impact.protectedApps;
    stops.push({
      key: "forwardAuth",
      text: (
        <>
          <strong className="font-semibold">
            {n} protected {n === 1 ? "app stays" : "apps stay"}
          </strong>{" "}
          protected, but forward auth can&rsquo;t be added or changed.
        </>
      ),
    });
  }

  return stops;
}
