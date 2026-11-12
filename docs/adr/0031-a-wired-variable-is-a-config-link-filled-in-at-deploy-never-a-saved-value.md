# A wired variable is a config link filled in at deploy, never a saved value

Status: accepted.

A `web` needs `DATABASE_URL` from `pg-1`, on a Server and on a cloud alike. Until now the Project config held variable *names* only and every value was typed in Cloudgate, so an operator copied a database's URL, password included, into each Environment by hand.

**We put the link in the Project config and fill the value in at each deploy.** An `env` entry may be `{ NAME: <service>.<output> }`, for example `env: [NODE_ENV, { DATABASE_URL: pg-1.url }]`. Each kind the config describes hands out a fixed list of **Outputs** (`postgres`: `url`, `host`, `port`, `user`, `password`, `database`; `redis`: `url`, `host`, `port`, `password`), all treated as secrets. The link is the same in every Environment, so it is the config's under ADR-0029's ownership rule. The value is not: at each deploy Cloudgate builds it from the source Service's saved settings (its encrypted password, ADR-0006) and the address, port and TLS flag its target reports, the way `${{project.KEY}}` is resolved at deploy (ADR-0014). The value is never written to the linked Service's row, and the console shows `DATABASE_URL ← pg-1.url`, never the value (ADR-0019). Typing a value for a linked name is refused, so a name has one source.

## Considered options

- **A typed reference in Cloudgate** (`DATABASE_URL=${{services.pg-1.url}}`, beside `${{project.KEY}}`). Rejected: it has to be typed again in every Environment, the plan cannot check it, and a repository-kept config would still not say what a Service needs.
- **Resolve once and save the URL on the linked Service.** Rejected: the password would be kept twice, encrypted on two rows that drift apart after a rotation or a re-created database, and every copy is one more secret to reclaim on Delete.
- **The target builds the URL** (an OpenTofu output on AWS). Rejected: each target would format it differently, and GCP would have to repeat the work. The target only gives the address.

## Consequences

- **The `{ NAME: service.output }` shape is part of `version: 1`** and its published JSON Schema, so it cannot be changed without a new version. A plain name stays valid, so older files keep working.
- **A link is checked by the plan, and it orders the Apply.** A missing or console-managed source, an unknown Output, a source this config removes while the link stays, a loop, and two Services that cannot reach each other (anything but the same Server or the same cloud network) all refuse the plan, naming the Service and the variable. The source's step runs before the linked Service's step.
- **A changed Output reaches the linked Service only when it deploys.** An Apply that changes a source redeploys every linked Service after it, and the plan shows that. A change made outside a plan shows a "deploy to pick up the new value" notice and does not redeploy by itself.
- **How a filled-in value reaches a cloud task** is the cloud slice's decision, not this ADR's. On AWS it is one encrypted SSM parameter per variable, written only by the deploy's Cloud run and never a plain value in the task definition.
