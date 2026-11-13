# CLAUDE.md

Cloudgate is a self-hosted deployment platform: a NestJS backend (`backend/`), a Next.js console
(`frontend/`) and a CLI (`cli/`), in one pnpm workspace. `README.md` has setup and commands.

## Read before changing code

- **`CONTEXT.md`**: the glossary. Use its terms in code, UI copy, tests and issues; it lists the
  words to avoid.
- **`docs/adr/`**: the decisions and why. Read the ones that touch the area you're changing. If your
  change contradicts one, say so explicitly instead of silently overriding it.
- **`CODING_STANDARDS.md`**: the conventions a review checks.
- **`frontend/AGENTS.md`**: this Next.js version differs from what you know; read its docs first.

## Design work

`frontend/docs/design-system.md` wins over any design skill. Its tokens, components, copy rules
and the "console" direction are fixed. A skill refines work inside that system; it never picks a new
palette, font or aesthetic. The console is an *Operate* surface: precision and restraint, not flair.

| The work | Use |
| --- | --- |
| Building or changing a page or component | `frontend-design` (plugin), then the design-system index |
| Exploring several UI directions | `/planning` (its `PROTOTYPE.md`: variants on `/dev/prototype/<feature>`) |

## Running tests

Run the test files your change touches, not the whole suite. A full e2e run takes about 24 minutes
on a 4-core machine and peaks around 9 GB; CI runs it on every push, split eight ways. A machine-wide
lock hands out one slot per worker, so runs of a file or two go at once and a full run waits for them.

- A single red suite in a full run is usually flakiness: re-run it alone before treating it as your
  regression. A `ran out of memory` failure is a resource problem, not a red test.
- A stalled run fails itself with exit code **124**. Wait for the exit code instead of watching the
  log, and re-run a stalled suite alone.

Details, lanes and commands: `docs/testing.md`.

## How work moves

Four skills in `.claude/skills/`:

- **`/planning`**: a rough idea → an approved `spec` issue and its tickets, asking you every decision.
- **`/build`**: a spec's tickets → tested commits on `main`, then the issues closed.
- **`/fix`**: a bug → a failing test, the fix, and the issue closed.
- **`/ask`**: a question about the code, answered plainly; it only reads.

The labels they use are listed in `CONTRIBUTING.md`.
