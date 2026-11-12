# A get-started wizard setup is applied by Cloudgate once its Server is ready

Status: accepted. Amends [ADR-0065](0065-a-template-setup-waits-as-a-pending-setup-and-a-plan-creates-its-compose-part-from-it.md) for the get-started wizard only. Builds on [ADR-0058](0058-a-setup-run-is-started-only-by-a-confirmed-press-and-a-setup-log-that-dials-only-watches.md), [ADR-0071](0071-the-hosted-instance-sells-bought-servers-paid-monthly-in-advance-and-deleted-when-unpaid.md) and [ADR-0054](0054-the-hosted-instance-sells-starter-and-business-with-a-30-day-free-trial-and-a-self-hosted-enterprise-license-is-invoiced-through-stripe-by-hand.md).

The public templates website has a "Deploy <app>" button on each template. It sends a person who may never have used a deployment tool to the console's `/get-started?template=<id>`, which walks them through signing up or in, getting a Server (buying one from Cloudgate, or adding their own) and the 30-day trial when needed. Under ADR-0065 the last step would then be a Plan that waits for them to press Apply, after a wait of minutes while the Server is made and set up. That person does not know what a Plan is, and is likely to have left the tab by then. So a setup the wizard makes is applied by Cloudgate itself.

## Decision

- **Asked for, never assumed.** `POST /templates/setup` takes `autoApply: true`. Only the wizard sends it. Every other setup is unchanged: its Plan waits for Apply, as ADR-0065 decides.
- **As the person, through the same Apply.** The Pending setup records who set it up. Cloudgate applies the Environment's open Plan as that person, through the same Apply a press goes through, so every permission check, refusal and result is the same. If the person's account is deleted first, nothing is applied in their name.
- **Once the Server is ready.** The Apply waits until the Environment's Server is Ready and set up: a Bought Server in its last stage (ADR-0071), and any Server with a finished Setup run and none going. A failed or never-run setup keeps it waiting, since *Run setup* can still fix it. A Server that is gone, failed to be made or is being deleted ends the wait. The platform host and a Cloud account are ready at once. Cloudgate looks when the setup is made, whenever a Setup run ends, and every minute.
- **Only what the person asked for.** Cloudgate applies a Plan only when every step in it creates a part of that setup. A Plan that holds anything else (a change, a destroy, another setup's part) was never part of the "Deploy <app>" press, so Cloudgate gives up and leaves the Plan for a person to review and Apply. A Plan gone stale is made again once, from the stored text, which carries the setup's entries forward (ADR-0065's amendment).
- **Not for a repository-kept config.** Its Plan comes from a push, so there is nothing to apply. `autoApply` there is refused at setup.
- **Seen like a pressed Apply.** An Apply that ran is recorded in the audit trail as a pressed one is (`POST /environments/:environmentId/plan/apply`), with `metadata.autoApply` set. A Plan that fails in part ends `partly-applied`, with each step's result, as a pressed one does. An Apply refused before it ran writes its reason on the Pending setup, and `GET /environments/:environmentId/pending-setups` shows it with the setup's state: `waiting` (and what for), `applying`, `applied` or `refused`.

## Considered options

- **Apply at setup, before the Server is ready.** Rejected: a Bought Server refuses every deploy until it is Ready, so the Apply would fail every time.
- **Hold the wizard's setup back until the Server is ready, then make it.** Rejected: the asked values and hosts would have to wait somewhere other than the Pending setup ADR-0064 and ADR-0065 already made for them, and the person would see nothing waiting in the console meanwhile.
- **Apply whatever the Environment's Plan holds.** Rejected: one press on a website must never apply a change or a destroy that someone else put in the config.
- **Let the wizard's browser tab press Apply when the Server is ready.** Rejected: it depends on the tab staying open for the minutes a Server takes, which is exactly what this person won't do.

## Consequences

- ADR-0065's "Setting up a Template is an ordinary Plan the user reviews and Applies" no longer holds for a wizard setup. The Plan is still made, kept and shown, but nobody reviews it before it runs. The wizard should show what will be made before the person confirms, and that stands in for the review.
- The `pending_setup` row gains who asked for the Apply, its state and its refusal (migration `0222_pending-setup-auto-apply`).
- A Bought Server can be named as a Deploy target only once its Server row exists, from its Setting up stage on. The wizard creates the setup then, not at Buy.
- The same wizard needs a sign-up to land back on it. Following a Hosted confirmation link now signs the person in (better-auth's `autoSignInAfterVerification`) and lands on the `next` path the sign-up carried. A Checkout takes a `returnTo` path on the console's own origin for the same reason.
