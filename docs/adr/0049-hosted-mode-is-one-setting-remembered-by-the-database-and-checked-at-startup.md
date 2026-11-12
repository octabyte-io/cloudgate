# Hosted mode is one setting, remembered by the database and checked at startup

Hosted mode is turned on by one setting, `HOSTED_MODE=true` (off when unset), which replaces `IS_CLOUD`; a backend that still finds `IS_CLOUD` set refuses to start and says it was renamed. The first start records the mode in the database, and any later start whose setting disagrees refuses to start, naming both, so a redeploy that drops the setting (`deploy/install.sh` rewrites `/etc/default/cloudgate-backend` from scratch) cannot quietly turn the Hosted instance into a Self-hosted one with no Server limits and an open platform host. Changing mode on purpose is a separate command run by hand. With hosted mode on, the backend also refuses to start, listing everything missing at once, unless the Stripe secret key, Stripe webhook secret, Hosted plan and Add-on price ids, a Resend mail sender with its key, and `SITE_URL` are all set; with it off, Stripe settings are ignored.

## Considered Options

- **Keep `IS_CLOUD`.** Rejected: "cloud" already means AWS and GCP here (Cloud accounts, Cloud Environments), and no Hosted instance runs yet, so the rename costs nothing.
- **The settings file alone.** Rejected: it is the very thing a redeploy loses, and losing it fails open.

## Consequences

- One instance-mode module is the only reader of `HOSTED_MODE`; every hosted rule (sign-up, refusing the platform host, billing, plan features, Enterprise in place of a license key) asks it, and one census test fails if any other file reads the setting.
- The operator sees the mode in a startup log line ("Instance mode: hosted" / "self-hosted") and in a `mode` field on the public `GET /settings/about`, which the console shows on its settings page; the `isCloud` field on `GET /billing/subscription` goes.
- An existing Self-hosted instance records "self-hosted" on its first start after the upgrade, and nothing else changes for it.
