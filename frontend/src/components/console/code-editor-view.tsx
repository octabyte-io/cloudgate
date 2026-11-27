import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { yaml } from "@codemirror/lang-yaml";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import {
  Compartment,
  EditorState,
  RangeSetBuilder,
  type Extension,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  lineNumbers,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { useEffect, useId, useRef, useSyncExternalStore } from "react";

import { createLocalStore } from "@/components/shell/local-store";
import { Switch } from "@/components/ui/switch";

import { hangColumns } from "@/lib/format/hang";
import { cn } from "@/lib/utils";

/**
 * The CodeMirror half of `CodeEditor`. **Import `code-editor.tsx`, not this** —
 * that one wraps this in `next/dynamic` so the editor is its own chunk.
 *
 * ## Why CodeMirror 6
 *
 * A `<textarea>` is what F10's patch editor uses and it is genuinely fine for a
 * short file you are pasting into. A compose file is not that: it is the *whole*
 * definition of a stack, it is where indentation is load-bearing, and it is the
 * screen the operator works in rather than a field they fill in. CodeMirror 6 is
 * the smallest thing that gives real editing (undo history, a line gutter,
 * bracket-aware selection) plus a YAML parser, it is modular enough that this file
 * imports six small packages rather than an IDE, and it needs no worker.
 *
 * **F10's patch editor and F16's Traefik config editor should use this**, which is
 * why it lives here rather than in `features/compose/`. F12 did not retro-fit
 * F10's — that file is a shipped screen with a shipped diff beside it, and the
 * phase brief asks for the choice to be *recorded*, not for six tabs to be
 * reopened.
 *
 * ## The theme is our tokens, and deliberately quiet
 *
 * Four roles, and no new tokens, because the well already has a measured set and
 * a fifth hue on a near-black surface is a decision to make on purpose:
 *
 * | Token | Contrast | What it paints |
 * |---|---|---|
 * | `--well-hl` | 9.32:1 | a **key** — the structure of the line, which is what the log well uses this tone for |
 * | `--well-tx` | 13.69:1 | a **value**, plain, because the value is the content |
 * | `--well-ts` | 4.66:1 | a **comment**, quiet but still text-contrast |
 * | `--well-tx` at 62% | 8.89:1 | punctuation, anchors and aliases |
 *
 * **No status hue is borrowed.** `--well-ok` / `-warn` / `-bad` mean *how
 * something is doing* everywhere else in the app, and a highlighter that paints a
 * string green would make the same colour mean "fine" in a log and "string" one
 * card above it. Two hues and two greys is enough to read YAML: keys separate from
 * values, comments out of the way.
 *
 * ## Long lines: an editor scrolls, a view wraps
 *
 * **An editable file does not wrap by default**, and is the one place in the
 * console that scrolls sideways on purpose. In a file being written, a wrapped
 * line makes YAML indentation harder to read at a glance, and a parser's
 * "line 12, column 80" stops matching what is on screen. So the box keeps its
 * own horizontal scroll, and a **Wrap lines** switch under it turns wrapping on
 * for the rare long image reference. The choice is this browser's, kept in
 * `localStorage` for every editor, because it is a reading preference and not
 * a property of any one file.
 *
 * **A read-only view always wraps** (no `onChange`): nothing is being typed,
 * columns are not being counted, and nothing in a page someone only reads
 * should hide behind a scrollbar (the Compose file overflowed by 370px at 375).
 * Wrapping is `EditorView.lineWrapping` plus `HANGING_INDENT` below: a wrapped
 * line keeps one line number and its continuation rows sit at its own
 * indentation, so the wrap never changes what the YAML appears to nest under.
 */
export function CodeEditorView({
  value,
  onChange,
  label,
  className,
}: {
  value: string;
  /** Omit for a read-only view. */
  onChange?: (next: string) => void;
  /** What this file is — the editor is one control and needs a name. */
  label: string;
  className?: string;
}) {
  const host = useRef<HTMLDivElement | null>(null);
  const view = useRef<EditorView | null>(null);
  /**
   * The callback, in a ref.
   *
   * A CodeMirror extension list is baked into the state at construction, so an
   * `onChange` in the dependency array would tear the editor down and rebuild it
   * every time the parent re-rendered — losing the selection, the scroll position
   * and the undo history on every keystroke, because every keystroke re-renders
   * the parent.
   */
  const latest = useRef(onChange);
  // Synced in an effect rather than assigned during render, which this project's
  // lint rules refuse outright and React's own docs warn about. An effect is
  // early enough: the only reader is CodeMirror's update listener, which cannot
  // fire before the editor has mounted.
  useEffect(() => {
    latest.current = onChange;
  }, [onChange]);

  const editable = onChange !== undefined;
  const wrapPreferred = useSyncExternalStore(
    WRAP_LINES.subscribe,
    WRAP_LINES.get,
    () => false,
  );
  const wrap = !editable || wrapPreferred;
  const wrapping = useRef(new Compartment());
  const switchId = useId();

  useEffect(() => {
    const parent = host.current;
    if (!parent) return;

    const instance = new EditorView({
      parent,
      state: EditorState.create({
        doc: value,
        extensions: extensions({ editable, label, wrap }),
      }),
    });
    view.current = instance;

    return () => {
      instance.destroy();
      view.current = null;
    };
    // `value` is deliberately not a dependency — the effect below reconciles it
    // into the live document instead of rebuilding the editor around it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editable, label]);

  /** The switch, applied to the live editor without rebuilding it. */
  useEffect(() => {
    view.current?.dispatch({
      effects: wrapping.current.reconfigure(wrap ? WRAPPED : []),
    });
  }, [wrap]);

  /**
   * An external change to `value` — a refetch landing, a Reset — replaced into
   * the document, and **only when it genuinely differs**. Without the comparison
   * this would fire on every keystroke (the parent holds the draft, so `value` is
   * what we just typed) and replacing the whole document moves the caret to the
   * end of it.
   */
  useEffect(() => {
    const instance = view.current;
    if (!instance) return;
    const current = instance.state.doc.toString();
    if (current === value) return;
    instance.dispatch({
      changes: { from: 0, to: current.length, insert: value },
    });
  }, [value]);

  /**
   * **The focus ring is on this box, not on the editable inside it.**
   *
   * CodeMirror puts focus on `.cm-content`, which lives *inside* the scroller — so
   * the base layer's `:focus-visible` outline was drawn around the whole document
   * (content height, not box height), clipped by `overflow: auto`, and scrolled
   * away with the text. The theme below turns that one off and `:has()` puts the
   * same ring, from the same token, around the control a person sees.
   */
  return (
    <div
      className={cn(
        "flex flex-col overflow-hidden rounded-lg border border-line bg-well",
        "has-[.cm-content:focus-visible]:outline-2 has-[.cm-content:focus-visible]:outline-offset-2 has-[.cm-content:focus-visible]:outline-brand-ring",
        className,
      )}
    >
      <div ref={host} className="min-h-0 min-w-0 flex-1" />
      {editable ? (
        <div className="flex items-center justify-end gap-2 border-t border-line/40 px-3 py-1.5">
          <label htmlFor={switchId} className="text-meta text-well-ts">
            Wrap lines
          </label>
          <Switch
            id={switchId}
            size="sm"
            checked={wrapPreferred}
            onCheckedChange={(next) => WRAP_LINES.set(next)}
          />
        </div>
      ) : null}
    </div>
  );

  function extensions(options: {
    editable: boolean;
    label: string;
    wrap: boolean;
  }): Extension[] {
    return [
      lineNumbers(),
      yaml(),
      syntaxHighlighting(YAML_HIGHLIGHT),
      history(),
      // Off in an editor until its switch says so, always on in a view — see
      // "Long lines" above.
      wrapping.current.of(options.wrap ? WRAPPED : []),
      // `defaultKeymap` and `historyKeymap` only. **Not `indentWithTab`**: it
      // binds Tab inside the editor, which takes away the one key a keyboard user
      // has for leaving a control. Two spaces typed is a smaller cost than a
      // focus trap in the middle of a form.
      keymap.of([...defaultKeymap, ...historyKeymap]),
      EditorView.editable.of(options.editable),
      EditorState.readOnly.of(!options.editable),
      EditorView.contentAttributes.of({
        "aria-label": options.label,
        spellcheck: "false",
        autocapitalize: "off",
      }),
      CONSOLE_THEME,
      EditorView.updateListener.of((update) => {
        if (update.docChanged) latest.current?.(update.state.doc.toString());
      }),
    ];
  }
}

/**
 * Every value here is a token reference. The height is
 * `--code-editor-h`, defaulting to `--spacing-log` — the same 340px a log well
 * takes before it scrolls inside itself, because an editor and a log are the same
 * kind of box on this screen and two different heights would look like an
 * accident. A caller that needs another one sets the variable
 * (`[--code-editor-h:var(--spacing-modal-h)]`).
 */
const CONSOLE_THEME = EditorView.theme({
  "&": {
    backgroundColor: "var(--well)",
    color: "var(--well-tx)",
    fontSize: "var(--text-meta)",
  },
  ".cm-scroller": {
    fontFamily: "var(--font-mono)",
    lineHeight: "var(--leading-log)",
    maxHeight: "var(--code-editor-h, var(--spacing-log))",
    overflow: "auto",
    // `--spacing` is Tailwind's own scale root — every `p-3` in the app compiles
    // to this same calc, so this is the scale and not a literal beside it.
    paddingBlock: "calc(var(--spacing) * 3)",
  },
  ".cm-content": { caretColor: "var(--well-tx)" },
  // CodeMirror's own line padding is `0 2px 0 6px`; the left side gains the
  // line's `--hang` and gives it back as a negative indent, so a wrapped line's
  // first row is where it always was and its continuation rows sit at its
  // indentation. CodeMirror reads `text-indent` when it measures, so the caret
  // and selection land where the text is.
  ".cm-line": {
    paddingLeft: "calc(6px + var(--hang, 0ch))",
    textIndent: "calc(var(--hang, 0ch) * -1)",
  },
  // See the note on the wrapper: the base layer's ring is moved off the
  // contenteditable and onto the box, because this one is inside a scroller.
  ".cm-content:focus-visible": { outline: "none" },
  "&.cm-focused .cm-cursor": { borderLeftColor: "var(--well-tx)" },
  // A selection tint mixed **against the well**, not `--brand-tint`: that token is
  // stepped against `--panel`, so in light mode it is near-white and near-white
  // text on it would disappear the moment anyone selected a line.
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, .cm-content ::selection":
    { backgroundColor: "color-mix(in oklch, var(--well-hl) 28%, transparent)" },
  ".cm-gutters": {
    backgroundColor: "var(--well)",
    color: "var(--well-ts)",
    border: "none",
    borderRight: "1px solid color-mix(in oklch, var(--line) 40%, transparent)",
    fontVariantNumeric: "tabular-nums",
  },
  ".cm-lineNumbers .cm-gutterElement": {
    padding: "0 calc(var(--spacing) * 2.5)",
  },
  ".cm-activeLine": { backgroundColor: "transparent" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--well-tx)" },
});

const YAML_HIGHLIGHT = HighlightStyle.define([
  { tag: tags.comment, color: "var(--well-ts)", fontStyle: "italic" },
  // A YAML key arrives as `propertyName`; `atom` covers the bare words at the
  // head of a block in some shapes, and `tagName` the `!!type` annotations.
  { tag: [tags.propertyName, tags.tagName], color: "var(--well-hl)" },
  { tag: [tags.string, tags.number, tags.bool, tags.null], color: "var(--well-tx)" },
  {
    tag: [tags.punctuation, tags.separator, tags.operator, tags.meta],
    color: "color-mix(in oklch, var(--well-tx) 62%, transparent)",
  },
]);

/**
 * **Wrapped lines hang at their own indentation.**
 *
 * `EditorView.lineWrapping` alone sends a long line's continuation back to the
 * left edge, which in YAML — where indentation *is* the structure — makes a
 * wrapped value look like a new key at the top level. This sets `--hang` (the
 * line's leading whitespace, in `ch`) on every visible line, and the theme turns
 * it into padding plus an equal negative `text-indent`. Line numbers stay one
 * per logical line: the gutter follows the line block, not its rows.
 *
 * Only the viewport is decorated, so a long file costs what is on screen.
 */
const HANGING_INDENT = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = hangDecorations(view);
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = hangDecorations(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

function hangDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const tabSize = view.state.tabSize;
  // Two visible ranges can meet inside one line; a line is decorated once.
  let last = -1;
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to; ) {
      const line = view.state.doc.lineAt(pos);
      const columns = hangColumns(line.text, tabSize);
      if (columns > 0 && line.from > last) {
        last = line.from;
        builder.add(
          line.from,
          line.from,
          Decoration.line({ attributes: { style: `--hang: ${columns}ch` } }),
        );
      }
      pos = line.to + 1;
    }
  }
  return builder.finish();
}

/** Wrapping, as one unit the switch turns on and off. */
const WRAPPED: Extension = [EditorView.lineWrapping, HANGING_INDENT];

/** Whether this browser's editors wrap long lines. Off until someone turns it on. */
const WRAP_LINES = createLocalStore<boolean>(
  "cloudgate.editor.wrapLines",
  false,
  (value) => (typeof value === "boolean" ? value : null),
);
