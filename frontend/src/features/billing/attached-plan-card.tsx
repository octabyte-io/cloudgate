import { useState } from "react";
import type { ReactNode } from "react";

import { Card } from "@/components/console/card";
import { Chip } from "@/components/console/chip";
import { KVList, KVRow } from "@/components/console/kv-list";
import { Button } from "@/components/ui/button";
import type { AttachedPaidBy, Usage } from "@/lib/api/endpoints/billing";
import { sentence } from "@/lib/api/error-message";
import { useStanding } from "@/lib/api/use-standing";

/**
 * An **Attached Organization's** Billing page (ADR-0059): its plan is its
 * Paying Organization's, so this card says who pays and who changes it, and
 * offers nothing to buy — no plan, Checkout or Add-on button, each of which
 * the backend would refuse with `PAID_BY_ANOTHER_ORGANIZATION`.
 *
 * Every member sees it, a plain member included (stories 23–25): it is drawn
 * from `GET /billing/attached-plan`, which any member may read, not from the
 * owner's and admin's `GET /billing/subscription`.
 *
 * ## Its own use, and the room left, and nothing about the others
 *
 * The other Organizations on the plan are other customers. So each count is
 * this Organization's own use beside the room left on the plan, with one line
 * saying that room is shared — never a meter, whose fill would let anyone
 * work out what the others hold.
 *
 * ## The payer's failing payment is one calm line
 *
 * While Stripe retries the Paying Organization's card, `GET /billing/standing`
 * names it (`payingOrganization.paymentFailed`), and only its owners and
 * admins can fix it, so this says so and asks nothing of the reader. Once the
 * payer lapses this Organization is frozen too, and the shell's usual frozen
 * bar says that.
 *
 * ## "Pay for it yourself", for its owner only
 *
 * Its own owner may take it over: `paidBy.payForItYourself` is set
 * for them alone. Pressing it opens `catalogue` — the ordinary plans and
 * Checkout, which the backend lets this one owner through, with no Free
 * trial. It stays on the payer's plan until the webhook sees the new
 * subscription active, so the card says so rather than promising a switch
 * on return from Stripe. Greyed out with the backend's reason when the owner
 * already owns an Organization that pays for itself (`ORGANIZATION_LIMIT`).
 */
export function AttachedPlanCard({
  paidBy,
  usage,
  catalogue,
}: {
  paidBy: AttachedPaidBy;
  usage: Usage;
  /** The plans to check out from, shown once the owner presses the button. */
  catalogue: ReactNode;
}) {
  const standing = useStanding({ enabled: true });
  const [paying, setPaying] = useState(false);
  const paymentFailing =
    standing.data?.payingOrganization?.paymentFailed === true;
  const payer = paidBy.name;
  const payForIt = paidBy.payForItYourself;

  return (
    <>
      <Card>
        <Card.Header
          title="Current plan"
          sub={`Only the owners and admins of ${payer} change the plan this Organization is on.`}
          headingLevel={2}
          actions={
            payForIt ? (
              <Button
                type="button"
                size="sm"
                disabled={!payForIt.allowed}
                onClick={() => setPaying(true)}
              >
                Pay for it yourself
              </Button>
            ) : undefined
          }
        />
        <Card.Body className="grid gap-4">
          {paymentFailing ? (
            <p role="status" className="text-body text-tx">
              {payer}&apos;s payment is failing; only its owners and admins can
              fix it.
            </p>
          ) : null}
          <KVList>
            <KVRow
              label="Plan"
              value={<Chip variant="brand">Paid by {payer}</Chip>}
            />
            <KVRow label="Servers in this Organization" value={usage.servers} />
            <KVRow
              label="Servers left on the plan"
              value={paidBy.roomLeft.servers}
            />
            <KVRow
              label="Cloud Environments in this Organization"
              value={usage.cloudEnvironments}
            />
            <KVRow
              label="Cloud Environments left on the plan"
              value={paidBy.roomLeft.cloudEnvironments}
            />
          </KVList>
          <p className="text-meta text-tx-2">
            Room left is shared with the other Organizations on {payer}&apos;s
            plan.
          </p>
          {payForIt ? (
            <p className="text-meta text-tx-2">
              {payForIt.allowed
                ? `Take this Organization off ${payer}'s plan by paying for it yourself. There is no Free trial, and it stays on ${payer}'s plan until your first payment goes through.`
                : payForIt.reason && sentence(payForIt.reason)}
            </p>
          ) : null}
        </Card.Body>
      </Card>
      {payForIt?.allowed && paying ? catalogue : null}
    </>
  );
}
