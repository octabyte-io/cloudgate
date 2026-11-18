"use client";

import { Chip } from "@/components/console/chip";
import { CodeEditor } from "@/components/console/code-editor";
import { Modal, containTab } from "@/components/console/modal";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Icon } from "@/lib/design/icons";

import { FileStatus, SaveButtons, type Draft } from "./file-card";
import { STACK_NAME } from "./fixtures";

/**
 * The editor fills whatever box it is put in: the scroller's cap is lifted and
 * CodeMirror's own root takes the host's height, so the well's background
 * reaches the bottom even when the file is short.
 */
const FILL = "min-h-0 flex-1 [--code-editor-h:100%] [&_.cm-editor]:h-full";

type OverlayProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  draft: Draft;
};

/**
 * **A · Dialog.** The console's own `Modal`, stretched to the screen's height
 * with a 16px margin all round, over the dialog's blurred backdrop. The page is
 * still there behind it, so closing it lands you where you were.
 */
export function DialogEditor({ open, onOpenChange, draft }: OverlayProps) {
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      className="top-4 bottom-4 flex max-h-none flex-col overflow-hidden sm:max-w-6xl"
    >
      <Modal.Header
        title="Compose file"
        description={`${STACK_NAME} · Stored in Cloudgate. Written to the deploy target on every Deployment.`}
      />
      <div className="flex min-h-0 flex-1 flex-col gap-2.5 px-5 pb-4 max-hd:px-3.75">
        <CodeEditor
          label={`The compose file for ${STACK_NAME}`}
          value={draft.value}
          onChange={draft.set}
          className={FILL}
        />
        <FileStatus draft={draft} />
      </div>
      <Modal.Footer>
        {draft.changed ? (
          <span className="text-meta text-tx-2 max-sm:w-full">
            <strong className="font-medium text-tx">Unsaved changes.</strong>{" "}
            Closing keeps them in the card.
          </span>
        ) : null}
        <Modal.Gap />
        <SaveButtons draft={draft} />
      </Modal.Footer>
    </Modal>
  );
}

/**
 * **B · Full screen.** The editor takes the whole viewport, like the Dock's
 * maximise: one bar on top with the file's name and its two buttons, the file
 * edge to edge, and a status line. Nothing of the page shows, so nothing
 * competes with the file.
 */
export function FullScreenEditor({ open, onOpenChange, draft }: OverlayProps) {
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
            size="icon-sm"
            variant="qt"
            aria-label="Exit full screen"
            title="Exit full screen (Esc)"
            onClick={() => onOpenChange(false)}
          >
            <Icon name="restore" size={15} />
          </Button>
          <div className="min-w-0 grow basis-40">
            <DialogTitle className="text-body font-semibold text-tx">
              Compose file
            </DialogTitle>
            <p className="truncate text-meta text-tx-3">{STACK_NAME} · Production</p>
          </div>
          {draft.changed ? <Chip variant="warn">Unsaved changes</Chip> : null}
          <div className="flex items-center gap-2 max-sm:w-full max-sm:justify-end">
            <SaveButtons draft={draft} size="sm" />
          </div>
        </div>
        <CodeEditor
          label={`The compose file for ${STACK_NAME}`}
          value={draft.value}
          onChange={draft.set}
          className={`${FILL} rounded-none border-0`}
        />
        <div className="border-t border-line bg-panel px-4 py-2">
          <FileStatus draft={draft} hint="Esc returns to the page" />
        </div>
      </DialogContent>
    </Dialog>
  );
}
