import { useState } from "react";

import { Card } from "@/components/console/card";
import { Chip } from "@/components/console/chip";
import { Dash } from "@/components/console/dash";
import { KVList, KVRow } from "@/components/console/kv-list";
import { Meter } from "@/components/console/meter";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { roleRefusal, usePermission } from "@/lib/auth/use-permission";
import { counted } from "@/lib/format/plural";
import {
  formatDay,
  formatMoney,
  PLAN_LABELS,
  type BillingPlan,
  type BillingState,
  type PaymentMethodSummary,
  type TrialState,
} from "@/lib/api/endpoints/billing";
import { useKeepTrial, usePortal } from "@/lib/api/use-billing";
import { OCTABYTE_CONTACT } from "@/lib/contact";

import { CancelTrialConfirm } from "./trial-confirms";

/**
 * What this Organization is on, and what it may hold.
 *
 * ## The allowance refuses additions and stops nothing (ADR-0048)
 *
 * `allowance.servers` and `allowance.cloudEnvironments` are each `3 + addOns`
 * while the plan, Starter or Business, is granted and 0 without it. They are what a Server
 * create, and a cloud Deploy target or a Project config Apply's first cloud
 * Service, are checked against, and that is all they do: an
 * Organization over one (Add-ons lowered at Stripe, or a plan that ended)
 * keeps everything it has, and only the next one is refused. Each meter says
 * so rather than threatening anything.
 *
 * The usage is the backend's own count, beside the allowance in the same
 * answer, so the two can never come from different moments.
 *
 * ## The portal can answer with no URL
 *
 * `createCustomerPortalSession` catches a Stripe failure and returns
 * `{ url: "" }`. An empty string is a refusal, not an address, so it is checked
 * before anything navigates. Sending a browser to `""` reloads the current
 * page, which would read as the button doing nothing.
 *
 * ## During a free trial (ADR-0054)
 *
 * Where the trial stands is said here, on the Billing page only — no
 * console-wide strip: a "Free trial · N days left" chip on the Plan row,
 * "Trial ends <date>", and "First charge: <amount> on <date>, to the <card>
 * (<plan> + <Add-ons>)", all from `subscription.trial`, which the backend
 * reads live from Stripe. "Cancel trial" turns the charge row into "No plan.
 * Nothing is charged." with "Keep <plan>" to take it back before the end. A
 * trial with no card on file offers "Add a card at Stripe", the portal.
 */
export function PlanCard({ subscription }: { subscription: BillingState }) {
  const portal = usePortal();
  const keepTrial = useKeepTrial();
  // BillingService admits an owner or admin, who both hold this.
  const canManage = usePermission({ organization: ["update"] });
  const [cancelling, setCancelling] = useState(false);

  const openPortal = async () => {
    try {
      const { url } = await portal.mutateAsync();
      if (!url) {
        toast.warn(
          "Stripe did not return a billing portal link. Try again in a moment.",
        );
        return;
      }
      window.location.href = url;
    } catch (error) {
      toast.error(error);
    }
  };

  const { allowance, usage, addOns, pool } = subscription;
  const trial = subscription.trial;
  const trialPlan = trial ? subscription.plan : null;
  const granted = allowance.plan !== null;
  // Hand-set counts by agreement: raised by Octabyte, not an Add-on.
  const enterprise = allowance.plan === "enterprise";
  const raise = enterprise
    ? `Octabyte raises the count (ask at ${OCTABYTE_CONTACT})`
    : "an Add-on makes room";
  const subscribed = subscription.stripeCustomerId !== null;

  return (
    <Card>
      <Card.Header
        title="Current plan"
        sub="What this Organization is subscribed to, and what that allows."
        headingLevel={2}
        actions={
          subscribed ? (
            <Button
              type="button"
              size="sm"
              disabled={portal.isPending}
              aria-busy={portal.isPending || undefined}
              onClick={openPortal}
            >
              Manage billing at Stripe
            </Button>
          ) : null
        }
      />
      <Card.Body className="grid gap-4">
        <KVList>
          <KVRow
            label="Plan"
            value={
              enterprise ? (
                "Enterprise"
              ) : subscription.plan ? (
                <span className="inline-flex items-center gap-1.75">
                  {PLAN_LABELS[subscription.plan]}
                  {granted ? null : <Chip>Not active</Chip>}
                  {granted && trial ? (
                    <Chip variant="brand">
                      Free trial · {daysLeftText(trial.endsAt, new Date())}
                    </Chip>
                  ) : null}
                  {granted &&
                  subscription.scheduledPlan &&
                  subscription.scheduledAt ? (
                    // A downgrade waits for the end of the paid month.
                    <Chip>
                      Moves to {PLAN_LABELS[subscription.scheduledPlan]} on{" "}
                      {formatDay(subscription.scheduledAt)}
                    </Chip>
                  ) : null}
                </span>
              ) : (
                <Dash word="None" />
              )
            }
          />
          <KVRow
            label="Status"
            value={
              subscription.status ? (
                // Stripe's own word, unmapped on purpose: the column is `text`
                // because Stripe adds statuses, and translating an unknown one
                // into a friendly word would mean inventing its meaning.
                <span className="font-mono">{subscription.status}</span>
              ) : (
                <Dash word="No subscription" />
              )
            }
          />
          {trial && trialPlan ? (
            <>
              <KVRow label="Trial ends" value={formatDay(trial.endsAt)} />
              {trial.cancelled ? (
                <KVRow
                  label={`From ${formatDay(trial.endsAt)}`}
                  value="No plan. Nothing is charged."
                />
              ) : (
                <KVRow
                  label="First charge"
                  value={
                    trial.firstCharge ? (
                      firstChargeText(trial, trialPlan, addOns)
                    ) : (
                      <Dash word="Not known yet" />
                    )
                  }
                />
              )}
            </>
          ) : null}
          <KVRow
            label="Add-ons"
            value={granted ? addOns : <Dash word="None" />}
          />
          <KVRow
            label="Servers allowed"
            value={granted ? allowance.servers : <Dash word="None" />}
          />
          <KVRow
            label="Cloud Environments allowed"
            value={granted ? allowance.cloudEnvironments : <Dash word="None" />}
          />
        </KVList>

        {trial && trialPlan ? (
          <div className="flex flex-wrap items-center gap-2">
            {trial.paymentMethodMissing && !trial.cancelled ? (
              <>
                <p className="w-full text-body text-tx-2">
                  There is no card on file for the first charge.
                </p>
                <Button
                  type="button"
                  variant="pri"
                  disabled={!canManage.allowed || portal.isPending}
                  title={canManage.allowed ? undefined : CARD_REFUSAL}
                  aria-busy={portal.isPending || undefined}
                  onClick={openPortal}
                >
                  Add a card at Stripe
                </Button>
              </>
            ) : null}
            {trial.cancelled ? (
              <Button
                type="button"
                variant="pri"
                disabled={keepTrial.isPending}
                aria-busy={keepTrial.isPending || undefined}
                onClick={async () => {
                  try {
                    await keepTrial.mutateAsync();
                    toast.done(
                      `This Organization keeps ${PLAN_LABELS[trialPlan]} after the trial.`,
                    );
                  } catch (error) {
                    toast.error(error);
                  }
                }}
              >
                Keep {PLAN_LABELS[trialPlan]}
              </Button>
            ) : (
              <Button type="button" onClick={() => setCancelling(true)}>
                Cancel trial
              </Button>
            )}
            {trial.cancelled ? null : (
              <CancelTrialConfirm
                plan={trialPlan}
                endsAt={trial.endsAt}
                open={cancelling}
                onOpenChange={setCancelling}
              />
            )}
          </div>
        ) : null}

        {granted ? (
          <>
            <UsageMeter
              noun={["Server", "Servers"]}
              used={usage.servers}
              allowed={allowance.servers}
              raise={raise}
              pool={
                pool && {
                  used: pool.usage.servers,
                  organizations: pool.organizations,
                }
              }
            />
            <UsageMeter
              noun={["Cloud Environment", "Cloud Environments"]}
              used={usage.cloudEnvironments}
              allowed={allowance.cloudEnvironments}
              raise={raise}
              pool={
                pool && {
                  used: pool.usage.cloudEnvironments,
                  organizations: pool.organizations,
                }
              }
            />
          </>
        ) : (
          <p className="text-body text-tx-2">
            {subscribed
              ? "This Organization holds no plan now, so adding a Server or a Cloud Environment is refused. Everything it already has keeps running. Choose the plan below to add more."
              : "Choose a plan to add Servers and Cloud Environments. Projects, members, Git connections and Cloud accounts need no plan."}
          </p>
        )}
      </Card.Body>
    </Card>
  );
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** "12 days left", "1 day left": whole days to `endsAt`, a part day counted. */
function daysLeftText(endsAt: string, now: Date): string {
  const days = Math.max(
    0,
    Math.ceil((new Date(endsAt).getTime() - now.getTime()) / DAY_MS),
  );
  return `${counted(days, "day", "days")} left`;
}

/** "Visa ending 4242", or the method's own name when it is not a card. */
function paymentMethodText(method: PaymentMethodSummary): string {
  const brand = method.brand.charAt(0).toUpperCase() + method.brand.slice(1);
  return method.last4 ? `${brand} ending ${method.last4}` : brand;
}

/**
 * "$65.00 on 5 December, to the Visa ending 4242 (Business + 2 Add-ons)".
 * With no card on file, it says so rather than naming one.
 */
function firstChargeText(
  trial: TrialState,
  plan: BillingPlan,
  addOns: number,
): string {
  const charge = trial.firstCharge;
  if (!charge) return "";
  const held =
    addOns > 0
      ? `${PLAN_LABELS[plan]} + ${addOns} Add-on${addOns === 1 ? "" : "s"}`
      : PLAN_LABELS[plan];
  const to = trial.paymentMethod
    ? `to the ${paymentMethodText(trial.paymentMethod)}`
    : "with no card on file";
  return `${formatMoney(charge.amount, charge.currency)} on ${formatDay(charge.at)}, ${to} (${held})`;
}

/**
 * One counted kind against its allowance. Over it, the note says that what is
 * held keeps running; at it, that only the next one is refused.
 *
 * On a Paying Organization with Organizations attached it is a **shared
 * meter** (ADR-0059): the allowance is the pool's, so the meter and its note
 * read the whole pool's use, and one line says how many Organizations that is
 * and how much of it is this one's own. With nothing attached, `pool` is null
 * and the meter is this Organization's alone, as it always was.
 */
function UsageMeter({
  noun: [one, many],
  used: own,
  allowed,
  raise,
  pool,
}: {
  noun: [string, string];
  used: number;
  allowed: number;
  raise: string;
  pool: { used: number; organizations: number } | null;
}) {
  const used = pool ? pool.used : own;
  const meter = (
    <Meter
      label={`${many} in use`}
      value={`${used} of ${allowed}`}
      percent={allowed === 0 ? 100 : (used / allowed) * 100}
      tone={used >= allowed ? "warn" : "brand"}
      note={
        used > allowed
          ? `Over the allowance. Every ${one} keeps running; adding another is refused until ${raise}.`
          : used === allowed
            ? `Adding another ${one} is refused until ${raise}.`
            : undefined
      }
    />
  );
  if (!pool) return meter;
  return (
    <div className="grid gap-1.25">
      {meter}
      <p className="text-meta text-tx-3">
        {used} used across {pool.organizations} Organizations:{" "}
        {own === 0 ? "none" : own} in this one, {used - own} in the other
        Organizations on this plan.
      </p>
    </div>
  );
}

const CARD_REFUSAL = roleRefusal("add a card for this Organization");
