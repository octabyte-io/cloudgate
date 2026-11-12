# Cloudgate design system

**Read this before writing a component.** It is the index every frontend phase consults first.

The visual system comes from `frontend/docs/e-console.html` — direction E, "console". Live
reference for everything below: **`/dev/tokens`**, which measures its own contrast claims in the
browser and re-measures them when you switch the theme.

## The rules

1. **No hardcoded design values.** No raw hex, no `rgb()`, no px font sizes, no off-scale spacing in
   any component. `src/app/globals.css` is the only file allowed to hold a literal. If the value you
   need is missing, add a *token* there and a line here — never a literal in the component.

   **One exemption, and F19 measured its exact size: vendored `src/components/ui/*`.** Rule 3 says
   never fork those files, and rule 1 says no literals — a shadcn component that ships one puts the
   two rules in direct conflict, and rule 3 wins, because editing a vendored file to satisfy a grep is
   how the next `shadcn add` silently reverts it. After F19 deleted the three shadcn components
   nothing imported (`toggle`, `toggle-group`, `tooltip` — `toggle` carried the codebase's only raw
   type size), the exemption is **three literals in three files, all shadcn-stock and never edited by
   us**: `tabs.tsx` `p-[3px]`, `switch.tsx` `h-[18.4px] w-[32px] h-[14px] w-[24px]`, and
   `dropdown-menu.tsx` `min-w-[96px]`. That is the whole list. **Everything we write still has none**,
   so run audit 1's greps with `--exclude-dir=components/ui` and expect silence.
2. **Reuse before you write.** If a component is in the table below, import it. If what you need is a
   variant of one, add a variant to its `cva`. Only then create something new — and add its line to
   the table in the same commit.
3. **Never fork `src/components/ui/*`.** Those files are shadcn's (`base-nova`). Add them with
   `pnpm dlx shadcn@latest add <x>` and extend their variants. Ours live in
   `src/components/console/*` as compositions on top.
4. **Small files.** ≤400 lines, component or route file. A tab panel is its own file.

   **The number was 200 until F19 finished, and it is worth knowing what changed and what it
   costs.** 200 was the rule through F01–F18 and it did real work: `live-card.tsx` grew from 365
   to 812 lines when a second store landed inside it, and the budget is what caught that. At
   400 it would have gone unremarked until it roughly doubled again. So the looser number buys
   less as a smell detector, and the thing it used to catch — a file quietly absorbing a second
   feature — now has to be noticed by whoever reads the diff. What the change reflects is that
   200 was aggressive for a component that owns a form, its states and its copy: F19's sweep
   split 40 files down from 812 → 193 at the top end, and the ones that were merely 210 or 230
   were being cut to hit a number rather than because anything was wrong with them.

   The budget is about components. A `src/lib/api/endpoints/*` module may run longer when it is
   mirroring one wide table — `applications.ts` is 233 lines because the `application` row has that
   many columns, and scattering one contract across files to hit a number helps nobody. The same
   goes for the other non-component modules that carry one wide contract each: `channels.ts` (917),
   `keys.ts` (900), `kinds.ts` (670), `use-invalidate.ts` (566), `endpoints/monitoring.ts` (491),
   `use-advanced.ts` (443) and `endpoints/settings.ts` (437).
   *(The three counts in the paragraph below re-measured 2026-09-18; the list above, 2026-08-25. `keys.ts` had drifted 861 → 900 and `endpoints/settings.ts` crossed
   400 in the second fix wave — 351 → 437 — without being listed here at all, which is the failure mode
   a register has: it is only as true as its last reading. `providers.ts` (501) is dropped: the file at
   that path is 35 lines, so the entry named something that has since moved or gone.)*
   **The same exemption covers a file that is a *table* rather than a component**, and it still does
   work at 400: `swarm/swarm-concerns.tsx` (567) is the eleven Docker Swarm concerns as data —
   with the column each of them edits, so a refusal names a card rather than a column —
   `swarm/swarm-values.ts` (441) is the pure fold in and out of eleven JSON columns,
   `compose/converted/converted-plan.ts` (439) is the one description of what a Deployment will
   change, read by the Converted plan, the Stack facts card and the isolation toggle alike,
   `networking-specs.tsx` (419) is three `ResourceSpec` factories with no component in it, and the
   `*-spec.tsx` files are one `ResourceSpec` each. All four named here are over 400 on the
   2026-09-18 reading and so still need the exemption — `swarm-values.ts` and `converted-plan.ts`
   are `.ts` folds rather than components — and every `*-spec.tsx` now sits under 400 on its own. Splitting them to hit a number would produce exactly
   the eleven-forms-per-concern shape the
   shared scaffolding exists to avoid. **The exemption is by kind, not by filename** — `-specs.tsx`
   and `-spec.tsx` are the same thing, and F19 had to settle that once. It is not a licence for a
   long *component*: F10's two that grew past the budget were split (`restore-steps.tsx` out of the
   restore modal, `preview-columns.tsx` out of the Previews panel).
5. **Meaning never rests on a glyph or a hue alone.** Every status mark renders its word too —
   visibly in a pill, in an `sr-only` span beside a bare dot.
6. **Vocabulary is non-negotiable** (`CONTEXT.md`): Organization, Project, Environment, Application,
   Deployment, Server. Third-party strings keep their own names (Docker Swarm's manager/worker, a DNS
   "Host" column, GCP's "Machine type").
7. **Sentence case, and quiet labels.** The reference does not shout its group labels; uppercasing
   them is the fastest way to look like a different product (`e-console.html:340`).
8. **Copy has a budget, and the next action comes first**. On-screen copy is written for an
   operator deciding what to do next. It is not for the next person to read the code:
   - **A page lede** (`PageHeader`'s `lede`) is **one sentence**: what the page is for. No `strap`
     under it to carry a second paragraph.
   - **An empty-state body** (`EmptyState`'s children, a list card's `empty`) is **one or two
     sentences, and the first names the next action**, in the words of the button beside it:
     "Add a Server to deploy onto…", not "No Servers yet. A Server is…". The title already says
     what is missing.
   - **A meta strip, card `sub` or note** says one thing in one sentence. A banner or note shows
     only while its condition holds. It does not stay up on a screen where it cannot apply yet,
     like "the running container keeps…" on an Application that has never run.
   - **No rationale on screen.** How the data model works, what is *not* true, why a control looks
     the way it does, what an empty table "would claim": all of that goes in a code comment beside
     the copy (CODING_STANDARDS §1.2), or is dropped. A fact the operator needs before acting stays,
     in one sentence. A product fact that needs a paragraph goes in a reference card the screen
     links to, not on every screen.

   `src/components/console/first-run-copy-budget.test.ts` holds the screens on the first-run path to the lede and
   empty-state counts: Organization home, Projects, a Project's Environments, an Environment's
   Services and Variables, Deployments, Templates, and an Application's Overview and Variables.
   A screen joins its list when it is brought within the budget.

## Where things live

```
src/app/globals.css              role tokens, shadcn aliases, @theme, base layer, @utility
src/app/providers.tsx            QueryClientProvider + ThemeProvider, mounted in the root layout
src/app/dev/tokens/              the live gallery — the proof and the reference
src/app/dev/data/                the data-layer harness — session, org scope, refusals, one socket
src/lib/design/status.ts         STATUS / CONTAINER_STATE / TASK_STATE / GUT + tone→class maps
src/lib/design/chart.ts          the chart palette: tone (state) vs slot (identity), and plot geometry
src/lib/design/icons.tsx         the one lucide map, keyed by the prototype's icon names
src/lib/design/contrast.ts       measures a token pair's real WCAG ratio in the browser
src/lib/utils.ts                 cn() — and the tailwind-merge config that makes it honest
src/app/dev/primitives/          controls, surfaces, status, flows, overlays, forms
src/app/dev/primitives/data/     tables, readouts, telemetry, streams — on real infra content
src/components/ui/*              shadcn-owned (base-nova). Extend, never fork.
src/components/console/*         ours: compositions on top of ui/*
src/components/shell/*           the masthead, the scope rail, ⌘K and the scope model (F05)
src/app/(console)/               the console route tree, inside the shell
src/app/(auth)/                  everything before the console — the doors (F06)
src/proxy.ts                     the session gate. **Not** `middleware.ts` — see The doors
frontend/docs/design-system.md   this file
```

### `cn()` knows our theme, and has to

`src/lib/utils.ts` does not export bare `twMerge`. tailwind-merge works out which CSS property a
class sets from Tailwind's *own* scales: `text-sm` is a font size because `sm` is a t-shirt size, and
anything else after `text-` is assumed to be a colour. Our type scale is named — `text-body`,
`text-ui`, `text-chip` — so every step of it looked like a colour, and `cn("text-body",
"text-primary-foreground")` collapsed to one class instead of a size and a colour. F03 found this the
expensive way: the primary button had silently lost its white label and the segmented control its
13px, in classes that were right there in the source.

So `cn()` is an `extendTailwindMerge` that names our `--text-*`, `--spacing-*`, `--container-*`,
`--radius-pill`, `--shadow-*` and breakpoint tokens. **Add a token to `globals.css`, add its name
there.** Until you do it still works — right up until something tries to override it.

## The data layer

Built in F02. No screen fetches anything any other way.

```
src/lib/config.ts                where the backend is, and why the browser never calls it directly
src/lib/api/client.ts            the one fetch wrapper — cookie, JSON, AbortSignal, typed errors
src/lib/api/api-error.ts         ApiError: status, message, field issues, isForbidden / isValidation
src/lib/api/error-message.ts     ApiError → one sentence a person can act on. Toast this, not .message.
src/lib/api/endpoints/*          one module per controller group, plain typed functions, no React
                                 F09 added: domains, git-providers (one parameterised surface over the
                                 four strategies), and read-only registries / ssh-keys
                                 F12 added: docker (containers and the four verbs) and filled in compose
                                 F13 finished docker (its whole `docker-ops` module: containers,
                                 swarm, cluster), filled in ssh-keys, and added monitoring —
                                 **F14 extends that one**
                                 F18 added: license, audit-logs, scim, forward-auth, billing, and
                                 filled in sso (F06 opened it with the two public reads)
src/lib/api/keys.ts              every query key. Tenant data is scoped by active Organization id.
src/lib/api/query-client.ts      QueryClient defaults, and the single place a 401 is acted on
src/lib/api/use-invalidate.ts    what a mutation invalidates, declared once
src/lib/auth/client.ts           better-auth: session, sign-in/out, organization, 2FA, API keys
src/lib/realtime/use-socket-stream.ts   one WebSocket: reconnect, teardown, capped line buffer
src/lib/realtime/gateways.ts     five of the six gateway wrappers. The sixth, /listen-server-setup,
                                 is dialled by features/server/use-server.ts because it starts what it
                                 streams. Nothing else builds a socket URL.
src/lib/realtime/socket-stream-store.ts the socket itself, outside React
```

Four rules that are easy to break by accident:

1. **Never render `ApiError.message`.** It is written for whoever reads the logs. `errorMessage(error)`
   is written for whoever is looking at the screen.
2. **A 403 is not a sign-out.** Only 401 redirects, and `query-client.ts` already does it centrally.
   A 403 means their role does not carry the action — show it where the control is.
3. **A mutation invalidates through `useInvalidate()`**, never by assembling a key itself.
4. **No HTTP cache in front of TanStack Query** (F13). `client.ts` sends `cache: "no-store"`,
   because Express ETags every JSON response and a revalidated GET comes back **304** — for
   which `Response.ok` is false, so the client would throw an `ApiError(304)` at a request
   whose data was correct and already in the browser's hand. This app's cache is `keys.ts`
   plus `use-invalidate.ts`; a second one in front of it can only disagree.
5. **A Nest route that returns `null` sends an empty body, and TanStack refuses `undefined`** (F18).
   `readJson` yields `undefined` for a zero-length 200, and a `queryFn` resolving to `undefined` makes
   TanStack Query throw. `GET /forward-auth/settings` is the one route in the app that does this —
   `getAuthDomain` returns `null` for a target with no row, and Nest sends `content-length: 0`. The
   endpoint module normalises with `?? null`; anything else typed `| null` in a Nest service wants the
   same.
6. **A Nest route typed `Promise<string>` needs `getText` / `postText`.** Nest sends a bare string as
   `text/plain`, so `api.get<string>` and `api.post<string>` JSON-parse it, fail, and hand back
   **`undefined`** — silently, with a type that says otherwise. Two routes do this today: build logs
   (`GET /deployments/:id/logs`) and `POST /domains/generate`. F02 documented the trap on `getText` and
   was one method short; F09 added `postText` after the missing one put `undefined` into a form field
   and took a dialog down on `undefined.trim()`.

## Colour roles

Read them as **roles**, not colours. Both palettes are in `globals.css`; `.dark` switches the roles,
and everything downstream follows for free.

| Role | Meaning |
|---|---|
| `--ground` | the page behind everything |
| `--panel` | a raised surface — card, rail, masthead |
| `--panel-2` | an inset strip inside one — table head, meta bar |
| `--raise` / `--raise-2` | hover fill / selected fill |
| `--line` / `--line-2` | hairline / a deliberate emphasis rule |
| `--tx` `--tx-2` `--tx-3` | primary / secondary / label text — all ≥4.5:1 on `--panel`, both themes |
| `--tx-4` | **decoration only** — never carries meaning |
| `--tx-ph` | an input's placeholder — lighter than `--tx-3` so an example never reads as a typed value, still ≥4.5:1 on `--panel`. Applied to every `::placeholder` by one unlayered rule; with the **"e.g."** convention under **Forms** |
| `--brand` `-hi` `-ring` `-tx` `-tint` `-line` | the accent as fill / hover / focus ring / text / tint / hairline |
| `--ok` `--warn` `--bad` `--info` (+ `-tint`, `-line`) | status — always paired with a word, never hue alone |
| `--well*` | a log well: near-black in **both** themes, with its own text, timestamp and tone tokens. The only place light borrows from dark — see below. |
| `--series-1..4` / `--series-other` | a **categorical** ramp: which part of a total, never how it is doing. Four, and why, below. |
| `--hatch` | means "does not exist yet", never "disabled for you" |
| `--land` / `--sea` | a map's two surfaces — *Buy a Server*'s world map of Locations. The sea carries a breath of the brand hue so grey land never reads as a disabled fill |
| `--shadow-panel` `--shadow-float` `--shadow-pop` | a control resting / floating / popping over |
| `--scrim` | behind a dialog or the mobile rail |

Each role is exposed as a Tailwind colour, so `bg-panel-2`, `text-tx-3`, `border-ok-line` and
`ring-brand-ring` all work, in both themes, from one class.

### Two renames on the way in from the prototype

- The prototype's `--accent` is **`--brand*`** here. shadcn already uses `--accent` for a neutral
  hover fill, and ours is the brand hue. `--accent` in this codebase means shadcn's hover fill.
- The prototype's `--shadow` / `--shadow-2` / `--pop` are **`--shadow-panel` / `--shadow-float` /
  `--shadow-pop`**. Tailwind's utility namespace is literally `--shadow-*`, and a role token sharing
  a name with a theme key is a trap for whoever edits it next.

### The well is one surface in both themes

A rack in a lit room still has black displays. `--well` is oklch(0.19) whichever theme the console
is in, declared **once** (globals.css section 1a) rather than twice and kept equal by hand.

**F04 corrected the light values.** F01 copied `--well: oklch(0.978)` / `--well-tx: oklch(0.29)` — a
near-white well with dark text — out of the prototype's *light* block, while copying, from three
lines below the dark ones, the comment saying wells are near-black in both themes. The values and the
sentence disagreed; `00-INDEX.md`, the F04 phase file and the prototype's own comment all took the
sentence's side, so the values moved.

That means the well needs its own tones, because `--ok` / `--warn` / `--bad` are stepped against
`--panel` and light mode's `--ok` is a dark green that would vanish on near-black. The well borrows
the **dark** palette's tones in both themes, measured against oklch(0.19):

| Token | On the well | For |
|---|---|---|
| `--well-tx` | 13.69:1 | a plain line |
| `--well-ts` | 4.66:1 | the timestamp column |
| `--well-ok` `--well-warn` `--well-bad` | 10.12 / 10.76 / 6.78:1 | a line's tone |
| `--well-hl` | 9.32:1 | a step heading, and the tail cursor |
| `dim` (`--well-tx` at 62%) | 8.89:1 | output that is present but not the point |

`--well-ts` exists rather than reusing `--tx-4` because **a timestamp is information** — which step
ran when — and `--tx-4` on this well measures 2.72:1. The prototype's own light-well timestamp was
3.43:1. Neither clears text contrast; oklch(0.6) does.

### `--paper` is the well's opposite, and refuses to switch for the same kind of reason (F16)

`--paper` / `--paper-ink` are declared outside `.dark`, exactly as the well is. There is one consumer
and there should stay one: `QrCode`.

A QR code is not a picture of some data, it is a thing a phone camera has to **decode**, and the
decoder's assumption is dark modules on a light field. Plenty of scanners handle the inversion;
enough do not that a dark-mode enrolment would be the one that "just doesn't work" for one person in
a team — on the screen that locks them out of their own account if they get it wrong. So the surface
is the content's requirement rather than the theme's choice, which is the same argument the well
makes in the other direction.

Near-white rather than pure white, so a bright square on a dark page is a surface and not a
flashlight. `--paper-ink` on `--paper` measures **18.75:1**, well past anything the contract asks and
past what any decoder needs. Verified in the browser in dark mode: the `rect` renders L 96.5 and the
`path` L 3.7 with `.dark` on the root.

### Two chart vocabularies, and why they must not merge

`src/lib/design/chart.ts` is the only place a chart's colour is chosen, and it holds two sets:

- **Tone — state.** A single series that goes `hot` in trouble, `mute` when nothing is reporting,
  `dead` when it has stopped. These read `--chart-1..5`, which are brand / ok / warn / bad / tx-4:
  our status colours, used for status. Every tone renders beside a word.
- **Slot — identity.** A total split by its parts, where the colour says *which part*. These read
  `--series-1..4`.

Running the `dataviz` skill's validator on `--chart-1..5` **as a categorical ramp** is what forced
the split, and the numbers are the argument:

```
light   bad ↔ warn    ΔE  1.7 deutan · 13.1 normal    FAIL
        chart-5       chroma 0, 2.88:1 on --panel     FAIL
dark    ok  ↔ warn    ΔE  7.5 protan                  floor band
        ok/warn/bad   L 0.79 / 0.83 / 0.72            outside the dark band
```

A deuteranope cannot separate our amber from our red at all. So `--series-*` was searched against the
same validator with our three status hues (27 / 74 / 156) excluded, every slot required to clear 3:1
on `--panel`, and **all** pairs checked rather than only adjacent ones:

```
light   #664fd8 #7da127 #b4065f #32a0c5   all-pairs ΔE 17.1 deutan · 20.1 normal · all ≥ 3:1
dark    #6d57e0 #7a9e23 #c5256d #2d9dc1   all-pairs ΔE 13.0 deutan · 19.9 normal · all ≥ 3:1
```

### Syntax highlighting borrows no status hue (F12)

The editor's YAML highlighting is **two hues and two greys**, all of them the well's own measured
tones, and the restraint is the decision:

| Token | On the well | Paints |
|---|---|---|
| `--well-hl` | 9.32:1 | a **key** — the structure of the line, which is what a log well uses this tone for |
| `--well-tx` | 13.69:1 | a **value**, plain, because the value is the content |
| `--well-ts` | 4.66:1 | a **comment**, quiet and still text-contrast |
| `--well-tx` at 62% | 8.89:1 | punctuation, anchors, aliases |

**`--well-ok` / `-warn` / `-bad` are not used.** Those mean *how something is doing* everywhere else,
and a highlighter that painted a string green would make one colour mean "fine" in a log well and
"string" in the card above it. Nothing new was added to `globals.css` for the editor: a fifth hue on a
near-black surface is a decision to make on purpose, and two hues is enough to read YAML.

The selection tint is `color-mix(… var(--well-hl) 28%, transparent)` and **not `--brand-tint`**, which
is stepped against `--panel` — in light mode that token is near-white, so near-white text on it would
vanish the moment anyone selected a line.

**Four is the honest maximum.** With the status hues reserved and 3:1 required in both themes, no
fifth hue clears all-pairs. A fifth part is therefore not a fifth hue: it folds into
`--series-other`, which is `--tx-3` and deliberately achromatic — "Other" is a bucket, not an
identity, and it always carries its word. Never generate a hue for a sixth.

Three rules follow, and breaking any is how a chart starts lying:

1. A slot belongs to the **entity**, not its rank. Filtering a part out must not repaint the rest.
2. **Text never wears the data colour.** Labels, values and legends take text tokens; identity comes
   from the mark beside the word.
3. `mute` draws in `--tx-4` on purpose. That token is decoration-only, and a muted series *is*
   decoration: there is nothing to read, and the label beside it is what says so.

### Where F04 departs from the `dataviz` skill, and why

The skill's form and accessibility guidance won everywhere. Three places where the reference won,
each measured rather than asserted:

- **Dashed gridlines**, not the skill's solid hairline. The prototype's grid is dashed 3 4 and the
  phase brief names it twice. `vector-effect: non-scaling-stroke` is what keeps it 3px wide at any
  panel width — and it goes on **every `<line>`**, never on a wrapping `<g>`: `stroke-dasharray`
  inherits and `vector-effect` does not, so a group carrying it dashes the grid and then lets the
  viewBox stretch the dashes to 35px anyway. Found by looking at the rendered pixels.
- **1.5px line, 1.4px sparkline**, not 2px. The chosen visual direction, and crisp at
  non-scaling-stroke.
- **The meter's track stays `--raise-2`**, not a lighter step of the fill's own hue. Ours cannot:
  `--warn-tint` is L 0.968 against a `--panel` of 1.0, so a tinted track would disappear on a light
  card and the meter would lose the one thing it is for — showing how much is left.

### shadcn aliases

Every `base-nova` component inherits the system because shadcn's variables point at our roles —
`--background: var(--ground)`, `--card: var(--panel)`, `--primary: var(--brand)`,
`--ring: var(--brand-ring)`, and so on. They are declared once, not per theme: the roles are what
`.dark` switches. `--chart-1..5` are brand / ok / warn / bad / tx-4, not an achromatic ramp.

## Type

Seven steps. **One class carries the whole recipe** — size, leading, tracking and weight — so a
heading is one decision instead of four. Weight is the one companion you may override (`font-medium`
on a rail item, `font-semibold` on a table head). Size, leading and tracking are not yours to change.

| Class | Size | Leading | Tracking | Weight | Use |
|---|---|---|---|---|---|
| `text-disp` | 30px | 1.16 | −0.16px | 600 | page title |
| `text-sect` | 20px | 1.25 | −0.2px | 600 | section heading |
| `text-lead` | 16px | 1.5 | — | 400 | lede |
| `text-body` | 14px | 1.5 | — | 400 | body copy and **every control** |
| `text-ui` | 13px | 1.4 | — | 400 | the workhorse: rail items and table cells |
| `text-meta` | 12px | 1.45 | — | 400 | meta and captions |
| `text-chip` | 11px | 1 | — | 500 | mono chips, pills and badges |
| `text-glyph` | 9px | 1 | — | — | a bare mark (●, ○, ✕, ⊘) beside an 11px word — not a step of the scale |

Two figures and one ruler marking sit outside the reading scale, because a readout's number is not
body copy at a heavier weight — it is the thing the eye lands on:

| Class | Size | Use |
|---|---|---|
| `text-fig` | 22px / 600 / −0.3px | the value in a `StatTile` |
| `text-hero` | 26px / 600 / −0.4px | the number a `Chart` leads with |
| `text-tick` | 10px | an axis tick. The only thing in the app under 11px, and never a word that is not repeated somewhere readable. |
| `text-mark` | 15px / 650 / −0.28px | the **wordmark**, and nothing else. A logotype is set once, to its own measurements; 650 is why it cannot be `text-lead font-semibold`, which reads as a heading. |

Two tracking tokens, and both exist because mono set for a *purpose* wants different tracking from mono
set as text: `tracking-mono` (−0.2px) because mono set small and right-aligned in a `KVRow` reads loose
at its nominal tracking, and `tracking-code` (0.32em, F06) because a six-digit one-time code is
*counted* rather than read as a number. `leading-log` (1.62) and `leading-diff` (1.75) give mono set in
bulk the air the reading scale does not — a log is scanned in columns, a diff is read line by line.

Geist Sans (`font-sans`) and Geist Mono (`font-mono`), self-hosted by `next/font`. Mono is set to
`0.92em` in the base layer, because mono at the same px reads a size larger than the sans beside it.
Figures that change in place get `.num` (tabular) so they do not reflow their row.

## Geometry

Under the `--spacing-*` namespace, so `h-ctl`, `w-rail`, `max-w-col` and `gap-pad` all resolve.

| Token | Value | Use |
|---|---|---|
| `top` | 56px | masthead |
| `rail` / `rail-c` | 259px / 60px | scope rail, expanded / collapsed to an icon strip |
| `aside` | 336px | right rail |
| `subnav` | 216px | a screen's own section list beside it — settings' navigation from `cols` up |
| `col` | 1360px | page measure (also `--container-col`, which is what `max-w-col` reads) |
| `ctl` | 36px | control height |
| `nav` | 34px | rail item height |
| `row` | 40px | table row height |
| `thead` | 38px | table head row, and the tab strip |
| `pill` / `chip` | 22px / 21px | status pill and switch track / chip |
| `pad` | 32px | page gutter |
| `pick` | 210px | narrowest a radio card gets before `PickGrid` rewraps |
| `modal-top` / `modal-h` | 8vh / 84vh | a dialog sits high, and scrolls inside itself past this |
| `drawer` | `min(285px, 86vw)` | the rail as a drawer. The vw clamp is part of the value: a 285px drawer on a 320px phone leaves no page behind it to see |
| `pal` / `pal-top` / `pal-list` | 612px / 11vh / `min(52vh,420px)` | the command palette, how high it sits, and how far its results scroll before the list — never the page — takes over |
| `plot` / `spark` | 96px / 30px | a plot frame, and an inline sparkline |
| `chart-side` | 118px | the label-and-number column beside a plot |
| `log` | 340px | a log well, before it scrolls inside itself |

### Measures and breakpoints

Line lengths live under `--container-*`, because a measure is about the text and not the layout:
`max-w-lede` (74ch, a lede under a page title) and `max-w-copy` (46ch, the one sentence in an empty
state). `max-w-col` (1360px) and `max-w-aside` (336px) are the two that bound a column. `max-w-auth`
(400px, F06) is the exception in the namespace: it is in px, not ch, because unlike the other two
measures it bounds a stack of 36px controls rather than a line of prose.

Four of the reference's five breakpoints are registered, and they are declared **ascending** — the
order Tailwind emits the variants in, so `lbl:` beating `hd:` is a property of the file and not luck:

| Key | Width | What changes |
|---|---|---|
| `hd` | 620px | a page header stacks and its actions go full-width |
| `lbl` | 820px | the masthead sheds **labels, before controls** — the logotype drops to its glyph (the Organization name stays, truncated), the resource's badges go (the page header repeats them in words), the breadcrumb goes entirely because the page title is right underneath it |
| `rail` | 900px | the scope rail leaves the grid and becomes a drawer |
| `cols` | 1040px | main + aside becomes one column |

At `rail` and below, two existing tokens are also **re-declared** rather than joined by new ones, so
every `px-pad` and `text-disp` already in the app follows for free: `--spacing-pad` goes to 16px (a
32px gutter costs a phone a fifth of its width) and `--text-disp` to 24px (a 30px title next to a
380px measure wraps to three lines).

### Radii

Chosen so base-nova's own class picks land on the prototype's geometry.

| Class | Value | Use |
|---|---|---|
| `rounded-md` | 6px | chips, rail items, inner controls |
| `rounded-lg` | 8px | buttons, inputs, segmented controls — what base-nova's Button asks for |
| `rounded-xl` | 12px | cards, dialogs, menus |
| `rounded-pill` | 999px | status pills, switches |

## Motion

Motion confirms that something happened and where it came from; it never decorates. All of it lives
in `globals.css` and degrades to a settled snapshot under reduced motion (see Base layer).

| Token / class | Use |
|---|---|
| `ease-out-strong` | the default curve for anything entering or responding to a press |
| `ease-in-out-strong` | something moving on screen from one place to another |
| `ease-drawer` | a sheet or drawer sliding in from an edge |
| `animate-rise` | a block of content arriving (a panel after its skeleton, a row a mutation added): 4px rise + fade, 200ms. Once per block, never per row of a long list |
| `animate-fade` | content replaced in place (tab switch, filter change): opacity only, 150ms |

Durations stay on Tailwind's scale: **100** press/hover, **150** menu/popover/tooltip, **200** dialog or
entering row, **300** drawer. Nothing triggered often waits longer than 200, and nothing on a keyboard
shortcut or a high-frequency surface (a log well, a live metric, a table being typed into) animates
at all. Animate `transform` and `opacity`; never `transition-all` on something that also changes size.

Where the shared primitives already use it, so a screen inherits it rather than adding its own:

| Where | What moves |
|---|---|
| `Button` (every variant, and `LinkButton`) | colours over 100ms; a 1px press on `:active`, never on an off (`aria-disabled`) button or a menu trigger |
| `ui/popover` · `ui/dropdown-menu` · `ui/select` · `ui/tooltip` | 150ms in from the trigger (`--transform-origin`), 100ms out. A tooltip that skips its delay or opens on focus (`data-instant`) does not animate |
| `ui/dialog` → `Modal` | 200ms fade + `zoom-in-96`, 150ms out. **⌘K opts out**: it is opened by a keystroke, many times a day |
| `scope-rail` drawer · its scrim | `ease-drawer` 300ms slide; the scrim fades in with `animate-fade` |
| `Tabs.Panel` | `animate-fade` on each swap (a `keepMounted` panel replays it as `hidden` lifts) |
| `ResourceList` · the home `ListCard` · `Outcome` | `animate-rise` once, when the skeleton gives way (`ListCard` only if it was actually waited for) |
| `EmptyState` · `Banner`'s body · a rail group's sub-list | `animate-fade`; `Banner` and the rail group turn one chevron 90° over 150ms |
| `CopyButton` | the tick replaces the copy glyph with `animate-fade`; back to idle is instant |
| `Switch` | track colour and thumb, 150ms |
| `PickCard` · `DataTable` rows · `FormError` | colours over 100ms (a card also takes `Button`'s 1px press); a refusal arrives with `animate-fade` |
| `DataTable` `rowClassName` (and `DeploymentTable`'s) | the hook for **one** row's motion — `animate-rise` on a row a mutation added, `animate-fade` on a status change. Never every row |
| `useArrival(pending)` (`console/use-arrival.ts`) | returns `animate-rise` only if this mount actually drew a skeleton, so a card over cached data does not move on a repeat visit. The way a feature section arrives |
| `useSwapFade(signal)` (`console/use-swap-fade.ts`) | replays `animate-fade` on one element when a read's *result* changes (filter, page, range answered), by toggling the class rather than remounting, so a `DataTable`'s sort survives |

What does **not** move, on purpose: ⌘K, the palette's highlighted row and a menu's highlighted row (keyboard),
a `Dot` or `StatusPill` (an Application `running` for a month is steady, not busy — the Dock's live log
mark is the one pulse, because it really is streaming), the log well, and every live figure.

## Utilities

| Class | What it does |
|---|---|
| `hatch` | the diagonal hatch that means "does not exist yet", never "disabled for you" |
| `num` | tabular figures, so a live number does not reflow its row |
| `no-scrollbar` | a strip that scrolls sideways on purpose — a tab bar — and clips at its own edge instead of growing a bar. Wheel, trackpad and keyboard still work; only the bar is gone. |
| `sr-only` | Tailwind's visually-hidden helper. **This is the prototype's `.sr`** — we reuse Tailwind's rather than ship a second name for one behaviour. |
| `wrap-anywhere` | Tailwind's own. On any copy that can hold an image digest, a resource address or a Swarm service name — the tokens no word-break ever finds a seam in. |
| `nonscaling` | `vector-effect: non-scaling-stroke`, on every stroke drawn inside a stretched viewBox. Named without a Tailwind prefix on purpose: a `stroke-fixed` would be classified as a *stroke colour* by tailwind-merge and dropped next to `stroke-chart-1`. |
| `dash-grid` / `dash-thin` | 3 4 for a plot's gridlines; 2 3 for a sparkline's baseline and a series that has stopped reporting. |
| `shell-grid` / `shell-body` | the console's two grids (F05): masthead row + body row, then rail + main. Both use `minmax(0,1fr)` and never the default `auto` — an auto grid column cannot shrink below its items' min-content, and the masthead's min-content is wider than a phone. That one declaration is what keeps 380px honest. |

### `railc` — one variant for "the rail is an icon strip"

`@custom-variant railc` is `html[data-rail="collapsed"] &` **inside** `@media (width >= 900px)`, and
it exists as one variant rather than a pair of conditions at each call site because every one of the
half-dozen things that hide when the rail narrows must hide under exactly the same circumstances — and
must come back when the rail becomes a drawer, since a drawer is never an icon strip.

`--rail-w` is the rail's *effective* width: `--spacing-rail` normally, `--spacing-rail-c` when that
variant's conditions hold. The masthead's Organization cell reads it too, as its *minimum* width, so
the vertical hairline stays on the rail's edge at both widths — unless the Organization's name needs
more room beside the logotype, when the cell grows into the masthead's spare width, up to two fifths
of it, rather than truncating the name.

## Base layer

Set once in `globals.css`, so no component repeats them: `border-border` on everything, body on
`--ground`/`--tx` at `text-body`, `svg { display:block; flex:none }`, a `:focus-visible` ring of 2px
`--brand-ring` at 2px offset **everywhere**, and a reduced-motion block that degrades animation to a
*settled* snapshot — the run finishes, the cursor stops — rather than to a fast one.

Two things deliberately *not* set globally: `overflow:hidden` on `html`/`body` (the app shell owns
scrolling — F05), and a colour on bare `<a>` (a link's colour is a component decision, and forcing
it fights shadcn's `asChild` links).

## Off, and looking off — one rule

"This control is inert" and "this control looks inert" cannot drift apart, because they are the same
attribute. `globals.css` ends with a single **unlayered** block keyed on `[aria-disabled="true"]`
(e-console.html:506-511). Unlayered on purpose: Tailwind's utilities live in a layer, so a rule
inside `@layer base` could never beat `bg-brand` on a disabled primary button.

There are two disabled spellings in the app and each is right for what it covers:

- **Actions** — a button, a menu row, a radio card — use `aria-disabled`. Our `Button` defaults Base
  UI's `focusableWhenDisabled`, so an off action keeps its place in the tab order and Base UI still
  swallows the click. A control nobody can focus is a control that cannot say why it is off.
  **Spell it `disabled` on our `Button`, not `aria-disabled` by hand**: the hand-written attribute
  gets the look and the announcement but not the swallowed click, so its handler has to refuse on
  its own — the resource dialog's test button did not, and sent a test it said could not run.
 Where there is a reason, the button carries it too, as `title` and through
  `aria-describedby` at the sentence on screen.
- **Form inputs** keep the native `disabled` attribute, which is the right answer for them: a
  disabled input should not be focused, and must not be submitted. shadcn already styles that case.

The flattening stops at the focus ring — `:not(:focus-visible)` guards the shadow and border, or an
inert control would be reachable and invisible, which is worse than unreachable.

## Forms

**react-hook-form with a zod resolver.** zod because the backend is already zod-first (every DTO is
a `createZodDto` wrapper), so a form schema is the same shape of thing the endpoint will check,
written in the same language. react-hook-form because it keeps inputs uncontrolled, which matters
when a Server form has forty fields.

Two pieces, and no feature phase writes a third:

- `useApiForm` — wraps `useForm` and routes the refusal. A **400 with field issues** goes back to
  the fields it is about, sentence-cased so the backend's fragments read like our own zod messages.
  **Anything else** — 403, 409, a backend that is not running — has no field to blame, so it goes to
  the form's root error and to a toast. An issue whose path is not a field on this form goes to the
  root rather than vanishing.
- `Field` — hands its child an `id`, registers it, sets `aria-invalid`, and points
  `aria-describedby` at whichever of the hint and the error are on screen. It works without a form
  around it (`error` prop), which is what one-off filters and the gallery use.

**A placeholder is an example, and says so**. Write it with `example()` from
`form-spec.ts` — "e.g. Nightly backups" — so a name, a count or a port in an empty box never reads as
a value already set. Where the value is a real default, it is not a placeholder at all: prefill it.
A format hint that cannot be mistaken for a value (`https://…`, `0 2 * * *` under a cron label) may
stay bare. `placeholder-examples.test.ts` holds every spec's name field to it.

A Switch or a Select is a button, not an input, so `register` has nothing to attach to: inside a
form those want react-hook-form's `Controller`. `Field` still owns the label, the hint and the
layout, and when its child is a `Controller` it hands the `id` and aria wiring to whatever the
Controller *renders* — cloning the Controller itself dropped them, and every spec-built
switch had no accessible name. `switch-field-name.test.tsx` holds every switch producer to it.

## The shell, and how a later phase adds a screen

Built in F05. **The rail is a scope, not a menu** — this is the one place that behaviour exists.

```
scope.ts             pathname → scope. Pure: no React, no fetch, no state.
nav.ts               the five nav tables. THE navigation model.
scope-provider.tsx   the seam: useScope() → scope, nav, identity, badges, exit, siblings
use-scope-queries.ts every request the identity needs, and nothing else
resolve-scope.ts     fetched rows → what the masthead and rail render. Pure.
scope-title.tsx      a resource scope's document title, from its resolved identity
console-shell.tsx    the 100dvh grid, two scroll regions, skip link, scrim, <main>
masthead.tsx         org cell · context area · actions
org-switcher.tsx · scope-identity.tsx · masthead-crumb.tsx · avatar-menu.tsx
scope-rail.tsx       the three widths and the two scroll regions
rail-entries.tsx     one nav-table entry, rendered
rail-row.tsx · rail-item.tsx · rail-group.tsx      the row recipe, and the row kinds
rail-group-flyout.tsx  a group's items beside the icon strip
rail-tip.tsx         a row's name beside the icon strip, on hover and focus — never announced
command-palette.tsx  ⌘K — the combobox
palette-sources.ts   what it searches (endpoints, never a list)
palette-keys.ts      its keyboard and focus plumbing — read this before changing it
palette-rows.tsx     its four rows of markup
rail-state.ts        collapsed, on <html>, written before paint (by the root layout's <head>)
dock-state.ts        the Dock's height and view, on <html>, written before paint the same way
dock*.tsx            the Dock: provider, panel, tabs (shells and logs), a log's tab and body, +, handle, close-all
dock-store.ts · dock-context.ts · terminal-offers.ts   its rules, seam and + offers
local-store.ts · favourites.ts · recents.ts        the browser's own state, no endpoint
use-is-drawer.ts     the one thing about drawer mode CSS cannot do
use-hydrated.ts      false until hydration is over: for what only the client knows
scope-panel.tsx      F07: the whole of a scope shell — one registry lookup, or the not-found state
palette-state.tsx    F07: how a *page* opens ⌘K (the home page's quick search)
```

**To add a screen: add a line to the tab registry.** That is the whole contract, and F07 moved where
the line goes: a resource scope's rail items *are* its tabs, so those tables live in
`src/lib/shell/tabs/*` where the same declaration that names a tab also names the panel that fills it.
`nav.ts` keeps Organization scope, whose rows are pages rather than tabs, and derives the other six
from the registry. One line makes the rail item, the route (a tab that is not declared 404s), the
document title, the panel's `<h1>` and — at Organization scope — ⌘K's `go:` entry and the masthead
breadcrumb. No feature phase edits `scope-rail.tsx`, `masthead.tsx` or a route file.

Five things worth knowing before you touch it:

1. **The scope comes from the URL, the names come from fetches.** That split is what stops a deep link
   from painting the Organization rail and then swapping: the correct rail is in the server-rendered
   HTML. Only the identity fills in — and the "Back to …" pill's row is *held* while its parent's name
   loads, so nothing below it moves when the name lands.
2. **Routes are flat** — `/environments/<id>`, `/applications/<id>`. The API takes one id and no
   parent, so a URL carrying a parent could disagree with the data it renders. Reasoning in
   `scope.ts`.
3. **Collapsed is an attribute on `<html>`**, not React state, read from localStorage by a blocking
   script before first paint. Held in state, the rail would open at 259px on every load and snap to
   60px after hydration — a 200px reflow of the whole page, once per navigation.
4. **The drawer's closed position is CSS**, not `isDrawer && !drawerOpen`. `useIsDrawer` cannot know
   the width on the server, so deriving the transform from it made a phone render the drawer *open*
   and slide it out after hydration. React only says when it is open; `inert` is the one thing about
   drawer mode that has to be React's, because a `translate`d drawer keeps its place in the tab order.
5. **⌘K searches endpoints, never a list.** `proj:` `env:` `srv:` `go:`. The prototype's `svc:` and
   `dep:` are **omitted, not faked** — neither can be answered organization-wide. An Environment
   names its own services now, but ⌘K
   searches the whole Organization, so reaching them all is one request per Environment, and
   Deployments are a second fan-out on top of that. `palette-sources.ts` has the argument.

## The route tree, and the tab registry

Built in F07. **This is the phase that owns routing**, so that six Wave 4 sessions can build panels in
parallel without ever touching the same file.

```
src/lib/shell/tab-registry.ts    the contract: TabEntry, PanelProps, panel(), TAB_REGISTRY
src/lib/shell/tabs/server.ts     Server scope's seven tabs          → F13's panels
                                 (F13 added Terminal — rule 2; that file says why)
src/lib/shell/tabs/project.ts    Project scope's two               → F08's
src/lib/shell/tabs/environment.ts  Environment scope's five        → F08's
src/lib/shell/tabs/application.ts  Application scope's five        → F09's, and Advanced is F10's
src/lib/shell/tabs/database.ts     database scope's three          → F11's
src/lib/shell/tabs/compose.ts      Compose scope's eight           → F12's
                                   (F12 added Converted, Containers, Logs — rule 2; that file says why)
src/features/<scope>/panels/<slug>.tsx   one file per tab. **Yours.**
src/app/(console)/<segment>/…/[[...tab]]/page.tsx   one route file per scope. **Not yours.**
```

### The contract

1. **A phase owns its panel files and nothing else.** F07 ships all 26 as a `TabPlaceholder`; you
   replace the contents of the ones your phase owns. You do not edit the registry, `nav.ts`, or a route.
2. **A genuinely new tab is one line** in your scope's table plus the panel file it names — and say so
   in your phase notes, because that line is the only thing in this seam two sessions could collide on.
3. **Panels are lazy** (`next/dynamic`), so six tabs are six chunks and opening a Server does not
   download its terminal. They still prerender, so a deep link into a tab is server-rendered.
4. **A panel is handed `{ id, kind, label, icon }`** and fetches what it needs itself. `label` and
   `icon` come from the registry entry, so a panel's `<h1>`, the rail row that led there and the
   document title are one declaration and cannot disagree. `kind` is the database engine at database
   scope and `null` everywhere else.
5. **The route file only 404s an invented tab, on the server** — where a 404 can still be a 404, since
   once the response is streaming the status is already sent. `ScopePanel` re-reads the same pure
   function client-side to pick the panel, so the two cannot disagree.

### Seven scopes, not five

F05 built five. F07 added **database** and **compose**, because `SVC_NAV` covered all three service
kinds and ours cannot: a managed database has no Deployment list (nothing lists them) and no domain
(`domains.controller.ts` serves applications and Compose stacks only), so one shared table would have
put two rail rows in front of screens that cannot exist.

**One segment in the whole app is not an id.** `/databases/postgres/<id>` carries the engine because
`GET /:id` is only answerable once you know which of the six controllers to ask, and a reload has
nothing but the address. That is the opposite of the parent ids flat routing rejects: it cannot
disagree with the row, because the row is what confirms it. An engine we do not have falls back to
Organization scope and 404s rather than opening a database rail over nothing.

### Loading, error and not-found

Four files, and their *placement* is the design:

- **`(console)/error.tsx`** sits directly under the console layout, so the masthead, the rail and
  ⌘K survive — someone whose tab crashed can still leave it. There is no `(console)/loading.tsx`
  beside it any more: it was deleted, because a Suspense boundary above the tab registry's check
  flushed the shell and its 200 status before any `notFound()` could run, so every undeclared slug
  answered 200. One boundary rather than one per scope: seven copies would differ in nothing, and the words that *are*
  scope-specific come from `useScope()` rather than from which folder the file is in. `error.tsx` uses
  **`unstable_retry`**, not `reset` — retry re-fetches, reset only re-renders the same inputs.
- **`(console)/not-found.tsx`** catches every `notFound()` under the console **inside the shell**.
- **`(console)/[...missing]/page.tsx`** turns a URL that matches no route at all into a `notFound()`
  under the console, so a signed-in operator's mistyped address keeps the shell. `proxy.ts`
  has already sent anyone without a session to sign-in.
- **`app/not-found.tsx`** catches a `notFound()` outside the console, where there may be no session to
  render a shell around, so it takes the doors' shape. It sets its title with React's hoisted
  `<title>`, because a `not-found.tsx` cannot export `metadata`.
- **A bad id is not a `notFound()`** — nothing on the server knows the id is bad, because every fetch
  in this app is a client fetch. `useScopeQueries` marks the scope `missing` when the *identity* query
  returns 404 and nothing else (a 403 means the row exists and this role cannot read it; a dead backend
  says nothing about the id), and `ScopePanel` renders `Outcome` in place of the panel. The rail drops
  the scope's tabs then and keeps only its "Back to …" row, since every tab would lead to the same
  not-found.

## The doors, and the gate in front of them

Built in F06. Everything before the console: getting in, getting back in, and being kept out.

```
src/proxy.ts                     the gate. Cookie *presence*, nothing more
src/lib/auth/routes.ts           the paths, and `safeNextPath` — the open-redirect rule
src/lib/auth/console-gate.ts     the one layout guard's decision, as a table
src/components/shell/dead-session-exit.tsx   and the exit that carries it out
src/lib/auth/membership.ts       is the session's user still in its Organization?
src/components/shell/not-a-member.tsx        what the shell becomes when they are not
src/lib/auth/auth-error.ts       better-auth's {data,error} → an ApiError, and its own sentences
src/lib/auth/end-session.ts      what signing out means. Three steps, shared with the 401 handler
src/lib/auth/use-sign-out.ts     the same three, for a button: a pending flag and words when it fails
src/lib/auth/active-organization.ts   nobody reaches the console without an active Organization
src/lib/auth/two-factor-cookie.ts     is a 2FA challenge in progress? Server-only
src/lib/api/endpoints/sso.ts     the two public reads the sign-in screen asks before rendering
src/app/(auth)/layout.tsx        the centred column, the mark, no shell
src/app/(auth)/_components/      the panel, the outcome, the five forms
```

Seven things worth knowing before touching any of it.

1. **It is `src/proxy.ts`, not `src/middleware.ts`.** Next 16 renamed the convention; a
   `middleware.ts` would simply never run, which is the worst way for an auth gate to be wrong
   (`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`).
2. **The matcher's exclusions are load-bearing.** Proxy runs *before* `beforeFiles` rewrites, so
   without them it also sees `/api/auth/*` and `/backend/*` — and would redirect a sign-in POST to
   `/sign-in` for having no session cookie yet. It is a negative lookahead rather than a list of
   protected paths, so a new screen is protected by existing.
3. **The gate checks cookie *presence*, and that is all it should do.** Next's own guidance is that
   this layer is for optimistic checks; the backend is the authority and F02 routes a 401 back here
   from anywhere that fetches. An expired-but-present cookie gets through and is refused once — except
   where nothing is sent, and so nothing is refused: every query under the console shell is
   `enabled: organizationId !== null`, so a stale cookie painted the whole authenticated frame over
   skeletons that never resolved, and made `/sign-up` unreachable on an instance nobody owned.
   `DeadSessionExit` closes that one gap from the console layout, and **ends the session** rather than
   redirecting, so the dead cookie cannot re-enter on the next navigation. It is the only layout guard
   there is; a second one means the matcher was wrong. And where a 401 *does* arrive, the handler in
   `query-client.ts` ends the session too — it used to redirect to `/sign-in` with the dead cookie
   still set, which this gate answered by sending them straight back to the screen that had just 401'd.
4. **`?next=` is attacker-controllable.** `safeNextPath` accepts only a path on this origin — it
   rejects `https://evil`, `//evil` *and* `/\evil`, because a browser normalises the backslash and
   reads the result as a host. All three were driven; all three land on `/`.
5. **Every form carries `method="post"`.** A form with no method is a GET, so a submit that reaches the
   browser rather than React serialises every field into the query string. Found by driving it: a
   pre-hydration submit put `?password=…&confirm=…` in the address bar, and therefore in history and in
   the next referer. There is no `action`; this only changes what the fallback does.
6. **better-auth's statuses cannot be read as statuses here.** A wrong password is a 401 and a wrong
   invitation recipient is a 403 — which F02 reads as "your session has ended" and "your role does not
   allow this", both wrong and both about to be said to the wrong person. `auth-error.ts` maps the
   `code` instead, and `errorMessage()` consults it first so `toast.error` and `useApiForm` get the
   right words for free. Anything with no special sentence falls through to F02's status rules.
7. **Signing out is three steps, and the cache is the one that matters.** End the session, **empty the
   query cache**, then leave with a *full navigation*. Query keys are scoped by active Organization,
   which stops one Organization's rows reaching another — and does nothing about a different *person*
   signing in on the same tab, whose first paint would come from the previous account's cache. Driven:
   a marker set on `window` before signing out is gone afterwards, so the document really does reload.
   The steps live in `lib/auth/end-session.ts` because there are **two** callers and neither may have
   its own version: the avatar menu's button, and the 401 handler in `lib/api/query-client.ts`, which
   is not a component and cannot call a hook.

**Two screens have no form at all**, and that is the design. `sso.enforced` means the password form is
not rendered — not disabled — because an organization that turned it on has decided passwords are not a
way in, and a form that is present but always refused makes someone doubt their own password. And
`/2fa` asks the *server* whether a challenge exists (the `two_factor` cookie is `httpOnly`), so a stray
visit reads "no sign-in is waiting on a code" instead of a code box certain to be refused.

**`/accept-invitation/[id]` is excluded from the gate** — the one screen correct for a signed-in and a
signed-out visitor alike. Signed out it shows two doors and *nothing about the invitation*, because
reading it needs a session: who was invited to which organization is not something a link alone should
reveal. Signed in, a closed invitation says **which way it closed**: better-auth's read refuses every
one with the same 400, so the page then asks Cloudgate's `GET /organizations/invitations/:id/state`,
and accepted, declined, expired and "no longer exists" are each their own sentence. There is
no "withdrawn" from the Members screen — Revoke deletes the row — so that case is the "no longer
exists" one, and it says it cannot tell a withdrawn invitation from a broken link.

## Status vocabulary

`src/lib/design/status.ts`. **Only what the real enums hold** — `applicationStatus` is
idle/running/done/error, `deployment.status` is pending/running/done/error/cancelled, `serverStatus`
is active/inactive. The prototype's `provisioning`, `unreachable`, `drift`, `planned` and `building`
are in no enum; they belong to the unbuilt provisioning work and are not here.

Five maps, because conflating vocabularies leaks:

| Map | Source | Keys |
|---|---|---|
| `STATUS` | our three enums | running, done, active, pending, error, cancelled, idle, inactive |
| `SERVER_REACH` · `SERVER_MAINTENANCE` | `server-mark.ts`: a Server's last reach attempt (`reachCheckedAt`, `reachOk`) and its Maintenance (`maintenanceSince`), neither an enum | reachable, unreachable, unchecked; "in maintenance" (`⊘`, warn) |
| `CONTAINER_STATE` | Docker `docker ps {{.State}}` | running, created, restarting, removing, paused, exited, dead |
| `TASK_STATE` | Swarm `docker service ps {{.DesiredState}}` | running, ready, accepted, shutdown |
| `GUT` | a signed change gutter | create, change, replace, destroy, noop, read |

Each entry is `{ glyph, tone, label }`. `TONE_TEXT`, `TONE_PILL` and `TONE_FILL` are the one place a
tone becomes colour, so a pill, a dot, a row tint and a chart series cannot drift apart. Resolvers:
`statusMark` is typed (a wrong key is a compile error); `containerMark` and `taskMark` take a string,
because those arrive as free text over SSH, and label an unknown state with the word Docker used
rather than showing `undefined`.

## Icons

`src/lib/design/icons.tsx` is the **only** file that imports lucide. Keys are the prototype's names
(`hdd`, `rocket`, `chevR`, …). Use `<Icon name="hdd" />` — 1.6 stroke, 16px default, `aria-hidden`
unless you pass `label`, which you only do when the icon is the sole thing naming a control.

lucide has already renamed two of these under us (`Filter` → `Funnel`, `AlertTriangle` →
`TriangleAlert`). That is the argument for the indirection.

## Known design issues

Found by measurement, not by eye. Fix them where the affected component is built, not by quietly
editing the palette.

**None open.** `/dev/tokens` measures 30 pairs and all 30 clear their tier, in both themes.

### Resolved

- **`--chart-1..5` measurably fail as a categorical ramp** — light bad↔warn is ΔE 1.7 under
  deuteranopia and 13.1 unsimulated; `--chart-5` is achromatic and 2.88:1 on `--panel`. **F04 closed
  it** by separating the two jobs: `--chart-*` stays the *status* set that F04's plot tones use, and
  a validated four-slot `--series-*` ramp carries identity. Numbers above.
- **The light well was near-white, against its own contract** — and its timestamp measured 3.43:1.
  **F04 closed it**: one near-black well in both themes, with `--well-ts` at 4.66:1 and five
  well-scoped tone tokens, all measured. Detail above.
- **White on `--brand-hi` measured 3.81:1 in dark** — the hover fill for a primary control failed
  4.5:1 even though the resting state passed at 5.13:1, because the prototype hovered *brighter*
  there (L 0.625 against `--brand`'s 0.555) and never measured it. **F03 fixed it** by taking dark
  `--brand-hi` to L 0.495 — the same −0.06 step light mode already uses (0.53 → 0.47). Hover now
  means the same thing in both themes, reading as *denser* rather than brighter, and the label gains
  contrast instead of losing it: **6.69:1 dark, 7.45:1 light**. `--brand` itself is untouched; its
  L 0.555 is load-bearing (see the comment in `globals.css`).

## Components

Every component gets one line. Add yours in the same commit that creates it.

### `src/components/ui/*` — shadcn (base-nova)

Added with `pnpm dlx shadcn@latest add <x>`. Two are edited, both to bring them onto the console's
geometry rather than to change what they are — extend the `cva`, never fork the file.

| Component | Notes |
|---|---|
| `button` | **Edited.** Ours: `pri` / `gh` / `qt` / `dngr`; sizes 36 / 30 / 26px (`default` / `sm` / `xs`) and their icon-only twins. `gh` is the *default variant*, so a bare `<Button>` is never accidentally brand. `focusableWhenDisabled` defaults on. base-nova's six variants are kept so a registry component still renders as its author expected. |
| `input` | **Edited.** `h-ctl`, 11px sides, on `--panel` with the resting shadow. `text-base md:text-body` stays — a 14px input is what makes iOS Safari zoom the page on focus. |
| `checkbox` | **Edited.** base-nova drew a tick for `indeterminate` too, so a header checkbox with 1 of 25 rows selected looked exactly like one with all 25. Base UI puts `data-indeterminate` on the root; the glyph now follows it (a dash), so the state is not invisible. |
| `table` | **Edited**, twice, both structural. The container gains `overscroll-x-contain` — a wide table scrolls in its own box and running out of table must not hand the gesture to the page. And `th`/`td` gain `position: relative`, which is load-bearing: an `sr-only` label inside a cell is absolutely positioned, and with no containing block *there* it resolves against the initial one and silently widens the document (e-console.html:617-619). |
| `textarea` | **Added and edited by F08.** Brought onto the console's geometry the same way `input` was — `--panel` with the resting shadow, our placeholder tone, the disabled state F03's one inert rule expects. Nothing caps its height: `field-sizing-content` is base-nova's and it is right for a control holding a dotenv blob; a caller inside a fixed box sets its own `max-h` and lets it scroll. |
| `select` | **Edited by F09**, the same way `input` was and for the same reason — F09 is the first phase to use one. The trigger goes to `h-ctl`, `w-full` (base-nova's `w-fit` is the one default that had to go: a select in a `Field` beside an `Input` must be the same width, or a form looks like two forms), `--panel` with the resting shadow, and our type scale. The popup takes our `rounded-xl` / `shadow-pop`, and an item **is `console/menu`'s row** — same height, same padding, same hover — so a select's options and a menu's items cannot drift apart. |
| `tooltip` | **Re-added and edited later** (F19 had deleted it unused). The popup takes `console/menu`'s surface — `--panel`, the hairline, `shadow-pop`, `text-ui` — instead of base-nova's inverted `bg-foreground` chip, and the arrow is gone: it was the file's only literals (`rounded-[2px]`, `translate-y-[calc(-50%-2px)]`), and a tooltip that sits 4px off its trigger needs no pointer. `shell/rail-tip` composes it. |
| `label` `separator` | Untouched. |
| `switch` `popover` | **Timing only.** base-nova's `transition-all` named down to what moves (`transition-colors` on the track, the thumb's `transform`), and every enter/exit put on the Motion table's durations and `ease-out-strong`. Nothing else changed. |
| `dialog` `dropdown-menu` `tabs` | **Timing only** — `console/modal`, `console/menu` and `console/tabs` compose them. Dialog 200ms in from `zoom-in-96` (out 150ms), menus and the select's popup 150ms from Base UI's `--transform-origin` (out 100ms), the tab rule's crossfade 150ms. |
| `field` | Untouched — `console/field` composes it. |
| `sonner` | Untouched. Re-exported by `console/toast`; mounted once in `providers.tsx`. |

### `src/components/console/*` — ours

| Component | Notes |
|---|---|
| `theme-provider` | `next-themes`, `attribute="class"`, opens **light**, system enabled. Wraps the app in `layout.tsx`. |
| `theme-toggle` | Light / Dark / System. A `Segmented`, not a second implementation of one. Lives in F05's avatar menu under "Appearance". |
| `wordmark` | The mark: glyph plus logotype, at their one size. A **fragment**, because its two callers put it in different rows (F05's masthead cell, F06's centred column). Nothing scales it — `text-mark` exists so a logotype is set once, and a door with a bigger wordmark than the console's is two marks. `wordClassName` is for *hiding* the word at the 60px rail, not restyling it. |
| `brand-mark` · `branding-style` · `error-page-copy` | **The instance's branding, drawn.** `BrandMark` is `wordmark` with the operator's name and logo (the logo takes the glyph's slot at its size, so a rebranded mark occupies exactly ours). `BrandingStyle` is the colours as `--brand*` overrides — `:root:root`, so one hex serves both themes — plus, **in the console shell only**, the operator's custom CSS: the auth layout passes `customCss={false}` because those screens hold a password field, and a stylesheet can overlay one or read it out through attribute selectors. `ErrorPageCopy` swaps the console's not-found / render-failed sentence for the operator's and adds a support link. All three read `useBranding()`, which both layouts seed from the server (`lib/branding/load-branding.ts`) so nothing flashes Cloudgate first; the title template and favicon are the layouts' `generateMetadata`, the one server-side read in the app, and the default favicon is declared in the root metadata from `public/` because a file-convention `app/favicon.ico` outranks every nested layout's icon. |
| **Controls** | |
| `search-input` | Leading magnifier, `label` required (a placeholder disappears the moment someone types). Grows to fill a toolbar row, shrinks to 220px before the row wraps. |
| `segmented` | Two to four mutually exclusive choices, all visible. `aria-pressed`, because each segment acts immediately. Past four options it is a Select. `disabled` turns every segment off with `aria-disabled` and refuses the click; an option's own `disabled` and `title` turn one off and say why. |
| `time-range` | **`TimeRange` (F14) — the window an observe screen is looking at**, plus the conversions three differently-shaped routes need (`rangeBounds` / `withinRange` / `spanReading`). Shared rather than per-screen because the `dataviz` rule is one filter row above everything it scopes, and two screens that could disagree about "the last hour" would both be right. Its bounds are rounded to the minute so they can safely be part of a query key. Full reasoning in the F14 section below. |
| `picker` | `Picker` — one choice from a short list, the six shadcn Select primitives composed into one control. Exists because a select is five components at every call site and F09 alone has eight. **It is a button, not an input**, so inside a form it wants `Controller` and its `Field` wants `manual`. `detail` renders **beside** the label, never under it: a select row is `h-8` and a stacked pair overflowed it, so the popup clipped the first option's label and the list read as a column of orphaned commit shas. Past ~20 options a list you cannot filter is the wrong control — see F09's `repository-picker`. |
| `tabs` | `Tabs` / `Tabs.Bar` / `Tabs.Tab` / `Tabs.Panel` over base-ui's tabs. Brand rule on the current tab, sitting *on* the strip's hairline. Scrolls sideways with the scrollbar hidden, so eleven tabs never widen the page. |
| `toolbar` | `Toolbar` + `ToolbarGap`. A layout row that wraps rather than scrolls. Deliberately no `role="toolbar"` — that role promises arrow-key navigation we do not implement. |
| **Surfaces** | |
| `card` | `Card` / `.Header` / `.Body` / `.Footer`. `tone="plain"` drops the shadow for a card inside a card; `<Card.Body flush>` for a table that owns its edges. Header takes `title` / `sub` / `actions` / `headingLevel`; its row wraps, the title block asks for `basis-60`, and the actions wrap among themselves, so at phone width they go under the title rather than squeezing it. |
| `meta-strip` | The `--panel-2` strip above a table, inside the card. Figures go in a `<strong>` — the strip is a sentence and the numbers are what people scan for. |
| `banner` | `Banner` (collapsible, count badge) + `BannerRow` (tone bullet with its word in an `sr-only` span, action that drops full-width under the text at 620px). Copy is `wrap-anywhere`. |
| `page-header` | Title, icon, badges, lede, strap, actions. The title block asks for 340px so the two halves wrap apart on their own; under 620px the actions go full-width and share the row. |
| `cols` | Main + `w-aside` rail, one column under 1040px with the rail second **in DOM order** — no `order` juggling, so eye and screen reader get the same sequence at both widths. |
| `section-heading` | Heading, lede and its controls on one line, wrapping at 240px of heading rather than squeezing. |
| **Status** | |
| `status-pill` | `status` (typed `StatusKey`) or `mark` (from `containerMark` / `taskMark`). **No colour prop, ever** — the key decides the tone. The glyph is decoration; the word is the status. |
| `dot` | A status where there is only room for one. Always ships its word in an `sr-only` span. |
| `chip` | A static label, never a status. `mono` for a literal (tag, commit, port), `brand` for the one chip that names what a row *is*. |
| `gutter-mark` | The signed `+` / `⇆` / `−` / `○` column in a plan or diff, mono so the glyphs line up, with the word in an `sr-only` span. |
| **Flows** | |
| `stepper` | `<nav>` + `<ol>`, `aria-current="step"`, tick when done. The current step keeps its tint under the pointer. Read-out when `onSelect` is omitted. |
| `pick-card` | `PickCard` + `PickGrid` — a choice with room to explain itself. `aria-pressed`, as the reference has it; the grid names the set. `inert` marks one off without removing it from the tab order. **Three props added by F17, and the third changes what the element is:** `descriptionLines` clamps to 2 or 3 lines, for a set whose descriptions are written to no length (the template catalogue's run from one clause to 677 characters, and unclamped one card is six times the height of its neighbour); `footer` is a last row under the meta, for a tag row — its own slot rather than folded into `meta`, which is one mono literal and would set chips in monospace; and **`render` makes the card a link** (pass `<Link href=…>`), which drops `aria-pressed` and the radio dot with it. That last one is F07's `LinkButton` rule applied to a card: a control that *goes somewhere* has to be a link, because a `<button onClick={push}>` cannot be opened in a new tab — and for a catalogue, comparing two entries in two tabs is the first thing anyone reaches for. No glyph replaces the dot: the whole card is the target, which is the convention, and every candidate in our icon set says something untrue (a `route` glyph was tried and read as decoration). |
| `empty-state` | Icon, heading, one sentence, action. An invitation to act, not a report that a query returned zero rows. |
| `skeleton` | `aria-hidden`; put `aria-busy` on the region. The pulse settles rather than speeds up under reduced motion. |
| **Overlays** | |
| `menu` | `Menu` / `.Item` / `.Group` / `.Separator` over base-ui's menu, plus **`MenuRow`** — the same row outside a menu, because the reference leaves `.mi` unscoped so a menu row and a compact card list row cannot drift apart. `Menu.Group` carries its own label: base-ui throws on a group label without a group, and a label outside the group it names is one nothing associates with. |
| `modal` | `Modal` / `.Header` / `.Body` / `.Footer` / `.Gap` / `.Close`, `wide` for 860px. Sits high rather than centred and scrolls **inside the box**, so the page behind never moves. The footer is sticky — one deliberate departure: a dialog whose "Delete" is below the fold is one people hunt for. **`keepOpen` (F16)** maps to Base UI's `disablePointerDismissal` and also refuses Escape: **set it only while the dialog holds something the person cannot get back.** A modal you cannot dismiss by clicking away has taken the page hostage, and the reflex to click the backdrop is deep enough that turning it off reads as a bug. The reveals that meet the bar are three: the two-factor enrolment's second step (the only copy of ten backup codes), the new personal key, and an Agent's first key — each a value no route hands out again, each closed by its own button. (The teardown report and the cloud-account credential steps also set it, while they hold work a stray gesture would lose.) A backdrop click and a single Escape press are both the *accidental* gesture; the close button still works. **The focus trap is ours, not the library's (F19).** This file used to say Base UI handled it. It does not, in practice: the guards are rendered and everything outside the popup is marked `aria-hidden`, but tabbing past the last control walked straight out — driven on Add-a-domain, sixteen Tabs from the Host field ended on **"Your account" in the masthead** with the dialog still open. That combination is worse than either half: the background is `aria-hidden`, so a screen reader following that focus is told **nothing at all** while it moves through six controls, and they are the controls a scrim exists to say are unavailable. `containTab` is the plain wrap — last→first, first→last, and focus that has already escaped is pulled back. It covers every dialog in the console **and ⌘K**, which is built on this component. Restore-on-close is still Base UI's and still works: measured returning to the trigger. |
| `toast` | `toast.done` / `.info` / `.warn` / **`.error(error)`**. The error one takes the *thrown value*, never a string, and runs it through `errorMessage()`. That is the whole reason this wraps sonner. |
| **Forms** | |
| `field` | `Field` (label, hint, error, all wired) + `FormError` (the refusal with no field to land on). See **Forms** above. **`min-w-0` on the root (F13)** is load-bearing and was paid for: `Textarea` carries `field-sizing-content`, whose content-based *width* propagates as a max-content contribution, so one unbreakable token — an SSH public key — pushed a 600px dialog to 661px and gave it a scrollbar that clipped its own footer. Neither `min-width:0` on the textarea nor `max-w-full` fixes that; it has to be the ancestor. **`manual`** (F09) skips the `register` call for a child whose value a `Controller` owns — a Select, a Switch, a radio-card grid. Everything else still applies, including reading the *form's* error for `name`, because a Controller reports under the same name. Without it, `Field` hands a button an `onChange` expecting a DOM event and claims a name the Controller is already managing. |
| `use-api-form` | `useForm` + zod resolver + the refusal routing. See **Forms** above. |
| `schema-issues` | `schemaIssues(schema, values)` — a zod schema's refusals as one sentence per field, for a dialog whose values live in `useState`; hand each to its `Field`'s `error`. Submit stays on and the sentence goes under the field, the one pattern `useApiForm` gives a form for free. |
| `submit-button` | `SubmitButton` — the button that submits a form, while it is submitting. The label **does not** change to "Saving…": a control that renames itself mid-press makes you doubt what you pressed, and the new word is a different width. `disabled` + `aria-busy`, so F03's one inert rule applies and the control keeps its focus ring and its place in the tab order. `block` for a form's one action on a narrow column. |
| `password-input` | `PasswordInput` — a password field you can read back. The toggle is `type="button"` (a bare button inside a form submits it, so revealing your password would sign you in) and `tabIndex={-1}` (tabbing from password to "Sign in" should not land on an eye first; it keeps its `aria-label`). Everything it is handed goes to the `<input>` — `Field` clones its child with the `id`, the `aria-*` wiring **and** react-hook-form's registration, so swallowing any of them would look right and be invisible to the form. |
| `test-result` | `TestResult` — the answer to a **Test connection** press: "Worked." on the ok tint or "Did not work." on the bad tint, then the sentence, as a `role="status"` paragraph. Shared by `ResourceFormModal`'s `spec.test` and the Docker-image source form, which asks a registry the same question outside a `ResourceSpec`. Run a refusal through `lib/format/redact.ts`'s `redactSecrets` with the values just sent before handing it here. |
| **Tables** | |
| `data-table` | `DataTable` — column definitions in, rows out. Sorting and selection held internally (two `useState`s and a `useMemo`; **no `@tanstack/react-table`** — a table library is a dependency to justify, not a default). Cell tones: `key` / `num` / `wrap` / `muted`. **Selection is carried by the checkbox, not the row**: `aria-selected` is only meaningful on a row inside a `grid`/`treegrid`, so the checkbox announces the state and the `--brand-tint` fill follows it through `data-selected`. Takes an `empty` node for a table with no rows, rendered **under the scroller, not in a `colSpan` cell** — inside the table it was centred across the full scroll width and cut off at phone width. **A table that scrolls says so**: the side with more table beyond it fades, and a last column whose head is `sr-only` (the row's Actions, by convention) is `sticky right-0`, opaque, and carries the right-hand fade on its own left edge, so a row's actions are always on screen. **`truncate: true` on a column is the only way a cell truncates**: the table is auto-layout, so a `truncate` class in a cell clips against nothing and the cell grows to its string, which put the Actions column behind the scroll at desktop width. A truncating column shares, by percentage, the width the others leave (floor `min-w-32` on the head and a `w-32` clip in the cell — `w-0` let Sessions' Device column collapse to nothing at phone width), and its content is clipped to that; `truncating-cells-are-bounded.test.ts` holds every cell to it. The `wrap` tone carries `wrap-anywhere`, so an identifier with no spaces can wrap. **A header is one line, in sans**: `HeadCell` puts `font-sans whitespace-nowrap` after the column's classes, so a `font-mono` column keeps its mono in the cells only. A `nowrap` header is its column's minimum, and the minimums are what decide whether a row fits once the truncating column is at its floor, so a header is a short word — the Domains table's are "Port" and "Sign-in", not "Container port" and "Sign-in required". No sticky head — that needs a vertical scrollport the app shell does not own until F07. |
| `head-cell` | `HeadCell`, sortable or not, plus `SortState` and `nextSort` — this file owns *how a header sorts*. `aria-sort` on the `th`, a button inside it. Omitting `sort` and passing `"none"` are different things: `"none"` promises the header is actionable. A third click does not clear the order. **The button fills the cell's height (F19)** — it used to size to its own text, 18px inside a 38px header row, which made the one control on every table in the console the only one below the 26px floor the rest of the system keeps (`Button`'s smallest size, `xs`, is exactly `h-6.5`). The row already reserved the space; the target was not claiming it. Nothing moved: 18px → 38px. A right-aligned (`num`) head's button carries `justify-end`, since the button, not the cell, places the label. |
| `pager` | `Pager` — says where you are before offering to move you. A step that leads nowhere goes `aria-disabled` rather than away, and takes no `aria-label`: "Previous" is already the whole truth. |
| **Readouts** | |
| `stat-tile` | `StatTile` + `StatGrid`. Label, value, unit, detail, optional `trend` slot for a sparkline. Figures are **proportional** unless `live` — a 22px number in tabular figures looks loose, but one that ticks in place must not shuffle the words beside it. Columns of figures are `DataTable`'s `num`, not this. |
| `kv-list` | `KVList` + `KVRow` — a real `<dl>`, so the pairing is in the accessibility tree rather than implied by which side a string sits on. The value truncates right-aligned, so a `sha256:` digest cannot widen a 336px rail; pass `title` and the whole string stays reachable. |
| `qa-row` | `QAList` + `QARow` — what to do next, why, and the control that does it. The title is a `<p>`, not a heading: twelve findings are not twelve sections of the document. **Two F16 fixes.** `title` is now `Omit`ted from the div props rather than intersected with them: a `<div>` already has a `title` attribute typed `string`, so the prop was silently `React.ReactNode & string` and a title with a chip in it failed to typecheck at the call site (`CardHeaderProps` was already doing it correctly two files away). And the row **wraps** — it was a non-wrapping flex, so at 380px an action wide enough (a `Switch` is 44px plus its gap) pushed it 11px past its card and the switch scrolled inside a box nobody can scroll. Found by measuring, not by looking. The answer is `PageHeader`'s: the action drops under the text and takes the full width. |
| `meter` | `Meter` — how far along, or how full. The bar is `aria-hidden` because the label and figure above it are the same information in words; which is exactly why `warn` and `alarm` **must** carry a word, and render one ("near its limit" / "over its limit") when the caller gives no `note`. |
| `segmented-progress` | `SegmentedProgress` — one segment per step, `done` / `now` / `todo`. The companion to a `Meter`, not a substitute: the meter says how far along, this says *which step*. The ribbon is `aria-hidden` and an `sr-only` sentence is the accessible version. Past ~30 steps, use `Stepper` for the phases. |
| `split-bar` | `SplitBar` — a total split by its parts, on the `--series-*` ramp. **The total is the sum and cannot be passed in**: a bar against a number nobody supplied data for is a bar against an invented quota, and this product has no quotas. The legend is always rendered, and part five onwards is painted `other`. |
| **Telemetry** | |
| `sparkline` | `Sparkline` — 30px, no axes. `role="img"` with a sentence (low, high, latest), because a path tells a screen reader nothing. `dead` is dashed as well as red, so "stopped" survives greyscale. |
| `plot` | `Plot` — dashed grid, area and line, four tones. **Scrubbing:** pointer *and* arrow keys, with the readout pinned to a corner so it can never collide with the line or fall off the panel, and a live region so focus says what hover shows. Every value is also in an `sr-only` table, so the scrub layer only ever enhances. Tick labels are **sampled from `labelAt`** rather than passed in — see `tickCount`. |
| `chart` | `Chart` — a number and its history side by side, plot on the right, stacked under 620px. The reading comes first and the plot explains it. |
| `series-table` | `SeriesTable` — a series as an `sr-only` table. Its own component because it is its own deliverable: it is what makes the hover and keyboard layers safe to be *enhancements*. Whatever renders it must be a containing block. |
| **Streams** | |
| `log-well` | `LogWell` — mono, tabular timestamps, one tone per line, capped by whoever owns the buffer. **It renders lines; it never parses them** (`toLogLines` is the trivial adapter), because what counts as a warning belongs to the tool writing the log. Follow-tail **detaches when the operator scrolls up** and offers a way back; the tail is a scroll position written to the DOM, not React state. The cursor snaps in `steps(1)` and stops under `prefers-reduced-motion`. `fill` makes it take the height it is given — a Docked log. |
| `log-dock` | `LogDockButton` · `DockedLogNote` — a log card's **Dock** control (the word, icon and place of a page shell's, disabled at the logs cap with the sentence beside it), and the one-line note left in the log's place once docked, with **Show the Dock** and **Read it here too**. |
| `log-refusal` | `LogRefusal` — why a stream stopped: the gateway's `closeReason` in primary text, and under it, quieter, the screen's guess at what is usually behind a refusal *at connect*. **The guess is conditional on the close code.** All three log views appended a fixed hint written before a mid-stream refusal existed, so ADR-0012's `4010` — a socket that was streaming a second earlier — was explained with "a database that has never been deployed". A `4010` gets the one sentence true on every screen instead: the access it was opened with is gone. |
| `service-output` | `ServiceOutput` — a Service's **Runtime log** on a Server or the platform host: its Swarm service's output, followed live from the last 200 lines, with Reconnect, Dock and the never-deployed, stopped and ended states read off the row. A database's Container output and an Application's Logs tab are this one box; `copies` keeps Docker's task prefix and draws every copy merged by time, each line naming its copy (`toCopyLines`, in `service-output-lines.ts`). |
| `diff-view` | `DiffView` — gutter of signs, tinted add/delete rows, and its **own** horizontal scroll: diff lines cannot wrap without lying about their indentation. The gutter is `sticky` at the left edge (the reference lets it scroll away). Its three words — added / removed / unchanged — are deliberately *not* `GUT`'s six: that map is about what a plan does to a resource. |
| **Page furniture** (F07) | |
| `page` | `Page` — the 1360px measure and the page gutter, declared once. Every console screen sits in one. A `<div>`, not a `<main>`: the console has exactly one `<main>` and it is the scroll region this sits inside. |
| `outcome` | `Outcome` — how a screen ends when there *is* no screen: a bad id, an address that names nothing, a page that threw. Tinted mark, `<h1>`, one sentence, and a link somewhere that certainly exists. **Not `EmptyState`** (whose action creates the missing thing — an appalling answer to a mistyped link) and not `AuthOutcome` (a statement inside a 400px column, not a page). A missing resource is `info`, not `bad`: nothing failed, and red sends an operator looking for an outage. |
| `dash` | `Dash` — there is no value here. Ships its word in an `sr-only` span, because `--tx-4` is decoration-only and a bare em dash tells a screen reader nothing. The word is the caller's: "None", "Never", "Unknown". |
| `avatar` | `Avatar` — a person's picture, else their initials, else the person glyph. The picture is an operator-typed URL, so a broken one falls back exactly like a missing one, keyed by the URL that failed. `aria-hidden` with an empty `alt`: every surface names the person beside it. A plain `img`, `no-referrer`, because the host is anyone's. Its name comes from `lib/format/person.ts`, which is the only place a person's name is built (`person-name.test.ts` holds that). |
| `link-button` | `LinkButton` — a link that looks like a button: a plain `<a>` (or `next/link`) wearing `buttonVariants`, **not** Base UI's `Button` rendered as an anchor, which stamps `role="button"` on it so a screen reader calls it a button and Space does nothing. Query it as `getByRole("link")`. F06's `auth-action` is just the full-width primary version of this. Use it whenever the control *goes somewhere*: a `<button onClick={push}>` cannot be opened in a new tab. |
| `tab-placeholder` | `TabPlaceholder` — a tab of a resource scope before the phase that fills it, titled from the registry entry. Deliberately not an empty state: an empty state invites you to act, and there is nothing here to act on yet. |
| `tab-pending` | `TabPending` — the shape of a panel while it arrives: title, lede, first card. The lazy panels' fallback. It was also every scope's `loading.tsx` until that boundary was deleted — it flushed the shell, and a 200, before an undeclared tab slug could 404. |
| `no-listing` | **Built by F08, promoted here by F10** — a screen, or a section of one, whose data has no endpoint. Five places are in this position now. Three are sections of an Application's Advanced tab; the other two are an Environment's Deployments and Domains tabs, which are a *different kind* of gap since — the services can be enumerated, so what is left is a fan-out to decide on rather than a route to wait for. The Environment's third tab, Services, is an ordinary table now. Deliberately not an `EmptyState` (whose action creates the missing thing, and whose "none yet" would be a lie about a list that may hold six) and not an `Outcome` (nothing failed). A tinted `info` mark, what is missing, and what does work instead. |
| `code-editor` · `code-editor-view` | **`CodeEditor` (F12) — a file, edited.** The one editor in the console, and **F10's patch editor and F16's Traefik config editor should come here rather than choosing again** (the F12 brief's instruction). `code-editor.tsx` is a `next/dynamic` boundary with `ssr: false`, so CodeMirror plus a YAML parser is its own chunk and every caller gets the split for free — measured in a production build: the chunk that contains it is named in **no** route's manifest. `code-editor-view.tsx` is the mount: **CodeMirror 6**, six small packages, no worker, undo history, a line gutter and a real YAML parse. Why not a textarea — a compose file is the whole definition of a stack and the screen the operator works *in*, not a field they fill in. Its theme is our tokens and its highlighting is deliberately two hues and two greys (see below). |
| `code-well` | `CodeWell` (F10) — a file, read: mono, numbered, on the same near-black well a log uses. `LogWell`'s sibling and deliberately not a variant of it: that one renders a *stream* — a tail to follow, a cursor, a per-line tone, a cap — and none of those mean anything about a file sitting still. The gutter is `aria-hidden` and the content is one `<pre>`, so selecting the text copies the file rather than the file interleaved with a column of numbers. |
| `revealed-key` | `RevealedKey` — **a secret shown once**: the warning box, "Copy this key now", a `CopyButton` whose `label` names the kind of key, and the value in mono. Built in `settings/account/` for personal keys and promoted when the Agents section's first-key and Add key reveals became its second importer. |
| `copy-button` | `CopyButton` (F11) — put a value on the clipboard and say so **in place**, not in a toast: the feedback belongs where the eye already is, and a corner toast for "copied" is the most interrupting way to acknowledge the least consequential action on a screen. The mark becomes a tick for two seconds and the accessible name changes with it. `type="button"`, because these sit inside forms. **It copies on an insecure origin**: a stock install serves the console over plain `http://`, where `navigator.clipboard` is `undefined`, so the Clipboard API is tried only where it exists and, when it is missing or refuses (the document is not focused), the value is selected in an off-screen `<textarea>` beside the button and copied with `document.execCommand("copy")` inside the click. **If that fails too, a popover under the button shows the value in a read-only field, focused and selected, with a visible "press ⌘C, or Ctrl+C" line** — and no timer: it stays until the operator copies from it (which counts as the copy), clicks elsewhere or presses Escape, because a two-second failure is the one someone who glanced away never sees, and then they paste the *previous* thing they copied into a production connection string. |
| `terminal` · `terminal-session` · `terminal-view` · `terminal-theme` | **`Terminal` (F13) — one emulator, two gateways.** A shell on a Server and a `docker exec` inside a container differ in the socket wrapper and in the words naming the target, and in nothing else. `terminal.tsx` is the `next/dynamic` boundary with `ssr: false` (xterm touches `document` at construction and is ~250KB) — verified in a production build: the chunk holding xterm is named in **no** route's manifest, so opening a Server does not download its terminal. `terminal-session.tsx` owns the socket **inside** that boundary, because both gateways speak first and a socket opened by a parent while this chunk downloaded would put its opening lines in the line buffer instead of the emulator. `terminal-view.tsx` is the mount; `terminal-theme.ts` turns our `oklch()` tokens into colours xterm can parse. Three things are the component's and not the caller's: it names its host or container **at all times**, a session that has ended says so where the cursor was, and the grid is 80 × 24 — see below. |
| `live-terminal` · `use-live-terminal` · `terminal-emulator` · `terminal-well` | **A shell session as a thing that can change hands.** `LiveTerminal` is one socket (`TerminalChannel`, `lib/realtime/terminals.ts`) and the `TerminalEmulator` showing it, owned outside React with an `owner` of `page` or `dock`: whoever holds it last disposes it, which closes the socket and has the gateway reap the shell. The emulator owns one xterm and its element, and `mount(frame)` moves that element between frames — a page's well and the Dock's — without a second xterm, so docking keeps scrollback and the running process; a mount refits at once and sends the shell its size. `useLiveTerminal` only reads (socket state and grid). `terminal-well.tsx` is the frame that lends itself to an emulator, and the one import of `xterm.css`, so it is lazy everywhere outside the terminal chunk. |
| `terminal-status` · `terminal-target` · `terminal-keys` | **What every terminal frame says, wherever it is drawn.** `TerminalStatus` is the line under the well (the sentence per close code, and *Connect again*), `sessionStatus` the pill, and `endedWords` the few words a Dock tab carries when its shell ended in the background. `terminal-target.ts` is `TerminalTarget` and its names: `terminalTitle` (`storefront · production · Demo Shop`, `container web on main-vps`, `Server main-vps`, `This host`), `targetNoun`, `terminalLabel`, and `terminalKey` — the identity the Dock's `+` dedupes offers by. `terminal-keys.ts` is ⌃`, which the Dock listens for and the emulator declines. |
| **Spec-driven forms** (F10, promoted by F11 and F15) | |
| `form-spec` | `FieldSpec` / `RowColumn` — **one control in a form, as data.** Built by F10 inside `application/advanced/resource-spec.ts`, moved here by F11, which is the second phase to want the form half without the list half. `resource-spec.ts` re-exports both, so F10's call sites did not change. Nine kinds; F11 added **`password`**, because five of six database engines have a password on their create form and one has two — a `text` field would put a live database password in plain sight and a bare `type="password"` would make a 16-character generated string untypeable. F15 added **`section`**, the one kind that is not a control: a rule and a heading between two groups of them, because a notification's eight event switches sitting straight under a webhook URL read as eight more settings *of* the webhook. |
| `resource-spec` · `resource-list` · `resource-form-modal` · `delete-resource-modal` | **A table of child records with add / edit / delete, as a configuration file.** Built by F10 in its own folder for mounts, schedules, volume backups and patches; **promoted here by F15**, the fifth through eighth consumer — registries, destinations, AI providers and twelve notification channels, none of which belongs to an Application. F10's `resource-spec.ts` re-exports the types so no call site changed. Two things F15 added: **`tableLabel`** (F10 hard-coded `"${title} of this Application"`, which is F11's `emptyBody` defect waiting to happen), and **`test`** — a connection test that runs from *inside the dialog*. **Two routes behind one button** since an id-taking test was added beside each credential-taking one: filled-in credential boxes probe the values on screen, empty ones on an edit name the saved row and let the server read its own decrypted credential. The dialog is where both can happen, and where the first can happen *at all*. `test.redact` is the escape hatch a refusal that *contains* the secret needs; see F15's section below. |
| `resource-field` | `ResourceField` — one `FieldSpec`, rendered. The reason `kind` exists rather than callers passing JSX is the wiring underneath: an `<input>` is registered by `Field`, and a `Picker` or a `Switch` is a **button** and needs a `Controller` and `manual`. Moved out of F10's folder by F11 along with `rows-field`. |
| `rows-field` | `RowsField` — the repeating group. Networks, published ports, ulimits, placement preferences and platforms, and Docker labels are all "a short list of little records". Moved here with `resource-field`. |
| `engine-limit-fields` | **The CPU and memory limit and reservation fields** an Application's and a database's Resources card share: typed in cores and sizes (`512 MB`, `1.5 GB`, a bare number is MB), saved in the nano-CPUs and bytes the API keeps. `limitShape` is the schema half, `limitDefaults` / `limitColumns` the two conversions, `limitFields` the four `FieldSpec`s. The conversions are `lib/format/units.ts`'s and the refusals `lib/forms/engine-units.ts`'s, which the Swarm durations (seconds) use too. |
| `use-unsaved-changes` | `useUnsavedChangesGuard(dirty, message)` — **asks before leaving a form with edits not saved**: `beforeunload` for a reload or a closed tab, and a capture-phase click on a same-origin link (a Next `Link` never unloads) that is stopped unless `confirm` says yes. A new-tab click and a link to the same page go through. The Swarm section is its first caller, because its eleven cards share one Save at the bottom. |
| `settings-card` | `SettingsCard` — a card that is a form over a few columns of one row. Resources, a run command, a build server, every Swarm concern, and all of F11's database cards are this. **Always editable**, unlike F08's variables and F09's source, and that split is deliberate: those guard a *destructive shape of edit*. `fields` may be a function of the current values, which is what makes a live unit reading possible. |
| `variables-card` · `variables-form` | The `env` blob as a masked table with an Edit that swaps in a textarea. **Built by F08, moved here by F11** — F09 and F11 were both already importing it across feature folders, which is the signal the doc's own rule names. F11 added **`emptyBody`** because the default sentence ("handed to everything deployed below them") is nonsense for a *service* — nothing is deployed below a database — and a shared component that hard-codes one caller's hierarchy tells the other callers' users something untrue. **F19 fixed the default itself**, because that sentence was not true of a **Project** either: nothing is inherited downward for anybody, since `prepareEnvironmentVariables` resolves `${{…}}` references and never merges levels. So the default was where the damage was — a Project and an Environment are the two screens on which somebody decides to set a key once and stop. |
| **Grants** (promoted) | |
| `access-tree` · `access-sections` | **The Project → Environment → Service tree a grant is ticked in, and the reads behind it.** Built inside `features/members/` for Manage access, and promoted here when the Agents section became its second importer — its create dialog, its own Manage access and its row's access line all draw the same tree, because a second copy of the fan-out is how one of them ends up stripping a grant the other would keep. `useAccessTree` reads only the signed-in person's own routes, so it can never offer what they cannot see; `AccessTree` renders the three columns with every tick going through the cascade in `lib/auth/access-grants.ts`; `access-sections` is the furniture (`AccessSection`, `AccessCheck`, `ScopeGroup` with §3.5's error → pending → empty order per group, `StrandedGrants`). The fan-out hooks sit in `lib/api/use-member-grants.ts` and `useProjects` in `lib/api/use-projects.ts`, so nothing here reaches into a feature. |
| `access-modal` | `AccessModal` — **Manage access, for a person or an Agent**. The seed from the member row's three columns, the tree, the stranded ids and the whole-set save were one dialog written twice; the callers keep only what differs — title, description, who the grant is for, and what is said above the tree (Members' admin notice, the Agents' log-mask notice). |
| **Organizations** (promoted) | |
| `organization-form-modal` · `new-organization-reason` | **"Create an Organization", and why it is greyed out.** `OrganizationFormModal` creates or renames one; `NewOrganizationReason` is the one line under a refused "New organization" — the backend's refusal (`GET /organizations/creation`) as a sentence, then "Go to License" or the Billing `planHint`, carrying `data-licensed-feature="manyOrganizations"`. Built in `features/settings/organization/` and promoted when the masthead switcher became their second importer, so Settings > Organizations and the switcher draw one button state from one read. The read and its gate, `useOrganizationCreation` and `newOrganizationGate`, sit in `lib/api/use-organizations.ts` beside the list and its mutations, which the billing and Enterprise features already shared. |
| **Shared rows** (F07) | |
| `rows/server-row` | `ServerTable` + `serverColumns` — a Server as a row (`srvRow`/`srvHead`). **Head and cells are one declaration**, so a column inserted in one of a pair cannot land over the wrong header. Origin, Region, Size, Cost, Services and CPU are **absent, not empty**: provisioning has no backend, and nothing indexes services *by Server* — an Environment names its own and each carries a `serverId`, so the column is derivable by reading every Environment and grouping, which is a page of requests for one column. CPU needs F14's gateway. A column of em dashes is not a column. |
| `rows/service-row` | `ServiceTable` + `serviceColumns` + the **`ServiceRow` view model** — one row shape for the three things an Environment holds. A view model rather than a row type because the three kinds have three id columns and two status columns. There *is* a list endpoint to type against now — `EnvironmentService` on the Environment read — and the view model is why that landed without this table changing at all: F08, F11 and F12 each map their own rows in, and the Services tab maps the new summary in beside them. |
| `rows/deployment-row` | `DeploymentTable` + `deploymentColumns` — newest first, the only order anyone wants. **Duration is derived** from `startedAt`/`finishedAt`, and a run still going measures against now. The Service column appears only when the caller passes `owner`: a `deployment` row carries an id and no name. There is no **By** column because the row has no `userId` — omitted rather than invented. |
| `rows/cells` | `RowLink` (the reference's `.lk`, a real link so a row can be opened in a new tab), `RowSub` (the quieter second line, capped where a description would otherwise size the column), `RowTime` (a `<time>` with the relative reading and the exact stamp on the element). |
| **Destructive actions** (F16) | |
| `danger-zone` | **`DangerZone` — one card and one dialog for every action that destroys something.** F16 alone puts eight irreversible controls on four screens; the failure mode of eight hand-written dialogs is not that they look different, it is that they end up asking for *different amounts of care for the same amount of damage*, which teaches the reader that the confirmation is decoration. So the weight is declared as data: an action either carries `confirm` (a typed name) or it does not, and every one of those decisions sits beside the others. Three rules it encodes: the consequence is on the **row** as well as in the dialog (one is read while deciding, the other while committing); typed confirmation is only for what has no copy anywhere (`delete-resource-modal`'s rule from the other side); and `unavailable` renders a control **off with its reason in place** rather than hiding it — F03's one inert rule, so it keeps its ring and its place in the tab order. The dialog is keyed by action, because what was typed into it is state (F09's sixth defect). |
| `confirm-delete-modal` | **`ConfirmDeleteModal` (F19) — destroying one of the six named things, once.** `delete-resource-modal` covers the small recoverable row and argues why it asks for *no* typed name; this is the other half — a Project, an Environment, a stack, a database, a Server. F19 found five of these written out by hand and drifting on exactly the parts that decide whether a confirmation works, with `delete-server-modal.tsx` drifting on all four at once: the typed name was **not cleared on close** (so reopening after a cancel armed the delete before you had read a word), the refusal went to a **toast** instead of staying in the dialog where the decision was made, there was **no `form`** so Return did nothing, and a wrong name showed a **hint** rather than an error. None of those is visible in a screenshot, which is how five dialogs disagreed about them for eleven phases. The body stays with the caller — the cascading Environments, the volume that survives, the containers that keep running on a machine Cloudgate is about to forget are the part worth writing five times. The machinery is not. |
| `restart-traefik-consequences` | **The words of every Restart Traefik confirm** — the line under the title, the consequences and the toast — shared by the Requests screen's `RestartTraefikModal` and the Settings → Traefik `DangerZone` action (through its `caution`). Words rather than a dialog because the two confirms sit in different shells. It exists because they drifted: the Settings one borrowed the destructive deletes' "This cannot be undone." for a restart that loses nothing. `change` is the one clause that differs per screen — what the restart makes take effect. |
| `qr-code` | `QrCode` (F16) — a QR code as a single SVG `<path>`, from `uqr` (~5KB, no dependencies). It uses `encode` rather than that library's own `renderSVG`, which writes literal `"black"`/`"white"` and one `<rect>` per module. **It does not switch with the theme**: a decoder expects dark modules on a light field, and this is the screen where "it works on my phone and not on hers" costs somebody their account — see `--paper` under **Colour roles**. |
| `service-health-state` | **A Service's worst current health**: `healthStateMark` over the backend's `state`, `HEALTH_STATE_RANK` for sorting worst-first, the Environment's `HealthCell` and the Overview's `HealthFactRow` (the mark, what it rests on, and the Health tab link). Built in `features/service-health/`, promoted when the Application, Compose and database Overviews and the Environment's Services tab became its importers; its reads, `useServiceHealth` and `useEnvironmentHealth`, went to `lib/api/use-service-health.ts` with it, and `serviceHref` to `components/shell/service-href.ts`. |
| `upgrade-confirm` | **`UpgradeConfirm` — Starter → Business, with the exact amount charged today (ADR-0054).** Self-contained: it reads Stripe's invoice preview itself while open and needs only `open`, so the Billing page's picker and the four paid-feature pages' "Upgrade to Business" (`features/enterprise/business-plan.tsx`) open the same one. Moved out of `features/billing/` for that second feature (§1.4); the billing reads both use went to `lib/api/use-billing.ts` with it. |
| `trial-switch-confirm` · `downgrade-impact` | **`TrialSwitchConfirm` — Starter ↔ Business during a free trial, at once and "0 USD, still free"**, opened by the Billing page's picker and, during a trial, by the paid-feature pages' "Upgrade to Business" in place of the paid `UpgradeConfirm`. To Starter it first lists what stops now with **`DowngradeImpactList`** (`GET /billing/downgrade-impact`), the list the paid month's `DowngradeConfirm` (`features/billing/`) shows too, so a trial's downgrade and a paid one name the same facts. Moved out of `features/billing/` for the paid-feature pages (§1.4). |
| `health-panel` | **`HealthPanel` (in `features/service-health/`)** — the whole Health tab, which the Application, Compose and database `panels/health.tsx` render with their `serviceType`. Listed here and left in its feature, as `license-gate` and `section-states` are: it *is* that feature — its sections, their writes and their modals — so promoting it would move the folder into `components/console/` or have `components/console/` import `features/`, which no file here does. |
| `service-shell` · `offer-service-shell` · `offer-scope-shell` · `open-shell-button` | **A Service's shell (in `features/service-shell/`)** — the Shell tab (`ServiceShell`), the Overview's *Open a shell* (`OpenShellButton`), and the Service page's offer under the Dock's `+` (`OfferServiceShell`, mounted by each scope layout through `OfferScopeShell`), shared by the Application, Compose and database features over one Service-scoped container listing (`useServiceContainers`, `GET /docker/services/:serviceType/:serviceId/containers`). Listed here and left in its feature on `health-panel`'s argument: it is one feature that three scopes render, not a primitive. |
| `service-requests-panel` | **`ServiceRequestsPanel` (in `features/requests/`)** — a Service's Requests tab: its Server's Access log fixed to that one Service, read by `GET /monitoring/requests/services/:serviceId`, which the Application and Compose `panels/requests.tsx` render. Listed here and left in its feature on `health-panel`'s argument: it is the Requests page's own body (`RequestsBody`, `useRequestsAddress`) without the Server picker, the Service filter and the Service column, so promoting it would move the Requests feature into `components/console/`. The Request logging card's anchor it links to, `REQUEST_LOGGING_ANCHOR`, lives in `lib/shell/tabs/server.ts` beside the Server's tabs, since the Requests and Server features both use it and neither imports the other. |
| `license-gate` | **`LicenseGate` / `LicenseLocked` (F18, in `features/enterprise/`)** — the one gate and the one sentence for every licensed section. Driven by `GET /license/status`, which is the only honest way to decide: the sections' own reads answer `403 Valid enterprise license required`, and a 403 means *"your role does not allow this"* to F02's status rules, which is exactly the wrong sentence. So the gate asks the question the backend will ask, once, and the sections beneath it never fire a request that was always going to be refused — driven and measured: an unlicensed `/settings/sso` makes **exactly one** backend request. **It is not `--hatch`.** That token means "does not exist yet"; this means "it exists, it works, and this Organization has not bought it" — a different statement with a different action attached, so it names the feature in a sentence *before* the licence, states the licence once, offers the one thing that changes the answer, and renders **nothing** of the feature: a disabled form invites you to fill it in, and an empty table claims your Organization has none of something it cannot be asked about. While the status read is in flight it is a skeleton, not a lock (F07's `CountTile` defect). `LicenseLocked` is the block without the card, for the one screen — Roles — that has something real to show unlicensed. |
| `section-states` | `SectionPending` / `SectionFailed` (F16, in `features/settings/`) — `TabPending` and `Outcome` at **card** scale. Both of those render their own `Page` because both replace a whole screen, and a settings section is already inside one; nesting a second `Page` doubles the measure and an `Outcome`'s `<h1>` would be the page's second. `SectionFailed` states the refusal in words rather than rendering an empty list — F09's first defect, and sharper on these screens than anywhere else, because "your role cannot read this" and "there is nothing configured" are the two most different sentences a settings page can say. |
| **DNS-01** | |
| `dns-challenge-card` | `DnsChallengeCard` — **a machine's DNS-01 setup**: the lego provider, the credentials, save and remove. Shared by the platform host's Traefik screen (`serverId` null) and a Server's Settings tab, because the setup is per machine as `traefik.yml` and Traefik's env are; `gate` is the caller's, since the two take different authority. Its own card rather than a block in "Traefik's container": that card reads the running container, and this is a stored row. Its form's rules are `PutDnsChallengeDto`'s, said first. |
| `dns-records` | `DnsRecords` and `dnsRecordLine` — **the DNS records a cloud Delete leaves**, as lines to remove at the operator's DNS provider, since Cloudgate never writes DNS. Shared by an Environment's Delete card and the plan rows that remove a network; moved out of `features/environment/` when the plan rows became its second feature (§1.4). |
| `wired-variables-card` · `wired-link-form` · `wired-changed-notice` | **A Service's wired variables** (ADR-0031): its links as name → source and Output with Add, Change and Remove through `wired-link-form`, and the "deploy to pick up the new value" notice. Shared by the Application's and the database's Variables and Overview panels; moved out of `features/wired-variables/` for that second feature (§1.4). Its reads live beside it in `lib/api/use-wired-variables.ts`. |
| `use-existing-button` · `use-existing-modal` · `use-existing-cache-modal` · `existing-database-form` | **"Use an existing database"** (ADR-0033): the plan row's button and the RDS and ElastiCache forms, which share `useExistingForm` (the reach, the save and its toast), `Tick` and `LetIn`. Each also asks for a switch from its database's page. Moved out of `features/database/existing/` when the plan rows became their second feature (§1.4). |
| `use-existing-bucket-button` · `use-existing-bucket-modal` | **"Use an existing bucket"**: the plan row's button and its form. Moved out of `features/bucket/existing/` with the database's, the plan rows being their second feature (§1.4). |
| `cloud-resource-list` | `CloudResourceTable`, `UnreadableStateBanner` and `RebuildStateModal` — **what an Infrastructure state holds**: type, AWS id, region and tags, never a value, with "not findable by tag" marked, the unreadable-state banner and Rebuild from the cloud confirmed by name. Shared by a cloud Service's card and the Environment network's; Rebuild's refusal is the caller's. Its reads live beside it in `lib/api/use-cloud-resources.ts`. |
| `dns-challenge-credentials` | `DnsChallengeCredentials` — the card's credentials half. **A stored value is never on screen, not even masked**: the read names the keys that are set, so the two states are the stored keys untouched (a save omits `credentials` and keeps them) and a full new set (a save sends it whole). Values are `PasswordInput`s with `autoComplete="new-password"`. |
| `dns-challenge-remove-modal` | `DnsChallengeRemoveModal` — remove the setup. No typed name, on `delete-resource-modal`'s argument: it is put back from the card beside it. The route's 409 names every Application's previews, Domain and forward auth still issuing through the resolver, and the refusal stays in the dialog's footer beside the button. |

### `src/components/shell/*` — the console shell (F05)

Read **The shell** above before changing any of these. A feature phase should only ever touch `nav.ts`.

| Component | Notes |
|---|---|
| `scope.ts` | `scopeFromPath` / `scopeRoot` / `tabHref`. Pure and fetch-free, so the rail is right on the first frame. Also the argument for flat routes. |
| `nav.ts` | The five nav tables plus `scopeNav` / `scopeTabs` / `tabScreen` / `scopeExit` / `isCurrent`. **The entire navigation model.** |
| `scope-provider.tsx` | `useScope()` — scope, nav, identity, badges, exit (+`exitPending`), siblings. The one seam the masthead and rail read. Badges are *data* (`ScopeBadge`), so colour stays in `status-pill`. |
| `use-scope-queries.ts` | Each query is `enabled` for exactly the scope that shows it, so entering a Server costs one request and no Project lists. Returns a bundle memoized on the **rows** — TanStack hands back a new wrapper every render, and the whole context hangs off this. |
| `resolve-scope.ts` | Rows → context, pure, one branch per scope. Adding a badge or changing an identity is a change here and nowhere else. |
| `rail-row.tsx` | The one row recipe. `relative` on it is load-bearing: the collapsed label is `sr-only`, and an absolutely positioned child with no containing block *here* resolves against the initial one and silently widens the document — F04's table-cell trap again. |
| `rail-entries.tsx` | One nav-table entry, rendered, plus where a group's live children come from. Group children are fetched only while the group is open. |
| `palette-keys.ts` | The three focus/keyboard defects and their fixes, kept together because opening and closing a dialog are the two moments a keyboard user can be stranded and neither came free from the library. |
| `masthead.tsx` | Org cell (width tracks the rail) · context area · actions. Shows **either** the breadcrumb or the resource identity, never both. `overflow-hidden` on the org cell is a backstop: at 60px its contents would otherwise print over the resource's name. |
| `org-switcher.tsx` | Switching Organization moves the tenant boundary, so it invalidates through `organizationChanged()` rather than just navigating. **No fallback name**: while the list does not name the active Organization the button is a skeleton labelled "Switch Organization", never the word "Organization" standing in for a name. |
| `scope-identity.tsx` | Star · name (after a quieter parent path — Project, then Environment — each segment a link to that scope) · badges · sibling switcher. The switcher is **absent at service scope** rather than empty. The siblings *can* be named now, so what is missing is on this side: `resolve-scope.ts` would have to fetch the parent Environment at a scope that costs one request today. |
| `scope-title.tsx` | The document title names the resource beside the tab — `Settings · ui-main · Cloudgate` — and a scope that 404s is `Not found`. A React `<title>` rendered by `ScopeProvider`, not a fetch in `generateMetadata`: nothing under the console fetches on the server, and the name is already resolved. React puts the most recently *mounted* `<title>` first, and Next's streamed metadata can mount a commit later, so it remounts when another title lands in front of it. |
| `masthead-crumb.tsx` | Fades in once `<main>` scrolls 40px. Organization scope only; a resource scope has its identity up there permanently. Unreachable *and* `aria-hidden` until it appears, and reset by a navigation so it can never name a page whose title is right underneath it. |
| `avatar-menu.tsx` | The trigger is the person's `Avatar`, once hydration is over (a glyph until then, for the same reason as the label below), and the group label is `personName` — first and last name. Profile (Settings → Account; `/account` only redirects there) · **Appearance** (F03's `ThemeToggle`, rendered in the menu rather than behind a submenu) · Sign out, through F06's `useSignOut`. The trigger's `aria-label` is the **constant** "Your account": it used to interpolate the person's name, which hydrated with a mismatch on every signed-in load (`useSession` has nothing on the server), and React does not patch a mismatched attribute up. The menu's own group label names who is signed in, inside a popup that does not exist until it is opened. |
| `scope-rail.tsx` | Quick-search button, the nav region, the collapse toggle. Three modes; only the drawer's *open* state is React's. **An open drawer is a modal**: focus moves to its first control, Tab is held in it by the dialog's own `containTab`, Escape and the scrim close it and hand focus back to the masthead's toggle, which reads "Hide navigation" while it is open. |
| `rail-item.tsx` | `RailLink` / `RailLabel` / `RailRule` / `RailBackTo` (+`Pending`). Collapsed labels go `sr-only`, **never `hidden`** — the icon is `aria-hidden`, so the label is the only accessible name there is. |
| `rail-group.tsx` | `RailGroup` / `RailSubList` / `RailSubLink`. The one row shape with two jobs, so a group that is *also* a page gets the chevron as its own control — opening it and going to it are two different clicks. |
| `rail-group-flyout.tsx` | A group on the collapsed icon strip: its items open as a `Menu` beside the icon, because `RailSubList` has no room under the row there and the click used to show nothing. Only for a group that is not also a page — Projects' icon is already a link to its whole list. A drawer never gets it; a drawer is never the strip. |
| `command-palette.tsx` | ⌘K / Ctrl+K. A real combobox: the field keeps focus, the list is `aria-activedescendant`-driven, Enter takes the highlight. Owns its own Escape — see below. |
| `palette-sources.ts` | Every row comes from an endpoint. `go:`'s pages are read off the Organization nav table, so a new screen is findable for free. |
| `console-shell.tsx` | The `100dvh` grid, the two scroll regions, the skip link, the scrim, and `<main tabIndex={-1}>`. Drawer and scroll state each record *which page* they were set on, so a navigation resets them with no effect and no second source of truth — back button included. |
| `dock.tsx` · `dock-panel.tsx` · `dock-tabs.tsx` · `dock-add-shell.tsx` · `dock-resize-handle.tsx` · `dock-close-all.tsx` | **The Dock** — up to four Docked shells and, counted apart, up to four Docked logs, as tabs along the bottom of the console, held by the layout so they survive navigation. `dock.tsx` is `DockProvider` (the store, ⌃`, and ending every tab on `endAllTerminals` and on unmount) and `Dock`, the grid's third row; the panel and its header are `dock-panel.tsx`, built from the tab strip (two labelled groups, "Shells n/4" and "Logs n/4"), the `+` menu, the drag handle and the close-all question. Only the active tab's body is mounted; the others keep their socket, and a shell its xterm. Below the drawer width it is full-screen (`globals.css` 7b). |
| `dock-log.tsx` | **A Docked log in the Dock.** `DockLogTab` is its tab — the lines icon, a labelled status mark and its end word; `DockLogBody` the log filling the panel, with its follow bar under it (following or paused, the line count, Pause or Jump to latest, Go to its page, and a refusal in a Docked shell's words); `logName` the tab's name, what the page called the log else its key. |
| `dock-store.ts` · `dock-context.ts` · `terminal-offers.ts` | The Dock's rules, its seam and its `+`. `DockStore` is pure and unit-tested: open, dock, activate, close one, close all, and the two caps, each with the sentence beside the controls it disables (`MAX_DOCK_SHELLS` and `DOCK_SHELLS_FULL_SENTENCE`, `MAX_DOCK_LOGS` and `DOCK_LOGS_FULL_SENTENCE`). `useDock()` is `null` outside the console shell, which is how every in-page `<Terminal>` knows whether to draw **Dock**. `useTerminalOffers(offers)` is how a page, layout or card lists the shells *its* caller may open under `+` — filtering is the caller's job — deduped by `terminalKey`. |
| `dock-state.ts` | The Dock's shape, which is the browser's: minimised or maximised as `data-dock` on `<html>`, the dragged height as `--dock-h`, both written before first paint by `DOCK_INIT_SCRIPT` beside the rail's, and kept in `localStorage` (`cloudgate.dock`). Tabs are not restored on a reload. |
| `dead-session-exit.tsx` | **The one layout guard §3.7 permits**. `proxy.ts` checks cookie *presence* on the understanding that the first 401 corrects it — but a screen that fetches nothing until it knows the Organization never sends a first request, so the shell painted its full authenticated frame for a visitor with no session. It **ends the session** rather than redirecting, so the stale cookie cannot re-enter on the next navigation, and on an *unclaimed* instance it leaves for `/sign-up` — the screen the redirect had made unreachable. The decision itself is pure and tested in `lib/auth/console-gate.ts`; this file only supplies the facts and carries out the outcome. **A session whose user was removed from its active Organization** is the one outcome that does not end the session: a coded `403 YOU_ARE_NOT_A_MEMBER_OF_THIS_ORGANIZATION` makes `query-client.ts` re-read better-auth's membership list, `lib/auth/membership.ts` reads it once more before believing it (the list also lags a *join*), and the shell is replaced by `not-a-member.tsx` — the Organizations still theirs to switch to, and Sign out. |
| `not-a-member.tsx` | What `DeadSessionExit` renders instead of the shell when the session's user is no longer a member of its active Organization. `Outcome`, tone `info`: the Organizations still theirs, each a switch through `unwrap(organization.setActive())` and `organizationChanged()` — a refused switch is said inline as well as in a toast, because this screen is the whole console — and Sign out. With no memberships left it is `/select-organization`'s "No organization yet" words and Sign out. It never ends the session itself: the session is what they switch with. |
| `use-hydrated.ts` | `useHydrated()` — `false` through the render that hydrates, `true` after. For a value the client knows on its first render that the server cannot (a cached Organization list, a session): render it before hydration is over and React logs a mismatch it does not repair, and under `next dev` its fallback re-render recreated the shell's inline scripts too. The org switcher and the avatar menu read it. |
| `rail-state.ts` / `local-store.ts` / `favourites.ts` / `recents.ts` | The three things that are honestly the browser's and not the backend's: the collapsed rail, starred resources, recently visited resources. A Recents entry carries its ancestors' ids, so a delete made here drops the resource and its subtree, and a scope that answers 404 drops its own entry. |

Three defects found by driving the shell rather than reading it, all in the keyboard path:

1. **⌘K opened a palette you could not type into.** With focus on a rail link, the dialog opened and
   left focus *on that link* — which it had just marked `aria-hidden`. `initialFocus` did not move it,
   and an effect in the palette cannot either: Base UI mounts the popup's children in a **later commit**
   than the one that flips `open`, so the ref is still null. A callback ref fixes it, because it is
   called when the node attaches, which is the only moment guaranteed to exist.
2. **Escape did not close it once you had typed.** Chrome reverts a *non-empty* text field on Escape
   and consumes the event doing so, so the dialog's own dismiss never saw it — Escape worked only on an
   empty palette, the one case nobody needs it for. The field handles Escape itself now.
3. **Closing dropped focus on `<body>`.** Base UI restores focus to a `Dialog.Trigger`, and this
   palette has none. A running record of the last focus outside the dialog feeds `finalFocus`.

### `src/app/(auth)/_components/*` — the doors (F06)

Route-local on purpose: nothing in the console composes these, and an auth screen's terminal states are
its own vocabulary. Read **The doors** above before changing any of them.

| Component | Notes |
|---|---|
| `auth-panel` | The one shape every auth screen takes: title, sentence, card, way out. The title sits **outside** the card — a `PageHeader` above the surface the work happens on — so the card's edges bound the form and nothing else. `text-sect`, not `text-disp`: the page-title step is calibrated against a 1360px measure, and this column is narrower than the `hd` breakpoint at every viewport, so it takes the narrow-column step *everywhere* rather than changing size for no reason. |
| `auth-outcome` | How a screen ends when there is no form left. Not `EmptyState` — same shape, but that one carries no tone and is written for "nothing here yet, go and make one". The difference that matters is tone: "we have sent you an email" and "this link is dead" cannot look the same, so the mark is tinted **and** the heading states it in words. |
| `auth-action` | The way out of a terminal state, as a link that looks like the one action. Exists for `nativeButton={false}`: Base UI's `Button` assumes its `render` element is a real `<button>`, and an anchor without that flag keeps native-button semantics applied to something that is not one. It was in seven places at once, which is why this is a file. `reload` picks a full document load over a `Link`, for when the *session* changed underneath us. |
| `auth-link` | A link in running text or a footer. `globals.css` deliberately sets no colour on a bare `<a>`, and these screens are the one place a link must look like one without being a button. Underlined on hover and focus only — four permanently underlined footer items read as a list of rules. |
| `auth-fallback` | The Suspense fallback. Holds the *layout*, not the content, so nothing moves when the real screen replaces it: a door that jumps as it opens is the first thing anyone sees of this product. |
| `schemas.ts` | One email rule and two password rules, shared. Four forms ask for an email; the moment each writes its own, the same mistake gets four different sentences. "Both passwords have to match" is pathed onto the *second* field, which is the one someone would go and change. |
| `use-sso-config.ts` | The two public SSO reads, asked **before** the sign-in form renders. A failure **fails open to the password form**: treating an unreachable backend as "SSO is enforced" would replace the only working way in with a button that also cannot work. |
| `sign-in-form` · `sign-up-form` · `two-factor-form` · `forgot-password-form` · `reset-password-form` · `accept-invitation` · `select-organization` | One per screen, each owning its own panel and its own terminal states. |
| `sso-button` | `Label` + `Input`, **not** `Field` — this input belongs to the button, not to the password form beside it, and `Field` would register it with the surrounding `FormProvider` and block that form's submit until it was filled in. |
| `challenge-closed` | The three endings that mean *start again*, kept apart: a timeout, a spent attempt budget, and a locked account with a duration. Collapsing them would hide the only part that decides what to do — whether waiting is required. |

Four defects found by driving these rather than reading them:

1. **A form submit put the password in the URL.** No `method` means GET, so a submit that reached the
   browser instead of React serialised every field into the query string — `?password=…&confirm=…`, then
   in history and in the next referer. Every form in the group carries `method="post"` now.
2. **`Button render={<a>}` is wrong without `nativeButton={false}`**, and Base UI says so at runtime. It
   was in seven places; `auth-action` is the one place now.
3. **The avatar menu hydrated with a mismatched `aria-label`** (F05's file, surfaced by finally having a
   real session to drive). A name interpolated into an accessible name cannot survive SSR, and React
   does not patch a mismatched attribute up.
4. **"Forgot your password?" as the password field's `hint`** wired it into `aria-describedby`, so a
   screen reader introduced the password box as the thing you use when you have forgotten it. It sits
   outside the `Field` now.

### `src/features/*` — the feature phases

A Wave 4 phase owns a folder under `src/features/` and the panel files the tab registry names inside
it. Anything **reused across phases** is still promoted to `src/components/console/*` — these are the
pieces that belong to one part of the product and would be noise in the shared index.

#### `project/` · `environment/` · `tags/` (F08)

| File | Notes |
|---|---|
| `project/use-projects.ts` | The Project queries and mutations — **and the fan-out**. `GET /projects` answers with bare rows, so `useEnvironmentCounts` and `useProjectTags` cost **one request per row** each and there is no batch route. Both return a `Map` rather than an array, because the caller filters and sorts and an index would go wrong the moment it did. A row still in flight is `undefined`, never `0`. |
| `project/projects-screen.tsx` | The Projects list: search, tag filter, the table, and the four dialogs. Two of the reference's columns are **absent, not empty** — Services, which put on the Environment *detail* read, so a count costs one request per Environment per Project, and Deploy targets, which has no column at all on an `environment` row. |
| `project/project-columns.tsx` · `project-dialogs.tsx` · `project-form-modal.tsx` · `delete-project-modal.tsx` · `project-details-form.tsx` · `project-facts-card.tsx` · `hierarchy-card.tsx` | One declaration per column; the four dialogs held at screen level (a dialog mounted in a row unmounts when the table re-sorts); create and rename as one modal, because `POST /projects` and `PATCH /projects/:id` take the identical body. |
| `environment/use-environments.ts` · `environment-columns.tsx` · `environment-form-modal.tsx` · `delete-environment-modal.tsx` · `environment-details-form.tsx` · `environment-facts-card.tsx` | An Environment's list route takes its parent as a query parameter, so a Project's Environments are **one** request. The form has one field, because that is the whole editable row — there is no `description` column. |
| `no-listing` | **Moved to `console/no-listing.tsx` by F10**, which is the second phase to need it. It used to cover three of an Environment's five tabs; **Services** is now an ordinary table, so two are left — Deployments and Domains, both now a fan-out to decide on rather than a missing route. Its line is in the console table above. |
| `environment/variable-reference-card.tsx` · `routing-card.tsx` | The two asides worth keeping from the reference, each with its unbacked claims removed. The first replaced the reference's *runtime* inheritance (`environment.runtime` is not a column) with **variable** inheritance — and F19 found that does not exist either. `prepareEnvironmentVariables` (`docker/docker.utils.ts:18`) maps over a service's **own** variables and returns only those; a Project's and an Environment's blobs are *interpolation sources*, reached as `${{project.KEY}}` and `${{environment.KEY}}`, and are never merged — so **a key nobody references reaches no container**. The card states that consequence outright, and was **renamed off `inheritance-card.tsx`**: the filename was the last thing in the file still asserting the merge, and the one part a grep for "inherit" could not tell apart from the copy it was about. The second turned "Traefik on the Environment's deploy target" into "on the Server a service is deployed to". |
| `environment/vars/blob.ts` | **Moved to `lib/format/env-blob.ts` by F11**, which is the fourth feature to import it — F08's own screens, F09's two variables cards and F11's database tab. The `env` column, parsed: one encrypted dotenv blob, no per-variable row, and **no flag saying which line is a secret**. |
| `environment/vars/variables-card.tsx` · `variables-form.tsx` | **Moved to `console/variables-card.tsx` and `variables-form.tsx` by F11.** Reading and editing are two screens of one card. The endpoint takes the **whole blob**, so editing has to be a textarea — but a textarea cannot hide a password while you scan the key beside it, so the resting state is a masked table. The form is **mounted only while editing**: `useApiForm` reads `defaultValues` once, and a form that outlived a refetch would offer to save a blob that had since changed. |
| `tags/use-tags.ts` · `tag-chips.tsx` · `tag-row.tsx` · `manage-tags-modal.tsx` · `project-tags-modal.tsx` · `tag-filter.tsx` | Tags are managed **on the Projects screen**, because a Tag has one use and the route tree has no `/tags`. Assignment commits per checkbox — the two routes are one assignment each, so a Save button would fan out and then have to explain "half of them worked". Renaming and deleting happen **in the row**, not in a second dialog: this list is already inside a modal, and a dialog over a dialog is a focus trap over a focus trap. |

Three rules this phase leaned on that are worth restating:

1. **The mask is a guess made from the key's name**, and the screen says so. Nothing in the data marks
   a line as a credential — the column is encrypted whole precisely because any line might be — so the
   list is deliberately wide (`_URL` and `DSN` are on it, because a connection string carries a
   password in the middle of it). A rule that is occasionally cautious beats one that confidently shows
   a `DATABASE_URL`.
2. **A Tag's `color` is never painted.** The column exists and holds a hex string, and nothing renders
   it: an arbitrary hex has no promise about contrast in either theme, and hue never carries meaning on
   its own here. Our create form does not offer one either, so the column stays null rather than
   filling with values nothing reads.
3. **Deleting names its children before it destroys them**, and requires the name typed. The Project
   dialog lists the Environments by name rather than counting them, and stops at "everything deployed
   in them". A services count is obtainable now and costs one request per Environment, fired
   while somebody decides whether to destroy a Project — a count that arrives late in *that* sentence
   is worse than none.

#### `application/` (F09 — Overview, Deployments, Variables, Domains)

The most-used screen in the product, and the one place a socket, a form and a third-party API all meet.
F10 owns `panels/advanced.tsx` and nothing else in here.

| File | Notes |
|---|---|
| `create/create-application-values.ts` · `use-create-application.ts` · `create-application-modal.tsx` | **The fourth create action on the Environment's Services header** — the panel named Applications first in its empty state and was the one kind its buttons could not make. Built as a sibling of F12's Compose modal and F08's database one: outer `Modal` plus an inner `Details` holding the form, so `useApiForm`'s one-shot `defaultValues` read is re-done per opening. Two fields are deliberately **not** offered. `appName` is generated and immutable — it names the container, its volumes and its Traefik router, and it is the one answer here that cannot be taken back. The **source** is not asked either, unlike the Compose modal, which does ask its equivalent: a stack's subject is where its file comes from and that has two answers, whereas an Application's source is seven-way with five distinct forms and `source/source-card.tsx` already is that flow one screen away. So this is a single `POST` with no follow-up `PATCH`, and the toast names the source as the next step. |
| `use-application.ts` | Every read and write the Application screens make, **including the lifecycle** — start, stop, reload, redeploy and cancel all arrived together, three on the applications controller and two on the deployments one, presented here as the single set they are. A deploy-webhook secret rotation came with them and was later taken back out of the console because no route accepts that webhook. The module still says out loud what is *not* there: no `GET /applications`, so an Application is only ever reached by id. Two queries **poll while a build is live and stop when none is**, via a `refetchInterval` function so the decision is re-made from each answer: the Deployment list (the engine writes `status`, and nothing pushes it) and — only when the caller says so — the Application row, whose `applicationStatus` the page header and the masthead badge read. |
| `source/providers.ts` | **The four git providers as data**, and the reason there is one source form instead of four. They differ in exactly two things: which columns hold the answer (`repository`/`owner`/`branch` vs `gitlabRepository`/… plus a numeric project id, plus Bitbucket's slug) and what their branches route asks for. `plural` is spelled out rather than derived — `${noun}s` printed **"repositorys"** on screen. |
| `source/git-source-form.tsx` | One form, all four providers — the queries, the two gates and the composition. The two choices the *queries* depend on are held in state as well as in the form, one-directionally: reading them back out of the form would put `useRepositories` after `useApiForm` and `onSubmit` before the query it needs. |
| `source/git-source-chain.tsx` | The chain — connection → repository → branch — and the rule that makes it one component: **each step clears the one below it**, because a branch from the previously selected repository is a value the provider would refuse and the form would happily submit. Which queries re-run is the form's business, so the two choices are handed back up rather than held here. |
| `source/git-source-values.ts` | The schema, the repository key reconstructed from the parts the row actually stores, and `sourceInput` — **the only place the four providers really differ**: a slug for Bitbucket, a numeric project id for GitLab, neither for the other two. It falls back to the typed key when the listing has not arrived, because a save that drops the repository is worse than one that saves a key the provider will recognise. |
| `source/git-source-build-fields.tsx` | The half no provider changes: what to build from the branch, and what a push should do about it — offered only where a push deploys at all (`pushCanDeploy` in `providers.ts`: a GitHub Application), and a one-line "deploys are manual" note everywhere else, the Source cards' own rule. Only the path's label and column vary, per `PathSpec`. |
| `source/repository-picker.tsx` | **The one long list in the console, and the one thing that is not a `Picker`.** A connection reaches every repository its token can see — tens for a person, hundreds for an organization — so it is a search field over a scrolling list of `MenuRow`s, which is what that component was factored out for. Collapses to the answer plus a Change button once chosen. Four distinct states, and keeping them apart is the point: nothing asked for yet, loading, refused, and genuinely empty. |
| `source/source-card.tsx` · `docker-source-form.tsx` · `custom-git-form.tsx` · `drop-source-form.tsx` · `no-connection.tsx` | Reading and editing as two states of one card (F08's variables shape), because the choice is seven-way and six of the seven have their own form. **All seven source types are offered**: `drop-source-form.tsx` is a file picker whose save *is* the upload — `POST /applications/:id/drop` unpacks the zip and sets the row to `drop` in one multipart call (`api.postForm`), so there is no `PATCH` behind it — and a `drop` row keeps Change source like any other. **A row with no source says so**: `source_type` defaults to `github`, so `hasSource` (`lib/format/source.ts`) reads the column the type needs, and an unset row renders one sentence and Change source instead of Type and Deploys-on rows claiming GitHub. The Compose Source card does the same, and the backend refuses a deploy on the same rule. The Docker form's password is **write-only**: it never comes back, so empty means *keep the stored one* and the hint says which. |
| `source/builders.ts` · `build-card.tsx` · `build-form.tsx` | **The six builders as data** — `buildTypeEnum` and nothing else. Each owns a different subset of the row's build columns, declared once so the read-out and the form cannot show different fields for the same builder. Values for a builder no longer chosen are **left on the row**, not cleared. A Docker-image source says there is no build at all rather than offering a `buildType` the deployment would ignore. |
| `deploy/log-tones.ts` | `LogWell` renders lines and never parses them; **this is the other side of that contract**, keyed to what this backend's own build commands write — `✅` / `❌` from the builder strategies, `[Enabled …]` from the registry push, BuildKit's `#N [stage]` headers, and `warning` matched on the word because it arrives from git and docker over `2>&1`. The markers stay **in** the text: they are what the backend chose to print. |
| `deploy/deployment-log.tsx` | **Two sources, chosen by status rather than tried in turn.** A live build opens `/listen-deployment`, whose `tail -n +1 -f` replays the file before following — so a build opened three minutes in shows those three minutes. A finished one reads `GET /deployments/:id/logs` once, because a socket to a file nothing is appending to would connect, replay, and wait for ever. |
| `deploy/deployment-facts.ts` | Which Server holds the log (`buildServerId` then `serverId`, the same precedence `deployments.service.ts` used when it created the file — ask the wrong host and the gateway opens a channel to a machine with no such file and closes, which looks exactly like a build that produced no output), and which Deployment is still writing. |
| `deploy/deploy-button.tsx` · `deployment-modal.tsx` · `phases-card.tsx` | Deploy used to be the **only** lifecycle action; Restart, Stop, Start, Redeploy and Cancel arrived later and live in `lifecycle/`. Deploy keeps its own folder and stays **primary**, because it is the only one that changes what is running from what is in the repository — the button's own comment says so. The drill-in is a **dialog, not a route**: there is no `GET /deployments/:id`, so an address would have nothing to fetch on a reload and would 404 the one thing a URL is for. The phases card stays because *a build is a phase of a Deployment, not another word for one*, and this is the screen where that gets confused. |
| `domains/domain-schema.ts` · `domain-host-field.tsx` · `domain-service-field.tsx` · `domain-tls-fields.tsx` | The dialog's four parts. The schema is a **function** of whether a compose service must be named, because zod strips keys it does not know — an optional extra field bolted beside a fixed one would be validated, filled in and then quietly dropped. The host field owns both mutations together, since generating a host **resets** the last lookup: that answer was about the host just replaced. The three TLS controls are one decision and own the state that decides which of them is on screen; nothing else in the form reads it. |
| `domains/use-domains.ts` · `domain-form-modal.tsx` · `domain-columns.tsx` · `dns-helper.tsx` · `delete-domain-modal.tsx` · `domains-aside.tsx` | Generate and validate are **mutations, not queries**: generate mints a new random host on every call, so caching one would be a lie about which is current, and validate reaches a resolver, so it happens when someone asks. The reference's per-row **Status** column is absent — nothing records whether Traefik is serving a host or whether a certificate was issued, and a green "active" on a domain whose DNS points nowhere is the most confident possible lie. What replaces it is a check that asks a real resolver, beside the record it tells you to create. |
| `vars/build-arguments-card.tsx` · `resolution-card.tsx` | **Three blobs, not one**, because that is the endpoint's shape and they reach different places: `env` becomes the container's environment, `buildArgs` becomes `--build-arg` and is recorded in the image's history, `buildSecrets` is mounted for the build and is in no layer. Presenting them as one list would invite someone to put a credential where it gets committed. The resolution card counts the three levels and says which wins; a resolved list with a scope per line would be the screen inventing a merge the platform never computes. |

#### `application/advanced/` (F10 — Advanced, Rollbacks, Previews, Schedules, Volume backups, Patches)

Six tabs, and the phase brief was blunt about the risk: *"a careless build turns into forty
near-identical form files."* What is here is **two shared components and eleven configuration files.**

| File | Notes |
|---|---|
| `resource-spec.ts` | **The one description of "a table of child records with add / edit / delete".** (`FieldSpec` and `RowColumn` moved to `console/form-spec.ts` in F11 and are re-exported from here.) Mounts, schedules, volume backups and patches are the same screen four times over — a list keyed by the owning service, a `POST /`, a `PATCH /:id`, a `DELETE /:id`. So a list is a *configuration file*: this type in, `ResourceList` out. Two things are deliberately not parameters — where the actions sit, and whether the dialogs are keyed (they always are; see `resource-list.tsx`). `FieldSpec` has seven kinds, and `plural` is spelled out rather than derived, for F09's "repositorys" reason. |
| `resource-list.tsx` | The table, the two dialogs and the delete confirmation. Three decisions live here rather than in each config, because they are the ones that go quietly wrong when repeated: **dialogs at list level** (one mounted in a cell unmounts when the table re-sorts — F08), **every opening keyed** (`useApiForm` reads `defaultValues` once — F09), and **`error` and `isPending` answered before `rows.length === 0`**, so a 403 never renders an empty state. |
| `resource-field.tsx` · `rows-field.tsx` | **Both moved to `console/` by F11.** One `FieldSpec`, rendered. The reason `kind` exists rather than callers passing JSX is the wiring underneath: an `<input>` is registered by `Field`, and a `Picker` or a `Switch` is a **button** and needs a `Controller` and `manual`. `rows` is the repeating group — networks, published ports, ulimits, placement preferences and platforms, and Docker labels are all "a short list of little records", so they share one control rather than a form each. |
| `advanced-sections.tsx` | **The Advanced tab's five sub-sections** — Resources, Runtime, Routing, Docker Swarm, Danger zone — as `Tabs` with every panel `keepMounted`, so an edit survives a look at another; `SaveScope` opens each on how its cards save and when the change lands. Sub-tabs inside the panel rather than five more registry rows, which would push the rest of the rail below the fold. |
| `settings-card.tsx` | **Moved to `console/settings-card.tsx` by F11.** The other half: a card that is a form over a few columns of the Application row. Resources, the run command, the build server, the preview settings and every Swarm concern are this. **Always editable** — no read-out with an Edit button, unlike F08's variables and F09's source, and that split is deliberate: those guard a *destructive shape of edit*, four numeric limits do not. `fields` may be a function of the current values, which is what makes a live unit reading possible. |
| `plural.ts` | **New after a fix for the toast** *"1 variables are now set here"* — the count was computed and the sentence around it was not. `counted(n, noun, plural)` and `agreeing(n, one, many)`. Here rather than beside the toast because agreement is formatting, and because the second caller would otherwise copy it (§1.4); it has three. **The plural is a required argument**, and defaulting it to `${noun}s` was tried and rejected on review — this file records that derivation printing **"repositorys"** twice already (`source/providers.ts`, `resource-spec.ts`), and a default would make the safe form the opt-in for the one helper whose whole purpose is that the words agree. |
| `units.ts` | **Moved to `lib/format/units.ts` by F11**, which needs the same readings on a database's Resources card. The three raw Docker units and the readings that make them legible: memory in **bytes**, CPU in **nano-CPUs**, every duration in **nanoseconds** — exactly what `calculateResources` and `mechanize.ts` pass to the Engine API. They stay raw in the field on purpose (a field that accepts "512 MB" has to pick a definition of MB and then disagree with `docker service inspect`); the reading beside it is the fix, and `30` meaning thirty nanoseconds is the mistake it prevents. |
| `swarm/swarm-values.ts` · `swarm-concerns.tsx` · `swarm-section.tsx` | **Eleven cards, one form, one Save.** Not tidiness: these columns are edited together or not at all — a mode and a placement constraint that disagree produce a service that never schedules, and finding that through eleven saves means eleven Deployments. The flat form folds out into eleven typed JSON columns under three rules, each of which loses configuration if broken: an empty concern is `null` not `{}`, **unshown keys are preserved**, and a blank field clears its key rather than becoming `0`. Update config and rollback config are one six-field table called twice, because they are one zod schema on the backend. |
| `mounts-spec.tsx` · `schedules-spec.tsx` · `volume-backups-spec.tsx` · `patches-spec.tsx` | The four lists that have a list route, as configuration. Each carries the one thing its form has to say: which mount kind survives a Deployment, that a schedule is a `docker exec` into a container that may not be running, that `turnOff` is the honest-backup switch, that a patch is a whole file rather than a diff. |
| `unlistable-card.tsx` | The three that **cannot** be built — ports, redirects, basic auth. Three refusals, each a lie the screen could have told: not an empty table (a claim about your configuration made because a route is missing), not an add button (the writes are typed and correct, and would write into a list that cannot show rows), not hidden (that would make the tab look complete and quietly lose three features). |
| `traefik-card.tsx` | The generated config, **read, not edited** — and that is the finding, not a shortcut. The write route exists (`POST /settings/traefik/file`), and `traefik/app-config.service.ts` regenerates the whole file from the domain, redirect and security rows on every change and deletes it when the last domain goes. A Save that silently discards its own work is worse than no Save. |
| `copy-range-card.tsx` | **How many copies a `web` on Cloud Run runs** (S10): the fewest and the most, Cloudgate's per Service and never in the Project config or a plan. A Save sets it on the Cloud Run service by a direct call and keeps it only if Google took it, so the card is never ahead of what runs. The fewest field's hint says what 0 costs: almost nothing, and a wait for a start after a quiet spell. |
| `rollback-modal.tsx` · `delete-rollback-modal.tsx` | Rolling back says five things first, each one someone would otherwise learn afterwards: nothing is built, it writes **no Deployment**, the variables are today's not the snapshot's, it captures nothing, and the next Deployment builds from the Application's settings as they are now. Deleting is the one delete on these screens that does not go through `DeleteResourceModal`: it runs `docker image rm` on the Server first, so the version is genuinely gone. |
| `restore-modal.tsx` | Three steps, and the third is named. The only **typed confirmation** in the phase — every other delete here is a row you can add back in seconds, and unpacking a tarball over a volume destroys what was in it with no copy. Step one is typed rather than picked because nothing lists a destination's objects. |
| `restore-steps.tsx` · `preview-columns.tsx` | The two extractions that keep a component under budget: the restore modal is flow control and its three steps are content, and a preview's row is one declaration per column the way F09's `domain-columns.tsx` is. Two of a preview's five columns are **links out**, which is what the row is for — a preview exists to be looked at. |
| `panels/requested-previews-card.tsx` · `requested-preview-columns.tsx` · `extend-preview-modal.tsx` | **One card per trigger**: the Pull-request previews card and the Requested previews card list disjoint rows, so each one's "every slot is taken" speaks for its own limit. A Requested preview's row names its requester from the create audit row (tagged *removed* or *suspended*), warns in the last ten minutes of its window, and links its latest build into the Deployments tab. **Expire now** is its Delete: the row flips to *expired, teardown pending* on the answer, and an expired row has no controls. Extend is a new window from now, never "+1 h". With the switch off, Extend and Redeploy carry the backend's switch refusal and Expire now stays. |
| `patch-browser.tsx` · `patch-editor-modal.tsx` · ~~`diff-lines.ts`~~ · ~~`cron.ts`~~ | **Both helpers moved to `lib/format/diff-lines.ts` and `lib/format/cron.ts`**, which is where the second and third feature to import them put them — F12's Compose Converted panel diffs its file, and F11's database Backups card reads a schedule back. Neither is a component and neither belongs to an Application, so they went to `lib/format` beside `env-blob.ts` and `units.ts` rather than to `console/`. Cloning is a **button** (it is a `git clone` over SSH, not something a tab opening should do) and the list is flat and searchable rather than a tree. The editor's diff is **what you are about to change** and says so: once a patch exists for a path, `GET /patches/repo/file` answers with the patch and the repository's copy is unreachable. `diffLines` is an LCS rather than a positional compare — insert one line at the top of a config and the cheap version marks every remaining line as both removed and added. |

#### `database/` (F11 — six engines, five tabs, one set of panels)

The brief's own instruction: *"The six backend controllers are near-identical by design; the frontend must reflect that, not duplicate it six times."* What shipped is **one descriptor table and five panels**, and **no panel file names an engine.**

| File | Notes |
|---|---|
| `kinds.ts` | **The phase.** One entry per engine: label, icon, blurb, default and suggested images, the listeners it publishes, the connection columns it carries, its URI form, whether it can be dumped, and what happens to its `command`/`args` at deploy. Everything that varies is here; `hasColumn`, `connectionFields`, `databaseSchema` and `toCreateInput` are what the panels call. Two entries repay reading twice — **Redis** (no user, no database name, no dump command at all) and **LibSQL** (three listeners, which is why its external-port route is plural). |
| `use-database.ts` | Every read and write, for all six, because the engine is a parameter and not a branch. `useDatabase` **polls while the row says `running`**, since a converge is what `running` means and nothing pushes the transition. The lifecycle mutations use **`onSettled`, not `onSuccess`** — see the defects below. |
| `database-panel.tsx` | The three states every tab opens in, once — refusal, skeleton, row. F09's four panels each carry their own copy; five more here is where that stopped being acceptable. |
| `panels/{overview,credentials,variables,advanced,backups}.tsx` | Five tabs. Two of them (`credentials`, `backups`) are new rows in `lib/shell/tabs/database.ts` — contract rule 2, and the reasoning is in that file. |
| `credentials/connection-card.tsx` | Internal and external connection details **in one card**, because the operator's real question is "which of these do I paste", and that is only answerable with both on screen. Masked until revealed, one reveal for the card (three reveals to read one connection string is friction, not privacy), a copy control per row, and the connection string assembled from the descriptor's `uri` so a Redis URL and a Mongo URL are right without this component knowing either scheme. |
| `credentials/external-ports-card.tsx` | One form for one listener and for three. **The exposure warning is at the control**, which is the brief's instruction and the right call: there is no allowlist column and Cloudgate writes no firewall rule. Saving redeploys, and the footer says so — nobody expects a port field to restart a database. |
| `lifecycle/database-actions.tsx` · `rebuild-modal.tsx` · `delete-database-modal.tsx` | Deploy / Start / Stop / Rebuild — the row that used to be **an asymmetry**, when an Application beside it had only Deploy. That is closed; **Rebuild** is the one control with no counterpart there, because only a database has a data volume to throw away. Two differences remain and both are the engine's: Start and Stop are always both offered, since a database's `applicationStatus` cannot say whether the engine is up, and Rebuild carries the phase's only typed confirmation because the word is the trap: for an Application it means "build again", here it is `docker volume rm <appName>-data`. Delete is the mirror image and says the *opposite* thing plainly — by default the volume **survives**, so the data is neither gone nor reachable again. **"Also delete its data volume"** is the on-request exception (#1413): a checkbox, offered unless the Server positively has no volume, that sends `deleteData` and turns the "Volume left behind" row into "Will delete volume". A volume the Server had to keep (its Volume lock held, another Service mounting it, Docker refusing) comes back as a `volume` line in the teardown report; otherwise the toast says it was deleted, from the Delete's answer rather than the read taken as the dialog opened. |
| `backups/backup-files-card.tsx` · `restore-modal.tsx` | The half of backups that works. `GET /backups/files` needs no `backup` row, so the restore picks a **real file** rather than a typed key — the one place the typed-key complaint never applied. Three steps with the destructive one named. |
| `container-log.tsx` | **The answer to the brief's endpoint audit.** A database's deploy writes no `deployment` row and no log file, so there is nothing to stream — but the container's own output is reachable, and needs no container lookup: with `runType=swarm` the gateway runs `docker service logs`, which takes a **service name**, and that is the `appName` the row already carries. Lines are deliberately **not** toned: six third-party engines have six log formats, and a rule keyed to one would be silent on the others. |
| `create/create-database-modal.tsx` | Pick an engine from the descriptor, then that engine's own fields. Mounted on the Environment's Services tab — **one edit to F08's file**, and it defeats that phase's objection rather than ignoring it: `POST /:kind` returns the new row, so creating ends on the new database's own screen and F07's rail records it in Recents. The list exists now and the Services tab shows it, which settles the argument in this flow's favour rather than making it redundant: landing on the thing you just made is still where you want to be. |
| `panels/memorystore-settings-card.tsx` | **A redis on Memorystore's one setting**: high availability, off by default. Cloudgate's, per Service, never in the Project config — so a Save stores it and the *next plan* shows the replica added or removed, and its Apply makes the change. It takes the place of the run command and resources cards, because Memorystore runs no container to configure, and a card offering one would be a control that does nothing. |

**Six defects found by driving it rather than reading it:**

1. **A deploy that succeeded reported failure.** A database's deploy is synchronous — image pull plus Swarm converge, inside the request — and a cold `docker pull mysql:8` outlasts the 30 seconds the dev proxy holds a response open. The POST came back 500 at **exactly 30005ms** while the service went on to reach 1/1. `toast.error`'s sentence for a 500 is "nothing changed", which was precisely backwards. Every lifecycle mutation now refreshes the row on **`onSettled`**, and a 5xx or dropped connection says the request did not come back and points at the status, while a real 4xx refusal still shows its own message (`wasRefused`).
2. **The container log never redialled after a deploy.** Opening a database that had never been deployed dialled a gateway whose `docker service logs` answered *no such task or service* and exited — and the local gateway does not close the socket when its pty exits, so nothing prompted a retry. Deploy succeeded and the well kept showing the error from ten seconds before the service existed, cursor blinking. It now redials on the row's transition to `done`.
3. **A folder full of dumps rendered as "Nothing here yet".** `rclone lsjson` is **not recursive**, so listing `<appName>/` when the dumps live at `<appName>/<prefix>/<file>` returns one directory and no files — and the card was filtering directories out. That is the exact lie this codebase keeps warning about, told about a bucket. Directories are navigable rows now.
4. **"Redishas neither."** F10's rule 3, paid for again: a JSXText node containing a newline loses the whitespace after an inline element sitting first on its line. `{" "}`. Backticks in the same sentence were rendering as literal backticks, too — markdown is not a thing in JSX text.
5. **A shared card told a database it feeds "everything deployed below" it.** F08's `VariablesCard` empty state was written for a Project, and nothing is deployed below a database, so `emptyBody` is a prop now. The other half of that took until F19, because this note stopped one step short of its own reason: the sentence was not true of a **Project** either. Nothing is inherited downward for anybody — so the *default* was the copy doing the damage, on the two screens where somebody sets a key once and stops, and it is fixed rather than merely overridable.
6. **Every pty gateway failed with `posix_spawnp failed.`** Not ours, but it reached the product's log well as though the container had said it: pnpm extracts node-pty's `spawn-helper` without its executable bit.

Two rules worth restating:

1. **A route's shape is a fact about the screen.** `GET /backups/files` exists and `GET /backups` does not, which is why half the Backups tab is complete and half is a stated absence. The audit came before the design, and it changed it.
2. **Two descriptor tables, split by layer, not by accident.** `endpoints/databases.ts` owns route facts (the id column per engine, and `EXTERNAL_PORT_ROUTE` — the one word LibSQL spells differently); `features/database/kinds.ts` owns screen facts. Neither leaks into a component.

Four rules this phase leaned on that are worth restating:

1. **`undefined` is not `null` is not `""`, and a create DTO and an update DTO disagree about which.**
   `undefined` vanishes in `JSON.stringify`, so a `PATCH` that omits a column leaves it *unchanged*;
   `createScheduleSchema` types an optional as `z.string().optional()` and refuses a null, while
   `updateScheduleSchema` types it `.nullable()` because clearing has to be expressible. Both halves
   of this cost a defect (below). Every `body()` in this folder now takes an `omit | clear` argument
   and says which route it is for.
2. **A raw unit needs a reading, not a conversion.** See `units.ts`.
3. **`{" "}` after an inline element, not a bare space.** A JSXText node containing a newline has
   its leading whitespace trimmed, so an element sitting first on its line loses the space after it.
   **Enforced:** `cloudgate/jsx-inline-element-spacing` in `eslint-rules/`, on in
   `eslint.config.mjs` and so in `pnpm lint` and in CI, with a `--fix` that inserts the `{" "}`. The
   DOM query below is now the runtime cross-check, not the primary detector. **And a bare space is
   not enough even when it is there**: this build strips a text node's leading space when the same
   node contains an HTML entity, so `{" "}` is the guard whether or not the space was typed. The
   rule reads for that shape too — after *any* neighbour, an interpolation included, since `2
   daysold` once shipped after a `{…}` the rule then ignored.
4. **The signed gutter marks are `GUT`'s, and a patch's `type` maps straight onto them** — `create` →
   `+`, `update` → `⇆`, `delete` → `−`, each with its word in an `sr-only` span.

Five things F09 leaned on that are worth restating:

1. **A refusal is not an empty list**, and conflating them is the easiest lie on this screen to tell by
   accident. A 403 on `GET /gitea` left `data` undefined, which read as zero options, which rendered
   "No Gitea account is connected" — a confident claim about the Organization's setup, made because a
   request failed. Same shape, same fix, in the repository picker.
2. **Hold an id in state, not a row.** A `Deployment` captured at deploy time keeps the `pending` status
   it had then, so the log's header reported `pending` beside a table row reading `running`. State holds
   the id; the row is always the current one from the list.
3. **A `Field` whose child is a button needs `manual`** and a `Controller`. See **Forms**.
4. **`Promise<string>` from Nest is `text/plain`.** See rule 4 under **The data layer**.
5. **The reference's confident columns are the ones to check hardest.** Three are absent here for the
   same reason — a per-domain Status, a per-variable Scope, and the Overview's requests chart. Each was
   drawn as a shipped feature and each is backed by nothing.

#### `compose/` (F12 — eight tabs, one file at the centre)

The one service kind whose source of truth is a **file**, which is why the editor is on the first tab
rather than behind one: an Application has a source, a builder, a run command and eleven Swarm
concerns, and a stack has a file that says all of it. Everything else in the scope is a consequence of
that file — which containers exist, what they log, which service a domain routes into.

| File | Notes |
|---|---|
| `use-compose.ts` | Every read and write. The three facts that shape every panel are stated once here: **deploy is the only route that builds** (start is `up -d` over the code already on disk, and for a Swarm stack it does *nothing at all*), **the compose controller does not list** — a stack is reached through its Environment, whose read names it, or by address — and `composeStatus` is a column something else wrote, so the row polls while a build is live. `useComposeServices` sets **`retry: false`** against the client default — see the defects below. |
| `compose-panel.tsx` | F11's wrapper: the refusal, the skeleton, and only then the screen, once instead of eight times. |
| `source/compose-source.ts` · `compose-source-card.tsx` | Six source types and **all six are offered** — the shared enum minus `docker` and `drop`, which the compose DTO refuses. The forms are **F09's, imported**: a `compose` row holds the git columns under the same names, so `GitSourceForm` and `CustomGitForm` serve both and `PathSpec` carries the only difference. `raw` has no form, because choosing it sets one column and the *file* is the card below. |
| `editor/compose-file-card.tsx` | **It is only an editor for a `raw` source, and that is a fact about the backend.** `readComposeContent` reads the `composeFile` column *only* when `sourceType === "raw"`; for a git source it `cat`s the clone. An editor there would accept work, save it, report success and change nothing. Save does not write `sourceType: "raw"` alongside the file, which would silently convert the stack — a real answer but not one a Save button should give on its own. |
| `editor/yaml-check.ts` | The **same parser the backend uses** (`yaml`), which is the only reason to say anything: a check written against a different parser would refuse files the platform accepts. It answers "is this YAML", never "is this a valid compose file" — that judgement is `docker compose`'s. |
| `editor/declared-services.tsx` | `GET /compose/:id/services` has four states and they say four different things. A **refusal is the normal state for a git source that has never been deployed** (the route reads the clone), which is not "no services" and is not broken. |
| `converted/converted-plan.ts` · `panels/converted.tsx` | **The tab that earns trust, and earning it here meant not drawing a diff** — see the note below. It describes the rewrite from its real inputs (the domains, the isolation flag) and names the three refusals the deploy makes before it writes anything — including the one that **fails silently**: a service whose `labels` are a *map* has its Traefik labels skipped, so the deploy succeeds and the domain 404s. |
| `containers/use-stack-containers.ts` · `container-columns.tsx` · `container-actions.tsx` | **The Containers table is a join of three reads, and the join is the design.** `compose/:id/services` is file-derived; `docker/containers/search` has membership and live state but no image; `docker/containers` (the whole host) has the image and the ports; `docker/containers/stack` is Swarm **tasks**, whose `{{.ID}}` is a task id that no lifecycle route and neither log gateway accepts. A service the file declares with nothing running gets a row of its own — the question people arrive with after a half-finished deploy is *which part of my stack is not there*, and a list of running containers cannot answer it. |
| `logs/container-output.tsx` · `panels/logs.tsx` | **A stack has no stack-wide log**: the gateway follows one container. So "the logs" is a choice before it is a stream, and that is why this is a tab. A Swarm stack gets a second reading (`runType=swarm` runs `docker service logs`, which takes a *service* name and aggregates every task and survives Swarm replacing one); a `docker-compose` stack has no such command, so the choice is absent rather than broken. Lines are **not toned** — third-party images have as many log formats. |
| `advanced/isolation-card.tsx` | The one rewrite toggle this backend has, stating what it will change **before** it is switched on, which is the brief's instruction and the right shape for a control that edits the file the platform is about to apply. The trade is one sentence: isolation buys a stack that cannot collide with — or reach — the rest of the platform. **Randomize is absent**: `compose.schema.ts:23` says those columns were deliberately left out, and an unbuilt feature gets nothing on screen (locked decision 1). |
| `lifecycle/compose-actions.tsx` · `delete-compose-modal.tsx` · `remove-containers-modal.tsx` | Deploy / Start / Stop / Remove containers, and **two of the four are absent for a Swarm stack**: Start, because the route runs its command only for the `docker-compose` type and then reports success, and **Remove containers**, because there `docker stack rm` is already what Stop runs. Delete carries the typed confirmation and the volumes switch — which is **absent for a Swarm stack too**, since `docker stack rm` does not touch volumes and the flag would be a control that does nothing. **Remove containers deliberately does not** carry the typed name: ADR-0011 keeps that ritual for the irreversible destruction of a record, and this rung is undone by pressing Start, so its dialog is a plain one naming both lists — the containers and their writable layer go, the volumes, the project directory and the stack stay. |
| `create/create-compose-modal.tsx` | Mounted on the Environment's Services tab beside F11's — **one more button in F08's file**, on F11's argument unchanged: `POST /compose` returns the row, so creating ends on the new stack's own screen. It asks where the file comes from because `createComposeSchema` accepts no `sourceType` and the column defaults to `github`, so a stack created silently would claim a GitHub source it has no connection for. |

**Six defects found by driving it rather than reading it**, and two of them are in shared files:

1. **All 175 lines of a deploy log appeared twice.** `socket-stream-store.ts` reset the buffer on every
   dial (F02's fix) but let a **superseded socket keep writing into it**: `close()` clears `this.socket`
   and calls `socket.close()`, and a socket still CONNECTING does not stop existing on the spot — the
   gateway may already be replaying (`tail -n +1 -f`). Those frames landed after the next dial had reset
   the buffer. React's development double-mount makes that the common case, and so does any change of
   target — one Deployment's log to another's. `onmessage` and `onclose` now ignore a socket that is no
   longer the current one. **F02's file, one guard, and it is the other half of the defect its own
   comment describes.**
2. **A skeleton that never resolved.** `GET /compose/:id/services` answers **500** for a git source with
   no clone — deterministically, because the file is not there — and the client default retries a 5xx
   twice. A query stays `pending` while retries are scheduled, so the screen showed a loading bar
   instead of the explanation; and TanStack's retryer **pauses while the document is hidden**, so in a
   backgrounded tab the skeleton never resolved at all. `retry: false` settles it on the first answer,
   which is the only answer there is.
3. **`docker ps` answering nothing crashed the query.** `GET /docker/containers` returns *no body* when
   docker writes to stderr, which `api.get` reads as `undefined` — and TanStack refuses `undefined` as
   query data, so the failure would have been reported in the console as our own bug rather than as
   docker's. The queryFn maps it to `null`, which is a legitimate value and says the same thing.
4. **"This stackruns on Cloudgate's own host."** Rule 3 above, paid for a fourth time, in F09's DNS
   helper the moment it was handed a different noun.
5. **"…at line 11, column 1:."** The `yaml` package's message ends in a colon because what followed was
   the quoted source we drop. Stripped before the full stop.
6. **"Follow the newest instead" offered while the newest was already being followed** — the Deployment
   someone just pressed Deploy on *is* the live one, so the control has to compare the two rather than
   check that one exists.

**Three cross-phase edits, all additive, all declared:**

- `lib/realtime/socket-stream-store.ts` — defect 1. Every stream in the app is better for it.
- `features/application/domains/*` — the domain dialog, its columns, its DNS helper and its delete
  confirmation now serve both parents. The dialog takes its two **writes as props** rather than reaching
  for a feature's hooks, which is what keeps one dialog from becoming two; the optional `service` column
  and field exist because a compose domain that names no service makes the *deploy* throw; and `noun`
  carries the four sentences that named an Application.
- `features/application/source/{providers,git-source-form,custom-git-form}.tsx` — `SourceRow` and
  `PathSpec`. The brief asked for these forms to be reused rather than duplicated, and the only
  structural difference between the two rows is where the path field is saved.

#### `server/` · `ssh-keys/` (F13 — the fleet, seven tabs, two terminals)

The infrastructure half of the console. Everything here reaches a **real machine over
SSH**, which is the one fact that shapes every screen in the folder: a reading is a
round trip somebody paid for, a failure is usually about reaching the host rather than
about the host, and "we could not ask" is never the same statement as "the answer is no".

| File | Notes |
|---|---|
| `use-server.ts` | The row and everything that happens *to* a Server. Three route shapes decided the module: `validate` / `audit` / `setup` are **actions whatever their verb** (all three open an SSH session, two are `GET` only because they answer with something), `setup` **fails while succeeding** often enough that it settles on `onSettled` and its copy says so, and `enableDockerCleanup` has **no writer on this controller** at all. `useServer` deliberately **does not poll**: `serverStatus` is `active | inactive` and nothing in this backend writes it after the insert, so a poll would spend a request a second re-reading a constant. What genuinely changes is readiness, and that is `useServerAudit`. |
| `server-panel.tsx` | F11's wrapper, and seven tabs is a better argument for it than five were: the refusal, the skeleton, then the screen, once. Every tab carries one shared action — open a shell — as a **link**, so it can be opened beside whatever sent you looking for one. |
| `infrastructure/audit-findings.ts` | **The audit as findings, not booleans.** Six facts come back; a screen of six ticks and crosses would be accurate and useless, because a cross beside `isNetworkInstalled` is not something anyone can act on. Each fact becomes what was checked, what the answer means, and **what to do** — and the split across two tabs is the brief's: four findings about what setup installed are Infrastructure's, two about what the SSH user may do are Access's. One query, two readings, one cache key, one SSH session. |
| `infrastructure/finding-list.tsx` | The four states the audit itself has, decided once. **A refusal is not "not ready"** — the script runs over SSH, so an unreachable machine, a wrong key and a wrong user all arrive as an error, and the card says the question could not be asked rather than reporting a host with nothing on it. |
| `infrastructure/reachability-card.tsx` | The one control that can answer "is this machine there". **The result goes on the screen, not into a toast**: it is diagnostic output somebody reads twice while they change a setting, and the interesting half is the failure — the service re-raises ssh2's own message as a 400, so "Timed out while waiting for handshake" and "All configured authentication methods failed" arrive as text that names the problem. It is also the card that explains `serverStatus`: that column is a label somebody chose, and this is the live reading. |
| `infrastructure/setup-card.tsx` · `setup-steps.ts` · `setup-run-panel.tsx` · `setup-confirm-modal.tsx` · `setup-log-tones.ts` | The one control in the console that **installs software on somebody else's computer**, so the list is `serverSetupCommand()` read in order rather than summarised, and the ports Traefik publishes are named before anyone presses. Three honest things beyond the list: it is safe to run twice (every step checks first), a **stored command replaces the whole script**, and the run says how it *ended* rather than only that we stopped waiting. The confirm dialog takes the action's words as a prop, which is the invariant stated rather than repeated: an action keeps its name all the way through. Its own finding is that a dialog must describe **what will actually run** — it once named Docker and ports 80/443 to a Server whose stored command did neither. The tones are keyed to this script's four kinds of line, not to `deploy/log-tones.ts`, which is keyed to BuildKit. |
| `telemetry/use-server-metrics.ts` · `utilisation-card.tsx` | **The brief named a socket that cannot answer.** `/listen-docker-stats-monitoring` takes an `appName` and no `serverId` — its own comment says local-host only — so pointing a remote Server's tab at it would print the platform host's CPU under another host's name. `GET /monitoring/metrics?serverId=` is the route that is per Server, and it has one condition that decides the whole screen: nothing is collected until a Server has been **set up for monitoring**, and a Server as created has an empty token. Three meters at zero would say a machine is idle rather than unmeasured, so the tab branches on the token before it asks for a sample. The poll follows the Server's own `refreshRate`, which nothing else can know. |
| `docker/use-server-docker.ts` | **`undefined` is not `[]`, and this is the module where that matters most.** `getContainers`, `getSwarmNodes` and `getNodeApplications` each return *nothing* when docker writes to stderr and an empty array when docker answered and there was none — and for `docker node ls` and `docker service ls` the first case is the **normal reply from a Swarm worker**, because both are manager-only. Reading it as the second would tell an operator their Swarm has no nodes while they are standing inside it. Every read maps `undefined` to `null` (F12's third defect) and every card says which of the two it got. |
| `docker/containers-card.tsx` · `container-columns.tsx` · `container-actions.tsx` | The whole-host listing, because this is a Server's tab and it is the only route carrying an image or a port map. Docker's `State` and `Status` are kept **apart**: the first is the word `containerMark` is keyed on, the second is the sentence carrying `Exited (137)` — and that number is the whole diagnosis. Actions are three tiers, and the third is not a lifecycle change: **Remove is `docker rm -f`** and what happens next depends on something the row cannot tell you, so it gets a dialog naming both outcomes. |
| `docker/container-detail-modals.tsx` | `docker inspect` **as the JSON it is** — the Engine API's document is forty keys deep and versioned by Docker, so picking a dozen fields would be this console deciding which parts matter and being wrong the first time somebody needed another. The shell is `sh`, the one every image has; offering `bash` would offer it on Alpine. |
| `docker/swarm-nodes-card.tsx` | Docker's words stay Docker's — manager, worker, Leader, Drain. `Status` and `Availability` are two questions and stay two columns: a node can be `Ready` and `Drain` at once, which is exactly a node being taken out of service. The row for `Self` has no Remove, because removing the manager answering for the cluster is not a thing to offer. |
| `docker/join-command-card.tsx` | **The endpoint audit's own note, and it changed every label.** `add-worker` and `add-manager` **perform no join** — they format a string somebody has to run elsewhere — so the button says "Show the command" and the card says nothing has happened yet. It is a **mutation** despite being a `GET`, because the string carries a live Swarm join token: a query would keep a credential under a key a background refetch could reach. |
| `server-unreachable.tsx` | **One block for "Cloudgate could not reach this Server"** on every Server tab: the fact, what that card's command therefore cannot claim, and a link to **Check now** on Infrastructure, which stores and shows SSH's own words for the cause. It replaced four wordings whose remedies disagreed (the Access tab for the key, the Settings tab for the address) and none of which linked to the one control that tries again. The per-card sentence is `children`, because what a silence does *not* mean is the part that differs. |
| `maintenance-notice.tsx` | **A Server in Maintenance, said on every tab** (spec #1420): one sentence, "In maintenance since <time>. Nothing new will start on this Server.", in the warn tint, `role="status"`, and nothing at all while it is not. The powered-off notice's pattern. It names when, not who: the read model carries a user id, not a name. It is there so a refused deploy is not read as a broken Server. |
| `panels/{overview,infrastructure,telemetry,docker,access,settings,terminal}.tsx` | Seven tabs. **Terminal is F13's one registry edit** — contract rule 2, and `tabs/server.ts` argues it: Escape closes a dialog and Escape is a key people press inside a shell constantly, so a modal would end the session on every `vim`; a tab also gives a shell an address, which is what every other tab's header links to. |
| `runtime-info.tsx` | **The version a host is actually running**, put back on the two rows once emptied. One component for both tabs, because the same five-state row written twice is where two screens start disagreeing about what a null means. Two failure modes shape every branch: a **403 is a role, not a reading** — the read is owner/admin gated, so the row degrades (the ingress named, the version absent) rather than showing a refusal where a value used to be, per §3.5's *a refusal is not an empty list* — and a **null `observed` is a 200**, not an error: Docker stopped or a Server unreachable reads "not known" with nothing on the screen going red. `declared` is shown beside `observed` only on `drift`, because printing the pin beside an identical observed version is noise on every healthy install. The fleet aside takes `declared` alone: that card describes what setup installs on *every* Server and `runtime-info` answers about one host, so an observed reading there would be the deleted literal's category error one level up. |
| `settings/delete-server-modal.tsx` | **The brief's "name the running services" has one honest source and it is not Cloudgate's own record.** An Environment names its services and each carries a `serverId`, but the index runs the other way, so answering *this* question from Cloudgate means reading every Environment to open one dialog. `docker service ls` on the host names them directly, so the dialog asks the machine — and states the limit, because those are Docker's names and nothing records which Project each belongs to. What deleting *does* is the other half: `remove` is one `DELETE` on the table, no SSH, no cleanup, so every container keeps running unmanaged and unreachable. That is more alarming than "your services are destroyed", so it is the first sentence rather than a footnote, behind a typed confirmation. |
| `settings/maintenance-card.tsx` | **Start maintenance and End maintenance** (spec #1420), on Settings beside Housekeeping. Starting asks in a dialog naming the Server, because it refuses every teammate's deploys until someone ends it; ending does not ask, since it only lets work through again. Both are `server: ['create']`, as Forget host key is, and a role without it sees both off with the same refusal line, the dialog's confirm included. |
| `ssh-keys/manage-keys-modal.tsx` · `ssh-key-row.tsx` · `use-ssh-keys.ts` | **A dialog on the fleet screen, not a page** — F08's Tags argument unchanged: a key has one use and the route tree has no `/ssh-keys`. The form asks *how* before it asks anything, because `create` reads `fields.publicKey && fields.privateKey` and **one half alone is silently discarded and a fresh pair generated** in its place. Renaming and deleting happen in the row (a dialog over a dialog is a focus trap over a focus trap), and deleting **names the Servers it strands**: `server.sshKeyId` is `onDelete: 'set null'`, so the delete does not refuse — it succeeds and those machines quietly become unreachable. |

**The public key is the reveal, not the private one.** The brief expected a private key
shown once at creation; that is the wrong secret at the wrong moment. Cloudgate holds
the private half to dial with and nobody needs it in a browser, while the **public**
half is what has to be pasted into a host's `authorized_keys` — a job people come back
to every time they add a machine, so it is on the row permanently with a copy control.
The "never again" premise is not true of this backend either: `GET /ssh-keys` returns
the private key on **every** listing,
and the typed client still declares only the fields a screen reads.

**The terminal grid is 80 × 24 and that is the phase's most consequential finding.**
Neither gateway has a resize protocol — both write **every** frame the browser sends
straight into the pty as input, `StreamChannel` has no `resize` at all, and all three
ways a session opens take their library's 80 × 24 default
Driven: `stty size`
answers `24 80` in both gateways and stays there. Two answers were available and one is
honest — fit the emulator to the box and a full-screen program draws its 80 × 24 frame
into the corner of a larger grid (or wraps unreadably on a phone), or **hold the
emulator at the remote's real size and scale the type**. The second is what ships, so
`top` and `vim` render exactly as they would natively; below the readable floor the box
scrolls inside itself, the rule every wide table follows; and the frame prints `80 × 24`
so nobody spends ten minutes on why their editor will not fill the screen.

**The 16 ANSI colours are xterm's own, and that is a decision.** An ANSI colour is
chosen by the *program* — `ls` paints a directory blue, `git diff` paints a deletion
red — so remapping them onto our ramp would be the console overruling the tool it is
showing, and would make `--bad` mean "a removed line" here and "something is wrong"
everywhere else. F12 decided the opposite way about YAML highlighting because there the
colours genuinely are ours. What *is* ours is the surface, the text, the cursor and the
selection, resolved from `--well*` — and theme-independent by design, since the well is
near-black in both themes.

**Five defects found by driving it rather than reading it, and two are in shared files:**

1. **An SSH public key gave a 600px dialog a horizontal scrollbar**, clipping its own
   footer buttons. `Textarea` carries base-nova's `field-sizing-content`, which is right
   for its *height* and makes its preferred **width** content-based too — so one
   unbreakable token pushed the whole dialog to 661px. Measured: `min-width: 0` on the
   textarea does **not** fix it (the contribution comes through the ancestors) and
   neither does `max-w-full` (the track is already too wide). `min-w-0` on **`Field`'s
   root** does, and it belongs there rather than at each call site — every dialog in the
   console holding a textarea inherits the trap, and a long `DATABASE_URL` is the same
   shape of value. *F03's file, one class.*
2. **The terminal's ResizeObserver watched the element its own callback resized.** A new
   font size re-measures the rows, the host changes height, the observer fires again, and
   Chrome stops delivering notifications for the cycle after the loop error — so the type
   never followed the window and the feedback froze the tab hard enough to time out a
   devtools evaluation. It observes the **frame** now, which layout sizes and the terminal
   never does, and it compares **widths**, because a font change alters the height too.
3. **The terminal's surface was xterm's black, not `--well`.** `xterm.css` ships
   `.xterm .xterm-viewport { background-color: #000 }` — specificity 0-2-0 and,
   decisively, **unlayered**, so no Tailwind utility can ever beat it — and the DOM
   renderer leaves a default cell transparent, so that rule is what an operator looks at
   whatever `theme.background` says. Measured at `rgb(0,0,0)` against `--well`'s
   `rgb(20,20,20)`: imperceptible and still wrong, because every contrast figure in this
   document is against `--well`. The same trap this file records for the disabled rule,
   from the other side. It is set inline from the token now.
4. **"Run setup" described the wrong script.** The dialog listed the six default steps —
   installs Docker, joins a Swarm, publishes 80 and 443 — to a Server whose *stored*
   command does none of them. The card behind it warned correctly and then the last thing
   anyone reads before pressing named a different script. A confirmation that names the
   wrong consequences is worse than one that names none.
5. **A new SSH key's "install this" prompt never appeared.** `useState(Boolean(fresh))`
   captured `false` a render before `fresh` became true, because the row mounts when the
   refetched list arrives and the dialog sets `fresh` *after* that. Derived from the prop
   now, with the toggle as an override.

And two smaller ones: **"0.0 GHz"** on every aarch64 host, where `/proc/cpuinfo` reports
no clock speed and a confident wrong number is worse than an absent one (the CPU model
beside it was already guarded — the speed was not); and a fleet **search that missed the
port** while the Address column renders `localhost:2222`, so typing `2222` matched
nothing that was plainly on screen.

**One hazard closed in F02's client.** Nest runs on Express, which ETags every JSON
response, so the browser revalidates with `If-None-Match` and Express answers **304** —
and `Response.ok` is false for a 304, so `api.get` turned "nothing has changed" into a
thrown `ApiError(304)` for a request whose data was correct and already in the browser's
hand. Real 304s appear in the backend's own log for this app's GETs. `cache: "no-store"`
closes it at the right layer rather than teaching the client to interpret a 304 and guess
where the body went: **this app already has a cache**, keyed and invalidated per
Organization, and a second one in front of it with its own revalidation rules can only
disagree with the first.

**Absences, each because of something that does not exist.** No provider, region, size,
cost or provisioning anywhere (locked decision 1). No Docker version or Swarm role
**column** on the fleet, because both come from the audit and a column of them would open
one SSH session per row on every visit — they are on each Server's Infrastructure tab,
where opening the tab *is* the asking. No service count or utilisation column, because
telemetry exists only for a Server set up for monitoring. No fleet-wide CPU or
network tile, which would be a mean over whichever part of the fleet happens to be
reporting. No firewall table on Access (its rows were "as Terraform last applied it") and
no per-Server member list (there is no per-Server permission to list, so three names
beside a Server would imply an access model that does not exist). `GET /cluster/nodes` is
called by nothing: it is a second reading of the same nodes that adds nothing the table
shows and *throws* off a Swarm rather than answering `undefined`, so the parsed
`docker node ls` is the one that can tell a worker apart from a broken host.


#### `monitoring/` · `requests/` · `deployments/` (F14 — the observe rail)

Three Organization-scope screens with one shared filter row and three completely
different sources underneath: a poll over stored samples, a socket with no history, and
a fan-out over whatever the client can name. Most of the work in this folder is keeping
those three from being presented as one thing.

| File | Notes |
|---|---|
| `console/time-range.tsx` | **One range control, three screens** — the `dataviz` composition rule, and the reason it is shared rather than three copies: two screens that could disagree about "the last hour" would both be right. The three routes take a window three different ways and this hides all of it: Monitoring gets a **sample count** converted per Server from its own refresh rate, Requests gets ISO **bounds**, Deployments gets **nothing** and is filtered client-side. The bounds are **rounded to the minute** and that is load-bearing: they are part of a TanStack query key, and a `start` computed from an unrounded `Date.now()` is a new key on every render — an infinite refetch that looks like a slow backend. There is deliberately **no "all time"**, and later fixes changed the reason rather than removing it: dropping *both* bounds puts the access-log route into its unfiltered mode, which answers the newest 500 lines and nothing older, so the count under the table would stop meaning "every request in this window". A ranged read is bounded by the window instead of capped, and seeks to the window's own hours through an hour index. |
| `monitoring/use-monitoring.ts` | The two `POST`s that are reads, and the three writes. `retry: false` everywhere, because every way these fail — a role, no access log, no `traefik.yml` — is permanent until somebody changes something, and this is a screen people watch. `placeholderData` on the log holds the previous page while the next arrives, so paging does not make the card's height jump. |
| `monitoring/health-card.tsx` | **Two legs, and a 403 rendered as a 403.** Postgres and Traefik are all this backend probes (there is no Redis leg; the queue is in-process), so there is no "1 of 3 healthy" fraction inviting the question "which one". The route is owner/admin, and folding that refusal into the readout would show a member two grey dots — telling them their platform's database might be down. "Your role cannot ask" and "Postgres is unreachable" are opposite statements and only one of them sends anybody anywhere. |
| `monitoring/live-card.tsx` | **One machine, one card** — the shell only, since a second store was merged into it and the file reached 812 lines. It owns the target, the layout and the two stores' names; each half's reasoning moved with its code into `live/`. The merge is the decision worth keeping here: one host with two cards, disagreeing by up to a refresh interval and both labelled "the host Cloudgate runs on", is the defect that shape avoids. Its header and subtitle are the **picker's target**, not a constant: they said `This host` over a container's figures, and the card has three pieces of copy about its subject that now come from one `liveTargetCopy` call. |
| `monitoring/live/live-readings.tsx` | One socket frame, drawn — and **three things the socket cannot do**: no `serverId` (platform host only), no queryable history (288-entry JSON files, newest entry only), and no threshold notification. That third is why meters and figures are the honest form here and the plot lives next door. **The finding is that its host path does not fail.** `HostStatsService` reads `/proc`, and on a non-Linux platform host `parseServerStats` defaults every field to 0 — so a perfectly well-formed frame arrives reporting 0% CPU and 0.00GiB of 0.00GiB memory. Drawn, that says the machine is completely idle: the exact lie the Server cards refuse to tell, through a different door. **Its refusal is `LogRefusal`, not prose of its own**: every close carrying a reason read "…, and no sample arrived" followed by the `/proc` guess, and on a `4010` all of that is wrong — a lease can only end after authorization has already succeeded, so the stream was delivering samples up to the refusal. "Nothing arrived" is kept for the one case where it is true by construction, silence outlasting its grace period with no reason to quote. The Network tile's caption branches on the target for the same reason — the host reading is `/proc/net/dev` **since boot**, and it was captioned as a container's lifetime. The host wording is `server-figures.tsx`' existing sentence rather than a new one. |
| `monitoring/live/host-history.tsx` | The stored half, in the **four states that are genuinely different**: never set up, set up with nothing stored yet, set up while storing nothing for ever — which is what a non-Linux platform host does, since a sample of zeros is dropped rather than saved — and **set up, stopped, samples kept**. The third is stated as fact rather than possibility because the live frame has already proved it, arriving here as `cannotMeasure`. The fourth is what "Stop keeping a history" leaves: the token cleared and nothing else, so the stored rows are still read and drawn (unpolled), the copy says they are deleted by the retention cleanup that goes on running, and the button resumes rather than sets up. `CpuHistory` draws it the way `ServerCard` draws a Server's. |
| `monitoring/live/container-history.tsx` | Whether anything is stored for the **container** the picker is on, in words rather than drawn: the include list is empty by default and there is no value meaning everything, so the honest answer for almost every instance is "no, and nothing will change that until somebody names this service". It reads the **exclude** list as well as the include one: checked in that order, an exclusion wins, and reading only the include list told an operator their samples were being stored when they had switched them off. |
| `monitoring/live/units.ts` · `units.test.ts` | The arithmetic, pure and pinned by tests now that the card it lived in is seven files. `memoryPercent` converts **both sides to bytes first** — `docker stats` prints whichever unit fits each side, so dividing as printed gives a bar 1024 times too long. `isUnmeasured` tests the **totals**, not the values, because a container really can be at 0.00% and have written 0B. |
| `monitoring/live/use-live-stream.ts` | The two readings a frame cannot give you, both of which were defects first: which target the socket is on, and whether silence has lasted long enough to count as an ending. `closed` is also the store's *initial* state, so reading it directly rendered "the stream closed" on first paint of a working socket. Held as **which target has settled**, so switching target needs no reset and a socket that closes and reopens is covered. |
| `monitoring/live/tone.ts` | The live tone ladder, and why the **stored** threshold wins when there is one: that is the number that actually notifies, so a bar turning amber anywhere else would disagree with the alert the operator receives. `0` means no alert rather than a threshold of zero, and then the fixed ladder is a reading aid that promises nothing. |
| `monitoring/live/target-options.ts` · `host-setup-modal.tsx` · `live-footer.tsx` | The picker's options are **Docker's own names** — an Environment can name its services, but the read runs the other way and nothing answers "which Environment is this container in". The label drops the 39-character task id and keeps the replica index, because `Picker` renders `detail` `flex-none` beside a `truncate` label and a long detail truncates the *name* to nothing. The footer's one job is saying which half of the card notifies; the modal is the shared `SetupTarget` with the one thing that differs about this machine — it is reached through Cloudgate's own shell, so a refusal is about a role and never reachability. `liveTargetCopy` lives here too — the card's title, subtitle and Network caption are the picker's target rendered as words, so the one thing that knows the target answers all three. |
| `monitoring/server-card.tsx` | The reference's card (`viewMonitoring`) with the state the prototype had no idea about, which is the common one: **a Server that has never been set up**, since `metricsConfig.server.token` is `''` at creation and `registerServer` returns early. That gets the setup action instead of a chart. **A stopped Server is a different state and not that one**: "Stop collecting" clears the token and keeps the config and the samples, so the card still draws what is stored in the range, says when retention deletes it, links to the Telemetry tab for all of it, and offers "Start collecting again". `samplingState` in `lib/format/sampling.ts` tells the three apart off `cronJob`, which is `''` only where no setup was ever saved. **Thresholds are the Server's own** `metricsConfig.server.thresholds`, because that is what `ThresholdService` compares every sample against — a meter turning amber at some other number would disagree with the alert the operator actually gets, and `0` means no alert rather than a threshold of zero. The footer reports the **span the samples really cover** rather than the window that was asked for: with a gap in collection, N samples reach further back than the range, and the route cannot be wrong about it because it was never told. Network is a **total since boot**, not the reference's Mb/s — a rate needs two samples and a claim about the interval. |
| `monitoring/containers-card.tsx` · `container-targets.ts` | Conditional rather than empty, because container samples need a **non-empty include list** and there is no value meaning everything. Its "nothing here" sentence exists because the include list matches by **substring** when collecting and the read route matches by **exact name or Swarm task prefix**, so `redis` stores 63 rows under `redis-12sp3x.1.kyc0…` that no `appName` of `redis` will ever return. Driven both ways. A container's CPU is **summed across cores**, so its domain is computed rather than fixed at 0–100 — the opposite of a host's. **It takes collection targets rather than `Server[]`**: the machine Cloudgate runs on has no `server` row, so a card built by filtering that array could never be the host's — and in a default single-box install every Application has `serverId: null`, so the card was unreachable for all of them while the route answered 200 with 79 samples. `container-targets.ts` is that list, host first, filtered by the config-shaped `samplingState`/`includedFrom` (the only shape a host with no row can be described in) — anything but `never` stays, so a host whose history was **stopped** keeps its card and its stored samples and pinned by this feature's one unit test; the screen mounts the card **outside** its "No Servers to monitor yet" branch, which is where it used to be stranded. A synthetic Server row for the host was rejected — that was decided early, and ADR-0010 and the strap both turn on the host genuinely not having one. An **excluded** name is explained by its exclusion and names the entry; the older two-cause sentence stays for a name that is neither running nor excluded, because that one is still true. The query is disabled for an excluded name rather than firing a request whose 400 is the thing being explained. |
| `monitoring/setup/metrics-config-spec.ts` | **Eight fields of eleven, and the three that are missing are the point.** `token` is a *presence* check and is never sent anywhere, so it is the on switch rather than a credential — and a text box whose empty value silently means "collect nothing for ever" is the worst spelling of a switch, so the form generates it and "Stop collecting" is its own control. `port` and `urlCallback` describe where an external agent would post and are read by nothing; they are **carried through untouched** rather than shown, so a Server configured for a real agent does not lose its callback to a form that never mentioned it. `defaultMetricsConfig` also **cannot be submitted** — it ships `urlCallback: ''` and `cronJob: ''`, which the DTO refuses — so `valuesFor` substitutes only where the stored value would 400. `exclusionsFor` is here: the console's half of a deliberate pair with `container-stats.collector.ts`' `exclusionsForAppName`, which is authoritative — change one and read the other. **`configCollects` and `samplingState` are not here any more**: they moved to `lib/format/sampling.ts` under §1.4 once a Server's Telemetry tab asked the same three-state question, and `lib/api/use-server-metrics.ts` gates its query on the same function instead of a third inline spelling. `retentionSpan`/`retentionDeletion` beside them are the one spelling of how long a stopped host's samples stay, which seven stopped-state sites had each built by hand — one of them as "2 daysold". |
| `requests/logging-card.tsx` | **Three states, not two**, and that is why the file exists. `GET /settings/traefik/requests` answers `false` both when the block is missing and when there is no `traefik.yml` to look in, so presence is established separately by asking for the Traefik directory listing — which either answers or fails. And turning logging on **does not restart Traefik**: `accessLog` is *static* config and the file provider watches `dynamic/` only, so the setting is on disk and the running process has not read it. The restart is offered as its own named action behind a confirmation, because bouncing the ingress that serves every domain is not a side effect of ticking a box. |
| `requests/requests-chart.tsx` | **The gaps are filled and that is the only interesting decision.** `processLogs` returns only the hours that had traffic, so plotting the array as it arrives draws a straight line through a four-hour outage — the shape of an outage being the most valuable thing this chart can show. Every hour in the window is materialised at zero first. When a filter is on, the header says the chart and the table **disagree**: the stats route takes a `dateRange` and nothing else, so status and host reach the log and not the summary, and two figures that differ with no explanation are worse than either alone. No p95 and no error rate, though the reference leads with both: they would need every row in the window rather than the page. |
| `requests/request-columns.tsx` | A status wears a tone **and** always its number, because 404 and 410 are the same tone and different afternoons. `DownstreamStatus: 0` reads "no reply" rather than as a number somebody would look up — it is Traefik never getting an answer to relay. Durations are **nanoseconds**, formatted per row rather than converted to one unit, so 131 µs and 3.4 s are both readable in the same column. |
| `requests/requests-screen.tsx` | Ships the three filters that exist — range, status class, host — and **no method filter**, because the log is server-paginated and filtering the loaded page would print a count that means nothing about the traffic. Method is a column that sorts, which is what the API does support. The search box says **host** and means it: `parseRawConfig` matches `RequestHost` and nothing else, and a box labelled "Search" that silently ignored a path is the same defect wearing a friendlier label. |
| `deployments/use-feed.ts` | **The screen reads the Organization, and Recents narrows it**. It walks `GET /deployments` by cursor, 100 rows a page, until it passes the widest window the range control offers, the last page, or a 10-page cap — and `truncated` is reported to the reader rather than hidden, because a silently clipped feed is the defect this screen was already carrying. Recents survives only as filter input (`recentServiceIds`), so "services you have opened" is a choice rather than the query. The old `useQueries` fan-out — one `findOne` plus one `listBy*` per opened service — is gone, and with it `scopePending`: there is no longer a gap where `useRecents` answering `[]` is indistinguishable from "you have opened nothing". |
| `deployments/coverage-card.tsx` | **Deleted.** It existed to say the feed was partial and to name what could never appear in it. Both halves stopped being true at once: the screen now reads the organization-wide route, and that route resolves scheduled runs, volume backups and database backups to their service through `ownedServiceId()`, so the run kinds it apologised for are ordinary rows. The instruction it embodied — *do not silently show a partial feed as if it were complete* — is now carried by `use-feed.ts`'s `truncated` flag and the table's error branch. |
| `deployments/deployments-screen.tsx` | The reference's screen with everything unbacked removed — its **By** column (no `userId` on the row), its Export, its "Live now" aside (requests belong on the Requests screen; p95 and error rate are computable from nothing), and its three trigger switches (per-Application columns, not Organization settings). What it keeps is the reference's best idea: **counts beside each status word**, computed after the range and before the status filter, so an empty "Error" is visibly empty rather than indistinguishable from a filter that found nothing. The log opens **here**, in F09's `DeploymentModal`, rather than sending you into the service's own tab — losing your filters to read one log is what makes a feed not worth using. |

**Two clocks on one screen, said out loud.** The live card streams from a socket that
reaches one host and keeps no history; the Server cards poll stored samples that exist
only where monitoring was set up. Presenting those as one "monitoring" would leave
somebody believing a remote Server's CPU was live, so each card says which it is. The
reference's **pause control is absent** for the same reason it made sense there: its
numbers were simulated on a timer that pausing genuinely stopped, while these come from
a poll whose interval is the Server's own — freezing a reading while the host moves on is
the one thing a monitoring screen must not do quietly.

**Two shared components were fixed, both latent, both found by looking at pixels.**
`Plot`'s `tickCount` is now **capped at the number of points**: asking for four labels
from a two-point series sampled indices `0, 0, 1, 1`, so the strip printed every label
twice *and* React logged "two children with the same key" twice per plot — a request
count bucketed by hour has two points in its first two hours. The labels are also keyed
by their position in the strip now, not by the point they name. And `ui/select.tsx`'s
`ItemText` carries `min-w-0` instead of `shrink-0`: the popup is `w-(--anchor-width)`
with `overflow-x-hidden` and `Picker` documents its label as truncating, which it was
not — `shrink-0` meant the box never dropped below its content width, so the child's
`truncate` had nothing to truncate against and long options were **clipped mid-string
with no ellipsis**, two different Docker containers rendering as the same visible text.
`min-w-0` on the child cannot fix a parent that refuses to shrink.

#### `integrations/` (F15 — git providers, registries, destinations, notifications, AI)

**Two descriptor tables and one form, four times over.** The brief named the trap and it is the
whole shape of the phase: `notifications.controller.ts` is 39 routes — create, update and test,
twelve times — and built literally it is twelve forms that drift apart inside one phase. What
shipped is **one form component and twelve entries in `notifications/channels.ts`**; the git
providers are the same argument on a smaller surface, four entries in `git-providers/providers.ts`.
Nothing below those two files names a channel or a provider. There is no `switch` on either.

```
lib/settings/sections.ts                    the settings section registry — F16 and F18 add lines
app/(console)/settings/_components/         the strip and the per-section frame
app/(console)/settings/<slug>/page.tsx      five routes, each four lines
features/integrations/use-integrations.ts   the queries
features/integrations/notifications/channels.ts   12 descriptors + the 8 shared event switches
features/integrations/git-providers/providers.ts  4 descriptors
```

**`/settings` is a registry, not a folder of pages.** Three phases write into one route, so it
needs the seam the tab registry gives the seven scopes: one line in `SETTINGS_SECTIONS` plus the
route file it names, and the strip, the index page and the `<h1>` all follow. It is deliberately
*not* `TAB_REGISTRY` — a scope's tabs are lazily loaded panels of one fetched resource and are
handed `{id, kind}`; a settings section is a plain route with no id at all.

**Every secret is write-only, and one of them tried to come back anyway.** Registries,
destinations, AI and all four git providers strip theirs server-side, so an edit form starts with
the box empty and a `PATCH` that omits it keeps what is stored — verified by renaming a registry
and reading the ciphertext back byte-identical. Notifications strip **nothing**
so the typed client declares no
credential field at all: F09's and F13's narrowing, for the same reason. And a *refusal* can carry
one — `POST /destinations/test-connection` rethrows an `rclone ls --s3-secret-access-key="…"`
command line, which rendered a live key on screen the first time it was driven
`spec.test.redact` takes the values
the caller just sent back out of the sentence `errorMessage()` produced — after it, not instead of
it, so *"dial tcp: lookup host.docker.internal: no such host"* survives while the key becomes
`••••••`. It lives on the spec because the spec is the only thing that knows which strings were
credentials.

**The test is a control in the dialog, not a button on a row.** It was built when all three test
routes took the credentials and no id; an id-taking route was added beside each, and the second case
— test the thing *as it is saved* — became the same button rather than a new one, decided by whether
the credential boxes have anything in them. The dialog stays the right home, because a test before
the row exists can only happen in a form. Where a test genuinely cannot run yet, the button goes
`aria-disabled` with the reason **in the body**. It was after
`Modal.Footer` first, which put it 209px below the dialog's own bottom edge: the footer is sticky
and the body is the scroll region, so anything after the footer is outside the box. A control that
is off and cannot say why is exactly what F03's `aria-disabled` rule exists to prevent.

**The git-providers screen was shaped by two gaps, and both are closed.** There was no OAuth
callback and no GitHub App manifest route, so connecting meant pasting credentials; now there
is `/git-providers/oauth/…`, and the banner at the top now says which of the four providers can send
you to itself and what each still wants first, because the answer differs for all four. And three of
the four strategies used to **filter their own listing** by the credentials they require while
accepting a save without them — a connection created and then invisible, unopenable, since the
list is the only place a strategy id comes from. All four listings are unfiltered now: an incomplete
connection is listed, opens, and can be completed, so what is missing costs the clone and not the
row. Two of the three answers survive and mean something narrower. The create dialog still says what
a provider needs *before* the save, because a repository list coming back empty is a worse place to
learn it. And `GET /git-providers` (base rows, unfiltered) is still fetched beside the four per-kind
lists, but a difference between them now means the base and strategy tables actually disagree — a
half-removed connection, a restored backup — rather than a missing credential; that section offers
Remove, because `DELETE /git-providers/:id` takes the **base** row's id and is the one route that
can still reach an orphan.

**There is no readiness column, and two attempts at one are why.** The first said "Can clone",
which this screen cannot know — the credentials that decide it are the ones `sanitize()` strips.
The second reported on the non-secret columns instead, and driving it showed that is dead code,
because a row that would fail the check is filtered out of the list before it gets here. The real
answer is the **check below the table**: `GET /<kind>/:id/repositories` is a round trip with the
actual credentials and the only thing that knows. Its three outcomes are three different sentences
— repositories, *authenticated and can see none*, and a refusal in the provider's own words —
because collapsing the middle one into either of the others is F09's first defect.

**The two AI features are where they belong, not on this screen.** `POST /ai/analyze-logs` is a
control under a finished Deployment's log (`ExplainLog`, mounted in F09's `deployment-log.tsx`),
and it **renders nothing at all** when no provider is configured rather than adding an error to
somebody else's screen. `POST /ai/suggest` + `POST /ai/deploy` is a three-step dialog beside "Add a
Compose stack" on F08's Services tab, because `/ai/deploy`'s DTO answers the brief's question: it
takes an `environmentId` and a `dockerCompose` and calls `compose.createByTemplate`, so what it
makes is an ordinary `raw` Compose stack. Its third step is **the whole file on screen** — every
image, port and generated password was written by a model, at the last moment it can still be
abandoned.

**Two shared components changed.** `console/resource-*` moved here from F10's folder (above), and
`lib/api/use-registries.ts` moved out of F09's `use-application.ts` beside `use-destinations` and
`use-ssh-keys` — the fifth list every feature picks from to make that move. Both re-export from
their old paths, so no F09 or F10 call site changed.

#### `settings/` · `members/` · `certificates/` (F16)

Twelve settings sections now, from three phases writing into one route. F15's `lib/settings/sections.ts`
is still the whole seam: **one line plus the route file it names**. F16 added seven lines, and one
thing about the file itself — its order is by **audience**, widening outwards (you → your
Organization → what it points at → the machine it all runs on), which is also why the index page and
the strip are titled **Settings** rather than "Organization settings". Account is the signed-in
person's and Platform is the whole instance's, so the old title was true of four of its twelve
sections. `nav.ts`'s rail label moved with it, and ⌘K's `go:` pages follow for free.

| File | Notes |
|---|---|
| `settings/section-states.tsx` | `SectionPending` / `SectionFailed`. Its line is in the console table above. |
| `settings/account/*` | Profile, password, two-factor, sessions, API keys. Five cards, four of them gated on `GET /users/me` — not because they need it, but because a screen that pours itself in three stages while somebody is deciding what to change is worse than one that arrives. |
| `settings/organization/*` | The Organizations you belong to, plus create / rename / set-default / switch, and the one `DangerZone`. |
| `settings/platform/*` | Traefik (three named files, the file browser, the container), Instance (version, health, address, concurrency, domain, SSH key, GPU) and Maintenance (disk usage, the two scheduled jobs, seven cleanups). `use-platform.ts` holds every read and write; `use-draft.ts` is the three editors' shared answer to "an edit in progress over a value that keeps arriving". **The three sections are compositions and each card is a sibling file (F19)**: `instance-{identity,health,danger-zone}-card` plus `console-domain-card`, `maintenance-{disk-usage,scheduled,cleanup}-card` plus `maintenance-danger-zone`, and `traefik-{env,ports}-block`. Two of those blocks hold a draft, which is why they are modules and not closures: a component defined during render is a new type every render, so React remounts it and throws away what somebody is typing. Only the section files carry `"use client"` — they are what the route imports, and a child that declares its own boundary makes every callback prop subject to the serializable rule. |
| `members/*` | The member table, invitations, the permission grid and teams. `permission-grid.tsx` is **F18's editor, shipped read-only** — its brief asks for exactly that. `manage-access-modal.tsx` is the **row-level grants** the role does not carry: the `accessed*` columns are what `PermissionService` actually filters a non-privileged role's listings by, and until this dialog the only way to set one was a PATCH by hand. Three things it must get right, all of them the route's and not the dialog's taste. The PATCH **replaces per column**, so it sends the whole set it read and never a diff — a diff would silently revoke the two columns the operator did not open. The three columns **cascade**: a Service granted without the Environment and Project above it leaves the Member unable to navigate to it, so ticking travels up and unticking travels down and the dialog cannot express the broken state. And `assertGrantsResolve` refuses the **whole** PATCH on one id that no longer resolves while a `member` row keeps ids for deleted rows, so stranded ids are stripped — but only where the scope was read and positively showed the row gone. An unread scope keeps its id, because *we did not look* is not *it was deleted*, and the dropped ones are listed rather than hidden. The tree is `components/console/access-tree.tsx` and the pure half is `lib/auth/access-grants.ts`, tested apart from the dialog — both promoted out of this directory when the Agents section became their second importer. **Revoke on an invitation and Delete on a team ask first** — both destroy (the row is deleted, and `team_member` cascades), so `team-row.tsx`' "a row control rather than a dialog" reasoning covers the roster's Remove and not these. Plain confirmations, not typed ones: `ConfirmDeleteModal` stays for the unbounded losses. `role-hint.ts` derives the invite dialog's Role hint from the served vocabulary and falls back to pointing at the roles card rather than asserting a stale claim. |
| `agents/*` | The Agents section: `agents-card.tsx` lists them, `agent-row.tsx` is one Agent at rest, `create-agent-modal.tsx` creates one and reveals its first key through `agent-key-reveal.tsx`. The rules the row draws — one status by precedence (Suspended, No valid key, Reaches nothing yet, Active), the 14-day amber on the next key expiry, the audit link by user id — are pure in `agent-facts.ts`. The access step is Manage access's own tree: `components/console/access-tree.tsx` holds the tree and its fan-out for both, and the row reads names through it only when its access line is opened. **An Agent's synthetic address is never rendered**: the listing does not carry it, and `members/member-kinds.ts` takes Agents (told apart by their Agent-only roles) out of the Members card and the team picker, which read the member list that does. |
| `certificates/*` | One `ResourceList` and one spec, F15's registries screen again. |
| `settings/cloud-accounts/connect-google-project.tsx` · `edit-google-cloud-account-modal.tsx` · `new-key-modal.tsx` | **A Google Cloud project, connected, edited and re-keyed** (slice 6), each by the AWS dialog's rules. Connect is two steps because the key exists nowhere else: the script that uploads its public half comes first, and nothing is saved until the connect check passes. Edit sends only what changed, and a changed provider or service account is checked before it is saved; the project, the key and the issuer are shown, not edited. New key runs in the order that never locks Cloudgate out — a JWKS with **both** keys, a check signed with the new one, then the JWKS with the new key alone; a refusal at any step stays in the dialog and changes nothing. |

**Six things this phase learned that are not obvious from the code.**

1. **`POST /settings/update-server` restarts the instance, and the brief was right to ask.**
   `UpdatesService.updateServer` runs `docker service update --force --image
   cloudgate/cloudgate:<latest> cloudgate` — it replaces the running task, so the console goes with
   it, mid-request, and comes back on a different version. It is the most destructive control in the
   product. It also **does nothing at all** when nothing newer is published, because it re-reads
   `getUpdateData` and acts only `if (data.updateAvailable)`. A button that means "restart onto a new
   version" on Tuesday and "nothing" on Wednesday is not one control, so it is `unavailable` with its
   reason until somebody has asked Docker Hub and been told there is something to move to. Driven: on
   this build the check answered "nothing newer", the control went off, and clicking it opened no
   dialog while keeping `aria-disabled="true"`, `tabIndex=0` and its ring.

2. **A refusal is not a reading, three more times.** `infrastructure-health`, `docker-disk-usage` and
   `traefik/config` are all owner-or-admin and throw *before* they measure, so rendering a 403 as
   `unhealthy` would tell somebody Traefik is down because their role cannot ask. Every one of them
   goes through `SectionFailed`. The same rule from the other end: `GET /settings/traefik/config`
   answers `null` for a file that is not there, which Nest sends as an empty body — and
   `dynamic/cloudgate.yml` genuinely does not exist until **Assign domain** creates it. The card says
   which file it is looking at and lets the emptiness speak, rather than claiming either "empty" or
   "missing".

3. **`useDraft` exists because `useEffect(() => setDraft(fetched), [fetched])` is wrong twice.** It
   throws away what somebody has typed the moment a background refetch lands, and this repo's eslint
   bans setting state from an effect for exactly that class of bug. So a draft **remembers what it was
   a draft of**: while `base` matches what the server last said the typed text wins, and the moment
   the server says something different the draft is stale by definition. No effect, no race, and
   "somebody changed this file underneath you" resolves in the only direction that cannot lose the
   file. The ports list holds its draft as **JSON text** so the same rule applies — an array would
   compare by reference and every refetch would look like a change.

4. **A cleanup has to refresh the reading it was decided from.** Found by driving: pruning the build
   cache really emptied it on the daemon and the disk-usage table went on saying `9 objects,
   70.31MB`. That is the exact failure the card's own argument warns about — a figure that does not
   move when you act on it is worse than no figure, because the reader concludes the button did
   nothing and presses the bigger one. Every cleanup and both `DangerZone` actions invalidate now.
   Verified afterwards: 21 containers → 14, reclaimable 155.6kB → 0B, in place.

5. **The instance's SSH private key needed a *runtime* strip, not a type narrowing.** `GET
   /settings/web-server` returns the row unprojected and `sshPrivateKey` is an `encryptedText`
   column — driven as a **plain member**, who is not owner or admin and gets the key anyway. Two
   similar leaks were answered by declaring fewer fields, and that is not enough here: TanStack
   holds the parsed response whatever the declared type says, so the key would sit in the query
   cache and in every devtools panel over it. `settingsApi.webServer()` **deletes the field** at the
   client boundary and hands on a derived `hasSshPrivateKey`, so every reader of that route gets the
   narrowed shape — including one written later by somebody who has not read this. *(Now there is no
   key, no flag and no card: nothing ever read the column, so it was dropped. The client strip
   stays, now for the metrics agent token.)*

6. **`GET /users/me/api-keys` is not an array**, and `DataTable` crashed on `sorted.map is not a
   function` the first time the screen was opened. `@better-auth/api-key`'s `listApiKeys` returns
   `{apiKeys, total}` and the controller passes the plugin's result through verbatim. This is the
   cost of an untyped API in its purest form: with no OpenAPI document the client's types are
   hand-written from the controller, and a controller that returns a plugin's result gives the
   reader nothing to read. `listApiKeys` unwraps it, so nothing downstream has to know.

**The `{" "}` trap, for the seventh time, and now with a detector.** F10, F11, F12 and F15 each paid
for it once; F16 paid twice in one session. The rule is sharper than "put a space in": the space
*before* an inline element survives and the space *after* it does not, so the two look identical in
the source and only one reaches the screen. **`{" "}` on both sides, always.** What is new is that
guessing is no longer necessary — the boundary is visible in the DOM, and one query finds every
instance on a screen:

```js
for (const el of document.querySelectorAll('main strong, main code, main em')) {
  const next = el.nextSibling;
  if (next?.nodeType === 3 && /^[A-Za-z0-9]/.test(next.textContent)) console.log(el.textContent, '|||', next.textContent);
}
```

That is what caught `F16 deploy pipelinestarts being refused` and `This is the staticconfig.`, and
what proves the other twelve inline elements on those screens are fine.

**That query is now the runtime
cross-check and not the primary detector.** It only ever saw one built screen at a time, and only
when somebody remembered to open the console; an eighth instance was a matter of time. The primary
detector is now static and runs in CI: `cloudgate/jsx-inline-element-spacing`, in
`frontend/eslint-rules/`, wired into `eslint.config.mjs` and therefore into `pnpm lint`, with an
autofix that inserts the `{" "}` and a `RuleTester` fixture next to it, which runs as the
`lint-rules` project of `pnpm --filter frontend test` alongside the console's own suite.

**Its predicate is this query's predicate**, deliberately: fire only where the stripped whitespace
would join two **alphanumeric** characters. That is the whole reason to write a rule rather than
enable one. `eslint-plugin-react`'s `jsx-child-element-spacing` arrives free with
`eslint-config-next` and detects the same mechanism, but it reports *every* stripped space — 27 of
them across 23 files here, re-measured against this tree, and nearly all intentional: an `or`
between two `flex-1` separators, a `<span className="block">`, the `(` before `<a>#26</a>`, the
comma opening `, with every Environment`. It has no options and no autofix, so adopting it meant 27
`eslint-disable` comments. The local rule reports **zero** on the same tree and still catches
`systemprunes`, `localhostkeeps` and `staticconfig`. Where it cannot see — a `{expression}` on
either side of the boundary, whose rendered text is not in the source — it declines rather than
guesses; guessing was measured too, and costs two false positives while catching nothing.

Keep the DOM query for what static analysis cannot do: it reads the *composed* screen, including
text a component interpolated, which is exactly the blind spot the rule admits to.

**The rule has a second predicate now, and the first predicate's model of the bug was wrong.**
Everything above is about a space the author never wrote. The shipped production bundle was
measured (`next start`, Next 16.2.10 / Turbopack) across **every** site in this tree where a text node follows a closing inline element,
begins with a space **on that same line**, and then continues onto further lines — the shape the
first predicate reads as already correct. There are 83, and the split is total: the 77 whose node
holds no HTML entity keep their space, and the 6 whose node also holds one (`&rsquo;`, `&mdash;`, …)
lose it, every time. **All 83 sources contain a real space**, so no author is at fault anywhere; the
build drops it while decoding the entity. That is how `rooton the machine`,
`verify-hostas its Server`, `/root/.dockeris appended`, `systemprunes`, `one host— the machine` and
`Portscolumns` all shipped with `pnpm -r run lint` green — the first predicate looks in the source
for a space that is *missing*, and in all six the space is there.

So the second predicate looks for the opposite thing, a space that is present and will not survive:
**a multi-line JSXText node, after a closing inline element, with an HTML entity in it.** It carries
**no** alphanumeric filter, and that is not an oversight. The filter exists to tell a space nobody
wanted from one somebody needed, and that question does not arise here — the author typed the space
on the closing tag's own line, so its loss is always a defect. `one host&mdash;` is the case that
proves it: the first predicate would rightly skip an em dash, and `one host— the machine` is still
wrong on screen. Two sites beyond those six turned up on `/dev/rows` when the rule ran, which is
the argument for a rule over a sweep in one line.

**It is not about the element.** The measurement covered the shape after a closing
inline element because that was the first predicate's ground, and the predicate kept the restriction
the build does not have. A stopped Server's card shipped `more than 2 daysold` with lint green: the
neighbour was `{days === 1 ? "day" : "days"}`. Next's own SWC transform, run over every `.tsx` with
its entities as written and again decoded, found eight more — `{errorMessage(error)}Nothing` on three
failure cards, `{switchedOff.length}of`, `{descriptor.label}reads` — every one after an interpolation.
The second predicate now reads any multi-line text node with an entity and a leading space, whatever
precedes it, and on this tree it and that census report the same sites.

The guard is the same `{" "}` either way, which is the useful part: **`{" "}` after an inline
element or an interpolation, always, whether or not you also typed the space.**

**Two verification notes for the phases behind, both about the harness rather than the product.**
Constraining `main` to 380px (F14's method) does **not** move the viewport, so `lg:` variants keep
applying — a two-column grid stays two columns and reports a clip that a real phone would never see.
`resize_window` floors at about **606px** on this machine, which is still below `lg` and is enough to
exercise the single-column path; use it to confirm anything the constrain-`main` method flags inside
a `lg:` grid. And `:focus-visible` needs keyboard modality **and** a focused document *and* a click
that landed inside `main` — a click on the rail followed by Tab left every one of 29 focusables
reporting a miss, which is a harness artefact and not a finding.

**Cross-phase edits, stated as `00-INDEX.md` asks.** `components/console/qa-row.tsx` (the `title`
`Omit` and the wrap — both above), `components/console/modal.tsx` (`keepOpen`),
`components/shell/nav.ts` (one label), `app/(console)/settings/_components/settings-strip.tsx` (the
group labels the registry already declared; the vertical `settings-nav.tsx`, and a link back to the index below `cols`) and `app/(console)/settings/page.tsx` (grouped and
retitled). F06's `app/(auth)/_components/schemas.ts` moved to `lib/forms/credentials.ts` and
re-exports, because F16's Account section changes a password and invites by email, which makes it the
second consumer of an email rule and a password floor. One new dependency: **`uqr`**, ~5KB and
dependency-free, argued in `console/qr-code.tsx`.

#### `templates/` (F17 — the marketplace: catalogue, target, review, deploy)

> **Superseded by the Template catalogue (#1356, ADR-0062 to ADR-0066).** What follows is the
> `template.toml` flow as F17 built it, kept as the record of why. The three POST routes it audits,
> the review step, `generated.ts`, `template-plan.ts`, `app-name.ts` and the `flow/` directory are
> gone. Today `features/templates/` is the catalogue view (logo, links, version, where a Template
> runs, the saved copy's age) and a setup form whose Submit opens the Environment's Plan, or shows
> the renamed entries to paste for a repository-kept config.

The one screen in the product that is about *browsing* rather than operating, and the phase whose
**endpoint audit changed the flow the brief described**. The whole audit is in
`lib/api/endpoints/templates.ts`; the three things that moved the design are:

1. **`POST /templates/process` is not for a catalogue template.** Its DTO is `{ base64, composeId }` —
   a payload processed against a Compose stack that already exists. And `deployTemplateSchema` accepts
   no variables at all. So the brief's *"fill the template's variables"* step **cannot exist**, and the
   target step says so on a card rather than letting somebody arrive at Review expecting a form.
2. **`POST /templates/deploy` creates; it does not deploy.** It writes one `compose` row (`raw`, the
   file verbatim, `composeStatus: "idle"`) plus a `mount` per template mount and a `domain` per
   template domain, and stops. Driven: `201`, `idle`, no `deployment` row. So "Create and deploy" is
   three calls (`use-templates.ts`).
3. **Every generated value is generated per request, and `preview` and `deploy` generate
   independently**. A preview can show the
   right keys, services, paths and host *shapes*, and can never show the value that will exist.

| File | Notes |
|---|---|
| `catalogue.ts` | Narrowing 500 templates in the client, because there is nowhere else: the two catalogue routes take one optional `baseUrl` and no query, tag, page or count. Pure functions, so when the route grows a parameter these are what get deleted. `tagCounts` derives the tag list from `list()` rather than calling `GET /templates/tags`, which returns exactly the same set over a **second** 264KB upstream fetch — and adds the count, which the route cannot give and which is the difference between a control and a scroll at 599 tags. The search reads **tags as well as** name and description: most of what someone types is a tag on something, and a search box that found nothing for a word printed on the cards under it reads as broken. |
| `catalogue-view.tsx` | The `PickGrid` of `PickCard`s the brief asks for by name — no new card component. **No logos**: `TemplateMetadata.logo` is a file name in the blueprint directory, so drawing them is one third-party image request per row. Each card is a **link** to `?template=<id>`. The strip says the catalogue arrives whole and that filtering happens in the page, so a "1 – 24 of 500" cannot read as server-driven. Paging brings the top of the grid back into view — measured: without it, Next leaves the reader at the bottom of the new page with four rows above them. |
| `tag-filter.tsx` | **Deliberately not F08's `TagFilter`, and the difference is scale.** That one lists three Project tags as a flat column of checkboxes, which is right for three and unusable for 599. This adds the two things 599 needs: a search over the tag names, and an ordering by how many templates carry each. Everything else is F08's and for F08's reasons — a popover rather than a `Menu` (choosing two tags is ordinary and a menu closes on the first), *any* rather than *all*, the count on the trigger. The 100-row cap is **said out loud**, in two different sentences depending on whether anything has been typed. |
| `templates-screen.tsx` | One route, two views, `?template=<id>` as the seam. A template is an address, so two can be compared in two tabs, Back from a review returns to the catalogue, and a reload keeps you where you were — and F07's route tree needed nothing added. The search and tag state live **here**, above both views, so a search parameter changing re-renders without unmounting and coming back lands on the filtered catalogue you left. A named template missing from the catalogue is an `Outcome` at `info`, held until the catalogue has actually arrived (until then *every* template is missing). |
| `app-name.ts` | **`slugify` and the appName rule, derived, with the reason.** `deployTemplate` hands the domain generator `projectName` while `previewTemplate` hands it the request's `appName`, so a previewed host is the same *shape* as the real one only if the client sends `slugify("<Project> <id>")`. Verified against a real deploy: `appName storefront-n8n-xydula`, host `storefront-n8n-b63d53-…`, stem `storefront-n8n`. `slugify` is reimplemented rather than depended on, and the file says why that is exact for this input class (the backend strips everything but alphanumerics and whitespace *before* calling the library, so its transliteration can never fire). |
| `generated.ts` | **Which values are generated, established by asking twice and diffing.** Not by matching the fourteen `${…}` helpers: that list grows upstream, and it would miss the interesting case — a value generated *through* another variable (`mongodb://mongo:${MONGO_PASSWORD}@…`) has no pattern on the resolved string. Two identical `preview` calls answer identically for everything fixed, so the diff *is* the answer. Index-aligned, which is exact because all three lists are built by mapping over the blueprint's own declarations in file order. It can only err in **one direction** — a collision reads as fixed — and the file says so. |
| `template-plan.ts` | The template's compose file, read: services, images, published ports, mounts, and the top-level named volumes. A reading of a document, not a second implementation — the file is stored **verbatim**, so these are the services that will exist. What happens to it on the way to Docker is F12's `convertedPlan` and deliberately not restated. Named volumes and binds are **separated**, because only one of them is created and the distinction is invisible in compose's short syntax. |
| `use-templates.ts` | Three hooks. The catalogue is cached for an hour (a CDN file, not the tenant's rows, and each read costs the backend 264KB); an empty answer **is** evidence of an empty catalogue now, because an unreachable one refuses with a 502 or 504 rather than answering `200 []`, so the screen renders the error and the emptiness as two states; the blueprint files are read **on the server** from a catalogue id, so the browser makes no third-party request and the files hook is gone; the preview fires **two identical requests in parallel** on purpose; and the deploy is three calls, with the rename non-fatal and the deployment reported rather than swallowed. |
| `flow/template-flow.tsx` | The stepper, and it is also the way back: `onSelect` on the done first step returns to the catalogue, so "Choose a template" is the record of the choice and the door out rather than a tick beside a Back button saying the same thing. The Server is asked **before** the review, because it decides the address every generated domain resolves through. `Away` is the local three-line link-out: a `LinkButton` that `reload`s with `target="_blank"`. |
| `flow/target-step.tsx` | Project → Environment → Server → Name, and one card saying **there is nothing to configure**, with the reason. The Project picker exists only to reach the Environment (there is no org-wide `GET /environments`), and choosing a Project clears the Environment — an id from the previous one would deploy into the wrong place while the picker above still read correctly. The Name is the one field not in the deploy route: it is here because the route names the stack after the template's **id** (`actualbudget`, not "Actual Budget") and because deploying the same template twice would otherwise leave two stacks nobody can tell apart. |
| `flow/review-step.tsx` · `services-card.tsx` · `domains-card.tsx` · `env-card.tsx` · `files-card.tsx` | The step that earns trust, and each card takes its content from the authority for its own half: services and volumes from the stored file, domains / variables / config files from `POST /templates/preview`, which is the **same `processTemplate` the deploy runs**. **Generated values are named, not printed** — a plausible, wrong, copyable secret on a review screen is the worst thing this phase could ship, and the failure would surface hours later as a connection string that does not work. Comment lines are kept in place (a blueprint may write `[config.env]` as an array; supabase sends 146 lines, about forty of them prose) because they are stored in the column exactly like that. The variables list caps at 40 with a **"Show all N lines"** button, and the config-files card gives paths and sizes rather than 15KB of somebody else's SQL. |

**What the review says about the host, and why it has been rewritten twice.** The generated host is
rendered as its **pattern**, with the six random characters masked, because the real one is minted
inside the deploy request. The paragraph beneath it first said the host "answers as soon as the stack
is up", which was the most useful-sounding and least true sentence available; a later change
replaced it with a `warn` panel saying the host **will not** answer, because an isolated stack's
services landed on Compose's own `<appName>_default` while the deploy connected Traefik to `<appName>`.
That was fixed, and the warning outlived it — two templates deployed in the U-run answered `200` on
their generated host. It is now a quiet
paragraph naming what the deploy actually wires, each clause held by a compose unit test rather than by
prose, and stopping short of promising that somebody else's software is ready.

**One shared file edited:** `components/console/pick-card.tsx`, three additive props, argued in the
console table above and asked for by the phase brief. `lib/api/keys.ts` gained a `templates` block that
straddles **both** roots — catalogue and blueprint files under `instance`, a preview under `org` — which
is the clearest illustration in the app of what that split is for; the reasoning is in that file.

**One JSX rule this phase paid for three times.** A text node that begins on a new line has its leading
whitespace trimmed, so an inline element sitting first on its line loses the space beside it. It printed
`/templates/deploytakes this Environment`, `a rawsource` and `######are chosen` on real screens. F10
found it once (`ports.controller.tscan create`); the reliable habit is `{" "}` after **every** inline
element, not a judgement about which line the following text starts on.

#### `enterprise/` · `billing/` (F18 — the licensed surfaces, and the cloud ones)

Six sections, five of them in one new **Enterprise** group at the end of the settings strip. The
grouping is the design: these are the only sections in the console whose whole contents may be
unavailable to the Organization looking at them, and F16 ordered that list by *audience*. Scattering
them by audience would leave somebody with no licence finding five locked pages one at a time, in five
different places, each a small surprise; collected under a heading they read as one region a licence
opens.

| File | Notes |
|---|---|
| `license-gate.tsx` | Argued in the console table above. `LicenseGate` for four sections, `LicenseLocked` for the fifth. |
| `use-license.ts` | `useLicenseStatus` is the most-read query in the app after the session — one key, five subscribers, deduped into one request. `staleTime` is **30s and not `Infinity`**: a licence is not a constant of the build the way `statements` is. It lapses on its own, because `isValid` compares `validUntil` to the clock at read time and nothing writes to the row when it runs out. |
| `license/license-section.tsx` · `license-key-card.tsx` | **The one screen not behind the gate** — it is where the gate sends you, and a gate in front of the thing that opens the gate is a locked door with the key behind it. Two switches, in order: `enableEnterpriseFeatures` is a separate opt-in and `activate` refuses until it is on, so the opt-in sits **above** the key rather than beside it. Owner-only reads (`assertOwner`, stricter than the sections it unlocks, which take owner *or* admin), so an admin gets a stated refusal where the key would be and the status above it still works. The key is masked to its last four with a reveal — it is a purchase credential in a query cache, and "which key is active" is the only question anybody has of it. **Checking a key can turn it off**: `validate` writes the answer, a refusal included, so it confirms first and says what a `false` costs. The card **prints `validUntil` when there is one** and says a licence has lapsed when the date has passed, instead of the sentence an earlier change left behind claiming no route reports it; the licensed paragraph counts `UNLOCKED_BY_LICENCE` rather than stating a number that disagreed with it. A refusal is one of three sentences now, not one — refused, server error with its status, unreachable — and `check-key-modal.tsx` says a failed check **recorded nothing**, since its own dialog has just warned that a refusal revokes four features. |
| `audit/*` | Not behind the gate, and that is the audit rather than an oversight: `audit-log.controller.ts` records that the trail **deliberately carries no licence gate**. It is `@RequirePermission('auditLog', 'read')` and nothing else. The response is `{logs, total}` and **not an array** — F16's first defect was a `DataTable` crashing on exactly this shape. The columns carry **no `compare`**: `findAll` orders by `createdAt desc` and takes no sort input, so a sortable header would reorder the 25 rows in front of you and leave the other 48 where they were. The filter bar says what each control does, because they do not agree: email and name are `ilike '%…%'`, action and kind are exact. The detail view renders `metadata` as a **diff only when the row really is one** — a `{before, after}` pair goes through F04's `DiffView`, anything else is a list of pairs, and an unparseable blob is shown raw. |
| `roles/*` | **The list renders whether or not there is a licence**, and that is the whole design of the screen. `GET /custom-roles` is open; only the three writes are `ensureEnterprise`. It has to render: a member on a custom role without a licence is denied **everything**, including what their role grants, and `organization_role` rows survive a licence lapsing. The banner naming how many people are in that position is the only place in the console that can explain why somebody's account suddenly does nothing. The builder is **F16's `PermissionGrid`, unchanged** — its `onChange` was in the signature from the day it was written with a comment saying F18 would add a call site and not a component. |
| `sso/*` | Providers, the enforce switch, trusted origins and SCIM on one screen, because all of it answers "how people get into this Organization without somebody typing their address into an invitation". **The client secret is deleted at the client boundary**, not merely undeclared — F16's answer to the same leak: a type narrowing does not empty a cache. Measured in the browser: the raw response carries the secret, the query cache carries `hasClientSecret: true` and neither the value nor the key anywhere in 24 cached queries. `oidcConfig` is **all-or-nothing on the way back in** (the DTO types `clientSecret` required *inside* an optional block), so an edit that touches any OIDC field has to resend the secret, and the form says so rather than sending a placeholder over a working one. The **enforce switch is the most dangerous control in the console**: instance-wide, and F06's sign-in screen renders *no* password form when it is on. It confirms, it refuses to turn on with no provider registered, and it says the scope out loud. |
| `sso/scim-*.tsx` | The token exists **once** — the listing projects it away, the column is encrypted at rest, nothing regenerates one. Two states in one dialog, F16's API-key treatment. Verified end to end: the token the dialog shows authenticated a real `GET /api/auth/scim/v2/Users` (a SCIM `ListResponse`) and the same call without it was a 401. The base URL is read off `window.location.origin` rather than configured, because `lib/config.ts` makes that the same value by construction. |
| `forward-auth/*` | **Two halves with two different gates**, and that is the design: the server-level routes are `ensureEnterprise`, the per-domain ones ride the `domain` permission, deliberately, so a member with domain rights goes on managing gates after an owner has stood the proxy up. **"Deployed", never "running"** — see below. `unknown` is not `stopped`: the probe is capped at four seconds and anything that fails reads `unknown`, which is an unreachable server rather than a proxy that is down. |
| `forward-auth/domain-gate-switch.tsx` | **F18's one component on somebody else's screen.** The brief asks for the per-domain switch "joined against the domains F09 manages", and the join cannot be made on F18's own screen: nothing lists an Organization's domains, and assembling that list is a fan-out per Project, Environment and service now that made the services enumerable. It can be made one row at a time on a table that already holds the `domainId`. `domain-columns.tsx` gained an optional `gate` prop in the shape `service` already established — passing it adds a column, omitting it leaves the table as it was — and F12 deliberately does not pass it, because the backend refuses a Compose domain outright. |
| `whitelabeling/*` | **Branding**: the settings screen for `GET`/`PATCH /settings/whitelabeling`, which had a backend and no screen. Behind `LicenseGate` like SSO and Forward auth. Four `SettingsCard`s — name and marks, colours, custom CSS, error pages — each **sending only the fields it changed** (`branding-form.ts`), because the route is a merge and a whole-blob save would wipe what another card or person set; an emptied field is sent as `null`, which clears it. The gate asks this Organization's licence, the write asks the *instance organization's* licence and instance authority, so a licensed owner of a second Organization sees the form and gets the backend's refusal on save — the first card says whose save counts. A save invalidates `keys.branding()` and calls `router.refresh()`, because the title and favicon are server-resolved metadata no query owns. |
| `billing/*` | **Not behind `LicenseGate`**, and the difference matters: the Enterprise sections are gated by a licence an Organization can buy, this one by whether the instance is Cloudgate Cloud at all — which nobody can change from a screen and **nothing reports**. So the screen reads from Cloudgate's own records for everything it can (`GET /billing/subscription` is a local row and answers correctly everywhere) and treats the one route that reaches Stripe as the only place uncertainty lives. A refused catalogue is **never rendered as an empty one**: both possibilities are named, with a retry. Money has **two units in one API** — invoice amounts are cents, `currentPriceAmount` is already divided by 100 — so `formatMoney` takes the unit explicitly rather than guessing from magnitude. |
| `billing/server-allowance-notice.tsx` | `GET /billing/can-create-server`, surfaced **where a Server is created** — the brief asks for it by name, and that is the moment the answer changes what somebody does. It renders nothing far more often than it renders something: `canCreateMoreServers` returns `true` immediately off cloud. A **failed** read renders nothing either and does not block the form — `assertCanCreateServer` runs inside `ServersService.create` regardless, so blocking on a failed *hint* would invent a refusal the backend has not made. |

**Two things this phase will not say out loud, and both are the same rule.**

**A proxy that is "running" may be answering nothing.** `isRunning` calls `docker.getService(name).inspect()`,
which succeeds the instant `docker service create` returns and says nothing about replicas
Driven on a real daemon: a proxy pointed at
an issuer that does not resolve crash-looped at `0/1` with every task exiting 1, the route answered
`running` throughout, **and `POST /forward-auth/domains/:id/enable` accepted** — putting a real
Application behind a middleware with no replica, which is exactly what that precondition exists to
prevent. So the pill says **Deployed**, in `Chip` rather than `StatusPill` (whose keys carry an `ok`
tone this reading cannot earn), and the card states the limitation where the reading is. F09 refused the
reference's green per-domain "active" on the same argument.

**A licence has no expiry on any screen.** The row holds `validUntil`, `status` and `features`; neither
route returns any of them. Expiry is derived
at read time, so a licence lapses with nothing written anywhere and the first symptom is five sections
stopping at once. The status card says that, rather than leaving a blank where a date would go.

**Two shared files edited, both stated as this doc asks.** `lib/api/client.ts` gained `put` (the
enterprise controllers are the first to use it — three routes) and `deleteWithBody` (for
`DELETE /sso/trusted-origins`, the one route in the app that names what to delete in a body, because a
trusted origin is a string in a `jsonb` array with no id to put in a path). And
`features/members/permission-grid.tsx` had one condition split: **"Managed by Cloudgate" is about the
form and "Not checked for the built-in roles" is about a static role's read-out**, so only the second
answers to `explainBypass`. F18's builder passes `explainBypass={false}` — correctly, since every tick
in a custom role really is checked — and that had left four rows disabled with no reason given, against
F03's one inert rule. Found by opening the builder and looking at it.

**One `min-w-0` that was paid for again.** A SCIM token is one unbreakable ~90-character string, and
`truncate` only takes effect when every ancestor will actually shrink; a grid item's default
`min-width: auto` is its content's intrinsic width, so the row grew and the **whole dialog scrolled
sideways with its labels cut off**. F13 hit this with an SSH public key in a `Field`. The rule is the
same and it has to be on the ancestor, not the element that truncates.

#### `service-health/` (the Health tab, on every Service kind)

One tab, one folder, and three one-line `panels/health.tsx` files (Application, Compose, database)
that render `HealthPanel` with their `serviceType`, so the seven kinds cannot drift. The slug is
`health` on all three scopes because the `service-incident` notification links to it.

| File | Notes |
|---|---|
| `health-panel.tsx` | The page and the **order**: open-Incident banner, Uptime checks, Error rate, Error-rate threshold, Incident history. Each section is its own component on the **one** summary read, `GET /service-health/:serviceType/:id`; the only state here is the history's page. |
| `use-service-health.ts` | The tab's writes and pickers' reads. The summary read, `useServiceHealth(type, id, page, select?)`, is `lib/api/use-service-health.ts` (the Overviews share it) — a section that wants one slice passes `select` and shares the cache entry; polls every 30 s (the fastest probe interval). `useUptimeCheckMutations`, `useThresholdMutations`, `useServiceDomains`, which reads the Domains tab's own key and never runs for a database, and `usePublishedPorts`, the TCP picker's options under the summary's key prefix. |
| `open-incident-banner.tsx` | `Banner` + one `bad` row per open Incident. Renders nothing when none is open **and** while the read is pending or refused — a "none open" off a failed request is the lie F09's first defect names. |
| `uptime-checks-section.tsx` · `uptime-check-spec.tsx` · `uptime-check-values.ts` | A `ResourceList` over the summary's checks, plus **Turn off / Turn on** as a row control on the same `PATCH` and statement. Every write is `service: ['update']`. The target is a picker, never typed: the Service's own Domains for HTTP, its published TCP ports for TCP. A database's checks are TCP and the kind is not asked; a Service with no port says why in the empty state and the picker's hint. **The header value is write-only**: the box is always empty, and an edit of a check with a saved value chooses Keep / Replace / Remove first — only Replace shows the box, and Keep leaves `headerValue` out of the body. The form's schema, picker options and the header value's body rule are `uptime-check-values.ts`, split out so the spec stays under 400 lines (§1.5) — it had reached 527 with the TCP, keyword and header fields. |
| `uptime-strip.tsx` | 48 half-hours: green all up, red all down, amber mixed, and **the quiet fill for not probed** — never a status hue, because no Probe is not a verdict. The ribbon is `aria-hidden`; the sentence under it and each segment's `title` carry it. |
| `error-rate-section.tsx` | A `Chart` of the 24-hour Error rate in 96 quarter-hours (domain = its own peak, at least 5 %), a `StatTile` for the slow share (over 1.2 s) and one for requests, and a per-Domain `DataTable`. **Never 0 % for nothing:** a quarter-hour with no requests is plotted as `-1`, which `Plot` clamps to the floor and `format` reads back as "No requests", and a Domain with none reads "No requests" in its share cells. With no Error rate at all it shows the backend's reason **verbatim** as the empty state's title, and a line on what to do about it under it. |
| `threshold-section.tsx` · `error-rate-threshold-spec.tsx` | A Service has **at most one** threshold, so this is a card of facts (threshold, when it is judged, a mark: judged / not judged yet / off) with **Turn off / Turn on**, **Edit** and **Remove** in its header — or an empty state with **Add a threshold** — not a `ResourceList`. The modal and the confirmation are `ResourceFormModal` and `DeleteResourceModal` over the spec; add and edit are one `PUT`. Every button is `service: ['update']`, registered in `GATED_CONTROLS`. A threshold added before there is an Error rate says **not judged yet** and the Error rate's own reason. A database gets a card saying it cannot have one, and no button. The console asks for a whole percent (a number box steps by one); the route takes fractions. |
| `incident-history.tsx` | Paged `DataTable`. An open row reads "open" in a `bad` pill; close reasons use the backend's own labels so the tab and the Slack message agree. |
| `health-words.ts` | Every code → words mapping (close reasons, Probe error classes, the check's mark, target labels, a threshold Incident's title and opening rate, `thresholdWords`/`rateWords` — the backend's words for the Notification), once. |

`ResourceSpec` gained **`deleteDescription`** here: the confirmation's default "removes the *noun* and
nothing else" is false for a check, whose Probes and Incident history go with it.
