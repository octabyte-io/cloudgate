"use client";

import { useEffect, useRef, useState } from "react";

import { Card } from "@/components/console/card";
import { Chip } from "@/components/console/chip";
import { CodeEditor } from "@/components/console/code-editor";
import { MetaStrip } from "@/components/console/meta-strip";
import { Button } from "@/components/ui/button";
import { yamlProblem } from "@/features/compose/editor/yaml-check";
import { Icon } from "@/lib/design/icons";
import { cn } from "@/lib/utils";

import { COMPOSE_FILE, STACK_NAME } from "./fixtures";
import { DialogEditor, FullScreenEditor } from "./overlays";

export type Variant = "a" | "b" | "c";

/** What every variant shares: the file, the edit, and the two buttons that act on it. */
export type Draft = {
  value: string;
  set: (next: string) => void;
  changed: boolean;
  discard: () => void;
  save: () => void;
};

function useDraft(): Draft {
  const [stored, setStored] = useState(COMPOSE_FILE);
  // Seeded with one edit, so every screenshot shows the unsaved state the
  // operator is in when they reach for more room.
  const [edit, setEdit] = useState<string | null>(
    COMPOSE_FILE.replace("LOG_LEVEL:-info", "LOG_LEVEL:-debug"),
  );
  const value = edit ?? stored;
  return {
    value,
    set: setEdit,
    changed: value !== stored,
    discard: () => setEdit(null),
    save: () => {
      setStored(value);
      setEdit(null);
    },
  };
}

/** The line under a full-height editor: whether the file parses, and its size. */
export function FileStatus({ draft, hint }: { draft: Draft; hint?: React.ReactNode }) {
  const problem = yamlProblem(draft.value);
  const lines = draft.value.split("\n").length;
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-meta text-tx-3">
      {problem ? (
        <span className="text-bad">
          Not valid YAML{problem.line ? ` (line ${problem.line})` : ""}
        </span>
      ) : (
        <span className="inline-flex items-center gap-1.25 text-tx-2">
          <Icon name="check" size={13} /> Valid YAML
        </span>
      )}
      <span>{lines} lines</span>
      {hint ? <span className="max-sm:hidden">{hint}</span> : null}
    </p>
  );
}

export function SaveButtons({ draft, size }: { draft: Draft; size?: "sm" }) {
  return (
    <>
      <Button type="button" size={size} disabled={!draft.changed} onClick={draft.discard}>
        Discard changes
      </Button>
      <Button
        type="button"
        variant="pri"
        size={size}
        disabled={!draft.changed}
        onClick={draft.save}
      >
        Save the file
      </Button>
    </>
  );
}

/**
 * The Compose file card as the Overview tab has it, with the one new control:
 * a button in the header that gives the editor the height of the screen.
 */
export function FileCard({ variant, startOpen }: { variant: Variant; startOpen: boolean }) {
  const draft = useDraft();
  const [open, setOpen] = useState(startOpen);
  const card = useRef<HTMLElement | null>(null);
  const grown = variant === "c" && open;

  useEffect(() => {
    if (grown) card.current?.scrollIntoView({ block: "start" });
  }, [grown]);

  const opener =
    variant === "c" ? (
      <Button type="button" size="sm" onClick={() => setOpen(!open)} aria-pressed={open}>
        <Icon name={open ? "restore" : "maximise"} size={14} />
        {open ? "Normal height" : "Full height"}
      </Button>
    ) : (
      <Button type="button" size="sm" onClick={() => setOpen(true)}>
        <Icon name="maximise" size={14} />
        {variant === "a" ? "Expand" : "Full screen"}
      </Button>
    );

  return (
    <>
      <Card ref={card} className={cn(grown && "scroll-mt-4")}>
        <Card.Header
          title="Compose file"
          sub="Stored in Cloudgate. Written to the deploy target on every Deployment."
          headingLevel={2}
          actions={
            grown ? (
              <>
                {draft.changed ? <Chip variant="warn">Unsaved changes</Chip> : null}
                <SaveButtons draft={draft} size="sm" />
                {opener}
              </>
            ) : (
              opener
            )
          }
        />
        {draft.changed && !grown ? (
          <MetaStrip>
            <strong>Unsaved changes.</strong> Nothing is applied until this is saved
            and the stack is deployed.
          </MetaStrip>
        ) : null}
        <Card.Body className="flex flex-col gap-3">
          <CodeEditor
            label={`The compose file for ${STACK_NAME}`}
            value={draft.value}
            onChange={draft.set}
            className={cn(grown && "[--code-editor-h:var(--spacing-frame)]")}
          />
          {grown ? (
            // Grown, Save moves up into the header beside Normal height, so the
            // header, the file and nothing else fit the screen's height.
            <FileStatus draft={draft} />
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <SaveButtons draft={draft} />
              <span className="ml-auto">
                <Chip>Docker Compose</Chip>
              </span>
            </div>
          )}
        </Card.Body>
      </Card>

      {variant === "a" ? (
        <DialogEditor open={open} onOpenChange={setOpen} draft={draft} />
      ) : null}
      {variant === "b" ? (
        <FullScreenEditor open={open} onOpenChange={setOpen} draft={draft} />
      ) : null}
    </>
  );
}
