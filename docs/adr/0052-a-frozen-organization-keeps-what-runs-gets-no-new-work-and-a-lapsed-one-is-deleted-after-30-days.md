# A Frozen Organization keeps what runs, gets no new work, and a lapsed one is deleted after 30 days

On the Hosted instance every Server, Cron service, backup and Uptime check of every Organization is driven by Octabyte's platform host, and today a lapsed subscription only marks Servers `inactive`, which stops almost nothing. We define one state, the **Frozen Organization**, with two causes each lifted only by its own trigger: **lapsed** (the subscription is gone; paying lifts it) and **suspended** (an Operator's act, ADR-0050; only an Operator lifts it). While frozen, Cloudgate starts no deploy, Cron service run, backup, Uptime check, Server threshold, Docker cleanup or cloud run, but it leaves alone everything already running on the customer's own Servers and clouds, because those are theirs, and the Gateway keeps forwarding their AI calls. Members can still sign in, look, pay, download configs and remove things, so they can always leave cleanly. A lapsed, unsuspended Organization is deleted 30 days after it lapsed.

- **Lapse is one moment.** Stripe retries a failed payment for 2 weeks (`past_due` freezes nothing; it brings a banner and emails), then cancels; a customer's cancel takes effect at the end of the paid month. The Organization lapses on `customer.subscription.deleted` or a deleted Stripe customer. There is no second grace period on Cloudgate's side.
- **Deletion** is an ordinary Organization delete: secrets, keys, cloud credentials, configs and logs go; nothing on the customer's Servers or in their clouds is touched. A suspension stops the clock, so a suspension never leads to a delete. The owner may delete a frozen Organization at any time, even their only one.
- **Coming back** needs a checkout that covers what the Organization still holds (ADR-0048); then everything resumes, and missed Cron runs are not run late.
- **Emails** (Cloudgate's, through Resend, to the owner and every admin, never opt-in): payment failed, 3 days before the lapse, lapsed (or "your plan has ended" after a cancel), 7 days before deletion, deleted. Stripe's own payment-failure emails are off. A suspension sends ADR-0050's suspend and lift emails instead.

**Amended 2026-11-05 (ADR-0054): the free trial.** Two emails join the list, to the same people and never opt-in: **"your trial has started"** (30 days, the end date, the plan and price that follow, how to cancel) and **"your trial ends in 7 days"** (the date and the amount for what is held then, with a link to Billing), sent by the daily job from the stored trial end date and marked so it is sent once; a plan or Add-on change after it sends no second one. No email is sent for a 0 USD invoice; the first real charge's "invoice paid" email adds that the free trial has ended. A trial that ends without a charge, by a cancel or by a removed card, lapses on day 30 and sends "your plan has ended" worded for a trial ("your free trial has ended and you were not charged"), never "lapsed"; a failed first charge takes the normal payment-failed path. Stripe's "Send a reminder email 7 days before a free trial ends" stays **off** on purpose, like its payment-failure emails, so there is one voice and it can be tested.

## Considered Options

- **Switching off the customer's Services, or refusing their Gateway calls.** Rejected: they run on the customer's own Servers and clouds, and breaking a running app the day a card fails punishes the wrong thing.
- **Keeping backups and alerts running through a lapse.** Rejected: that is the paid service itself. Instead, the emails say plainly that it has stopped.
- **Refusing everything, removal included.** Rejected: a customer leaving must be able to pull their Services out of their own AWS or GCP account, which takes a cloud run.
- **A separate state for suspension.** Rejected: one state means one check on every path, and separate causes mean a payment never lifts a fraud suspension.

## Consequences

- The billing webhook stops writing `serverStatus: 'inactive'` and records the lapse instead; every path that starts work asks one question, "is this Organization frozen".
- A daily job sends the 3-days and 7-days warnings and deletes on day 30.

**Amended 2026-11-10 (ADR-0071):** a **Bought Server** is the exception to "touches nothing already running". Octabyte pays for it every hour it exists, so it is deleted, with its data and backups, when the Organization lapses, 7 days after an Operator suspends the Organization unless the suspension is lifted, and 7 days after a payment for it fails, even while the Organization is only `past_due`. Servers the customer owns are still never touched.
