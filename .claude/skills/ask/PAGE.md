# An answer as an HTML page

A page is for answers with a shape: a flow, layers, a state machine, many parts. Its layout *is* that shape, so the answer can be read at a glance. There is no fixed page template: design each page for the one answer it carries.

## Where it goes

Write one file, named for the question (`how-maintenance-refuses-a-deploy.html`), to the session's scratchpad directory if it has one, otherwise a temporary directory (`mktemp -d`). Never inside the repo: these pages describe the code as it is today and would go stale in the tree.

Then show it:

- if you have a tool that sends a file to the user (`SendUserFile`), send it with `display: "render"` so it opens in the output panel;
- otherwise open it in the browser (`open <file>` on macOS, `xdg-open <file>` on Linux) and print its absolute path.

Publish it as a claude.ai artifact (a private link) only when the person asks to share or keep it.

## Design it for the answer

Before writing any HTML, name the answer's shape in one word, then build the layout that draws it. Pick from these, or combine two when the answer truly has both:

| The answer's shape | Draw it as |
|---|---|
| A flow, a request's path, "step by step" | A numbered vertical sequence of steps joined by arrows; a fork (refused / allowed) splits into two columns |
| Several actors handing off (console → API → queue → Server) | Swim lanes: one column per actor, each step placed in its actor's lane |
| Layers or "what sits on what" | Stacked bands, top to bottom, each naming what it owns |
| A state machine, a lifecycle | State boxes with labelled transitions between them; the terminal states marked with status colour |
| Parts of a whole, "what is in X" | A grid of cards, grouped under short headings |
| A comparison or options | A matrix: options as columns, criteria as rows, the deciding cell highlighted |
| A history or ordering in time | A timeline with dated points |
| A verdict with a few reasons | One verdict card (yes / no / partly, in status colour) and its reasons beneath |

Size the page to the answer. A four-step flow is four steps and nothing else; do not add sections the answer has no content for (no empty "Background", "Summary" or "Notes" headings, no repeated intro). If a part of the page restates another, remove it.

## What it contains

- **The answer first**, at the top, in the same one or two sentences as the chat.
- **The picture**, drawn with HTML and CSS (or inline SVG for arrows between boxes that do not sit in a line). No image files and no charting library. Labels on the picture are a few words, not sentences.
- **Detail stays folded.** Each part opens, with `<details>`/`<summary>` or a click that shows a panel, for a sentence or two in plain words, the file (`backend/src/servers/server-maintenance.ts:31`), and the ADR or glossary term behind it. Closed, the page shows only the shape and the labels.
- **Facts and opinion apart**: a recommendation sits in its own labelled box, short.
- **What was not checked**, if anything, in one line at the bottom.

## How it is built

One self-contained file: styles in a `<style>` tag, any script in a `<script>` tag, no external requests (no CDN, no fonts, no images), so it opens offline and works anywhere. It reads well at 380px and at 1440px, and in light and dark.

It uses the console's own look (`frontend/docs/design-system.md`), so it reads as Cloudgate, not as a random web page. Start from these tokens, taken from `frontend/src/app/globals.css`:

```css
:root {
  --ground: oklch(0.9875 0 0); --panel: #fff; --raise: oklch(0.965 0 0);
  --line: oklch(0.922 0 0); --tx: oklch(0.205 0 0); --tx-2: oklch(0.44 0 0); --tx-3: oklch(0.49 0 0);
  --brand: oklch(0.53 0.2 285); --brand-tint: oklch(0.968 0.017 285); --brand-line: oklch(0.86 0.06 285);
  --ok: oklch(0.47 0.13 155); --ok-tint: oklch(0.965 0.03 155);
  --warn: oklch(0.51 0.12 68); --warn-tint: oklch(0.968 0.045 78);
  --bad: oklch(0.52 0.2 27); --bad-tint: oklch(0.968 0.028 27);
  --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --ground: oklch(0.178 0 0); --panel: oklch(0.216 0 0); --raise: oklch(0.275 0 0);
    --line: oklch(0.302 0 0); --tx: oklch(0.97 0 0); --tx-2: oklch(0.775 0 0); --tx-3: oklch(0.695 0 0);
    --brand: oklch(0.555 0.2 285); --brand-tint: oklch(0.28 0.06 285); --brand-line: oklch(0.42 0.11 285);
    --ok: oklch(0.79 0.15 158); --ok-tint: oklch(0.27 0.05 158);
    --warn: oklch(0.83 0.14 80); --warn-tint: oklch(0.28 0.05 78);
    --bad: oklch(0.72 0.18 25); --bad-tint: oklch(0.29 0.07 25);
  }
}
body { background: var(--ground); color: var(--tx); font: 15px/1.55 var(--sans); }
code { font-family: var(--mono); }
```

The tokens stay fixed; the layout changes with the answer. Keep it restrained, as the console is: one accent (`--brand`), status colours only for status (`--ok`, `--warn`, `--bad`), sentence case, no decoration, and motion only where it helps follow a step.
