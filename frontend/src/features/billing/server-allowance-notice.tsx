import Link from "next/link";

import { useCanCreateServer } from "@/lib/api/use-billing";
import { Icon } from "@/lib/design/icons";
import { cn } from "@/lib/utils";

/**
 * **`GET /billing/can-create-server`, where a Server is created.**
 *
 * The phase brief asks for this explicitly: the allowance is surfaced at the
 * point somebody adds a Server, not only on the billing page. That is the moment
 * the answer changes what a person does — on the billing page it is a fact about
 * the plan, and in this dialog it is the difference between a filled-in form
 * that works and one that comes back refused.
 *
 * ## It renders nothing far more often than it renders something
 *
 * `serverRoom` answers room immediately when self-hosted, so
 * on every self-hosted instance this is invisible — which is the whole design.
 * A dialog that carried a permanent "you are within your allowance" line on an
 * instance with no allowances would be noise on the most common path, and the
 * rule the codebase already follows is that a control says something when there
 * is something to say.
 *
 * A **failed** read renders nothing either. The route is open to any member and
 * `assertRoomFor` runs inside `ServersService.create` regardless, so the
 * rule is enforced whether or not this read worked — and blocking a form because
 * a *hint* failed would be inventing a refusal the backend has not made. F09's
 * first defect, in the direction that costs somebody a Server.
 *
 * ## `useServerAllowance` is separate because the button needs the answer too
 *
 * The notice explains and the submit button acts, and they must not disagree.
 * One query, two readers — TanStack dedupes them into a single request.
 */
export function useServerAllowance() {
  const query = useCanCreateServer();
  return {
    /** True only when the backend really would refuse. */
    blocked: query.data?.canCreateMoreServers === false,
    /** Why: no plan, or a full count (ADR-0048). */
    code: query.data?.code ?? null,
  };
}

/**
 * The refusal before the form is filled in: with no plan, "choose a plan"
 * and the way to Stripe Checkout (the Billing page); with a full count, the
 * Add-on. Nothing already running is affected either way, and it says so.
 */
export function ServerAllowanceNotice({ className }: { className?: string }) {
  const { blocked, code } = useServerAllowance();

  if (!blocked) return null;

  return (
    <div
      className={cn(
        "flex gap-2.5 rounded-lg border border-warn-line bg-warn-tint p-3",
        className,
      )}
    >
      <Icon name="alert" size={15} className="mt-0.5 flex-none text-warn" />
      {code === "PLAN_REQUIRED" ? (
        <p className="min-w-0 text-ui text-tx">
          This Organization has no plan, so a Server cannot be added yet.
          Starter and Business each include 3 Servers and 3 Cloud
          Environments.{" "}
          <Link
            href="/settings/billing"
            className="text-brand-tx underline underline-offset-2"
          >
            Choose a plan
          </Link>
        </p>
      ) : (
        <p className="min-w-0 text-ui text-tx">
          This Organization has all the Servers its plan allows, so adding
          another will be refused. Every Server it has keeps running.{" "}
          <Link
            href="/settings/billing"
            className="text-brand-tx underline underline-offset-2"
          >
            Buy an Add-on
          </Link>{" "}
          for one more Server and one more Cloud Environment, or delete a Server
          first.
        </p>
      )}
    </div>
  );
}
