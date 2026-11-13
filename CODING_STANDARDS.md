# Cloudgate coding standards

What this repo actually does, written down so it can be cited.

Two audiences. A person adding a feature, who wants to know the shape before writing it — and the
**Standards review in `/build`** (step 6 of `.claude/skills/build/SKILL.md`), which checks every
landed spec's diff against this file.

Almost every rule here was already true before it was written down. That is deliberate: a standard
nobody follows is a standard that generates noise in review. Where the code and the intent genuinely
disagree, the rule is **not** stated as a rule — it goes in [§4](#4-known-gaps), so a reviewer never
cites an aspiration as a violation.

## 0. How to read this

### Precedence

1. **`docs/adr/`** wins. The decision records are the only documents here that record a trade-off
   rather than a convention. If this file contradicts an ADR, the ADR is right and this file is
   stale — say so out loud ("contradicts ADR-0007, but worth reopening because …") rather than
   silently overriding.
2. **This file** wins over the review skill's smell baseline. That baseline is a set of Fowler
   smells applied to any repo; where this file endorses something it would flag, the endorsement
   stands. The corollary matters more than the rule: **writing something down here can silence a
   legitimate smell**, so nothing is endorsed by accident. Duplication that exists but is not wanted
   is in §4, not here.
3. **Tooling gates are not standards.** `pnpm -r run typecheck`, `pnpm -r run lint` and both
   workspaces' unit lanes (the OpenAPI staleness test and `test/coding-standards/` among them) are
   what CI runs; Prettier settles formatting. None of it belongs in a review
   comment, because a machine already said it. This document is for what only a person notices.

### The four documents this one points at, rather than repeats

| Read it for | Where |
|---|---|
| The vocabulary, and what each term rules out | `CONTEXT.md` |
| The six backend conventions, the test harness, migrations, the OpenAPI contract | `backend/README.md` |
| The visual system, the component index, the file budget and its exemptions | `frontend/docs/design-system.md` |
| The architecture decisions and why they went the way they did | `docs/adr/` |

The build records that used to sit in `.project/` (phase briefs, design prototypes, verification
runs) were removed once the build closed. Their standing rules had already moved here; the records
themselves are in git history at `c8e9bdfb`, for history, not for law.

---

## 1. Shared

### 1.1 The vocabulary is not negotiable

`CONTEXT.md` is the glossary, and it binds schema columns, route paths, class names, UI copy and
**test names** alike: when anything you write names a domain concept, use the term as defined in
`CONTEXT.md`, and if the concept is missing, either the word is invented (reconsider) or the
glossary has a gap (add it). It is unusual among glossaries in naming what each term rules
out, and the *Avoid* column is the half that gets cited in review:

| Use | Never |
|---|---|
| Organization | team, workspace, tenant |
| Project | app group, workspace |
| Environment | stage, namespace |
| Service (an Application, Compose stack or Database) | workload; or "service" for Application alone |
| Application | app, workload |
| Deployment | release, build — a build is a *phase* of a deployment |
| Server | host, node, machine |
| Member | user, account, collaborator |
| Deployment log | build log, log file |

**Third-party strings keep their own names.** Docker Swarm has managers and workers, DNS has a Host
column, a cloud provider has machine types. Renaming those to fit the glossary is a different error.

If the concept you need is not in the glossary, that is a signal — either the language is invented
(reconsider) or there is a real gap (note it; `/planning` adds terms as decisions settle them).

**This binds what you write now, not the tree behind you.** A banned synonym already sitting in a
comment is corrected when you are in that file anyway; a repo-wide grep for one is not a finding
and not a ticket, and `CONTEXT.md`'s note above the glossary says why. The exception is a use that
would make a reader draw the wrong conclusion about which machine or which row is meant — that is
a defect on its own terms, and does not need the vocabulary rule to justify it.

### 1.2 Comments explain why, and name what was rejected

This is the most distinctive property of the codebase and the easiest to erode. Roughly 15% of lines
in `backend/src` and 23% in `frontend/src` are comment lines, and they are not restating the code.
The house form is a JSDoc block on the export that says **what broke first, what alternative was
rejected, and which issue or phase produced the answer**.

`frontend/src/components/shell/palette-keys.ts` states the reason such a comment exists at all:

> Both of these are here rather than inline because both were **wrong** first, and the reasons are
> worth keeping next to each other.

Two sub-forms are worth naming, because both exist specifically to stop a later reader deleting
load-bearing code:

- **The negative claim.** `// Not dead code: …` in `palette-keys.ts` guards a `if (!event.key) return`
  that looks redundant against its own type (`key` is non-optional) but is not, because the listener
  is on `window` and sees synthetic keydowns from autofill and extensions that carry no key.
  `test/openapi/openapi.spec.ts:39` does the same for an omission: *"**Deliberately no
  `app.init()`**."* Deleting either re-introduces a fixed bug.
- **The negative assertion in tests.** A one-liner naming what did *not* happen, beside the
  assertion that proves it: `// Nothing was scaled on the way to being refused.`

A public method's docblock states what it does and who may call it — `/** Every tag in the active
organization, by name; any member of it may call this. */` — so a reviewer can check the body
against the stated intent and the route's gate against the stated caller.

What this rule is not: licence to narrate. A comment restating the statement below it is noise.

**Cite the symbol, never the line, when the reference crosses a file — and especially when it crosses
a package.** Added at the X09 barrier of the X-run, after three of these were found wrong in one phase:
`remove-containers-modal.tsx` cited `compose.service.ts:318` for a method that was at **374 in the very
commit that wrote the reference** (H-103 — not drift; wrong on day one), and `compose-actions.tsx` and
`use-compose.ts` both cited `compose.service.ts:218` for a method at **503**, describing behaviour that
had since been deleted (H-106, H-112). A sample of ten of the **43** `file.ts:NN` references in
`frontend/src` found essentially none landing on the symbol it named: they point at blank lines, at
`);` mid-expression, at a docblock's own `*`.

`ComposeService.removeContainers` costs a reader one grep and cannot rot. `compose.service.ts:318`
costs the same grep, *plus* the work of noticing it is lying. The rule is not about tidiness: a stale
reference is worse than no reference, because a reader who follows it and lands on plausible-looking
code draws a conclusion from the wrong function. Line numbers are still fine inside one file's own
docblock where the distance is small enough to be checked at a glance, and in `.project/` records,
which are pinned to a commit by construction.

**The class is closed in `frontend/src`, and a lint rule holds it closed.** Re-derived, the
set was **49** rather than 43, every one of them crossing a file and none of them the same-file kind
this rule still permits — and **32 of the 49 line numbers were wrong**, with only **10** landing on
the declaration of the symbol the sentence named. The sample of ten was not unlucky: they pointed at
a docblock's own `*/`, at a `);` mid-expression, at the *wrong option of the right function*, at a
`@RequirePermission` on an unrelated route, and at a list of blocked SCIM paths 280 lines from the
plugin array the sentence was about. All 49 now cite a symbol.

What keeps the count at zero is `frontend/eslint-rules/no-cross-file-line-reference.mjs`, wired into
`frontend/eslint.config.mjs` as an **error**. It reads `Block` and `Line` comment tokens and reports
any cited `*.ts`/`*.tsx`/`*.mjs` path carrying a line number, exempting the two cases named above:
a cited basename equal to the containing file's own, and any `.project/` path. So `pnpm lint` is now
the answer to *"is this section followed"*, and the escape hatch is an inline
`eslint-disable-next-line` with a reason — there are none in the tree today. H-112's objection
stands as written: fixing them mechanically was not a *rule's* job, and it was a separate sweep's.

`backend/src` carries **36** of the same class, heaviest at `compose.utils.ts:80` (3 sites) and
`web-server.ts:124` (2). It is unfixed on purpose: `backend/eslint.config.mjs` has no local plugin,
so wiring one there is its own decision, sized on its own rather than smuggled into that sweep.

### 1.3 Commits state what is now true

The convention is precise, and it is not conventional-commits:

```
<scope>: <lowercase sentence, present indicative, stating what is now true> (#N)
```

Scopes are lowercase feature or process names — `auth`, `deployments`, `console`, `monitoring`,
`ci`, `docs`, `tests`, `run-log`. No `feat:`/`fix:`/`chore:`, no `feat(auth):` parentheses, no
`BREAKING CHANGE`, no emoji, no trailing period, and never a bare imperative ("add X") or past tense
("added X"). The subject describes the world after the commit:

```
environments: an Environment's Deployments and Domains can be read in one request each
certificates: a certificate no longer carries an auto-renew flag nothing reads
```

Two recurring shapes:

- **`", and"` pairs the win with the surprise** — `monitoring: the web server is set up and read back
  on screen, and an unmeasured host stores nothing`.
- **A fix names the root cause, not the symptom** — `auth: a console screen that will not populate is
  a Suspense boundary awaiting a frame, not a null organization id`.

Issue references are parenthesised and last; `` for several; `(F19)` for a frontend phase,
`(L10)` for a VPS-deploy session. Nothing says "WIP", "should" or "update X".

### 1.4 Reuse before you write

Both workspaces state this, and both mean it as a review question: *did this need to be new?*

- **Backend** — reach for `common/service-parent.ts` (the "which service owns this row" lookup),
  `common/owned-server.ts` (the "is this `serverId` in the caller's organization" lookup — five
  copies of it had drifted apart, and the one that never got written was a security bug),
  `common/pagination/`, and the column helpers in `db/columns.ts` before writing the same thing
  again. `RemoteExecService`, `PermissionService`, `RemoteDockerFactory` and `EncryptionService` are
  all `@Global()`, so using them costs no wiring.
- **Frontend** — `frontend/docs/design-system.md` rule 2: if a component is in its table, import it;
  if you need a variant, add one to its `cva`; only then create something new, **and add its line to
  that table in the same commit**.

**The promotion rule** is the frontend's version of the same instinct, and it is mechanical: anything
a *second* feature imports leaves `features/` — into `components/console/*` if it renders, into
`lib/format/*` if it does not. `lib/format/units.ts`, `lib/format/cron.ts` and
`components/console/variables-card.tsx` all arrived that way.

### 1.5 File size

**≤400 lines for a frontend component or route file**, and a tab panel is its own file
(`design-system.md` rule 4). The number was 200 through F01–F18 and the looser figure has a
documented cost: 200 is what caught `live-card.tsx` doubling to 812 lines when a second store landed
inside it, and at 400 that would have gone unremarked. So the budget is a weaker smell detector than
it was, and **a file quietly absorbing a second feature now has to be noticed by whoever reads the
diff** — which makes it a review concern rather than a grep.

The exemption is by *kind*, not by plea: a module mirroring one wide contract (`lib/api/endpoints/*`,
`keys.ts`, `use-invalidate.ts`) or a file that is a data table rather than a component
(`swarm-concerns.tsx`, `*-spec.tsx`). Splitting those to hit a number helps nobody.
`design-system.md` names all ten current over-400 files by hand; if a new one appears, it needs its
line there.

**The backend has no stated file budget.** Not an oversight worth inventing a number for — but a
service growing past a few hundred lines is where the extracted-helper pattern already in the tree
applies (`environments/environment-feeds.ts`, `applications/application-ops.ts`,
`servers/server-setup.ts`).

### 1.6 TypeScript

- **Split the type import from the value import** of the same module, rather than mixing them:
  `import { DRIZZLE } from '../db/drizzle.module';` then
  `import type { DrizzleDB } from '../db/drizzle.module';`. In the frontend, inline-qualify instead:
  `import { projectsApi, type Project } from "@/lib/api/endpoints/projects";`.
- **Import order** is three groups separated by blank lines — builtins/framework, then absolute, then
  relative. No lint rule enforces it in either workspace, which is why it is here.
- **The frontend is `strict: true`; the backend is not.** See §4 — do not read the backend's looser
  settings as permission.

### 1.7 Tests

Write the test first, at the highest seam that reaches the behaviour, and watch it fail before
making it pass. What follows is what the tree does, and what a reviewer can check.

**A test name states a fact.** Third-person present indicative, describing the capability or the
refusal as something the system does — `refuses`, `creates`, `denies`, `records`, `rejects`,
`builds`, `returns`. Full clauses are normal and good:

```ts
it('a tag is invisible and unusable outside its own organization')
it('denies a protected route with 401 when no credentials are sent')
it('does not go over 100 when a container is over its limit')
```

**`should` is not used.** It appears exactly once across the suites, in `test/app.controller.spec.ts`, which is
untouched Nest scaffold and is not the convention (§4). `describe` names the unit under test for a
unit spec (the exported function, verbatim) and `'<Feature> (e2e)'` for an integration one; nested
`describe`s name a behaviour group — `'cross-org isolation'`, `'remove cascades'` — not a method.

**Expected values come from an independent source.** A test that recomputes the expectation the way
the code does proves nothing. `backend/test/utils/totp.ts` is this rule at its most deliberate: an
independent RFC 6238 implementation, *"so tests don't verify better-auth's codes with better-auth's
own library."*

**Test doubles only at system boundaries, injected through DI.** SSH, a Docker daemon, the network,
mail, a payment or licence API — those get replaced; your own collaborators do not. In the backend
that means `createTestApp({ overrideProviders: [...] })`, used in 60 e2e files, against
`RemoteExecService` (44), `RemoteDockerFactory` (13), `FETCH_CLIENT` (11) and a handful more.
`jest.mock` appears in 8 of 196 files, all of them node/system libraries.

The boundary is **designed for in `src`**, not worked around in the test: `FETCH_CLIENT` and
`OCTOKIT_FACTORY` are exported symbols that exist so a strategy can be handed a different client.
When you find yourself wanting to mock something internal, that is the signal to add a seam.

**Where tests live.** Backend: `backend/test/` mirrors `src/`, with `*.spec.ts` (no Docker) and
`*.e2e-spec.ts` (Testcontainers Postgres, ADR 0002) side by side in the same feature directory.
Fixtures sit with the feature that needs them (`test/deployment-engine/application.fixture.ts`), not
in a central directory. Frontend: co-located **`*.test.ts(x)`** — not `*-spec.ts`, which already names
the declarative form and resource specs in that tree.

**What the frontend suite is for.** Nine tests in two files, and `frontend/README.md` is blunt that
this "is honest about what unit tests gate here, which is very little." The rule it implies: unit-test
pure logic that has already bitten, and verify UI by driving it — `tsc --noEmit`, `eslint`, a clean
`next build`, then a browser at 1440px and 380px in both themes with no console errors.

**One mistake at N sites gets one census test, not N fixes.** When a bug turns out to be the same
mistake in several places, fixing the places you found is not the deliverable: the next site will be
added silently. The deliverable is a census in `backend/test/coding-standards/` (or a co-located
frontend `*.test.ts`) that makes a site N+1 fail the build. Three rules make a census work:

- **Enumerate from the producer's own declarations**, so it cannot miss a producer: every caller of
  the helper off the TS AST, every column in the schema, every member of the backend's union type —
  never a list written by the same person who missed the site.
- **Assert both directions.** An undeclared site fails, and so does a declaration whose site is
  gone; otherwise the allowlist becomes an append-only amnesty.
- **A gate that has never failed proves nothing.** Before landing one, restore the defect (or its
  shape), run the gate, see it red, restore the tree — and say what went red in the commit message.

---

## 2. Backend

`backend/README.md` states six conventions; they are not repeated here. This section is the
code-level detail underneath them.

### 2.1 Module layout

**`src/projects/` is the template, and says so in its own docblock** (`projects.module.ts:5-11`).
`environments/` and `applications/` both carry a comment naming it as their source. A feature is:

```
src/<feature>/
  <features>.module.ts      plural — ProjectsModule
  <features>.controller.ts  plural — ProjectsController
  <features>.service.ts     plural — ProjectsService
  <feature>.schema.ts       singular — the table, its relations, its inferred row type
  dto/<feature>.dto.ts      zod schemas + createZodDto classes
```

Extra collaborators take a **role suffix** rather than being bent into a service: `*.provider.ts`,
`*.strategy.ts`, `*.factory.ts`, `*.client.ts`, `*.adapter.ts`, `*.port.ts`, `*.types.ts`,
`*.utils.ts`. Query helpers extracted from a fat service keep a descriptive name
(`environment-feeds.ts`, `server-audit.ts`).

**Schemas are per-module and re-exported from `src/db/schema.ts`**, which is nothing but
`export *` lines so drizzle-kit sees every table without anyone maintaining a list. The direction of
imports matters: a **service imports tables from the barrel**, while a **schema imports its
neighbours directly** to declare foreign keys.

### 2.2 Controllers are thin

A handler resolves the caller's context and returns the service's promise. That is all.

```ts
@Get(':id')
findOne(
  @CurrentUser() user: AuthSession['user'],
  @CurrentSession() session: Session,
  @Param('id') id: string,
) {
  return this.projectsService.findOne(toCtx(user, session), id);
}
```

- **Handlers are not `async`** — they return the promise rather than awaiting it, unless they need
  the value (forwarding better-auth's `Set-Cookie` is the attested reason to await).
- **Parameter order** is `@CurrentUser`, `@CurrentSession`, `@Param`, `@Query`/`@Body` last.
- **Method names are Nest's CRUD names** — `create`, `list`, `findOne`, `update`, `remove`. Not
  `getAll`, not `delete`.
- **Route prefixes are the plural kebab-case resource** in `@Controller('ssh-keys')`. No global
  prefix, no `@Version`. Nested reads hang off the id — `@Get(':id/deployments')` — and verbs are
  `@Post(':id/start')`. A bare `@Controller()` with full paths per method is the exception, used when
  routes genuinely span resources (`deployments.controller.ts`, which documents why each route lives
  there).
- **Every `@Post` states its status code unless it creates a resource**. Nest answers
  `201 Created` for a `@Post` it is told nothing about, and this API's POSTs are mostly verbs —
  `start`, `stop`, `revoke`, `restore`, `prune`, `validate`, `test-connection` — where `201` names a
  thing that was not created. So: a POST whose effect is bringing a new addressable row into
  existence carries no decorator and keeps `201`; **everything else carries an explicit `@HttpCode`,
  immediately below the `@Post`** — `200` when the handler answers with something, `204` when it
  answers with nothing at all. The decision follows the handler's *effect*, not its path: a verb that
  hands back a freshly inserted row (`POST /applications/:id/deployments`) is a create; a noun-shaped collection POST that only edits a `jsonb` array
  (`POST /sso/trusted-origins`) is not.
- **`@HttpCode(204)` is a claim about the body, not a synonym for "nothing interesting".** Nest sends
  the body it was given alongside whatever status it was told, and a 204 carrying content is a
  protocol error for some clients. Read what the handler actually returns before choosing it — a
  handler ending `return this.service.remove(...)` is returning the deleted row, and a service typed
  `Promise<void>` is the only thing 204 describes.
- **No `@UseGuards`, no `@UsePipes`, no `@ApiTags` — zero of each in `src/`.** `AuthGuard` and
  `PermissionsGuard` are registered as `APP_GUARD`; `ZodValidationPipe` as `APP_PIPE`. Opt out of
  auth with `@Public()`, never by ungating a guard.
- **Never catch-and-respond** (ADR 0005). A controller that try/catches to shape an error is
  reimplementing `AllExceptionsFilter`.
- **Scope is resolved in the service, not the controller.** The controller builds a `PermissionCtx`
  and passes it down; the service calls `checkProjectAccess` / `checkServiceAccess` /
  `checkEnvironmentAccess`, which filter by `organizationId` so a row in another organization reads
  as 404 rather than 403. Do not resolve a project or environment in a controller to "save a query" —
  that is how a cross-tenant read gets written.

**Swagger decorators are the exception, not the rule.** The OpenAPI document is reflected off
`createZodDto` metadata, so decorating for it is redundant. The three attested reasons to reach for
one: `@ApiSchema({ name })` to disambiguate two modules exporting the same DTO class name (without it
one silently overwrites the other); `@ApiOkResponse`/`@ApiProduces` for a response a zod DTO cannot
express; `@ApiExcludeController()` for a catch-all proxy route.

### 2.3 Services

```ts
@Injectable()
export class ProjectsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: DrizzleDB,
    private readonly permissions: PermissionService,
  ) {}
```

`private readonly`, database first, short noun property names (`db`, `permissions`, `remoteExec`,
`config`). **No repository layer and no second driver** — `pg` with a `Pool`, per ADR 0004.

**`this.db.transaction(async (tx) => …)` for a read-then-write invariant** — a uniqueness check and
the insert that depends on it belong in one transaction. Side effects that must not be rolled back
by a later failure, and must not hold the transaction open, go **after** the commit; granting the
creator access in `applications.service.ts:68` is the pattern.

A public method's docblock says what it does and how it is scoped to its caller: `/** Updates a
Project, org-scoped through findOneForUpdate. */`.

### 2.4 Validation is zod, once, globally

`class-validator` is not a dependency. A DTO is an exported zod schema plus a class extending
`createZodDto`, validated by the one global pipe — **a controller never validates by hand**:

```ts
export const createProjectSchema = z.object({
  name: z.string().min(1, 'name cannot be empty'),
  description: z.string().optional(),
});
export class CreateProjectDto extends createZodDto(createProjectSchema) {}

export const updateProjectSchema = createProjectSchema.partial();
export class UpdateProjectDto extends createZodDto(updateProjectSchema) {}
```

**Derive with combinators, never re-declare** — `.partial()`, `.pick()`, `.omit()`, `.extend()`. A
second hand-written schema that repeats the first is the thing this rule exists to catch. Field
messages are inline and lowercase. The same zod validates the environment (`common/config/env.schema.ts`),
so there is one validation technology in the app.

### 2.5 Errors

Throw Nest's built-in `HttpException` subclasses; one `AllExceptionsFilter` renders every one into
`{ statusCode, error, message, details?, path, timestamp }` (ADR 0005). There are **no custom domain
exception classes**, and adding one is a change to the contract, not a local decision.

Messages are sentence-case, no trailing period, and name the entity: `'Project not found'`,
`'No active organization'`. A message is read by an operator, so it says what is wrong — never an
internal detail, which the filter would leak.

### 2.6 Database

- **snake_case in SQL, camelCase in TS, both spelled out.** No `casing` shortcut; every column names
  its SQL identifier: `projectId: nanoidPk('project_id')`.
- **Table names are singular** — `'project'`, `'server'`, `'application'`. `pgEnum` names are
  snake_case.
- **Primary keys are `<entity>Id` via `nanoidPk`**, never a bare `id` — except better-auth's own
  tables, which keep the shape better-auth gives them.
- **Timestamps are `isoTimestamp('created_at')`** — ISO-8601 strings in `text`. Real `timestamp()`
  columns exist only where better-auth compatibility demands them. Most tables carry `createdAt`
  alone; there is no `updatedAt` convention.
- **There are no soft deletes anywhere.** Deletes are hard, with `.returning()`. The "invisible row"
  behaviour comes from organization scoping, not a flag — do not add one.
- **Secrets are the `encryptedText` / `encryptedJson` column type** from `db/columns.ts`, never hand
  encryption in schema code (ADR 0006). `EncryptionService` is for non-column values.
- **Foreign keys always declare `onDelete`** — `'cascade'` for ownership, `'set null'` for an
  optional reference.
- **Writes use `.returning()` and destructure**; every schema file ends with a `relations` export and
  an inferred `$inferSelect` type.
- **Reads: `select().from()` for scoped single rows and any projection or join;
  `db.query.x.findFirst({ with: … })` for a deep relation tree.** A list read that would fan out per
  row uses a Drizzle subquery and `leftJoin` instead — `projects.service.ts:94-100` states the rule
  and the trap: *"swapping an HTTP N+1 for a SQL N+1 would be no fix… A join must never widen what a
  restricted member sees."*

**Migrations** are generated (`db:generate`), then **renamed to `NNNN_kebab-case-description.sql`**
with the `tag` in `drizzle/meta/_journal.json` edited to match — `0000_swift_power_man.sql` is the
only survivor of drizzle-kit's random slugs. **Never `db:push` on a database you intend to keep:** it
writes the column and no journal row, and the next `db:migrate` dies on an `ALTER TABLE` that has
already happened, reporting it by exiting 1 with nothing on stdout or stderr.

### 2.7 Logging

`private readonly logger = new Logger(ThisClass.name);` — the plain `@nestjs/common` logger, as a
field. `nestjs-pino` is wired at the edge and imported in exactly three files (`main.ts`,
`common/common.module.ts`, `common/logging/logger.config.ts`); `PinoLogger` and `@InjectPinoLogger`
are not used. **`console.*` is not how this codebase logs** — see §4 for where it nonetheless is.

### 2.8 Configuration

One zod `envSchema` (`common/config/env.schema.ts`), validated at boot via
`ConfigModule.forRoot({ isGlobal: true, validate: validateEnv })`, which fails with every bad key
listed rather than the first. Access it through an injected `ConfigService` conventionally named
`config`; `getOrThrow` for what must exist. Each key carries a comment saying what it controls.

`process.env` direct reads are confined to code that runs before DI exists or outside it — bootstrap,
module-level constants, pure non-DI functions. **A constant computed at import time is a trap**:
`localCloudgateDirectory()` is a function rather than a constant precisely because *"a constant
computed at import time would silently miss a `.env` entry"*, and the same reasoning is why
`realtime.module.ts` uses `useFactory` over `useValue`.

### 2.9 Reaching a Server or a daemon

**Anything touching a Server goes through `RemoteExecService`**; **anything touching a Docker daemon
goes through `docker/`'s client provider or `RemoteDockerFactory`**. A feature module never opens its
own SSH connection. Both modules are `@Global()`, so there is no wiring excuse. This is also the seam
every test overrides — a module that bypasses it cannot be tested without a real host.

**The shape of the command decides the method**. Four, in two pairs:

| | one command | a shell *program* |
|---|---|---|
| platform host | `execFileAsync(program, args, {input, cwd, env})` | `execAsync(command, options)` |
| a Server | `execRemote(serverId, argv, onData?, options?)` | `execAsyncRemote(serverId, command, onData?, options?)` |

Callers that dispatch on a `serverId` reach for `remote/exec-dispatch.ts`'s
`execOnServer(remoteExec, serverId, command)` rather than writing the fork again: it takes
`string[]` or `string` and picks the cell. Twelve modules do, and the ops helpers that only want the
output take its `execOnServerStdout` projection rather than keeping their own.

- **A single command passes argv, and the caller quotes nothing.** `['cat', path]`, not
  `` `cat ${quote([path])}` ``. Locally that is genuinely shell-free (`child_process.execFile`);
  remotely `execRemote` joins it with `quote()` itself.
- **A shell program passes a string, and every interpolation in it is still the builder's to
  `quote()`.** A pipeline, `&&`/`||`, a redirect, `set -e`, an inline `$(…)` — `compose.utils.ts`,
  the builder strategies and the git strategies are all of this kind, ~92% of the tree's 113
  `quote()` calls, and they are not going away. `quote()` in a script builder remains mandatory.
- **`execRemote`'s argv is an API guarantee, not a shell-free wire, and that is not a bug to file.**
  RFC 4254 §6.5's `exec` request carries one length-prefixed string, which sshd hands to the login
  shell; `ssh2` writes exactly that (`ssh2/lib/protocol/Protocol.js:1280-1288`) and `@types/ssh2`
  has no array overload. The remote shell always parses the joined string. What argv buys is that
  the joining happens once, behind a test, instead of at every call site from memory — which is the
  failure that shipped twice, both times a file path spliced into a trivial `cat`. The method's own
  JSDoc carries the citation; read it before proposing a transport change.

Three other quoting conventions stand beside this and are not replaced by it: `assertShellSafePath`
/ refuse (`docker/docker.utils.ts` — a path that cannot be worded safely is a 400, not an
escape), `shEscape` (`registries/registry.utils.ts`, `git-providers/strategies/docker.strategy.ts` —
local single-quoting in files that already had one), and `quote()` itself.

### 2.10 WebSocket gateways

Six gateways, one path each, all work in `handleConnection(ws, req)`. The rules are security rules,
and each has a reason in the file:

- **Authenticate by calling `wsAuth.authenticate(ws, req)` manually, before reading a single query
  parameter.** `WsAuthGuard` deliberately does not implement `CanActivate`, because *"Nest guards
  never run for raw `ws` connections"*. A gateway that forgets the call is unauthenticated, and
  nothing else will catch it. Validating first, which five of the six still do (§4), answers an
  anonymous caller a `4000` that describes the gateway's contract, and leaves the parameter
  handling one reordering away from answering about the ids behind it (ADR 0007).
- **Parameters come off the URL, not a DTO** — the global pipe never sees a socket.
- **Denial is a close code, not an exception** (`ws.close(4000, …)`); the exception filter is
  HTTP-only.
- **Unknown id and wrong organization collapse to the same close**, via
  `findAuthorizedServer(...)`, so the socket is not an enumeration oracle.
- **Every authorized socket arms an authorization lease** with
  `armAuthorizationLease(...)`, passing the *same* thunk its connection handler
  authorized with, so the authorization is re-run every 30 seconds and the socket
  closes `4010` when it stops passing (ADR 0012). A gateway that authorizes only
  at connect keeps streaming to a Member whose entitlement was withdrawn, for as
  long as they hold the socket open — a defect that was in all six
  at once. Nothing in the compiler catches a seventh that forgets;
  `test/realtime/gateway-leases.e2e-spec.ts` enumerates the directory and is what
  does.
- **Every input that reaches a shell is regex-validated** through `realtime/ws.utils.ts`
  (`isValidContainerId`, `isValidTail`, `isValidShell`, `readValidDirectory`, …), and paths are
  base64-smuggled into remote commands so no shell metacharacter survives.
- **Every socket arms a keep-alive** with `armKeepAlive(...)`, which pings every 45 seconds and
  `terminate()`s a peer that has not answered by the next tick. It is not the lease and does not
  replace it: a lease ends a socket whose *authorization* went away, a keep-alive ends one whose
  *peer* did. Without it nothing in the module can tell a live peer from a vanished one, so every
  timer hung off the socket keeps firing — the stats gateway kept spawning a `docker stats`
  subprocess every 1300ms for nine minutes after its tab was closed. A ping that registers no
  `'pong'` listener is worse than none, because it defeats the proxy idle timeout that would
  otherwise have ended the socket. `gateway-leases.e2e-spec.ts`'s enumeration guards this too.
- **Never call `ws.send` from a gateway.** Every send goes through `sendIfOpen(ws, data)`, which
  guards `ws.readyState === ws.OPEN` and answers whether the frame went out, so the callers that
  close afterwards do not close a socket that was already gone. Guarding by hand was the rule and was
  unmet at sixteen of the twenty-six sends here, in every shape the omission takes; a real `ws` does
  not throw for it — the error goes to a callback, or to the socket's `'error'` event when there is
  none — so an unguarded send is silent in production and invisible in a test that drives it.
  `gateway-leases.e2e-spec.ts` asserts the *absence* of a raw `.send(` across the directory, checked
  on `.send(` rather than `ws.send(` so renaming the socket parameter does not slip past it. Tear the
  channel down on `close`, which is the single teardown point and what `terminate()` reaches it by.

### 2.11 The OpenAPI document

`backend/openapi.json` is checked in **so a contract change arrives in review as a diff next to the
DTO that caused it**. Regenerate with `pnpm --filter backend openapi:generate` in the same commit as
any controller or DTO change; CI runs the staleness assertion with the unit lane. Nothing hand-declares
a schema — request shapes come off the `createZodDto` classes the global pipe already validates
against.

It is **not the frontend's type source** (§3.5).

---

## 3. Frontend

`frontend/docs/design-system.md` is the authority for the visual layer and the component index —
read it before writing a component. This section is everything else.

Note the framework facts, because they defeat training data: **Next 16.2.10 and React 19.2.4, exact
pins**; the session gate is **`src/proxy.ts`**, Next 16's rename of `middleware.ts`; the primitives
are built on **Base UI, not Radix**; `error.tsx` takes `unstable_retry`, not `reset`. Per
`frontend/AGENTS.md`, read the guide in `node_modules/next/dist/docs/` before writing route code.

### 3.1 Where code goes

| Directory | Holds |
|---|---|
| `src/app/**` | Routes only — Next's own file names. Route-local components go in `_components/` (the underscore keeps it off the router). |
| `src/components/ui/*` | 15 vendored shadcn `base-nova` primitives. **Never forked** — add with `pnpm dlx shadcn@latest add`, extend variants. |
| `src/components/console/*` | Our compositions on top of `ui/`. |
| `src/components/shell/*` | Masthead, scope rail, ⌘K palette, scope model. |
| `src/features/<scope>/*` | One directory per scope: `panels/` (one file per registry tab), `use-<feature>.ts`, and job-named subdirs. |
| `src/lib/*` | Non-visual — the API client, endpoints, keys, auth, realtime, formatters, design tokens. |

Routes are **flat**: one segment, an id, and an optional catch-all tab —
`applications/[applicationId]/[[...tab]]`. `databases/[kind]/[databaseId]/[[...tab]]` is the single
exception, because `GET /:id` needs the engine to know which controller to ask.

### 3.2 `"use client"` marks an entry point

Now the directive lands **only on files a Server Component imports** — 93 files, at
screen, section and panel level. Zero in `components/ui/*`. A leaf component does not carry it, and
one that pointedly omits it says so in a comment, because the omission looks like an oversight:

> No `"use client"` here, which is the rule across `src` rather than this file's exception.

Adding the directive to a leaf is not harmless — it is the boundary moving without anyone deciding.

### 3.3 Components

- **kebab-case filenames**, universally. Hooks are `use-*.ts`.
- **Named `export function PascalCase`.** Default exports are only Next's route files and the 37
  `features/*/panels/*.tsx`, which the tab registry loads with `next/dynamic`.
- **Props: `export type XProps` for a shared primitive, an inline object type for a one-off.**
  **Never `React.FC`. Never `interface XProps`** — zero of each in the tree; `interface` is for data
  shapes in `lib/api/endpoints/*`.
- Three composition idioms worth reaching for: `React.ComponentProps<"span"> & VariantProps<…>` to
  extend an element; a **discriminated union** where misuse should fail to compile
  (`status-pill.tsx:9-24` makes `status` and `mark` mutually exclusive); `Omit` the clashing DOM
  attribute rather than intersecting it.
- **Compound components** for anything with parts: `Card.Header` / `.Body` / `.Footer`, `Modal.*`,
  `Tabs.*`, `Menu.*`.
- **`cva` only where variance is real** — five files use it. Elsewhere a lookup map (`TONE_PILL[tone]`)
  or plain `cn()` conditionals. A `cva` with one variant is ceremony.
- `components/ui/*` and `lib/utils.ts` are semicolon-free shadcn CLI output; everything we write is
  semicolon-terminated. Do not normalise either into the other.

### 3.4 Styling

Two rules from `design-system.md` are cited often enough to restate:

1. **No hardcoded design values.** No raw hex, no `rgb()`, no px font sizes, no off-scale spacing.
   `src/app/globals.css` is the only file allowed a literal; a missing value becomes a **token**
   there, not a literal in the component. The one exemption is vendored `ui/*`, and its size is
   measured — exactly three literals in three files. Everything we write has none.
2. **Meaning never rests on a glyph or a hue alone.** Every status mark renders its word, visibly in
   a pill or in an `sr-only` span beside a bare dot.

Tokens are **roles**, not colours: `--ground`, `--panel`, `--tx`/`-2`/`-3`, `--brand*`,
`--ok/--warn/--bad/--info`. `--tx-4` is decoration only and never carries meaning. `--chart-1..5` is
status; `--series-1..4` is identity — swapping them is a bug. `cn()` is an `extendTailwindMerge` in
`src/lib/utils.ts` whose theme lists every token group, so **a new token needs a line there too**.

### 3.5 The data layer

Typed `fetch` + TanStack Query on the client, and `better-auth/react` for session and Organization
state — **deliberately not RSC or server actions**, because the app is mutation-, tab- and
stream-heavy.

- **`lib/api/endpoints/*`** — 40 hand-written modules, one per controller, each exporting interfaces
  and a `<name>Api` object with `list` / `findOne` / `create` / `update` / `remove`. Hand-written on
  purpose: `openapi.json` describes request shapes from zod DTOs, and a controller returning a
  plugin's result verbatim has no DTO to generate from. **Do not replace these with a generated
  client**; `endpoints/users.ts` records why.
- **Hooks are `useX` and `useCreateX`** — not `useXQuery`. They live with their feature
  (`features/<scope>/use-<scope>.ts`); the seven genuinely cross-feature ones sit in `lib/api/`.
- **Keys come from the one factory, `lib/api/keys.ts`.** Three roots, and choosing between them is a
  statement: `org(organizationId)` for tenant data, `account` for the person, `instance` for pre-auth
  config. A hand-assembled key array in a component is a defect.
- **A mutation never assembles a key** — it calls `useInvalidate()`. Use `onSettled` rather than
  `onSuccess` for a lifecycle mutation that can time out mid-success.
- **`enabled: organizationId !== null`** pairs with every org-scoped key. A `null` organization must
  not fetch.
- **Terminal-state order is `error` → `isPending` → `empty`**, because **a refusal is not an empty
  list**. Rendering "Nothing here yet" for a 403 tells the user the opposite of the truth.
- **Never render `ApiError.message`.** Use `errorMessage(error)`; `toast.error` takes the thrown
  value, not a string. A 403 is **not** a sign-out — 401 is acted on in exactly one place
  (`query-client.ts`).
- No HTTP cache in front of TanStack Query — `cache: "no-store"` is set for a documented reason
  (Express ETags → 304 → a fabricated `ApiError`). Routes returning `Promise<string>` from Nest use
  `getText`/`postText`.

### 3.6 Forms

`useApiForm` + `Field`, and no third mechanism. `useApiForm` exists for the failure routing: a 400
with field issues goes back to the field, an issue whose path is not a field on this form goes to
`root` rather than vanishing, and anything else goes to `root` plus an optional toast.

- **Every `<form>` carries `method="post"`.** A pre-hydration submit on a method-less form is a GET,
  which once put `?password=…` into the address bar and the history.
- Dialogs are held at **list** level, never inside a row — a re-sort unmounts them — and every
  opening is **keyed**, because `useApiForm` reads `defaultValues` once.
- `Field` owns the wiring (`id`, `register`, `aria-invalid`, `aria-describedby`); pass `manual` when
  a `Controller` owns the value.
- Repeated CRUD is a **`*-spec.tsx` config**, not another component.

### 3.7 Auth

**Nothing calls `/api/auth/*` by hand** — `lib/auth/client.ts` is the one client, and it re-exports
the surface. `useActiveOrganizationId()` is the tenant boundary every query key is scoped by, and it
reads the already-loaded session rather than costing a request.

Route protection is `src/proxy.ts`, which checks cookie **presence, not validity** — the real check
is the backend's. Its matcher is a negative lookahead **so a new screen is protected by existing**;
adding a route to an allowlist is how one silently ships unguarded.

**One layout guard exists, and it is the only one permitted: the console shell's dead-session exit**.
The proxy lets an expired-but-present cookie through on the understanding that the first
401 corrects it — but a screen that fetches nothing until it knows the organization never sends a
first request, so no 401 arrives and the shell paints its full authenticated frame, empty, for a
visitor with no session. A layout may guard *only* to close that gap, and it **ends the session**
rather than merely redirecting, so the stale cookie cannot re-enter on the next navigation. The same
guard also replaces the shell, *without* ending the session, when a good session's user is no longer
a member of its active Organization — one more fact into `console-gate.ts`, not a second
guard. Anything a route can protect stays in `proxy.ts`; a second layout guard is a sign the matcher
was wrong.

Sign out is three steps — end the session, empty the query cache, leave with a full navigation.

### 3.8 Realtime

`useSocketStream` is reached **only** through `lib/realtime/gateways.ts`; outside that file and
`terminals.ts`, nothing assembles a socket URL. The socket lives outside React in a store subscribed
with `useSyncExternalStore`, because a build emits hundreds of frames a second and driving that
through `setState` would re-render on every one.

A log well **renders lines and never parses them** — tone maps belong to the feature. Heavy widgets
(CodeMirror, xterm) sit behind `next/dynamic` with `ssr: false`, verified absent from every route
manifest in a production build.

### 3.9 State

**No global store library** — no zustand, jotai, nanostores, redux or nuqs. The query cache is the
store for anything server-derived. Four contexts are the shell's — the scope, the palette's opener,
and the terminal dock's API and its panel element — and `features/project/plan-aws-lines.tsx`
holds one more, a cloud's display name; all are consumed with React 19's `use()`.

Browser-owned state is three shell files plus `rail-state.ts` and `dock-state.ts`, and
`localStorage` is touched in exactly three: `local-store.ts`, `rail-state.ts` and `dock-state.ts`. The collapsed rail is **an attribute on `<html>` written by a blocking inline script**,
not React state, because state would reflow 200px after hydration. Local UI state is `useState` in
the screen that owns it; eslint bans setState-in-effect, and `console-shell.tsx` shows the idiom for
resetting on navigation without one.

### 3.10 Accessibility

- **Four terminal states are four components, and picking the wrong one is a bug**: `EmptyState`
  (nothing yet — plus the action that creates the first, "an invitation to act, not a report that a
  query returned zero rows"), `NoListing` (the data has no endpoint), `Outcome` (a bad id or a page
  that threw — a missing resource is `info`, never `bad`), `AuthOutcome` (inside the auth column).
- **Skeletons are `aria-hidden` and the region carries `aria-busy`**, sized to the value they
  replace so nothing moves on arrival.
- **The modal focus trap is ours** (`containTab` in `modal.tsx`), not the library's — after tabbing
  out of a dialog landed on the masthead with the dialog still open.
- **`aria-disabled` for actions** (they keep their tab position and can say why they are off) vs
  **native `disabled` for form inputs**.
- Anything that navigates is a `Link`/`LinkButton`, never `<button onClick={push}>`, so it opens in a
  new tab. `CopyButton` reports in place, not in a toast: a toast is for something that already
  happened and needs no answer, a decision is a `Modal`, and a bad field belongs beside the field.
- Sentence case everywhere, quiet labels, and copy is design material — a control says what happens
  ("Save changes", not "Submit") and keeps the same word through the whole flow.

---

## 4. Known gaps

**These are not standards, and a reviewer must not cite them as violations.** They are places where
the code and the intent disagree, recorded so the difference between drift and a rule is visible.

| Gap | Evidence | What it means |
|---|---|---|
| The backend `tsconfig.json` is **not** `strict` — `noImplicitAny: false`, `strictBindCallApply: false`, no `strict` | `frontend/tsconfig.json` is `strict: true` | Not permission. New backend code should type-check as if strict; the asymmetry is unexplained and worth closing deliberately. |
| `console.*` at ~45 sites, concentrated in `src/settings/` | `gpu.service.ts`, `traefik-setup.service.ts`, `settings.controller.ts`, `cleanup.service.ts` and others | Drift from §2.7, being paid down. `main.ts`'s single call, after `app.listen`, is legitimate. |
| `toCtx` copy-pasted **verbatim into 49 controllers** | every feature controller | The obvious `@CurrentCtx()` param decorator, not yet extracted. Real duplication; do not read §2.2 as endorsing it. |
| `signUp` copy-pasted into **81 of 89** e2e specs | `backend/test/**/*.e2e-spec.ts` | `test/utils/test-auth.ts` covers the *member* half only — `signUpMember`, extracted because a copy that never accepted its invitation made role assertions unable to fail. The owner `signUp` has no harness and stays duplicated; that half is pure duplication with no correctness claim behind it. Same shape as above. |
| `common/pagination/` is imported by no `src/` file | only `test/common/pagination.spec.ts` | `backend/README.md` calls it reusable; it is prescriptive, not yet descriptive. |
| `test/app.controller.spec.ts` and `test/app.e2e-spec.ts` | `it('should return "Hello World!"')`, hand-rolled module setup | Untouched Nest scaffold. They contradict §1.7 and are not the convention. |
| **37 top-level `describe`s in non-e2e specs are prose rather than the unit under test** | the `BASELINE` list in `backend/test/coding-standards/describe-names.spec.ts`; 37 of 248 | Drift from §1.7, not permission. That test freezes the list — a thirty-eighth *that opens with prose* fails it, and the only correct edit to the list is a deletion. It matches the title's leading symbol rather than the whole title, so a bound name with prose bolted on (`trustedProxyRanges as the gate on an incoming chain`) still passes; requiring the whole title to be a bound name rejects sixty-two legitimate `Class.method` and `name` titles, so the looser rule is the deliberate one — so the thirty-seven are a shrinking debt rather than a precedent. Every one of them predates §1.7: a spec written after it names its unit, and `test/common/container-logs.spec.ts` — born in the same wave — was corrected rather than baselined. §1.7 states the shape a new spec follows. |
| Five of the six gateways read `searchParams` before `wsAuth.authenticate` | `container-logs`, `container-terminal`, `docker-stats`, `server-setup`, `server-terminal`; only `deployment-logs` authenticates first | Drift from §2.10's first rule, not permission. Their `4000` answers an unauthenticated caller; §2.10 states the order new gateway code follows. |
