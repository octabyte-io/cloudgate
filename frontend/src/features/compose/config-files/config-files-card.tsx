import { useId, useState } from "react";

import { Card } from "@/components/console/card";
import { CodeEditor } from "@/components/console/code-editor";
import {
  ExpandButton,
  ExpandedEditor,
} from "@/components/console/expanded-editor";
import { FormError } from "@/components/console/field";
import { MetaStrip } from "@/components/console/meta-strip";
import { SubmitButton } from "@/components/console/submit-button";
import { toast } from "@/components/console/toast";
import { useUnsavedChangesGuard } from "@/components/console/use-unsaved-changes";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api/error-message";
import type { ComposeDetail } from "@/lib/api/endpoints/compose";
import type { Mount } from "@/lib/api/endpoints/mounts";
import { roleRefusal, usePermission } from "@/lib/auth/use-permission";
import { cn } from "@/lib/utils";

import { useComposeActions } from "../use-compose";

/** Why Save is off: `PATCH /mounts/:id` takes both statements. */
export const CONFIG_FILE_SAVE_REFUSAL = roleRefusal(
  "change this Compose stack's config files",
);

/** Why Restart to apply is off: the stack's Restart takes `deployment: ['create']`. */
export const CONFIG_FILE_RESTART_REFUSAL = roleRefusal(
  "restart this stack's containers",
);

const LEAVE_WARNING =
  "This config file has changes that are not saved. Leave without saving them?";

/**
 * A Compose stack's **Config files** (#135): the files a Template shipped
 * with it, kept by Cloudgate as the stack's `file` mounts. One open at a
 * time, in the editor; Save sends only its content to `PATCH /mounts/:id`,
 * which writes it where the stack runs (a Server, a Stack VM, the platform
 * host) in place, so a running container sees it at once. Its path and kind
 * are never sent: the compose file names them, so they cannot change here.
 *
 * Some apps read their config only at startup, so a save offers **Restart
 * to apply**, the stack's own Restart. A Swarm stack has no Restart
 * (`startOrRestart`): Deploy restarts it, which the note says instead.
 *
 * **Save is off, with the reason, for a role the route would refuse**: the
 * mount update takes `volume: ['create']` and `service: ['update']`. The
 * editor stays live, as on the compose file card: reading is not refused.
 */
export function ConfigFilesCard({
  compose,
  files,
  save,
}: {
  compose: ComposeDetail;
  files: readonly Mount[];
  save: (mountId: string, content: string) => Promise<unknown>;
}) {
  const [openId, setOpenId] = useState(files[0]?.mountId ?? null);
  const [edit, setEdit] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const volumeWrite = usePermission({ volume: ["create"] });
  const serviceWrite = usePermission({ service: ["update"] });
  const canSave = volumeWrite.allowed && serviceWrite.allowed;
  const refusalId = useId();

  const file = files.find((one) => one.mountId === openId) ?? files[0];
  if (!file) return null;
  const stored = file.content ?? "";
  const draft = edit ?? stored;
  const changed = draft !== stored;
  const name = fileName(file);
  const label = `The config file ${name} for ${compose.name}`;

  return (
    <Card>
      <Card.Header
        title="Config files"
        sub="Shipped by the stack's Template. Saving writes the file where the stack runs."
        headingLevel={2}
        actions={
          <ExpandButton
            name={name}
            size="sm"
            onClick={() => setExpanded(true)}
          />
        }
      />
      <UnsavedGuard dirty={changed} />
      {files.length > 1 ? (
        <div
          role="tablist"
          aria-label="Config files"
          className="flex flex-wrap gap-1.5 border-b border-line px-4 py-2.5"
        >
          {files.map((one) => (
            <button
              key={one.mountId}
              type="button"
              role="tab"
              aria-selected={one.mountId === file.mountId}
              className={cn(
                "rounded-md px-2 py-1 font-mono text-meta text-tx-2 hover:bg-panel-2",
                one.mountId === file.mountId && "bg-panel-2 text-tx",
              )}
              onClick={() => {
                if (one.mountId === file.mountId) return;
                if (changed && !window.confirm(LEAVE_WARNING)) return;
                setOpenId(one.mountId);
                setEdit(null);
                setRefusal(null);
                setSaved(null);
              }}
            >
              {fileName(one)}
            </button>
          ))}
        </div>
      ) : null}
      <ExpandedEditor
        open={expanded}
        onOpenChange={setExpanded}
        kind="code"
        title={name}
        context={compose.name}
        label={label}
        value={draft}
        onChange={setEdit}
        changed={changed}
        actions={
          <>
            {discardButton("sm")}
            {saveButton("sm")}
          </>
        }
        status={
          expanded && refusal ? (
            <span className="text-bad">{refusal}</span>
          ) : null
        }
      />
      {changed ? (
        <MetaStrip>
          <strong>Unsaved changes.</strong> Nothing is written until this is
          saved.
        </MetaStrip>
      ) : null}
      <Card.Body className="flex flex-col gap-3">
        <p className="text-meta text-tx-2">
          Mounted in the container at{" "}
          <span className="font-mono text-tx">{file.mountPath}</span>.
        </p>
        <CodeEditor
          key={file.mountId}
          label={label}
          value={draft}
          onChange={setEdit}
        />

        <FormError message={refusal ?? undefined} />
        {canSave ? null : (
          <p id={refusalId} className="text-meta text-tx-2">
            {CONFIG_FILE_SAVE_REFUSAL}
          </p>
        )}

        {saved === file.mountId && !changed ? (
          <AfterSave compose={compose} name={name} />
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          {saveButton()}
          {discardButton()}
        </div>
      </Card.Body>
    </Card>
  );

  async function saveDraft() {
    if (!canSave || !file) return;
    setRefusal(null);
    setSaving(true);
    try {
      await save(file.mountId, draft);
      setEdit(null);
      setSaved(file.mountId);
      toast.done(`${fileName(file)} saved.`, {
        description: "Restart the stack if the app reads it only at startup.",
      });
    } catch (error) {
      setRefusal(errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  function saveButton(size?: "sm") {
    return (
      <SubmitButton
        type="button"
        size={size}
        pending={saving}
        disabled={!canSave || !changed}
        title={canSave ? undefined : CONFIG_FILE_SAVE_REFUSAL}
        aria-describedby={canSave ? undefined : refusalId}
        onClick={saveDraft}
      >
        Save the file
      </SubmitButton>
    );
  }

  function discardButton(size?: "sm") {
    return (
      <Button
        type="button"
        size={size}
        disabled={!changed}
        onClick={() => {
          setEdit(null);
          setRefusal(null);
        }}
      >
        Discard changes
      </Button>
    );
  }
}

/** The leave warning, on only while the open file has unsaved edits. */
function UnsavedGuard({ dirty }: { dirty: boolean }) {
  useUnsavedChangesGuard(dirty, LEAVE_WARNING);
  return null;
}

/**
 * After a save: the file is written, and an app that reads its config only
 * at startup needs a restart, which is the person's to choose when.
 */
function AfterSave({
  compose,
  name,
}: {
  compose: ComposeDetail;
  name: string;
}) {
  const actions = useComposeActions(compose.composeId, compose.environmentId);
  const canRestart = usePermission({ deployment: ["create"] });
  const restartRefused = !canRestart.allowed;
  const restarting = actions.restart.isPending;
  const swarm = compose.composeType === "stack";

  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-ok-line bg-ok-tint px-3 py-2.5"
    >
      <p className="min-w-0 flex-1 text-meta text-tx">
        {swarm
          ? `${name} is saved where the stack runs. If the app reads it only at startup, deploy the stack to apply it.`
          : `${name} is saved where the stack runs. If the app reads it only at startup, restart the stack to apply it.`}
      </p>
      {swarm ? null : (
        <Button
          type="button"
          size="sm"
          aria-disabled={restartRefused || restarting || undefined}
          aria-busy={restarting || undefined}
          title={restartRefused ? CONFIG_FILE_RESTART_REFUSAL : undefined}
          onClick={
            restartRefused || restarting
              ? undefined
              : () =>
                  actions.restart.mutate(undefined, {
                    onSuccess: () =>
                      toast.done(
                        `${compose.name}'s containers are restarting.`,
                      ),
                    onError: (error) => toast.error(error),
                  })
          }
        >
          Restart to apply
        </Button>
      )}
      {restartRefused && !swarm ? (
        <p className="w-full text-meta text-tx-2">
          {CONFIG_FILE_RESTART_REFUSAL}
        </p>
      ) : null}
    </div>
  );
}

/** A file's name as the list shows it: where it lands under the stack. */
export function fileName(mount: Mount): string {
  return mount.filePath ?? mount.mountPath;
}
