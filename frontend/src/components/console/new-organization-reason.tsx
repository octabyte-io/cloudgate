import Link from "next/link";

import type { OrganizationCreation } from "@/lib/api/endpoints/organizations";
import { sentence } from "@/lib/api/error-message";

/**
 * **Why "New organization" is greyed out, in one line, before anyone clicks.**
 *
 * The sentence is the backend's (`GET /organizations/creation`), the same one
 * `POST /organizations` would refuse with, so the button and the route never
 * say two different things. A refused action is never hidden (ADR-0059): it
 * shows greyed out with this line under it. The backend's refusals carry no
 * full stop (CODING_STANDARDS §2.5), so `sentence` gives it one before a link
 * follows it.
 *
 * Here rather than in `features/settings/organization/` because Settings >
 * Organizations and the masthead switcher both draw it (§1.4).
 *
 * The Instance organization's owners and admins can add the license that lifts
 * the Self-hosted limit, so they also get the way to Settings > License. The
 * element names its licensed feature, `manyOrganizations`, for the census in
 * `licensed-features.test.tsx`: this line is that feature's gate.
 *
 * On the Hosted instance the open Organization's owners and admins get the
 * backend's `planHint` instead: "Add an Organization to <name>'s plan" when it
 * can pay for one, "See plans" otherwise, both on its Billing page.
 */
export function NewOrganizationReason({
  creation,
  className,
}: {
  creation: OrganizationCreation | undefined;
  className?: string;
}) {
  if (!creation || creation.allowed || !creation.reason) return null;
  return (
    <p
      className={className ?? "text-meta text-tx-3"}
      data-licensed-feature="manyOrganizations"
    >
      {sentence(creation.reason)}
      {creation.licenseHint ? (
        <>
          {" "}
          <Link href="/settings/license" className="text-brand-tx underline">
            Go to License
          </Link>
        </>
      ) : null}
      <PlanHint hint={creation.planHint} />
    </p>
  );
}

function PlanHint({ hint }: { hint: OrganizationCreation["planHint"] }) {
  if (!hint) return null;
  return (
    <>
      {" "}
      <Link href="/settings/billing" className="text-brand-tx underline">
        {hint.kind === "add-to-plan"
          ? `Add an Organization to ${hint.organizationName}'s plan`
          : "See plans"}
      </Link>
    </>
  );
}
