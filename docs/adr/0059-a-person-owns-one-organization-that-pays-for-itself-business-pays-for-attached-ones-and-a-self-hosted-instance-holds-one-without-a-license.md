# A person owns one Organization that pays for itself, Business pays for Attached ones, and a Self-hosted instance holds one without a license

This amends ADR-0054, and with it ADR-0050 and ADR-0052. Until now anyone could create as many Organizations as they liked, each paying for itself, so one person could run several Starter Organizations instead of buying Business. It was decided on the map "One Organization on Starter and the free Self-hosted version, many on Business, Enterprise or a license".

**On the Hosted instance, more than one Organization is a Business and Enterprise perk:**

- A person owns at most **one Organization that pays for itself**. Octabyte's Instance organization is exempt. Starter has no second, self-paying Organization.
- A **Paying Organization** (on Business or Enterprise, not attached itself) pays for any number of **Attached Organizations**. The link is between Organizations, not people. There is one level only: an Attached Organization never buys a plan or has Attached Organizations of its own.
- Every Organization on the plan shares **one pool** of Server and Cloud Environment counts, which the Paying Organization's Add-ons raise. Only the Paying Organization manages the plan.
- Only **creating** is limited. Invites and membership are not.

**Making and ending the link**:

- "New organization" asks "Who pays for it?". "<open Organization> pays for it" is offered when the open Organization is on Business or Enterprise, is not attached, and the caller is its owner or admin. "It pays for itself" is offered when the caller owns no Organization that pays for itself. The creator owns the new Organization, which has its own members. Only new Organizations are attached, never existing ones.
- An Attached Organization's own owner can **pay for it themselves** through Checkout, with no Free trial (having been attached counts as having held a plan). This is refused if they already own an Organization that pays for itself. The link ends only once the new subscription has started.
- Owners and admins of the Paying Organization can **"Stop paying for it"**. That is a lapse of that one Organization (ADR-0052): it freezes at once, the 30-day clock starts, and it leaves the pool.
- **Deleting a Paying Organization**, and **moving it to Starter** (a trial switch included) are refused while any Organization is attached, naming each one. Deleting an Attached Organization returns its counts to the pool at once. Add-ons stay with the Paying Organization.
- During a Business Free trial, Attached Organizations can be made. A cancel, or a failed first charge, is a lapse for all of them together.

**What exists is kept.** When something outside the customer's choice ends the perk (a lapse, an Operator turning Enterprise off, a Self-hosted key passing `validUntil`), no Organization is removed by the limit itself and only new ones are refused. A lapse of a Paying Organization freezes every Attached Organization with it, and deletes them together after 30 days (amends ADR-0052). An Operator's suspension stays on one Organization.

**Notices and audit.** The "payment failed" email goes to the Paying Organization's owners and admins only. The "3 days left" email and the lapse email also go to every Attached Organization's owner and admins. While payment is failing, an Attached Organization's Billing page says so in one line. A refused move to Starter emails nobody. Creating an Attached Organization, its owner paying for it, "Stop paying for it" and deleting an Attached Organization are each recorded in **both** Organizations' audit logs, each entry naming the other Organization.

**The shared pool is checked as one Organization's count is checked today.** A full pool refuses the next addition, and the check-then-insert race that can overshoot by one is tolerated, as it already is (ADR-0048). There is no lock just for shared pools.

**The Operator page** (amends ADR-0050) stays a flat list. An Attached Organization's Plan reads "Paid by <Paying Organization>". It shows its own state when it has one, otherwise its Paying Organization's, and its counts are its own share of the pool. A Paying Organization's Plan reads "Business, pays for N", with counts for the whole pool.

- Turning Enterprise on for an Attached Organization is refused, with the reason. The Operator never detaches anything.
- Turning Enterprise off on a Paying Organization names every Attached Organization that freezes with it. Enterprise counts are measured against the whole pool.
- The Operator keeps its three writes (suspend, lift, Enterprise on or off). It never attaches, detaches or re-points an Organization. Suspension stays per Organization, and suspending a Paying Organization leaves its Attached ones running.

**On a Self-hosted instance**, more than one Organization is the **seventh licensed feature** (amends ADR-0054's six), gated by the same `hasValidLicense` check:

- Only the **Instance organization's** license counts, the same subject as white-labelling (ADR-0013).
- Creating is allowed when no Organization exists or that license is valid. Every existing Organization counts, and deleting one frees the slot.
- The existing owner-or-admin check runs first.
- The refusal is 403 `ORGANIZATION_LIMIT`. To the Instance organization's owners and admins it points at Settings > License. To everyone else it says the instance's administrators can add a license, and names no other Organization and gives no count.
- An install already over the limit keeps every Organization, and Settings > Organizations shows owners and admins one calm line. "Creating more Organizations" joins the lapse list (`STOPPED_BY_LAPSE`, the renewal bar, `license-lapse`).
- The license server needs no change, because any valid key unlocks it.

**The console explains the limit in place**:

- "New organization" stays visible in Settings > Organizations and in the switcher, greyed out with a one-line reason. The upsell goes to owners and admins only.
- An Attached Organization's Billing page shows "Paid by <Paying Organization>" and its own use against one unnamed "Other Organizations on the plan" figure. Other Organizations are not named (ADR-0013).
- The Paying Organization's Billing page lists each Attached Organization with its counts and "Stop paying for it".
- The move to Starter opens "Delete or detach these first".
- The switcher stays flat, with a "Paid by" second line.

**Amended 2026-11-08: the switcher is a tree, and an Attached Organization's Billing page names no figure for the others.** Two lines above were overtaken by the PRD before they were built, and the build follows the PRD:

- **The switcher is a tree, not flat** (PRD story 53). An Attached Organization sits indented under its Paying Organization when the person is a member of both. When they belong to the Attached Organization alone it stays at the top level with a grey second line, "Paid by another Organization", and the payer is never named (story 54). With nothing attached the list is as flat as before. The Operator page's list is unchanged: it stays flat.
- **An Attached Organization's Billing page shows no figure for the other Organizations** (story 24), not an unnamed "Other Organizations on the plan" figure. Each count is the Organization's own use beside the room left on the plan, with one line saying that room is shared with the other Organizations on the Paying Organization's plan. Any figure for the others, or the plan's size beside the room left, would let a reader work out what other customers hold. The page is every member's, not only its owners' and admins' (stories 23–25, 29), and none of them is offered a plan or Add-ons.

## Considered Options

- **Billing per person** (a plan held by a user account). Rejected: the plan would follow one person when owners change, and Cloudgate never changes an Organization's owner.
- **Limiting invites or membership.** Rejected: only creating and owning are limited.
- **Attaching existing Organizations, or nesting more than one level.** Rejected: re-pointing who pays an existing Organization brings in proration, history and trial questions for little gain.
- **Removing or freezing Organizations over the limit after a lapse or a lapsed key.** Rejected: what exists is kept everywhere else, too (ADR-0052, ADR-0054).
- **Any Organization's license, or the caller's own, lifting the Self-hosted limit.** Rejected: that is the cross-tenant flaw ADR-0013 names.
- **Letting an Operator attach, detach, re-point, or suspend a whole family.** Rejected: who pays is the customer's to change, an Operator act never writes to Stripe, and suspension is about abuse, not payment.
- **A lock on the shared pool.** Rejected for now: it would make a shared pool behave differently from one Organization's. Fix the race for both together if it ever matters.

## Consequences

- An Organization gains a nullable "paid by" link to another Organization. The allowance check (`assertRoomFor`) reads the Paying Organization's plan, and the usage of every Organization on that plan.
- Organization creation, deletion, Checkout, the move to Starter, the lapse sweep, the lapse emails and the Operator's Enterprise switch all learn about the link. The Stripe catalogue does not change.
- There are no live customers, so nothing is migrated. A Self-hosted install already over the limit keeps everything and is told once.
