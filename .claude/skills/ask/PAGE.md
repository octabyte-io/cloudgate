# An answer as an HTML page

A page is for answers with a shape: a flow, layers, a state machine, many parts. It shows that shape so it can be understood at a glance, and lets the reader open each part for the detail.

## Where it goes

Write one file, named for the question (`how-maintenance-refuses-a-deploy.html`), to the session's scratchpad directory if it has one, otherwise a temporary directory (`mktemp -d`). Never inside the repo: these pages describe the code as it is today and would go stale in the tree.

Then show it:

- if you have a tool that sends a file to the user (`SendUserFile`), send it with `display: "render"` so it opens in the output panel;
- otherwise open it in the browser (`open <file>` on macOS, `xdg-open <file>` on Linux) and print its absolute path.

Publish it as a claude.ai artifact (a private link) only when the person asks to share or keep it.

## What it contains

- **The answer first**, at the top, in the same one or two sentences as the chat.
- **The picture**: the flow or structure drawn with HTML and CSS (boxes and arrows, a stepped list, columns for layers). No image files and no charting library.
- **Each part opens for its detail**, with `<details>`/`<summary>` or a click that shows a panel: what it does in plain words, the file and line (`backend/src/servers/server-maintenance.ts:31`), and the ADR or glossary term behind it.
- **Facts and opinion apart**, as in the chat: a recommendation sits in its own labelled box.
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

Keep it restrained, as the console is: one accent (`--brand`), status colours only for status (`--ok`, `--warn`, `--bad`), sentence case, no decoration, and motion only where it helps follow a step.
