# The Hosted instance sells Bought Servers, paid monthly in advance and deleted when unpaid

Status: accepted. Amends ADR-0052 and ADR-0054.

Many Hosted customers cannot buy a VPS, make an SSH key and add it as a Server. On the Hosted instance an Organization can now **buy a Server from Cloudgate**: it picks a size and a location, and optionally backups and extra storage. Octabyte buys the machine from Hetzner in Octabyte's own Hetzner account, Cloudgate sets it up as an ordinary Server of that Organization, and the Organization pays Octabyte a monthly price that includes a markup on Hetzner's cost. This is a business decision for the Hosted instance only. The code lives on `main`, and the instance-mode module (ADR-0049) gates it like every other hosted rule. Off hosted mode the feature does not exist. Facts about the Hetzner API and Stripe below come from their primary sources: the Hetzner Cloud API reference (https://docs.hetzner.cloud/) and Stripe's documentation.

**What the customer sees and what they don't.**

- The customer sees one monthly price per Bought Server, and separate prices for its backups and for its extra storage. Each price is Hetzner's monthly price for that size and location, plus the **Server markup**.
- The markup is never shown, and Hetzner is never named in the product. Cloudgate sets each machine's reverse DNS to an Octabyte name. Hetzner is named only where the law needs it, in the sub-processor list.
- A Bought Server is a Server like any other. It counts against the Hosted plan's Server count (ADR-0048), and buying one is refused when the count is full, as adding any Server is. The console offers the Add-on in the same step.

**The Server markup is an instance setting.** It defaults to 20%, and only an Operator changes it, on the Operator page (ADR-0050). Every change is recorded in the Instance organization's audit log. A change prices new purchases and new lines only. Each line keeps the price it was sold at, until Hetzner's own price for it changes (below).

**Bought Servers are made in Octabyte's existing EUR Hetzner account, and priced from Hetzner's USD list.** Hetzner fixes an account's currency when the account is made, and its API returns prices only in that currency. Hetzner's USD prices are a separate list, 16% to 34% above its EUR prices, not a conversion. So Cloudgate reads USD prices through the official API from a **second, empty USD Hetzner account** that holds no servers. It makes and changes every machine in the EUR account. A Server's price is the USD list price for its type and Location, plus the Server markup, rounded up to a tidy number.

Customers pay in USD, Stripe converts to GBP (Octabyte's UK account), and Octabyte pays Hetzner in EUR. The USD list's gap over the EUR price is a cushion against the conversion fees and exchange-rate swings, but not a guarantee. So the Operator page shows each Bought Server's real margin: its price, less Hetzner's EUR cost at the day's exchange rate.

Both API tokens are hosted-mode settings. Unlike the Stripe settings, they are optional: without them, buying a Server is not offered, and the instance still starts.

**Hetzner price changes are passed on as Hetzner makes them.**
- **Running servers repriced.** When Hetzner raises the price of servers already running, Bought Servers already sold go up too, with the same markup and **30 days' notice** by email. The customer may delete before the new price starts, with no penalty.
- **New orders only.** When a change affects only new orders, Bought Servers already sold keep their price.
- **Decreases** are passed on at once.
- **Exchange rate.** When the margin falls below a floor because the exchange rate moved, with no Hetzner change, an Operator may reprice with the same notice.
- **By hand.** An Operator applies every reprice as one action, which sends the notices. Hetzner announces changes weeks ahead, and they are rare.

**What can be done, through the Hetzner Cloud API and never the `hcloud` CLI:**

- **Buy.** The customer picks a server type available in the chosen location, with or without backups and extra storage. Cloudgate creates a key pair for the Server, as it does for any Server, and gives Hetzner only the public key. So no root password is made or emailed, and nobody ever handles a key. Each Hetzner resource carries labels naming the Organization and the Server. Once the machine answers, the ordinary Server setup runs on it.
- **Backups on or off.** Turning them off deletes every backup at once (Hetzner's rule), so the console says so and asks for confirmation.
- **Extra storage.** Extra storage is a Hetzner Volume, between 10 GB and 10 TB, in the Server's location. It only ever grows. After growing it, Cloudgate grows the filesystem on the machine. Volumes are not in Hetzner's backups, and the console says so.
- **Change size, up or down.** The machine is powered off while it changes, and the console warns about the downtime first. The disk is never grown with the size (`upgrade_disk=false`), so a size can always be moved back down. More disk is extra storage.
- **Delete.** Deleting the Server in Cloudgate deletes the machine and its backups, and Cloudgate also deletes its Volumes and Primary IPs, which Hetzner would otherwise keep billing. There is no "remove from Cloudgate but keep the machine".

Snapshots, firewalls, floating IPs, private networks, ISO images and rescue mode are left out.

**Billing is monthly and in advance, on the one Hosted plan invoice.**

- Each Bought Server, its backups and its extra storage are lines on the Organization's Hosted plan subscription. For an Attached Organization, they are on its Paying Organization's subscription (ADR-0059). So every month there is one invoice holding the plan, the Add-ons and every Bought Server.
- Buying a Server, turning backups on, growing storage and moving a size up are each charged at once for the rest of the month. This uses `always_invoice` with `pending_if_incomplete`, the pair plan upgrades already use. Hetzner is asked to act only after that payment succeeds, so Octabyte never pays Hetzner for something the customer has not paid for.
- Deleting, turning backups off and moving a size down give a credit on the next invoice, never cash back.
- There is no trial on a Bought Server.

**Buying the first Server starts the Starter Free trial.** An Organization with no Hosted plan that buys a Server starts the Starter Free trial in the same Checkout, if it is eligible (ADR-0054). Otherwise it pays for Starter today. A Stripe trial covers the whole subscription, and per-item trials are not available, so a Server bought during a Free trial is charged on its own invoice, from today to the trial's end. When the trial ends, the Server's lines join the subscription and the single monthly invoice. A Server bought after the trial goes straight onto the subscription.

**Protecting against fraud and unpaid use.**

- **Paying first** bounds the loss. A failed renewal means the customer already paid for the month they used.
- **3D Secure** is requested on the payment that buys the first Server.
- **Prepaid cards are refused** for buying a Server. Cloudgate checks the card's funding type itself, so Radar's paid custom rules are not needed.
- **The Free trial's card-fingerprint history (ADR-0054) applies as it is.**
- **There is no cap** on what a new Organization may buy. Paying first, 3D Secure and refusing prepaid cards are judged enough; a cap can be added later if fraud shows up.
- **A dispute** on any of the Organization's payments emails the Operators, who decide on a suspension (ADR-0050).

**A Bought Server is deleted when it stops being paid for.** This amends ADR-0052, under which a Frozen Organization's Servers are never touched. That rule protects machines the customer owns; a Bought Server is Octabyte's machine, and Hetzner bills Octabyte for every hour it exists, powered off or not.

- **A failed payment for a Bought Server.** The Organization's Bought Servers are deleted 7 days after the payment for them fails, unless it is paid by then. This holds whether the payment is a renewal or a charge during a trial, and even though the Organization is only `past_due`, not yet frozen. The Organization's own lapse still follows ADR-0052.
- **A lapse** (a cancel reaching the end of the paid month, a Free trial ending without a card, Enterprise turned off, or Stripe giving up). The Bought Servers are deleted when the Organization lapses. A cancel's date is known, so the warning emails go out 7 days before it.
- **A suspension.** The Bought Servers are deleted 7 days after an Operator suspends the Organization, unless the suspension is lifted first.
- **Warnings.** Every email on these paths, the purchase screen and the delete confirmation say plainly that deleting a Bought Server deletes its data and backups, and that it cannot be undone.

**Terms and abuse.**

- Hetzner allows reselling, but holds Octabyte solely liable for what is done on the machines, and may lock a server or the whole Octabyte account without notice. Crypto mining, spam, open relays, DDoS and network scans are forbidden there.
- So buying a Server requires ticking a box that accepts Octabyte's terms and acceptable-use policy. The box also confirms that Octabyte is not responsible for lost data or machines, whatever the cause, and that the customer keeps their own backups. Cloudgate records who ticked it and when.
- The purchase screen points to volume backups to a Destination outside the Server.
- An abuse report Hetzner sends Octabyte is forwarded by an Operator to the Organization's owners, with a deadline. If the deadline passes, the Operator suspends the Organization, and the deletion clock above starts.
- No hidden access, as ADR-0050. Cloudgate holds the Server's key as it does for any Server, encrypted at rest (ADR-0006). Operators get no shell and see a Bought Server only as an account fact: its size, location, monthly price and Hetzner id.

## Considered Options

- **Hourly usage billed at the end of the month.** Rejected: Octabyte would pay Hetzner for a month before learning whether the card works, which is exactly the loss to avoid. Hetzner caps a server at its monthly price anyway, so monthly pricing loses the customer little.
- **A separate subscription, and so a separate invoice, for Bought Servers.** Rejected: the customer gets one invoice a month. A separate invoice is used only during a Free trial, because a Stripe trial cannot leave one line out.
- **Leaving the Bought Server free during a Free trial.** Rejected: Octabyte pays Hetzner from the first hour.
- **A size or count cap for new Organizations.** Rejected for now, as above.
- **Powering off an unpaid Bought Server instead of deleting it.** Rejected: Hetzner bills a powered-off server in full.
- **Keeping a Bought Server through ADR-0052's 2 weeks of retries and 30 days frozen.** Rejected: up to six unpaid weeks of a machine Octabyte pays for.
- **A USD Hetzner account, a USD settlement balance in Stripe, and a USD business bank account.** This is the only setup where no money is converted. Deferred: it means opening a new bank account and a new paying Hetzner account, which is too much to take on now. It can be revisited later; machines would then start in the new account rather than be moved, because a server moved into a project with a different currency is switched to current prices.
- **Converting EUR prices to USD at a market rate.** Rejected: it needs a rate source and a buffer. Hetzner's own USD list already carries a gap over the EUR price.
- **Reading the USD prices Hetzner's website uses, or an Operator-kept price table.** Rejected: the website's feed is not an API Hetzner promises to keep, and a hand-kept table for every type and Location goes stale.
- **Keeping old Bought Servers at their price whatever Hetzner does.** Rejected: Hetzner's 1 April 2026 rise hit running servers too, and a rise bigger than the markup would make them lose money every month.
- **Handing a machine over to a customer who leaves.** Rejected: Hetzner's "Transfer to Project" is a manual console flow that needs the customer's own Hetzner account. A leaving customer moves their data out themselves before deletion.
- **A separate branch or repository for the hosted-only code.** Rejected: it touches Servers, billing, the Operator page and freezing, which change every week, and hosted mode already gates hosted-only code.

## Consequences

- **The Free trial no longer only ever charges at its end (amends ADR-0054).** A Server bought during it is charged at once.
- **Subscription size.** A subscription in Stripe's flexible billing mode holds at most 100 items, about 30 Bought Servers with backups and storage. The research note expects flexible mode on the repo's API version, but no live subscription has been checked.
- **New emails:** "payment for your Servers failed, they will be deleted on <date>", "your Servers will be deleted in 7 days", and "your Servers were deleted".
- **A reprice** changes the price of Stripe subscription lines already sold, from the date the notice gives.
- **Octabyte's Hetzner account starts with limits.** Mail ports 25 and 465 are blocked, a server limit applies, and the API allows 3,600 requests per hour per project. A limit raise must be asked for before launch.
