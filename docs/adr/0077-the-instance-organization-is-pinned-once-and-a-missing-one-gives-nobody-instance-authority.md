# The Instance organization is pinned once, and a missing one gives nobody instance authority

ADR-0013 found the Instance organization as "the Organization of the earliest `member` row whose role is `owner`". Nothing held that row in place. If the Instance organization, or its first owner's `member` row, was ever deleted (an operator's mistake, the lapse sweep of ADR-0052, the unconfirmed-accounts sweep, a cascade from its owner's `user` row), the next-earliest owner silently became the Instance organization. On the Hosted instance that is a paying customer, and the authority is root over the platform host: its shell, Traefik, its Docker daemon and swarm, and the Operator page (ADR-0050).

So we **pin** it. One row in a new single-row table, `instance_organization`, records the Organization's id. Instance authority, and every reader of `PermissionService.instanceOrganizationId` (the instance licence, the Operator page, the Self-hosted Organization limit, the Hosted one-Organization limit's exemption, the audit copies), reads that pin and nothing else.

- **Who pins it.** `create-instance-organization` (Hosted, ADR-0051) and a Self-hosted install's first sign-up (`bootstrapDefaultOrganization`), each in the transaction that creates the Organization. A pin is written once (`on conflict do nothing`) and the app never moves it.
- **Existing installs.** The migration that makes the table back-fills it once from the old definition. It runs exactly once, so a later deletion cannot cause it to be worked out again. An install nobody has claimed pins nothing, and its first sign-up or the command pins it.
- **Fail closed.** If the pinned Organization no longer exists, nobody holds instance authority and every read logs an error naming the id. There is no fallback to another Organization. If nothing is pinned, nobody holds it either.
- **It cannot be deleted.** `OrganizationsService.delete` refuses it with 403 `INSTANCE_ORGANIZATION_UNDELETABLE`, frozen or not. The lapse sweep and the unconfirmed-accounts sweep skip it and log an error. The Operator page has no delete (ADR-0050). The pin's foreign key is `on delete restrict`, so the database also refuses any other path, including the cascade from its owner's `user` row.
- **Sign-up stays closed.** `hasInstanceOwner`, which closes Self-hosted sign-up and opens Hosted sign-up, is true once a pin exists *or* any owner row does. Losing owner rows never reopens an instance to a first sign-up that would claim it.

## Considered Options

- **Keep deriving, but from the earliest *Organization* (`organization.createdAt`).** Rejected: it moves on deletion just as the member row did.
- **Back-fill at startup instead of in the migration.** Rejected: a startup back-fill runs on every boot. After any loss of the pin it would quietly re-derive "earliest owner", which is the flaw this ADR removes.
- **A column on `recorded_instance_mode` or `web_server_settings`.** Rejected: the first row is written at boot with a `not null` mode, which the command and the migration do not know. The second is made lazily, with a generated id.
- **Fall back to the earliest owner when the pinned Organization is gone.** Rejected: that fallback is the vulnerability.

## Consequences

- An operator who loses the Instance organization anyway (by hand-run SQL that gets past the key) has nobody with instance authority until they restore that Organization or write the pin by hand. There is no command for re-pinning; add one if it is ever needed. Until then the refusal is the safe answer.
- On a Self-hosted install, deleting the first Organization is refused even when its owner owns another one. Before this change, deleting it handed authority to the next Organization.
- Removing the Instance organization's owner is already refused: the owner role is non-transferable and better-auth refuses to remove an owner. If an owner row went anyway, the authority would not move, because it is read from the pin.
