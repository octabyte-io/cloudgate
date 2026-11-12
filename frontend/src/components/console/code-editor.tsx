import dynamic from "next/dynamic";

import { Skeleton } from "./skeleton";

/**
 * A file, edited. Mono, numbered, YAML-aware, on the same near-black well a log
 * and a `CodeWell` use.
 *
 * **The editor is a separate chunk, and this file is why.** CodeMirror plus a YAML
 * parser has no business in the console's shell bundle — most screens have no
 * editor on them — so the one export here is a `next/dynamic` boundary and every
 * caller gets the split for free rather than having to remember it.
 * `ssr: false` because CodeMirror wants a DOM at construction; the fallback holds
 * the box's height so nothing moves when the real editor lands.
 *
 * The component itself, the theme and the reasoning about tokens and the focus
 * ring are in `code-editor-view.tsx`. **This is the one editor** — F10's patch
 * editor and F16's Traefik config editor should come here rather than each
 * choosing again.
 */
export const CodeEditor = dynamic(
  () => import("./code-editor-view").then((module) => module.CodeEditorView),
  {
    ssr: false,
    // `Skeleton` is `aria-hidden` by design, so the wait is announced by the
    // `aria-busy` on the card around it rather than by a label on a grey box.
    loading: () => <Skeleton className="h-log w-full rounded-lg" />,
  },
);
