# Cloudgate console

The dashboard: Next 16 App Router, Tailwind v4, shadcn (`base-nova`), written against the backend's REST routes and its six WebSocket gateways. Requirements, environment and the commands table live in the [root README](../README.md); this file is about working *inside* this workspace.

**Read two files before you write anything here.**

- [`AGENTS.md`](AGENTS.md) — this is not the Next.js you know. The version in `node_modules` has breaking changes against most people's assumptions, so read the relevant guide in `node_modules/next/dist/docs/` before writing route code, and heed the deprecation notices. The clearest example is already in the tree: the session gate is **`src/proxy.ts`**, because Next 16 renamed the `middleware.ts` convention — the old filename would silently never run.
- [`docs/design-system.md`](docs/design-system.md) — the component index and seven rules. If a component is listed there, import it; if you need a variant of one, add a variant; only then write something new, and add its line in the same commit. 77 console components exist already.

## Layout

```
src/
  app/
    (auth)/            the seven screens outside the console shell
    (console)/         everything inside it — layout, loading, error, not-found
    dev/               galleries: tokens, data, primitives, primitives/data, rows
    globals.css        the role tokens, the shadcn aliases, @theme — the only file with literals
  components/
    ui/                shadcn's, 15 of them. Never forked. Add with `pnpm dlx shadcn@latest add`
    console/           ours, 77 compositions on top of ui/
    shell/             masthead, scope rail, ⌘K palette, scope resolution
  features/            one directory per scope; the panels the tab registry mounts
  lib/
    api/               typed client, endpoints/, query keys, error-message mapping
    auth/              the better-auth react client
    design/            status maps, chart tone vs series slot, the lucide map, contrast
    realtime/ forms/ format/ settings/ shell/
  proxy.ts             the optimistic session gate (see above)
```

## The data layer

**Typed `fetch` + TanStack Query on the client, and `better-auth/react` for session and Organization state — deliberately not RSC or server actions.** This app is mutation-, tab- and stream-heavy: a screen that follows a build log, holds six tabs and invalidates half a cache on a mutation is not what server components are good at. Switching Organization re-keys the cache to the new tenant.

Two traps the client already handles, both worth knowing before you add an endpoint:

- **A refusal is not an empty list.** A 403 leaves `data` undefined, and so does a disabled query — rendering "nothing is connected" for either is a confident claim about someone's setup made because a request failed. Those states are distinct, and only one of them blames the operator.
- **A Nest route typed `Promise<string>` answers `text/plain`.** `api.post` would JSON-parse it, fail, and hand back `undefined`. Use `postText` / `getText`.

## The shell's two signatures

**The rail is a scope, not a menu.** Entering a Server, Project, Environment or service *replaces* the whole rail with that resource's navigation, drops a "Back to …" pill above it, and rewrites the masthead to that resource's identity. Seven scopes, each with its own nav table. **Second: ⌘K with typed prefixes** (`srv:` `svc:` `env:` `dep:`) filtering real data. Everything else stays quiet around those two.

Routes are **flat** — `/environments/<id>`, `/applications/<id>` — because every endpoint takes one id and no parent, and a URL carrying a parent id can disagree with the data it renders. The reasoning is in `src/components/shell/scope.ts`.

`src/lib/shell/tab-registry.ts` and `src/lib/shell/tabs/*` are the seam: each scope declares its tabs *and* the lazily imported panel that fills each one, so the nav tables are derived rather than restated and one line is the whole cost of a new screen.

## Tokens

**No hardcoded design values** — no raw hex, no `rgb()`, no px font sizes, no off-scale spacing. `globals.css` holds every literal; if a value you need is missing, add a *token* there, not a literal in the component. Tokens are **roles**, not colours: `--panel`, `--tx-2`, `--brand-hi`, `--ok`. Two pairs it is easy to get wrong — `--tx-4` is decoration and never carries meaning, and `--chart-*` (status) must not be swapped with `--series-*` (identity).

`/dev/tokens` measures its own contrast claims live and re-measures them when you switch theme, so the accessibility contract is checkable rather than asserted. Note that `src/lib/utils.ts` is an `extendTailwindMerge`, not a bare `cn()`: tailwind-merge would otherwise classify our named type scale as colours and silently drop classes. A phase that adds a token adds its name there.

## Tests

`pnpm test` is Vitest, and it is **9 tests in 2 files** — `src/**/*.test.ts(x)`, co-located with what they cover. Note the naming: `*-spec.ts` in this tree is already taken, for the declarative form and resource specs, so a test is `*.test.ts`.

**That number is honest about what unit tests gate here, which is very little.** This workspace was verified by driving it: a live backend, real seeded data, every control clicked, every screen at 1440px and 380px in light and dark, zero console errors, focus visible on every focusable, the page body never scrolling sideways, and no `undefined` / `NaN` / `[object Object]` reaching the screen. Nearly every defect the phase notes record was found that way and could not have been found by a unit test — a clipped popup, a hydration mismatch on a relative timestamp, a password serialised into the query string by a form with no `method`, an indeterminate checkbox drawing a tick. The two suites that do exist cover pure logic worth pinning: the palette's key handling and the monitoring unit conversions.

So `tsc --noEmit` and `eslint` are the cheap gates, a clean `next build` is the next one, and a browser is the real one. The per-phase records of what was driven and what it turned up are in git history at `c8e9bdfb`, under `.project/frontend-phases/`.
