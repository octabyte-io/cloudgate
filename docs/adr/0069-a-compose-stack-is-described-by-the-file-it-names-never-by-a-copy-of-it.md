# A Compose stack is described in the Project config by the file it names, never by a copy of it

Status: accepted, implemented. Extends ADR-0029; supersedes nothing. Its "Never in a Cloud account" consequence is superseded by [ADR-0070](0070-a-compose-stack-in-a-cloud-account-runs-on-its-own-stack-vm-made-by-opentofu-and-reached-through-the-clouds-tunnel.md). Its whole-block refusal of `native` on a compose entry is narrowed by ADR-0070: a cloud block (`native.aws`, `native.gcp`) may set the Stack VM's machine type under ADR-0044, and `native.docker` stays refused (#1359).

A Compose stack is **console-managed** today: the Project config lists it by name and kind and can say nothing else about it (ADR-0029, `CONTEXT.md` **Console-managed**). Templates make that common, since every template instantiates as a Compose stack. Operators who keep their config in a repository have asked to describe stacks there too.

**Decided: `compose` becomes a kind the config can express, and an entry names the stack's compose file in a repository. It never holds the file's contents.**

```yaml
services:
  analytics:
    kind: compose
    source:
      github: acme/analytics
    file: deploy/docker-compose.yml   # default: docker-compose.yml
    type: docker-compose              # or: stack
```

The compose file is the stack's *source*, as a Dockerfile is an Application's: the config names it, and Cloudgate builds and deploys from it. So the config owns only what is the same in every Environment, which is the name, the kind, `source`, `file` and `type`. Everything else stays Cloudgate's under ADR-0029's rule: the branch, Domains, mounts, every variable value, the run Server, backups, and the stack's Converted file.

## Why not put the compose file inside the config

- **Two owners.** A compose file mixes settings the config would own (images, commands) with ones ADR-0029 gives to Cloudgate because they differ per Environment or name a host: published `ports:`, bind mounts, `environment:` values. Inlining it would make the config own those too, which is the first item on ADR-0029's list of things that would falsify it.
- **Secrets.** Compose files routinely carry passwords in `environment:`. The config never carries a secret (ADR-0006, ADR-0019), and checking an inlined file for one means parsing and policing Compose's whole format inside ours.
- **Two formats in one file.** Errors, the published schema and plan diffs would all have to cover a nested foreign format.

## Consequences

- **A plan compares four fields, not the file.** A plan compares `source`, `file`, `type` and the stack's existence with saved settings, as for any kind. A change to the compose file's *contents* is a code change: it reaches the stack on its next Deployment, like a commit to an Application, and is never a plan line. A build still never reads the config (ADR-0029).
- **Only a stack whose source is a repository can be described.** A stack whose compose text is kept in Cloudgate (`raw`, which is every template stack) or that came from an uploaded archive stays console-managed, because no config field could name its source without becoming a second copy of it. The planner already reports such a source as set in the console. Handing a template stack to the config means first moving its file into a repository.
- **No upgrade rewrites a config.** Existing stacks stay `managed: console` until their operator removes that line, and every plan notes the entries that now could be handed over. This follows the rule set when MySQL became expressible, which replaces ADR-0029's earlier wording that a later slice "converts these entries itself".
- **Never in a Cloud account** (superseded by ADR-0070: a stack in a Cloud account runs on its own Stack VM; only `type: stack` is still refused there, and a cloud `native` block now sets the Stack VM's machine while `native.docker` stays refused). A cloud cannot run a Compose stack, so under ADR-0035 a plan that would create a `compose` entry in an Environment whose Deploy target is a Cloud account is refused, naming the entry. It is never placed on a fallback Server.
- **A destroy names its volumes.** Name is identity, so a rename or a `type` change is a destroy and a create. A destroy is the stack's Delete, confirmed by name, and the plan line names the volumes that Delete would remove. The plan knows them without reading a compose file: each successful deploy records the volumes the file it deployed declares (`compose.deployedVolumes`), and a stack no deploy has recorded yet says so.
- **`native` does not apply** (narrowed by ADR-0070: only `native.docker` is still refused; a cloud block sets the Stack VM's machine type). A stack's container settings are its compose file's. ADR-0044's `native.docker` block describes the one Swarm service Cloudgate generates, and a stack has no such service, so a `native` block on a `compose` entry is refused.

## Considered options

- **Inline the compose file in the config.** Rejected for the reasons above.
- **Translate compose services into native kinds at plan time** (a `web` per exposed service, a `postgres` for a `postgres` image). Rejected as a runtime behaviour: the translation would be a guess the plan applies silently, and any service it cannot place would still need this ADR. It stays worth building as a one-off **import** in the CLI or console that writes ordinary entries an operator then owns. It is not part of this decision.
- **Per-Environment compose overrides** (`docker-compose.prod.yml`). Deferred. A file list that differs per Environment is a per-Environment setting in the config, which ADR-0029 rules out, so it needs its own decision.

## What would falsify this

- Any field on a `compose` entry that carries part of the compose file, such as a service's image, port or variable.
- A plan that reads the compose file's contents to decide what to change.
