# The template.toml system is removed in one release, with no converter, and an install that kept the old URL gets templates off

Status: accepted. Follows [ADR-0062](0062-the-template-catalogue-is-on-by-default-read-as-the-newest-fixed-release-of-cg-templates-in-one-file.md), which left the retirement of `CLOUDGATE_TEMPLATES_BASE_URL` to this decision, and [ADR-0065](0065-a-template-setup-waits-as-a-pending-setup-and-a-plan-creates-its-compose-part-from-it.md), whose Plan replaces today's preview-and-deploy screen. Decided in [How do we retire the template.toml system?](https://github.com/octabyte-io/cloudgate/issues/1354). As built (#1364, #1380): `generators.ts` and `slug.ts` were wrongly taken to serve only templates. `AiService.deploy` used `generatePassword`, `slugify` and `composedCreateStatements` too, so `generatePassword` and `slugify` moved to `backend/src/ai/` (`generate-password.ts`, `slug.ts`) and `composedCreateStatements` to `backend/src/compose/`, where a Template's Apply (`PlanApplier.check`) asks it too. No Template code uses the first two, and the rest of `generators.ts` was deleted. The frontend's `toml` dependency is a dev dependency, used only by `features/agents/connect-snippets.test.ts` to parse the Codex TOML snippet `connect-snippets.ts` writes by hand; that is the test the Decision means.

Today's templates are Dokploy-style `template.toml` files, read from a tree that `CLOUDGATE_TEMPLATES_BASE_URL` names, which is off until an operator sets it. The new **Template catalogue** (`cg-templates`, `cloudgate.yaml` plus `template.yaml`) replaces it. Cloudgate records nothing that ties a running stack to the template it came from, so there is no usage data to tell which templates matter, and `cg-templates` starts empty.

## Decision

- **Ported by hand, no converter.** Before the switch, a fixed starter list is written in the new format by hand: n8n, Uptime Kuma, Plausible, Umami, Ghost, WordPress, Gitea, Vaultwarden, Metabase, Nextcloud, Actual Budget, Directus, Listmonk, Outline and Mattermost. It was picked on public popularity signals and covers every shape: a single web app, an app with Postgres, an app with Postgres and Redis, a worker, and at least one compose part.
- **One release switches.** The release that ships the new reader deletes the old one. Old and new never run side by side. That release waits until the starter list is in the first published version of `cg-templates`.
- **Removed.** Everything that only serves `template.toml`: `processors.ts`; the backend's `toml` dependency (the frontend's stays, for its own test); `POST /templates/preview`, `POST /templates/process` (paste-your-own) and `POST /templates/deploy`; the `meta.json`/`blueprints/` fetch and its caches; the console's review step, `generated.ts` and `template-plan.ts`; `CLOUDGATE_TEMPLATES_BASE_URL`; and their tests. `generators.ts` and `slug.ts` move into the new code only if it really uses them.
- **Stacks already set up keep running.** They are plain compose stacks with no link to the reader, so nothing touches them.
- **An install that still sets the old URL gets templates off.** It starts normally. The old setting is no longer read, and while it is set and `CLOUDGATE_TEMPLATES_URL` is not, templates are off rather than pointed at the official catalogue. The startup log and the templates screen say: "`CLOUDGATE_TEMPLATES_BASE_URL` is no longer read. Set `CLOUDGATE_TEMPLATES_URL`, or remove the old setting to use the official catalogue." An install that never set it gets the default from ADR-0062.
- **Docs.** One changelog entry in the switching release says the old format and paste-your-own are gone with no converter, that running stacks are untouched, what happens to the old setting, and which routes were removed. `docs/deploy.md` and `deploy/env/cloudgate-backend.example` change as ADR-0062 names. There is no migration guide. How to write a template lives in the `cg-templates` README.

## Considered options

- **A converter from `template.toml`.** Rejected: the formats differ in kind (Cloudgate's own kinds against one compose file, typed inputs against inline helpers), and a mechanical copy would ship unpinned images and compose where an own kind fits.
- **Both readers for one release.** Rejected: the old one was off by default, so few installs use it, and two would keep two review screens and two rule sets alive.
- **Refuse to start while the old setting is set.** Rejected: too harsh for a templates setting on an upgrade.
- **Ignore the old setting and use the official catalogue.** Rejected: an operator who pointed it at an internal mirror may block `github.com`, and quietly switching would override that choice.

## Consequences

- `env.schema.ts` keeps reading `CLOUDGATE_TEMPLATES_BASE_URL` only to detect it and turn templates off; that check can go in a later release.
- Paste-your-own templates are gone until someone asks for them in the new format.
