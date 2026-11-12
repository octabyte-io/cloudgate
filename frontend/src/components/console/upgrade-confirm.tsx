import type { ReactNode } from "react";

import { Modal } from "@/components/console/modal";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { isApiError } from "@/lib/api/api-error";
import { errorMessage } from "@/lib/api/error-message";
import {
  formatDay,
  formatMoney,
  UPGRADE_PREVIEW_STALE_CODE,
} from "@/lib/api/endpoints/billing";
import { useUpgrade, useUpgradePreview } from "@/lib/api/use-billing";
import { counted } from "@/lib/format/plural";

/**
 * The confirm before Starter → Business (ADR-0054). It takes effect at
 * once and is charged today, prorated, so the confirm says the exact amount,
 * on the button too: "Today, for the 23 days left of this month: $15.33",
 * "Upgrade and pay $15.33". The amount is Stripe's own invoice preview, and
 * the upgrade sends back the time it was worked out at, so what is charged is
 * what was read here.
 *
 * Self-contained, so a page other than Billing can open it: it reads
 * the preview itself while open, and needs nothing but `open`. A preview over
 * an hour old is refused by the backend; the confirm then reads a new one and
 * says the amount changed, rather than charging one nobody saw.
 */
export function UpgradeConfirm({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <Modal.Header
        title="Upgrade to Business?"
        description="Business adds SSO sign-in, SCIM, custom roles and forward auth. It starts now, with the same Servers, Cloud Environments and Add-ons."
      />
      {open ? <UpgradeConfirmBody onDone={() => onOpenChange(false)} /> : null}
    </Modal>
  );
}

function UpgradeConfirmBody({ onDone }: { onDone: () => void }) {
  const preview = useUpgradePreview(true);
  const upgrade = useUpgrade();

  if (preview.isPending) {
    return (
      <>
        <Modal.Body>
          <p className="text-body text-tx-2">
            Working out today&rsquo;s amount…
          </p>
        </Modal.Body>
        <Footer />
      </>
    );
  }

  if (preview.error) {
    return (
      <>
        <Modal.Body>
          <p role="alert" className="text-body text-tx">
            {errorMessage(preview.error)}
          </p>
        </Modal.Body>
        <Footer />
      </>
    );
  }

  const { today, monthlyAfter, currency, daysLeft, renewsAt, prorationDate } =
    preview.data;
  const todayText = formatMoney(today, currency);
  const pending = upgrade.isPending || preview.isFetching;

  return (
    <>
      <Modal.Body>
        <dl className="grid gap-2 text-ui text-tx">
          <div
            aria-label="Today"
            className="flex flex-wrap items-baseline justify-between gap-2"
          >
            <dt>
              Today, for the {counted(daysLeft, "day", "days")} left of this
              month
            </dt>
            <dd className="num font-semibold">{todayText}</dd>
          </div>
          <div
            aria-label="Every month after"
            className="flex flex-wrap items-baseline justify-between gap-2 border-t border-line pt-2"
          >
            <dt>Then every month, from {formatDay(new Date(renewsAt * 1000))}</dt>
            <dd className="num font-semibold">
              {formatMoney(monthlyAfter, currency)}
            </dd>
          </div>
        </dl>
        <p className="text-meta text-tx-2">
          Stripe charges the card on file now. If the payment does not go
          through, the Organization stays on Starter.
        </p>
      </Modal.Body>
      <Footer>
        <Button
          type="button"
          variant="pri"
          disabled={pending}
          aria-busy={pending || undefined}
          onClick={async () => {
            try {
              await upgrade.mutateAsync(prorationDate);
              toast.done(
                `This Organization is on Business. ${todayText} was charged today.`,
              );
              onDone();
            } catch (error) {
              if (
                isApiError(error) &&
                error.code === UPGRADE_PREVIEW_STALE_CODE
              ) {
                await preview.refetch();
                toast.warn(
                  "The amount changed while this was open. Check the new amount, then upgrade.",
                );
                return;
              }
              toast.error(error);
            }
          }}
        >
          Upgrade and pay {todayText}
        </Button>
      </Footer>
    </>
  );
}

function Footer({ children }: { children?: ReactNode }) {
  return (
    <Modal.Footer>
      <Modal.Gap />
      <Modal.Close render={<Button type="button">Cancel</Button>} />
      {children}
    </Modal.Footer>
  );
}
