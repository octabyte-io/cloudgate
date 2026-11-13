# Prototypes inside `/planning`

A prototype answers one open question by giving the user something to react to. It is a question in the SKILL.md sense: you build it, show it, recommend a reading, and wait for the user's answer.

Pick the shape from the question:

- **"How should this look?"**: a UI prototype, below.
- **"Does this flow or state model make sense?"**: a logic prototype, below.

## UI prototype: a real page from real components

Build it at `frontend/src/app/dev/prototype/<feature>/page.tsx`, beside the existing `/dev` galleries. It inherits what they guarantee: served only under `next dev`, open without signing in, and held by `src/app/dev/dev-pages-write-nothing.test.ts` to never write to the backend. Keep that test green; a prototype reads, it never creates.

Read `frontend/AGENTS.md` and `frontend/docs/design-system.md` first. The prototype uses the design system's components and tokens as they are; a variant that needs a new colour, font or primitive is out of bounds.

**Data without a backend.** Give the page its own React Query client, seed it with fixture data under the same keys the real screens use (`frontend/src/lib/api/keys.ts`), and set `staleTime: Infinity` so nothing refetches. Existing feature screens then render exactly as in production, with no server and no login. If a screen reads the session or the active Organization, seed those keys too. Only the new part of the feature is new code; everything around it is the real screen.

**Variants side by side.** While the layout is still open, put two or three structurally different variants (different layout, hierarchy or primary action, not different colours) on one page as A, B, C tabs.

**Show it.** Run `next dev`, take screenshots of each variant in light and dark, at 1440px and 380px wide, and show them to the user with the page's URL and your recommended variant and why. In a large feature, attach the screenshots to the `question` issue as well.

The one limit: a screen fed by a live socket (logs, metrics) shows a static snapshot.

**After the user picks.** Record the verdict on the spec (or the question). The winning variant's new components are where `/build` starts, so keep them; the spec's tickets include deleting the `/dev/prototype/<feature>` page when the feature lands.

## Logic prototype: real code, example inputs

A small test or script that runs the real code, or the proposed function or state shape, through the cases that are hard to reason about on paper: the happy path, the awkward edge case, and something that should be refused. Print the state after each step, in domain words.

Put it beside the code it explores, named so it is obviously a prototype. Show the user the cases and what each printed, with your reading, and wait. A state shape or reducer the user accepts may go into the spec as the one allowed snippet; the script itself is deleted once the spec is published.
