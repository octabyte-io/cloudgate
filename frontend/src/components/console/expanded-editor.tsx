"use client";

import type { ReactNode } from "react";

import { Chip } from "@/components/console/chip";
import { CodeEditor } from "@/components/console/code-editor";
import { containTab } from "@/components/console/modal";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Icon } from "@/lib/design/icons";
import { cn } from "@/lib/utils";

/**
 * The box the file fills: everything between the top bar and the status line.
 * For the code editor, the scroller's cap is lifted (`--code-editor-h`, no new
 * token) and CodeMirror's own root takes the host's height, so the well reaches
 * the bottom even when the file is short.
 */
const FILL = "min-h-0 flex-1 rounded-none border-0";

/**
 * The button that opens an `ExpandedEditor`: `maximise`, the Dock's half of
 * the pair Back to page's `restore` closes. `name` is the file it expands, for
 * a form holding two (a certificate and its private key).
 */
export function ExpandButton({
  name,
  size = "xs",
  onClick,
}: {
  name: string;
  size?: "xs" | "sm";
  onClick: () => void;
}) {
  return (
    <Button type="button" size={size} aria-label={`Expand ${name}`} onClick={onClick}>
      <Icon name="maximise" size={14} />
      Expand
    </Button>
  );
}

/**
 * A file editor given the whole browser window (spec #118, the prototype's
 * variant B): a top bar with the file's name, where it belongs, "Unsaved
 * changes" and the caller's own Discard and Save; the file edge to edge; and a
 * status line under it.
 *
 * **The draft stays with the caller.** This holds no copy of the file, so
 * closing it — Esc, even with the cursor in the editor, or Back to page — keeps
 * the edit in the card it was opened from, and nothing is asked. The buttons
 * are the caller's for the same reason: the card already knows when its Save is
 * off and why, and a second Save here could disagree with it.
 *
 * It is Base UI's dialog, so it stacks over a dialog the editor already sits in.
 */
export function ExpandedEditor({
  open,
  onOpenChange,
  kind = "code",
  title,
  context,
  label,
  value,
  onChange,
  changed,
  actions,
  status,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `code` renders `CodeEditor`; `text` the console's `Textarea`. */
  kind?: "code" | "text";
  /** The file's name, as its card titles it. */
  title: string;
  /** Where the file belongs: the stack, the Environment. One line. */
  context: string;
  /** The editor's accessible name, the same one the card's editor has. */
  label: string;
  value: string;
  onChange: (next: string) => void;
  /** Whether the draft differs from what is saved. */
  changed: boolean;
  /** The caller's own Discard and Save. */
  actions: ReactNode;
  /** What the caller knows about the draft, such as whether its YAML parses. */
  status?: ReactNode;
}) {
  // As the code editor's gutter numbers them: the empty line after a final
  // newline is a line the caret can stand on.
  const lines = value.split("\n").length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        onKeyDown={containTab}
        className="inset-0 top-0 left-0 flex h-dvh w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none bg-ground p-0 text-tx ring-0 sm:max-w-none"
      >
        <div className="flex flex-wrap items-center gap-2.5 border-b border-line bg-panel px-3 py-2.5 sm:px-4">
          <Button
            type="button"
            size="sm"
            variant="qt"
            title="Back to page (Esc)"
            onClick={() => onOpenChange(false)}
          >
            <Icon name="restore" size={14} />
            Back to page
          </Button>
          <div className="min-w-0 grow basis-40">
            <DialogTitle className="text-body font-semibold text-tx">{title}</DialogTitle>
            <p className="truncate text-meta text-tx-3">{context}</p>
          </div>
          {changed ? <Chip variant="warn">Unsaved changes</Chip> : null}
          <div className="flex items-center gap-2 max-sm:w-full max-sm:justify-end">
            {actions}
          </div>
        </div>
        {kind === "code" ? (
          <CodeEditor
            label={label}
            value={value}
            onChange={onChange}
            className={cn(FILL, "[--code-editor-h:100%] [&_.cm-editor]:h-full")}
          />
        ) : (
          <Textarea
            aria-label={label}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            spellCheck={false}
            className={cn(
              FILL,
              "resize-none field-sizing-fixed font-mono shadow-none focus-visible:ring-inset",
            )}
          />
        )}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line bg-panel px-4 py-2 text-meta text-tx-3">
          {status}
          <span>{lines} lines</span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
