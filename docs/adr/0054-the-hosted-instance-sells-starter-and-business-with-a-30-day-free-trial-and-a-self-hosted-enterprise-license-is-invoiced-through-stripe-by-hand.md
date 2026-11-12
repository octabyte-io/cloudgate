# The Hosted instance sells Starter and Business with a 30-day free trial, and a Self-hosted Enterprise license is invoiced through Stripe by hand

This amends ADR-0048. ADR-0048 sold one self-serve Hosted plan and kept the paid features (SSO, SCIM, custom roles, forward auth) for Enterprise alone, on the reasoning that a customer who needs SSO wants a contract anyway. We now sell **two Hosted plans**, monthly only, decided on the map "Starter and Business Hosted plans with a free trial, and a Self-hosted Enterprise license sold through Stripe":

- **Starter**: 15 USD a month, 3 Servers and 3 Cloud Environments.
- **Business**: 35 USD a month, the same counts, plus the four paid features.
- Both take the same 5 USD Add-on, which raises both counts by one. What is counted, and what going over a count does, is unchanged from ADR-0048.

**Enterprise stays** on the Hosted instance for custom deals an Operator sets (ADR-0050), and on the Hosted instance it always counts as Business: the paid-feature check becomes "is this Organization on Business or Enterprise". The install-wide settings (white-labelling, parallel builds and cloud runs) stay Octabyte's and are never sold on the Hosted instance.

**A 30-day free trial** comes with both plans, through Stripe's own subscription trial in Checkout (`trial_period_days: 30`):

- A card is needed to start it. If the card is removed during the trial, the trial cancels at its end (`missing_payment_method: cancel`) and the Organization lapses (ADR-0052).
- While it lasts, a trial counts as paid: the plan's counts, plus Add-ons, which cost nothing until the trial ends. Starter and Business can be switched both ways at once, and the trial clock keeps running. The first bill is for what is held on day 30. A failed first charge, and a cancel during the trial, follow ADR-0052 like any other.
- **One trial per Organization ever, one per person (by email) ever, and one per card (by Stripe card fingerprint).** The emails and card fingerprints are kept in an Instance trial-history record that outlives the Organization and the user account. The Organization and email checks run before Checkout, which then simply leaves the trial out ("Subscribe", pay today). The card is known only after Checkout, so a card that has had a trial ends the new trial at once: the customer is charged today and keeps the plan.

**Plan switches outside a trial:** Starter → Business takes effect at once and is charged today, prorated. Business → Starter takes effect at the end of the paid month, through a Stripe subscription schedule, and can be taken back until then. Customers switch plans in Cloudgate's Billing page, never in Stripe's customer portal.

**When an Organization stops being on Business or Enterprise** (a downgrade reaching its date, a lapse, Enterprise turned off), every setting is kept and the paid features stop working, without locking anyone out and without making anything public:

- SSO sign-in stops; anyone without a password gets in through "Forgot password".
- SCIM refuses pushes that add or widen access, and still accepts deactivations and deletions.
- Custom roles stay fail-closed: the member can sign in, the role grants nothing, nobody is moved, and owners and admins are emailed the list of those stuck.
- Forward auth keeps protecting every app it already protects; new setups and edits are refused; removal is always allowed.

Moving back to Business, or Enterprise, makes all of it work again with no other step.

**The Self-hosted instance** keeps gating all six licensed features (the four above, white-labelling, and parallel builds and cloud runs) on a valid license key, and the free version's gates do not change. The **Enterprise license** is sold by hand: Octabyte agrees a price and billing period with each customer (monthly, 3, 6 or 12 months, or any custom period), sends a Stripe invoice from the dashboard, and once it is paid (or earlier, if the deal says so) issues a key on the license server whose `validUntil` is the end of the paid period plus 14 days. Every key unlocks all six features. Renewal keeps the same key with a later `validUntil`. A 30-day trial key is issued by hand on request. When a key passes `validUntil`, the same keep-settings, stop-features rules apply, plus: white-labelling stays as last saved but cannot be edited, and builds and cloud runs go back to one at a time.

## Considered Options

- **Keep one Hosted plan and Enterprise as the only way to the paid features (ADR-0048).** Replaced: the four paid features become something a customer buys self-serve, without a contract, while Enterprise stays for the deals that need one.
- **Automate Self-hosted licensing (the license server listening to Stripe), or a billing page inside a Self-hosted Cloudgate.** Rejected for now: deals are few and each one is custom.
- **No card to start a trial.** Rejected: a card is the cheapest guard against repeat trials, and Stripe Radar's trial-abuse control needs one.
- **Stripe's Trial Offers (per-item trials).** Rejected: not on the API version the repo uses, and not available in Checkout.
- **Moving members off a custom role, or making a forward-auth app public, when the plan ends.** Rejected: every automatic choice widens someone's access, and a billing event must never expose an app.
- **Letting an Operator extend a trial, grant one to someone not eligible, or clear trial history.** Rejected: it would turn the trial-history record into a loophole, and Operator acts never write to Stripe (ADR-0050).
- **Yearly billing.** Out of scope for now; monthly only, as ADR-0048.

## Consequences

- The catalogue has three Stripe prices (Starter, Business, Add-on) where it had two; the Hosted plan's single price setting is replaced. There are no live customers, so nothing is migrated.
- An Organization holds a Stripe subscription or Enterprise, never both. Turning Enterprise on stays refused while a subscription can still charge (a trial counts); Checkout stays refused while Enterprise; turning Enterprise off is a lapse (amends ADR-0050).
- Cloudgate sends the trial emails itself and Stripe's trial reminder stays off (amends ADR-0052).
- A Self-hosted instance warns owners and admins from 14 days before `validUntil` (a console bar, a new `license-expiring` notification event, and a direct owner email when mail is set up), re-checks its stored key once a day in that window and while lapsed, and `license-lapse` reports every lapse. This needs the license server, which is Octabyte's and not in this repo, to accept a repeat `activate` of a key it has already activated and return the new `validUntil`.

**Amended 2026-11-10 (ADR-0071):** a Free trial no longer only ever charges at its end. Buying a **Bought Server** with no Hosted plan starts the Starter trial in the same Checkout, or charges Starter today if the Organization is not eligible. A Server bought during the trial is charged at once on its own invoice, up to the trial's end, and joins the subscription when the trial ends.
