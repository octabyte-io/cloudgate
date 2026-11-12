import { useState } from "react";

import { CodeEditor } from "@/components/console/code-editor";
import { Field } from "@/components/console/field";
import { Modal } from "@/components/console/modal";
import { Picker } from "@/components/console/picker";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api/error-message";
import type { Environment } from "@/lib/api/endpoints/environments";
import type {
  CloudgateTarget,
  RepositoryLocation,
} from "@/lib/api/endpoints/project-config";
import { Icon } from "@/lib/design/icons";

import { MovePreviewList, readLine } from "./move-preview-list";
import { useConfirmMove, usePreviewMove } from "./use-project-config";

/**
 * Moving a repository-kept config back into Cloudgate (US64, US65):
 * pick whose copy to keep — the default branch's unless an Environment's
 * Config branch is chosen — then **Preview**, which shows that copy and each
 * Environment's plan of it, and **Move**, refused if the copy changed since.
 * The move clears every Config branch and applies nothing.
 */
export function MoveOutModal({
  projectId,
  open,
  onOpenChange,
  serverNames,
  from,
  environments,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serverNames: Readonly<Record<string, string>>;
  from: RepositoryLocation;
  environments: readonly Environment[];
}) {
  const [fromEnvironmentId, setFromEnvironmentId] = useState("");
  const preview = usePreviewMove(projectId);
  const confirm = useConfirmMove(projectId);
  const target: CloudgateTarget = {
    kind: "cloudgate",
    fromEnvironmentId: fromEnvironmentId === "" ? null : fromEnvironmentId,
  };
  const shown = preview.data && !preview.isPending ? preview.data : null;
  const kept = shown?.to.kind === "cloudgate" ? shown.to.copy : null;

  const close = (next: boolean) => {
    if (!next) {
      preview.reset();
      confirm.reset();
    }
    onOpenChange(next);
  };

  return (
    <Modal open={open} onOpenChange={close} wide>
      <Modal.Header
        title="Move the config out of the repository"
        description={`One copy of ${from.path} becomes the config Cloudgate keeps, edited on this page. ${from.repository} is no longer read, and every Environment's Config branch is cleared. Moving applies nothing.`}
      />
      <Modal.Body className="grid gap-4">
        <Field
          name="from-environment"
          label="Keep the copy from"
          manual
          hint="The default branch's copy unless you pick an Environment, whose own Config branch is read."
        >
          <Picker
            options={[
              { value: "", label: "The default branch" },
              ...environments.map((environment) => ({
                value: environment.environmentId,
                label: environment.name,
                detail: environment.configBranch ?? "default branch",
              })),
            ]}
            value={fromEnvironmentId}
            onValueChange={(value) => {
              setFromEnvironmentId(value);
              preview.reset();
              confirm.reset();
            }}
          />
        </Field>

        {preview.error ? (
          <p className="text-body text-bad">{errorMessage(preview.error)}</p>
        ) : null}
        {confirm.error ? (
          <p className="text-body text-bad">{errorMessage(confirm.error)}</p>
        ) : null}

        {kept ? (
          <div className="grid gap-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-meta text-tx-2">
                {kept.path} from {kept.repository} on{" "}
                {readLine(kept.branch, kept.commitSha)}
              </p>
              <a
                href={kept.fileUrl}
                target="_blank"
                rel="noreferrer"
                className="text-meta font-medium text-brand-tx underline-offset-3 hover:underline focus-visible:underline"
              >
                Open the file
              </a>
            </div>
            <CodeEditor
              value={kept.text}
              label="The copy Cloudgate will keep"
            />
          </div>
        ) : null}
        {shown ? (
          <MovePreviewList preview={shown} serverNames={serverNames} />
        ) : null}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="qt" onClick={() => close(false)}>
          Cancel
        </Button>
        <Button
          variant="gh"
          disabled={preview.isPending}
          onClick={() => preview.mutate(target)}
        >
          <Icon name="refresh" size={15} />
          Preview
        </Button>
        <Button
          variant="pri"
          disabled={shown === null || confirm.isPending}
          onClick={() =>
            shown &&
            confirm.mutate(
              { to: target, reads: shown.reads },
              {
                onSuccess: () => {
                  toast.done("Config moved into Cloudgate.", {
                    description: `${from.repository} is no longer read. Nothing was applied; review each plan before you apply it.`,
                  });
                  close(false);
                },
              },
            )
          }
        >
          Move config
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
