import { Card } from "@/components/console/card";
import { Button } from "@/components/ui/button";
import { isApiError } from "@/lib/api/api-error";
import { errorMessage } from "@/lib/api/error-message";
import { Icon } from "@/lib/design/icons";
import type { BillingState } from "@/lib/api/endpoints/billing";
import { useProducts } from "@/lib/api/use-billing";

import { SectionPending } from "../settings/section-states";
import { Catalogue } from "./plan-catalogue";

/**
 * The two Hosted plans, Starter and Business, and their Add-ons, and buying or
 * changing them.
 *
 * ## A refused catalogue is never an empty list
 *
 * `GET /billing/products` is the one read here that reaches Stripe. This card
 * is rendered **only on the Hosted instance** — `BillingSection` reads the mode
 * off `GET /settings/about` and shows one sentence instead on a self-hosted one,
 * where this route refuses with a 400 — so a failure here is about the
 * payment provider or the caller, not about which kind of instance this is.
 *
 * - **It is never rendered as "no plans available."** That is an earlier mistake
 *   and F09's first defect: a confident claim about your configuration, made
 *   because a request failed. It says the catalogue did not answer, with a
 *   retry.
 * - **A refusal the backend named goes to `errorMessage()`** (H-48), so a
 *   banned operator is told about the ban. An unnamed failure keeps this card's
 *   own sentence, which says what Cloudgate knows — the catalogue did not
 *   answer — and that the rest of the page is still accurate.
 *
 * ## Two plans and one Add-on picker
 *
 * `Catalogue` shows Starter and Business side by side and one Add-on picker
 * that cannot go below what the Organization already uses (ADR-0048,
 * ADR-0054).
 */
export function PlansCard({
  subscription,
}: {
  subscription: BillingState;
}) {
  const products = useProducts();

  if (products.isPending) return <SectionPending title="Plans" rows={3} />;

  if (products.error) {
    // `isNamed` and not a status: a Stripe failure surfaces as a bare 500 with
    // no code, and only a refusal the backend deliberately named carries one
    // (H-48).
    const named = isApiError(products.error) && products.error.isNamed;
    return (
      <Card>
        <Card.Header
          title="Plans"
          headingLevel={2}
          actions={
            <Button
              type="button"
              size="sm"
              onClick={() => void products.refetch()}
              disabled={products.isFetching}
              aria-busy={products.isFetching || undefined}
            >
              Try again
            </Button>
          }
        />
        <Card.Body>
          <div className="flex gap-3">
            <span className="mt-0.5 flex size-7 flex-none items-center justify-center rounded-md border border-info-line bg-info-tint text-info">
              <Icon name="info" size={15} />
            </span>
            <div className="min-w-0">
              <p className="text-body text-tx">
                Cloudgate could not read the plan catalogue.
              </p>
              <p className="mt-1.5 text-meta text-tx-2">
                {named ? (
                  errorMessage(products.error)
                ) : (
                  <>
                    The payment provider did not answer, so the plans cannot be
                    listed right now. Everything else on this page is read from
                    Cloudgate&rsquo;s own records and is accurate.
                  </>
                )}
              </p>
            </div>
          </div>
        </Card.Body>
      </Card>
    );
  }

  return <Catalogue catalogue={products.data} subscription={subscription} />;
}
