import { useState, type ReactNode } from "react";

import { LinkButton } from "@/components/console/link-button";
import { toast } from "@/components/console/toast";
import { TrialSwitchConfirm } from "@/components/console/trial-switch-confirm";
import { UpgradeConfirm } from "@/components/console/upgrade-confirm";
import { Button } from "@/components/ui/button";
import { useOrganizations } from "@/lib/api/use-organizations";
import { formatDay, type AllowanceSource } from "@/lib/api/endpoints/billing";
import {
  useKeepBusiness,
  usePlan,
  useSubscription,
  useTrialOpen,
} from "@/lib/api/use-billing";
import { useInstanceMode } from "@/lib/api/use-instance-mode";
import { useActiveOrganizationId } from "@/lib/auth/client";
import { Icon } from "@/lib/design/icons";
import { timeExact } from "@/lib/format/time";

import { lapsedOn } from "./license-lapse";
import {
  inlineList,
  LICENSED_FEATURES,
  type LicensedFeatureId,
} from "./licensed-features";
import { useFeatureLicensed } from "./use-feature-licensed";
import { useLicenseStatus } from "./use-license";

/**
 * **Where an Organization stands below Business, on the four paid-feature
 * pages (ADR-0054).** SSO, SCIM, custom roles and forward auth come
 * with Business on the Hosted instance (with a license key Self-hosted), and a
 * page for one of them is in one of two states below it:
 *
 * - **never set up**: `ComesWithBusiness`, the panel `LicenseLocked` shows on
 *   the Hosted instance, with the one action that changes the answer for this
 *   reader (`PlanAction`);
 * - **kept but stopped**: the settings are still there, read-only, with
 *   `KeptStoppedStrip` at the top of the page saying what is off, why, and
 *   that they work again on Business. Edit and Add are off with
 *   `useKeptStopped().reason` on them; Remove is always on, since leaving is
 *   always allowed.
 *
 * Hosted Enterprise counts as Business, so it is licensed and sees neither.
 * `PlanStrip` is the strip without its words, for the other page-level notes
 * about the plan: `DowngradeWaitingStrip`, while a downgrade waits.
 */

/** The facts every variant of the panel and the strip is chosen from. */
export interface PlanFacts {
  hosted: boolean;
  /**
   * The plan held now, Hosted only; `undefined` while `GET /billing/plan` is
   * in flight, has failed, or Self-hosted, where there is no plan.
   */
  plan: AllowanceSource | null | undefined;
  /** Owner or admin, who may pay; `undefined` until the role is read. */
  manager: boolean | undefined;
  organizationName: string | null;
  /** Whether Checkout would start the 30-day free trial. */
  trialOpen: boolean;
  /**
   * When a waiting downgrade moves the plan to Starter, ISO; null
   * when none waits, and off the Hosted instance.
   */
  scheduledAt: string | null;
  /**
   * The subscription as Billing reads it, for an owner or admin on the Hosted
   * instance: Stripe's status and, in a free trial, when it ends.
   * `undefined` while it is read, and for anyone else; a failed read is both
   * null, and the upgrade confirm then says what the backend says.
   */
  billing: { status: string | null; trialEndsAt: string | null } | undefined;
}

export function usePlanFacts(): PlanFacts {
  const mode = useInstanceMode();
  const hosted = mode.data === "hosted";
  const plan = usePlan({ enabled: hosted });
  const { organizationId } = useActiveOrganizationId();
  const organizations = useOrganizations();
  const current = organizations.data?.find(
    (organization) => organization.id === organizationId,
  );
  const role = current?.member.role;
  const manager =
    role === undefined ? undefined : role === "owner" || role === "admin";
  const trialOpen = useTrialOpen({ enabled: hosted && manager === true });
  const subscription = useSubscription({ enabled: hosted && manager === true });

  return {
    hosted,
    plan: hosted ? plan.data?.plan : undefined,
    manager,
    organizationName: current?.name ?? null,
    trialOpen,
    scheduledAt: hosted ? (plan.data?.scheduledAt ?? null) : null,
    billing: subscription.data
      ? {
          status: subscription.data.status,
          trialEndsAt:
            subscription.data.trial?.endsAt ??
            subscription.data.trialEndsAt ??
            null,
        }
      : subscription.error
        ? { status: null, trialEndsAt: null }
        : undefined,
  };
}

/** "Single sign-on", or "Single sign-on and SCIM" for a page holding two. */
export function featureNames(
  feature: LicensedFeatureId | readonly LicensedFeatureId[],
): { names: string; plural: boolean } {
  const ids: readonly LicensedFeatureId[] =
    typeof feature === "string" ? [feature] : feature;
  const labels = ids.map((id, index) =>
    index === 0 ? LICENSED_FEATURES[id].label : LICENSED_FEATURES[id].inline,
  );
  const names = inlineList(labels);
  // "Custom roles come", "Single sign-on comes": every plural label in the
  // registry ends in an s, and no singular one does.
  return { names, plural: labels.length > 1 || names.endsWith("s") };
}

/**
 * **The one action that changes the answer, for this reader.** An owner or
 * admin on Starter gets "Upgrade to Business", which opens the upgrade
 * confirm right here, with the exact amount — or, during a free trial,
 * the trial's free switch (`TrialSwitchConfirm`, "0 USD, still free"),
 * as the Billing page does; with a payment failing (`past_due`) no upgrade can
 * be charged, so the reader is sent to Billing to settle it. With no plan, the
 * way in is Checkout, so the button goes to Billing with Business picked. A
 * member cannot pay, so is told who can, and gets no button that would only
 * say no. Nothing until the facts it needs are read.
 */
export function PlanAction({
  facts,
  size = "sm",
}: {
  facts: PlanFacts;
  size?: "sm" | "xs";
}) {
  const [upgrading, setUpgrading] = useState(false);
  const { plan, manager } = facts;

  if (!facts.hosted || manager === undefined || plan === undefined) return null;
  if (plan === "business" || plan === "enterprise") return null;

  if (!manager) {
    return (
      <p className="text-meta font-medium text-tx">
        Ask an owner or admin of {facts.organizationName ?? "this Organization"}{" "}
        to upgrade.
      </p>
    );
  }

  if (plan === null) {
    return (
      <LinkButton
        href="/settings/billing?plan=business"
        size={size}
        variant="pri"
      >
        {facts.trialOpen ? "Start 30-day free trial" : "Subscribe"}
      </LinkButton>
    );
  }

  const { billing } = facts;
  if (billing === undefined) return null;

  if (billing.status === "past_due") {
    return (
      <>
        <p className="text-meta font-medium text-tx">
          A payment is failing. Settle it on the Billing page, then upgrade.
        </p>
        <LinkButton href="/settings/billing" size={size}>
          Go to Billing
        </LinkButton>
      </>
    );
  }

  return (
    <>
      <Button
        type="button"
        size={size}
        variant="pri"
        onClick={() => setUpgrading(true)}
      >
        Upgrade to Business
      </Button>
      {billing.trialEndsAt ? (
        <TrialSwitchConfirm
          to="business"
          endsAt={billing.trialEndsAt}
          open={upgrading}
          onOpenChange={setUpgrading}
        />
      ) : (
        <UpgradeConfirm open={upgrading} onOpenChange={setUpgrading} />
      )}
    </>
  );
}

/**
 * **"<Feature> comes with the Business plan"**: what a Hosted page shows for
 * a paid feature this Organization never set up, in place of the "Contact us"
 * it showed when only Enterprise had them. One line on Business, then
 * `PlanAction`.
 */
export function ComesWithBusiness({
  feature,
}: {
  feature: LicensedFeatureId | readonly LicensedFeatureId[];
}) {
  const facts = usePlanFacts();
  const { names, plural } = featureNames(feature);
  const where =
    facts.plan === null
      ? "This Organization has no plan yet. "
      : facts.plan === "starter"
        ? "This Organization is on Starter. "
        : "";

  return (
    <>
      <p className="text-body text-tx">
        {names} {plural ? "come" : "comes"} with the Business plan.
      </p>
      <p className="mt-1.5 text-meta text-tx-2">
        {where}Business adds SSO, SCIM, custom roles and forward auth, with the
        same Servers and Cloud Environments as Starter.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <PlanAction facts={facts} />
      </div>
    </>
  );
}

/**
 * A page showing kept settings it cannot change, and the words for it: where
 * ("on Starter", for "Allows nothing on Starter") and the reason an off
 * control carries. Passed down to the cards, `null` when nothing is stopped.
 */
export interface Stopped {
  where: string;
  reason: string;
}

/**
 * Whether a paid feature's page is kept but stopped. Only once the license
 * status has answered `false`: an unanswered read stops nothing.
 */
export function useKeptStopped(
  feature: LicensedFeatureId | readonly LicensedFeatureId[],
): Stopped | null {
  const status = useFeatureLicensed(feature);
  const facts = usePlanFacts();
  if (status.licensed !== false) return null;
  const where = stoppedWhere(facts);
  return {
    where,
    reason: `Off ${where}. The settings are kept, and can be changed again ${backOn(facts)}.`,
  };
}

/** "on Starter", "without a plan", "without a license": after "Allows nothing". */
export function stoppedWhere(facts: PlanFacts): string {
  if (!facts.hosted) return "without a license";
  if (facts.plan === null) return "without a plan";
  if (facts.plan === "starter") return "on Starter";
  return "below Business";
}

function backOn(facts: PlanFacts): string {
  return facts.hosted ? "on Business" : "once a license is active";
}

/**
 * **A yellow strip at the top of one page**, about the plan: the bold part
 * says what, the rest why, and the action sits at the end. The frame
 * `KeptStoppedStrip` fills, kept separate so another note about the plan on
 * the same pages (a downgrade waiting) reads the same way.
 */
export function PlanStrip({
  title,
  children,
  action,
}: {
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      role="status"
      data-slot="plan-strip"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-warn-line bg-warn-tint px-4 py-2.75"
    >
      <p className="flex min-w-0 flex-1 basis-60 gap-2.5 text-ui text-tx">
        <Icon name="alert" size={15} className="mt-0.5 flex-none text-warn" />
        <span className="min-w-0">
          <strong className="font-semibold">{title}</strong>
          {children ? <> {children}</> : null}
        </span>
      </p>
      {action ? <div className="flex-none">{action}</div> : null}
    </div>
  );
}

/**
 * **Kept but stopped**: one strip per page, "<what is off>. This
 * Organization is on Starter. The settings below are kept and work again on
 * Business.", worded for a lapse with no plan, and for the license
 * Self-hosted. Renders nothing unless the page's feature is stopped.
 */
export function KeptStoppedStrip({
  feature,
  what,
}: {
  feature: LicensedFeatureId | readonly LicensedFeatureId[];
  /** What is off, as a sentence: "SSO sign-in is off." */
  what: string;
}) {
  const stopped = useKeptStopped(feature);
  const facts = usePlanFacts();
  const status = useLicenseStatus({ enabled: !facts.hosted });
  if (!stopped) return null;

  let where: string;
  if (facts.hosted) {
    where =
      // Kept settings with no plan were set up on one: the plan lapsed.
      facts.plan === null
        ? "This Organization's plan has lapsed."
        : facts.plan === "starter"
          ? "This Organization is on Starter."
          : "";
  } else {
    const lapsed = lapsedOn(status.data);
    where = lapsed
      ? `The license lapsed on ${timeExact(lapsed)}.`
      : "This Organization has no valid enterprise license.";
  }

  const action = facts.hosted ? (
    <PlanAction facts={facts} size="xs" />
  ) : facts.manager ? (
    <LinkButton href="/settings/license" size="xs">
      Go to License
    </LinkButton>
  ) : null;

  return (
    <PlanStrip title={what} action={action}>
      {where ? `${where} ` : ""}The settings below are kept and work again{" "}
      {backOn(facts)}.
    </PlanStrip>
  );
}

/**
 * **A downgrade waits**: while a move to Starter is scheduled, the
 * page says what stops on which day, with "Keep Business" for an owner or
 * admin, who may take it back; a member is told who can. Renders nothing
 * unless a move is scheduled, which is only ever while Business is held, so
 * the page is licensed and `KeptStoppedStrip` is not showing.
 */
export function DowngradeWaitingStrip({
  stops,
}: {
  /** What stops, before " on <date>.": "SSO sign-in stops". */
  stops: string;
}) {
  const facts = usePlanFacts();
  const keepBusiness = useKeepBusiness();
  if (!facts.scheduledAt) return null;

  const action = facts.manager ? (
    <Button
      type="button"
      size="xs"
      variant="pri"
      disabled={keepBusiness.isPending}
      aria-busy={keepBusiness.isPending || undefined}
      onClick={async () => {
        try {
          await keepBusiness.mutateAsync();
          toast.done(
            "This Organization stays on Business. Nothing was charged.",
          );
        } catch (error) {
          toast.error(error);
        }
      }}
    >
      Keep Business
    </Button>
  ) : null;

  return (
    <PlanStrip
      title={`${stops} on ${formatDay(facts.scheduledAt)}.`}
      action={action}
    >
      This Organization moves to Starter then. The settings are kept and work
      again on Business.
      {facts.manager === false
        ? ` To stay on Business, ask an owner or admin of ${facts.organizationName ?? "this Organization"}.`
        : ""}
    </PlanStrip>
  );
}
