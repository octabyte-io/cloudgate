# The Hosted instance sells one plan counting Servers and Cloud Environments, and paid features only on Enterprise

**Amended 2026-11-05 by ADR-0054:** the Hosted instance now sells two plans, **Starter** (15 USD) and **Business** (35 USD, the same counts plus SSO, SCIM, custom roles and forward auth), both with the same Add-on and a 30-day free trial. Enterprise is no longer the only Hosted route to the paid features, and on the Hosted instance it always counts as Business. What is counted and what going over a count does are unchanged.

The Hosted instance sells one self-serve plan, monthly only: 15 USD a month for 3 Servers and 3 Cloud Environments, and a 5 USD Add-on that raises both by one. A Cloud Environment is an Environment whose Deploy target is a cloud or that still has a Service in one, counted once however many Cloud accounts or regions it uses; connecting a Cloud account, members and Projects are never counted. The paid features (SSO, SCIM, custom roles, forward auth) come only with Enterprise, an Organization billed by agreement outside Stripe with its counts set by hand; the install-wide settings (white-labelling, parallel builds and cloud runs) are Octabyte's and never sold. The legacy, hobby and startup prices the billing code carried are removed, and checkout refuses to start when a price is unset rather than falling back to another.

## Considered Options

- **Two self-serve tiers (hobby per Server, startup with paid features).** Rejected: one price is one thing to explain and test, and the customers who need SSO or SCIM are the ones who want a contract anyway.
- **Counting Cloud accounts instead of Environments.** Rejected: one AWS account can hold any number of Environments, so the count would not follow the work Cloudgate manages.
- **Counting only an Environment's Deploy target.** Rejected: switching the target moves nothing, so an Environment could keep running in a cloud while counting zero.

## Consequences

- Going over a count, by any route, refuses only the next addition; nothing running is stopped, and the billing webhook no longer deactivates Servers when the allowance drops. What a lapsed subscription does is An Organization whose subscription lapses (ADR-0052): the Organization is frozen.
- On the Hosted instance a license check becomes "is this Organization Enterprise"; the Self-hosted instance keeps its license key unchanged.
