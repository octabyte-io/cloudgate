import { useId, useState } from "react";

import { ActionReason } from "@/components/console/action-reason";
import { Card } from "@/components/console/card";
import { CodeEditor } from "@/components/console/code-editor";
import { FormError } from "@/components/console/field";
import { MenuRow } from "@/components/console/menu";
import { MetaStrip } from "@/components/console/meta-strip";
import { SubmitButton } from "@/components/console/submit-button";
import { toast } from "@/components/console/toast";
import { useUnsavedChangesGuard } from "@/components/console/use-unsaved-changes";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api/error-message";
import { runsOnStackVm, type ComposeDetail } from "@/lib/api/endpoints/compose";
import type { Mount } from "@/lib/api/endpoints/mounts";
import { roleRefusal, usePermission } from "@/lib/auth/use-permission";
import { cn } from "@/lib/utils";

import { ActionIcon } from "../../application/lifecycle/action-icon";
import {
  COMPOSE_RESTART_REFUSAL,
  useComposeActions,
  useComposeLifecyclePending,
  wasRefused,
} from "../use-compose";
import { useSaveConfigFile } from "./use-config-files";

/**
 * Why Save is off: `PATCH /mounts/:id` is decorated `volume: ['create']` and
 * `MountsService.update` then asks `service: ['update']` of the stack.
 */
export const CONFIG_FILE_SAVE_REFUSAL = roleRefusal(
  "change this Compose stack's config files",
);

export const CONFIG_FILE_UNSAVED =
  "Your changes to this config file are not saved. Leave it and lose them?";

/**
 * A Compose stack's **Config files**, one open at a time (spec #134).
 *
 * The compose file card's save pattern (`compose-file-card.tsx`): the draft is
 * `null` until something is typed, so a refetch landing is shown rather than
 * overwritten; one Save, one Discard, the refusal in place, and Save off with
 * the role's reason. Only the content changes: adding, renaming or deleting a
 * file is not offered, because the stack's compose file names each one.
 *
 * **Restart to apply** follows a save rather than being a step of it: some apps
 * read their config only at startup, and when to restart is the operator's
 * call. It is the stack's own Restart (`docker compose restart`), so it is
 * absent for a Swarm stack, whose restart route refuses that type and whose
 * Deploy is what applies a change.
 */
export function ConfigFilesCard({
  compose,
  files,
}: {
  compose: ComposeDetail;
  files: Mount[];
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [edit, setEdit] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  /** The file the last save wrote, until the next edit or another file. */
  const [savedId, setSavedId] = useState<string | null>(null);
  const save = useSaveConfigFile(compose.composeId);

  // What `PATCH /mounts/:id` asks, both halves.
  const canWriteVolumes = usePermission({ volume: ["create"] });
  const canUpdateService = usePermission({ service: ["update"] });
  const saveAllowed = canWriteVolumes.allowed && canUpdateService.allowed;
  const refusalId = useId();

  const open = files.find((file) => file.mountId === openId) ?? files[0];
  const stored = open?.content ?? "";
  const draft = edit ?? stored;
  const changed = draft !== stored;
  useUnsavedChangesGuard(changed, CONFIG_FILE_UNSAVED);

  if (!open) return null;
  const path = open.filePath ?? "";
  const label = `The config file ${path}`;

  function choose(mountId: string) {
    if (mountId === open?.mountId) return;
    if (changed && !window.confirm(CONFIG_FILE_UNSAVED)) return;
    setOpenId(mountId);
    setEdit(null);
    setRefusal(null);
    setSavedId(null);
  }

  async function saveDraft() {
    if (!saveAllowed || !open) return;
    setRefusal(null);
    try {
      await save.mutateAsync({ mountId: open.mountId, content: draft });
      setEdit(null);
      setSavedId(open.mountId);
      toast.done(`${path} saved.`, {
        description: "It is written where the stack runs.",
      });
    } catch (error) {
      setRefusal(errorMessage(error));
    }
  }

  return (
    <>
      <Card>
        <Card.Header
          title="Files"
          sub="Shipped by the Template this stack was set up from."
          headingLevel={2}
        />
        <Card.Body>
          <ul className="grid gap-0.5">
            {files.map((file) => (
              <li key={file.mountId}>
                <MenuRow
                  icon="lines"
                  aria-pressed={file.mountId === open.mountId}
                  className={cn(
                    "font-mono",
                    file.mountId === open.mountId && "bg-raise",
                  )}
                  onClick={() => choose(file.mountId)}
                >
                  {file.filePath}
                </MenuRow>
              </li>
            ))}
          </ul>
        </Card.Body>
      </Card>

      <Card>
        <Card.Header
          title={path}
          sub="Saved here, it is written where the stack runs."
          headingLevel={2}
        />
        {changed ? (
          <MetaStrip>
            <strong>Unsaved changes.</strong> Nothing is written until this is
            saved.
          </MetaStrip>
        ) : null}
        <Card.Body className="flex flex-col gap-3">
          <CodeEditor
            label={label}
            value={draft}
            onChange={(next: string) => {
              setEdit(next);
              setSavedId(null);
            }}
          />

          <FormError message={refusal ?? undefined} />
          {saveAllowed ? null : (
            <p id={refusalId} className="text-meta text-tx-2">
              {CONFIG_FILE_SAVE_REFUSAL}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <SubmitButton
              type="button"
              pending={save.isPending}
              disabled={!saveAllowed || !changed}
              title={saveAllowed ? undefined : CONFIG_FILE_SAVE_REFUSAL}
              aria-describedby={saveAllowed ? undefined : refusalId}
              onClick={saveDraft}
            >
              Save the file
            </SubmitButton>
            <Button
              type="button"
              disabled={!changed}
              onClick={() => {
                setEdit(null);
                setRefusal(null);
              }}
            >
              Discard changes
            </Button>
          </div>

          {savedId === open.mountId ? <Saved compose={compose} /> : null}
        </Card.Body>
      </Card>
    </>
  );
}

/** What a save leaves: the way to apply it. */
function Saved({ compose }: { compose: ComposeDetail }) {
  const actions = useComposeActions(compose.composeId, compose.environmentId);
  const pending = useComposeLifecyclePending(compose.composeId);
  const [pressed, setPressed] = useState(false);
  // What `POST /compose/:id/restart` asks.
  const canRestart = usePermission({ deployment: ["create"] });
  const reasonId = useId();
  const busy = pressed || pending !== null;
  const onStackVm = runsOnStackVm(compose);

  if (compose.composeType === "stack") {
    return (
      <p role="status" className="text-meta text-tx-2">
        Saved. Deploy the stack to apply it.
      </p>
    );
  }

  async function restart() {
    setPressed(true);
    try {
      await actions.restart.mutateAsync();
      toast.done(
        onStackVm
          ? `${compose.name}'s containers are restarting. Its Stack VM keeps running.`
          : `${compose.name}'s containers are restarting.`,
      );
    } catch (error) {
      if (wasRefused(error)) toast.error(error);
      else
        toast.warn("The request did not come back.", {
          description:
            "Docker was still working when the connection closed, so the restart may have carried on. Watch the status beside the name.",
        });
    } finally {
      setPressed(false);
    }
  }

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-2 rounded-lg border border-ok-line bg-ok-tint px-3 py-2.5"
    >
      <p className="text-meta text-tx">
        <strong className="font-medium">Saved.</strong> An app that reads this
        file only at startup picks it up after a restart.
      </p>
      <Button
        size="sm"
        className="ml-auto"
        disabled={!canRestart.allowed || busy}
        aria-busy={busy || undefined}
        title={canRestart.allowed ? undefined : COMPOSE_RESTART_REFUSAL}
        aria-describedby={canRestart.allowed ? undefined : reasonId}
        onClick={restart}
      >
        <ActionIcon name="refresh" pending={busy} size={14} />
        Restart to apply
      </Button>
      {canRestart.allowed ? null : (
        <ActionReason id={reasonId}>{COMPOSE_RESTART_REFUSAL}</ActionReason>
      )}
    </div>
  );
}
