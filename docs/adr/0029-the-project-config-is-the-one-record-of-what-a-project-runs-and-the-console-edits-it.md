# The Project config is the one record of what a Project runs, and the console edits it

Status: accepted, implemented.

Cloudgate is gaining a **Project config**: one description of what a Project runs, kept either in a repository or in Cloudgate. Until now the console has been the only way to say what runs, and it stays the way most operators work. So two records could easily appear side by side: a file someone writes and the console's own settings, with a sync between them and a rule for which one wins.

**We don't build two records.** Every Project has exactly one Project config. The repository and Cloudgate are two places it can be kept, never two copies. The console is a way to edit it, never a record beside it. A Service of a kind the config can describe exists because the config lists it, and dropping it from the config is how it is removed.

**"One record" holds only because every setting has exactly one owner.** The rule: a setting is the config's when it is the same in every Environment. That covers names, kinds, size, variable *names*, build settings, source, command, a `web` port, and a database's version, name and user. A setting is Cloudgate's when it differs per Environment, names a host or an account, holds a secret, or is an operational record. That covers branches, Domains, ports, mounts, Preview settings, backups, health, Traces, Swarm settings, run and build Servers, and every variable *value*. Nothing is owned by both sides, so there is nothing to merge and no "which wins". The config never carries a secret (ADR-0006, ADR-0019).

**How the one record reaches what runs.** Cloudgate's saved settings (the Service rows) are what builds and deploys read. On the fields the config owns, they are the *applied state* of the config, not a second record. They change only by applying a **Plan**:

- A plan compares the config with the saved settings on the config's fields, never with the running Swarm. Bringing containers in line with saved settings stays the deploy engine's job.
- A console edit to a Cloudgate-kept config is a plan that its own Save applies, so the console behaves as it always has. A push, or a whole pasted config, waits for an explicit Apply. Nothing applies a plan by itself.
- Applying writes saved settings and then queues ordinary Deployments (ADR-0017 unchanged). Creates run first, then changes, then destroys. A destroy is the Service's Delete (ADR-0018), confirmed by name. Name is identity, so a rename or a kind change is a destroy plus a create.
- Only a plan reads the config. A build or a Preview deployment uses saved settings, so a build never needs the config's repository.

## Considered options

- **Two records that sync, the file winning.** This is what every vendor surveyed does: the file overrides the dashboard, nothing writes back, and a dashboard edit is quietly undone by the next deploy. Rejected because the console is Cloudgate's main surface. An operator would lose console edits with no warning, and "which record is right?" would become a question every support thread starts with.
- **Two records that sync, the console writing back** (a commit or a pull request per edit). Rejected for now. It needs write access to the repository, collides with protected branches and the operator's own edits, and has to choose which branch's copy to change. How the console treats a repository-kept config is a separate question, and whatever it decides, the console edits the one config or refuses. It never keeps an edit of its own.
- **One config per repository, merged into the Project.** Rejected. Partial configs need a rule for who owns and deletes what, and a home for image-only Services. They would make "one Project config" several records merged together. Instead, each Service names its own source, so one config can describe Services built from several repositories.
- **Reconciling against what is running.** Rejected. It would make the Swarm a third record, and a crashed container would show up as a config change.

## Consequences

- **No fallback copy, anywhere.** An unreachable repository or a missing Config branch refuses every plan of that Environment, naming the repository and branch. Nothing that runs changes. Cloudgate never keeps a copy of a repository-kept config to fall back on, because that copy would be the second record this ADR rules out.
- **The config lists every Service, even ones it can't describe yet.** A Compose stack, MongoDB, MySQL, MariaDB or libsql Service is listed by name and kind as **console-managed**. A plan never creates, changes or destroys one, and removing its line is not a Delete. So a Service created in the console never makes a repository-kept config destroy anything. A later slice that can express the kind converts these entries itself.
- **Environments may briefly disagree.** Each Environment reads its own Config branch, so staging can run a Service production doesn't have yet. That is a change waiting to be promoted, not a second config.
- **Where a Service runs stays Cloudgate's.** An Environment's **Deploy target** decides only where a plan *creates* a Service. Each Service keeps its run Server, and changing the default moves nothing.
- **Every existing Project gets a generated, Cloudgate-kept config,** so the rule holds for Projects nobody has opened a config for. An operator who never opens it sees nothing change. How and when it is generated was still open.

## Still open when this was drafted

The console's treatment of a repository-kept config, the file's name, format and location, the sizes, and the statements that gate editing and applying. None of them can add a second record without superseding this ADR.

Each was settled without one. On a repository-kept config the console never writes the file: a config-owned setting, a new variable name, a new Service of a kind the config describes, and the Delete of a Service the file describes are refused with a pointer to the file and the Environment's branch, for the console, the API and an Agent alike, while Cloudgate's own settings and console-managed kinds stay editable.

## What would falsify this

Each of these is a new decision that supersedes this ADR, not a branch added to the code.

- **A setting owned by both sides**, such as a per-Environment override in the config, or a console edit that is kept when the config disagrees. Two owners bring back "which wins".
- **A console edit to a config-owned field that bypasses a plan.** The saved settings would then drift from the config with nothing to show it.
- **A cached copy of a repository-kept config** used when the repository can't be reached.

**The tripwire that fires first** is "let me tweak it in the console just this once" on a repository-kept config. It will be asked for because it is convenient. Allowing it without writing to the repository creates the second record.
