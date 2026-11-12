import Link from "next/link";

import { useInstanceMode } from "@/lib/api/use-instance-mode";
import { Icon } from "@/lib/design/icons";
import { cn } from "@/lib/utils";

import { useStanding } from "@/lib/api/use-standing";

/**
 * **The Frozen Organization's banner (ADR-0052)**, at the top of every
 * console page, for every member.
 *
 * It shows from the first failed payment until the Organization is paid again
 * (or deleted), and names each cause:
 *
 * - **suspended** — "Suspended. Contact Octabyte", with the Operator's reason;
 *   paying does not lift it, so it comes first;
 * - **lapsed** — the plan has ended: "Pay to continue", with the way to
 *   checkout. Everything already running keeps running;
 * - **a failed payment** while Stripe retries (`past_due`) — nothing is
 *   frozen yet; the card needs updating.
 *
 * The backend's frozen refusal says the same words, so the banner and a
 * refused button never disagree. Nothing at all on a Self-hosted instance,
 * where the standing is never asked for, and nothing while it loads or when
 * the read fails: a hint that failed is not a refusal.
 */
export function FrozenBanner({ className }: { className?: string }) {
  const mode = useInstanceMode();
  const hosted = mode.data === "hosted";
  const standing = useStanding({ enabled: hosted });
  const data = standing.data;

  if (!hosted || !data || (!data.frozen && !data.paymentFailed)) return null;

  const suspended = data.causes.includes("suspended");
  const lapsed = data.causes.includes("lapsed");

  return (
    <div
      role="status"
      data-slot="frozen-banner"
      className={cn(
        "flex flex-col gap-1.5 border-b px-4 py-2.75",
        data.frozen
          ? "border-bad-line bg-bad-tint"
          : "border-warn-line bg-warn-tint",
        className,
      )}
    >
      {suspended ? (
        <p className="flex gap-2.5 text-ui text-tx">
          <Icon name="alert" size={15} className="mt-0.5 flex-none text-bad" />
          <span className="min-w-0">
            <strong className="font-semibold">
              Suspended. Contact Octabyte.
            </strong>{" "}
            {data.suspendedReason ? (
              <>Reason: {data.suspendedReason}. </>
            ) : null}
            Nothing new starts until the suspension is lifted; everything
            already running keeps running.
          </span>
        </p>
      ) : null}
      {lapsed ? (
        <p className="flex gap-2.5 text-ui text-tx">
          <Icon name="alert" size={15} className="mt-0.5 flex-none text-bad" />
          <span className="min-w-0">
            <strong className="font-semibold">
              This Organization&apos;s plan has ended. Pay to continue.
            </strong>{" "}
            Nothing new starts until it is paid for again; everything already
            running keeps running.{" "}
            <Link
              href="/settings/billing"
              className="text-brand-tx underline underline-offset-2"
            >
              Choose a plan
            </Link>
          </span>
        </p>
      ) : null}
      {!data.frozen && data.paymentFailed ? (
        <p className="flex gap-2.5 text-ui text-tx">
          <Icon name="alert" size={15} className="mt-0.5 flex-none text-warn" />
          <span className="min-w-0">
            <strong className="font-semibold">A payment failed.</strong> Stripe
            will retry it. Nothing has stopped; update the card before the
            retries run out.{" "}
            <Link
              href="/settings/billing"
              className="text-brand-tx underline underline-offset-2"
            >
              Open billing
            </Link>
          </span>
        </p>
      ) : null}
    </div>
  );
}
