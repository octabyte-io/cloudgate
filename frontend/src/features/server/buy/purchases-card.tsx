import { useState } from "react";

import { Card } from "@/components/console/card";
import { StatusPill } from "@/components/console/status-pill";
import { Button } from "@/components/ui/button";
import type {
  BoughtServerStage,
  ServerPurchase,
} from "@/lib/api/endpoints/bought-servers";
import { errorMessage } from "@/lib/api/error-message";
import type { Mark } from "@/lib/design/status";

import { centsUsd } from "./buy-summary";
import {
  useCancelPurchase,
  useFinishPaying,
  useServerPurchases,
} from "./use-bought-servers";

/** How a stage reads while the Server has no row of its own. */
export const PURCHASE_STAGE_LABELS: Partial<Record<BoughtServerStage, string>> =
  {
    waiting_for_payment: "Waiting for payment",
    creating: "Creating",
    deleting: "Deleting",
  };

/**
 * Waiting on the customer stands out; Deleting is only shown going. A stage is
 * a status, so it is a pill with its glyph and word — not a chip, which is a
 * static label (rule 5, and `chip`'s own contract).
 */
const STAGE_MARKS: Partial<Record<BoughtServerStage, Omit<Mark, "label">>> = {
  waiting_for_payment: { tone: "warn", glyph: "◐" },
  creating: { tone: "info", glyph: "◐" },
  deleting: { tone: "mute", glyph: "○" },
};

/**
 * The Bought Servers not made yet (ADR-0071), above the fleet: each counts
 * against the Server count from Buy, so it shows from Buy too. One waiting
 * for payment offers *Finish paying* (3D Secure, on Stripe's page) and
 * *Cancel*; a refused or dropped payment removes it, and the card says why.
 * A deleted one shows **Deleting** here, with no action, until the provider
 * has deleted everything, then goes. Nothing at all while there are none.
 */
export function PurchasesCard({ enabled }: { enabled: boolean }) {
  const purchases = useServerPurchases(enabled);
  const finish = useFinishPaying();
  const cancel = useCancelPurchase();
  const [said, setSaid] = useState<string | null>(null);

  const rows = purchases.data ?? [];
  if (rows.length === 0 && said === null) return null;
  const title = rows.some((row) => row.stage === "deleting")
    ? "Servers being bought or deleted"
    : "Servers being bought";

  function finishPaying(row: ServerPurchase) {
    setSaid(null);
    finish.mutate(row.id, {
      onSuccess: (result) => {
        if (result.payUrl) window.location.assign(result.payUrl);
      },
      onError: (error) => setSaid(errorMessage(error)),
    });
  }

  function cancelPurchase(row: ServerPurchase) {
    setSaid(null);
    cancel.mutate(row.id, {
      onSuccess: () =>
        setSaid(
          `The purchase of ${row.name} was cancelled. Nothing was charged.`,
        ),
      onError: (error) => setSaid(errorMessage(error)),
    });
  }

  return (
    <Card>
      <Card.Header title={title} headingLevel={2} />
      <Card.Body className="grid gap-2.5">
        {said ? (
          <p role="status" className="text-body text-tx-2">
            {said}
          </p>
        ) : null}
        {rows.length > 0 ? (
          <ul aria-label={title} className="grid gap-2">
            {rows.map((row) => (
              <li
                key={row.id}
                className="flex flex-wrap items-center justify-between gap-2.5"
              >
                <span className="flex min-w-0 flex-wrap items-center gap-2.5">
                  <span className="min-w-0 text-body font-medium text-tx wrap-anywhere">
                    {row.name}
                  </span>
                  <StatusPill
                    mark={{
                      ...(STAGE_MARKS[row.stage] ?? {
                        tone: "info",
                        glyph: "◐",
                      }),
                      label: PURCHASE_STAGE_LABELS[row.stage] ?? row.stage,
                    }}
                  />
                  <span className="num text-meta text-tx-2">
                    {centsUsd(row.monthlyCents)}/month
                  </span>
                </span>
                {row.stage === "waiting_for_payment" ? (
                  <span className="flex gap-2">
                    <Button
                      size="sm"
                      variant="pri"
                      disabled={finish.isPending}
                      onClick={() => finishPaying(row)}
                    >
                      Finish paying
                    </Button>
                    <Button
                      size="sm"
                      disabled={cancel.isPending}
                      onClick={() => cancelPurchase(row)}
                    >
                      Cancel
                    </Button>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}
      </Card.Body>
    </Card>
  );
}
