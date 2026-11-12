import { useMutation, useQuery } from "@tanstack/react-query";

import {
  billingApi,
  type AddOnsInput,
  type BillingPlan,
  type CheckoutInput,
} from "@/lib/api/endpoints/billing";
import { organizationsApi } from "@/lib/api/endpoints/organizations";
import { keys } from "@/lib/api/keys";
import { useInvalidate } from "@/lib/api/use-invalidate";
import { useActiveOrganizationId } from "@/lib/auth/client";

/**
 * The Organization's subscription, the catalogue, and the invoices.
 *
 * **`useProducts` is the only read here that reaches Stripe** (the plan's and
 * the Add-on's prices), and it is only
 * made on the Hosted instance: `BillingSection` reads the mode off
 * `GET /settings/about` first and renders neither the catalogue nor the invoices on a
 * self-hosted instance, where `getProducts` refuses with a 400.
 *
 * None of them retries — three attempts at a refusal that will not change is a
 * slower screen and three identical lines in the backend's log — and the screen
 * never reads a failed catalogue as an empty one.
 */

/**
 * `GET /billing/subscription`, an owner's or admin's read. A page that is not
 * Billing passes `enabled` for one only, on the Hosted instance; it shares the
 * Billing page's cache entry.
 */
export function useSubscription({
  enabled = true,
}: { enabled?: boolean } = {}) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.billing.subscription(organizationId),
    queryFn: billingApi.subscription,
    enabled: enabled && organizationId !== null,
    retry: false,
  });
}

/**
 * The plan this Organization holds now — Starter, Business, Enterprise, or
 * `null` for none — off `GET /billing/plan`, which **any member** may read.
 * The paid-feature pages read it to say where the Organization
 * stands, for a member as much as an owner; `useSubscription` would be a 403
 * for the member. Hosted only: the caller passes `enabled` from the mode.
 */
export function usePlan({ enabled }: { enabled: boolean }) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.billing.plan(organizationId),
    queryFn: billingApi.plan,
    enabled: enabled && organizationId !== null,
    retry: false,
  });
}

/**
 * Whether Checkout would start this Organization on the 30-day free trial,
 * decided as the picker decides it: no plan held and
 * `trialAvailable` (the Organization and the reader both eligible) off
 * `GET /billing/subscription`. That read is an owner's or admin's, so the
 * caller passes `enabled` only for one, on the Hosted instance; `false` while
 * it is off, in flight or failed, so the page offers "Subscribe" until it
 * knows better. It shares the billing page's cache entry.
 */
export function useTrialOpen({ enabled }: { enabled: boolean }): boolean {
  const state = useSubscription({ enabled }).data;
  return state !== undefined && state.allowance.plan === null
    ? state.trialAvailable
    : false;
}

/**
 * The "Organizations on this plan" card: the Organizations the active one
 * pays for, how much of the pool is free, and whether "Add an Organization to
 * this plan" is offered (ADR-0059). An owner's or admin's read, like the rest
 * of the Billing page.
 */
export function useAttachedOrganizations() {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.billing.attachedOrganizations(organizationId),
    queryFn: billingApi.attachedOrganizations,
    enabled: organizationId !== null,
    retry: false,
  });
}

/**
 * `GET /billing/attached-plan`, which **any member** may read: who pays for
 * the active Organization when it is attached, the room left on that plan,
 * and its own use (stories 23–25). The Billing page asks it first, so a plain
 * member of an Attached Organization sees its page rather than a 403. Hosted
 * only: the caller passes `enabled` from the mode.
 */
export function useAttachedPlan({ enabled }: { enabled: boolean }) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.billing.attachedPlan(organizationId),
    queryFn: billingApi.attachedPlan,
    enabled: enabled && organizationId !== null,
    retry: false,
  });
}

/**
 * "Add an Organization to this plan": a new Organization the active one pays
 * for, which the caller owns. It is a membership write as much as a billing
 * one — the switcher and Settings > Organizations gain it — so it invalidates
 * as a create does, which covers the card's read too.
 */
export function useAddOrganizationToPlan() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (name: string) =>
      organizationsApi.create({ name, paidBy: "active-organization" }),
    onSettled: () => invalidate.membership(),
  });
}

/**
 * "Stop paying for it" (ADR-0059): the active Organization stops paying for
 * one it pays for. The "Organizations on this plan" card's row action, and
 * the "Before <Paying> can move to Starter" checklist's Detach. Billing goes
 * stale (the card, the pool's room), and so does membership: the caller may
 * be in the detached Organization too, and the switcher shows who pays.
 */
export function useStopPaying() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (organizationId: string) =>
      billingApi.stopPaying(organizationId),
    onSettled: () =>
      Promise.all([invalidate.billing(), invalidate.membership()]),
  });
}

export function useProducts() {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.billing.products(organizationId),
    queryFn: billingApi.products,
    enabled: organizationId !== null,
    retry: false,
  });
}

export function useInvoices() {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.billing.invoices(organizationId),
    queryFn: billingApi.invoices,
    enabled: organizationId !== null,
    retry: false,
  });
}

/**
 * Whether another Server may be created.
 *
 * **Read by F13's add-server dialog**, which is where the brief asks for it —
 * not only on the billing page, because the moment the answer matters is the
 * moment somebody is adding one. Open to any member, so it works for the person
 * who will actually hit the limit.
 *
 * Room when self-hosted, unconditionally: `serverRoom` returns early off
 * hosted mode, so a self-hosted instance never sees a refusal here. That
 * makes this safe to render everywhere and useless as a mode check — that is
 * `useInstanceMode`.
 */
export function useCanCreateServer() {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.billing.canCreateServer(organizationId),
    queryFn: billingApi.canCreateServer,
    enabled: organizationId !== null,
    retry: false,
  });
}

export function useCheckout() {
  return useMutation({
    mutationFn: (input: CheckoutInput) => billingApi.checkout(input),
    /**
     * Nothing is invalidated. Checkout hands off to Stripe and the subscription
     * only exists once the webhook has been delivered, so there is no newer
     * answer to fetch at the moment the button is pressed — refetching here
     * would replace the current state with the identical current state and look
     * like a change that did not happen.
     */
  });
}

export function usePortal() {
  return useMutation({ mutationFn: () => billingApi.portal() });
}

export function useSetAddOns() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (input: AddOnsInput) => billingApi.setAddOns(input),
    onSuccess: () => invalidate.billing(),
  });
}

/**
 * What Starter → Business charges today and every month after, read
 * only while the confirm is open. Never cached past it: the amount is Stripe's
 * proration as of the second it was asked, and the upgrade charges that one.
 */
export function useUpgradePreview(enabled: boolean) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.billing.upgradePreview(organizationId),
    queryFn: billingApi.upgradePreview,
    enabled: enabled && organizationId !== null,
    retry: false,
    gcTime: 0,
    staleTime: 0,
  });
}

/**
 * Starter → Business. Business turns on the paid features, so everything the
 * Organization reads is refetched — the license status every feature page
 * gates on as much as billing.
 */
export function useUpgrade() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (prorationDate: number) => billingApi.upgrade(prorationDate),
    onSuccess: () => invalidate.license(),
  });
}

/**
 * What the move to Starter stops, against what this Organization uses
 * read only while the downgrade confirm is open, and fresh each time
 * it opens: a provider or a role added since would be missing from it.
 */
export function useDowngradeImpact(enabled: boolean) {
  const { organizationId } = useActiveOrganizationId();
  return useQuery({
    queryKey: keys.billing.downgradeImpact(organizationId),
    queryFn: billingApi.downgradeImpact,
    enabled: enabled && organizationId !== null,
    retry: false,
    gcTime: 0,
    staleTime: 0,
  });
}

/**
 * Business → Starter at the end of the paid month. Nothing changes
 * until then — the paid features stay — so only billing is refetched.
 */
export function useDowngrade() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: () => billingApi.downgrade(),
    onSuccess: () => invalidate.billing(),
  });
}

/** "Keep Business": takes a waiting downgrade back. */
export function useKeepBusiness() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: () => billingApi.keepBusiness(),
    onSuccess: () => invalidate.billing(),
  });
}

/**
 * Starter ↔ Business during a free trial: at once and free, both
 * ways. Either way the paid features change now, so everything the
 * Organization reads is refetched, the license status included.
 */
export function useTrialSwitch() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (plan: BillingPlan) => billingApi.switchDuringTrial(plan),
    onSuccess: () => invalidate.license(),
  });
}

/** "Cancel trial": no plan after the trial, nothing charged. */
export function useCancelTrial() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: () => billingApi.cancelTrial(),
    onSuccess: () => invalidate.billing(),
  });
}

/** "Keep <plan>": takes a cancelled trial's cancel back. */
export function useKeepTrial() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: () => billingApi.keepTrial(),
    onSuccess: () => invalidate.billing(),
  });
}

export function useSetInvoiceNotifications() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (enabled: boolean) =>
      billingApi.setInvoiceNotifications(enabled),
    onSuccess: () => invalidate.billing(),
  });
}
