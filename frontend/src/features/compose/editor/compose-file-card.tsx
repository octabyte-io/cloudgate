import { useId, useState } from "react";

import { Card } from "@/components/console/card";
import { Chip } from "@/components/console/chip";
import { CodeEditor } from "@/components/console/code-editor";
import { FormError } from "@/components/console/field";
import { MetaStrip } from "@/components/console/meta-strip";
import { SubmitButton } from "@/components/console/submit-button";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api/error-message";
import {
  COMPOSE_TYPE_LABEL,
  type ComposeDetail,
  type UpdateComposeInput,
} from "@/lib/api/endpoints/compose";
import { usePermission } from "@/lib/auth/use-permission";

import { unsetInterpolations } from "./interpolation-check";
import { yamlProblem } from "./yaml-check";
import { DeclaredServices } from "./declared-services";
import { COMPOSE_UPDATE_REFUSAL } from "../use-compose";

/**
 * The compose file, edited. **This is the screen for this service kind** — the one
 * place in the product where the operator's source of truth is a file.
 *
 * **It is only an editor for a `raw` source, and that is a fact about the
 * backend rather than a simplification.** `DeploymentEngineService`'s
 * `readComposeContent` reads the `composeFile` column *only* when
 * `sourceType === "raw"`; for every git source it `cat`s the clone on the build
 * Server. So a stack pulling from GitHub can have a perfectly good file in that
 * column and no deploy will ever look at it. An editor there would accept work,
 * save it, report success and change nothing — which is the worst of the shapes
 * this codebase keeps refusing. What it shows instead is where the file really is,
 * and what the platform managed to parse out of it.
 *
 * Save does not write `sourceType: "raw"` *along with* the file, which would
 * silently convert the stack. That is a real answer but not one a Save button
 * should give on its own — changing where a stack comes from is the Source card
 * above, one decision, with its own words.
 *
 * **Save the file is off, with the reason, for a role the save would be
 * refused**: `PATCH /compose/:id` runs `findOwnedForUpdate`, which asks
 * for `service: ['update']`. The editor stays live, as the fields on a gated
 * `SettingsCard` do — reading the file is not the refused act.
 */
export function ComposeFileCard({
  compose,
  save,
}: {
  compose: ComposeDetail;
  save: (input: UpdateComposeInput) => Promise<unknown>;
}) {
  const raw = compose.sourceType === "raw";

  return (
    <Card>
      <Card.Header
        title="Compose file"
        sub={
          raw
            ? "Stored in Cloudgate. Written to the deploy target on every Deployment."
            : `Read from the repository at ${compose.composePath} when the stack deploys.`
        }
        headingLevel={2}
      />
      {raw ? (
        <RawEditor compose={compose} save={save} />
      ) : (
        <ClonedFile compose={compose} />
      )}
    </Card>
  );
}

/** The editable half. One field, one Save, and a YAML check before it. */
function RawEditor({
  compose,
  save,
}: {
  compose: ComposeDetail;
  save: (input: UpdateComposeInput) => Promise<unknown>;
}) {
  /**
   * `null` until something is typed, and then the edit.
   *
   * F10's shape, for F10's reason: seeding a draft from the row inside an effect
   * is a `setState` in an effect, which this project's lint rules refuse outright.
   * Deriving it needs no effect and behaves better — until someone types, the
   * editor shows whatever the query currently holds, so a refetch landing is not
   * silently overwritten by a stale seed.
   */
  const [edit, setEdit] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const permission = usePermission({ service: ["update"] });
  const roleRefusalId = useId();

  const stored = compose.composeFile;
  const draft = edit ?? stored;
  const changed = draft !== stored;
  const problem = changed ? yamlProblem(draft) : null;
  const unset = unsetInterpolations(draft, compose.env);

  return (
    <>
      {changed ? (
        <MetaStrip>
          <strong>Unsaved changes.</strong> Nothing is applied until this is saved
          and the stack is deployed.
        </MetaStrip>
      ) : null}
      <Card.Body className="flex flex-col gap-3">
        <CodeEditor
          label={`The compose file for ${compose.name}`}
          value={draft}
          onChange={setEdit}
        />

        {problem ? (
          <p className="rounded-lg border border-bad-line bg-bad-tint px-3 py-2.5 text-meta text-tx">
            <strong className="font-medium">
              {problem.kind === "aliases"
                ? "These YAML aliases cannot be resolved"
                : "This is not valid YAML"}
              {problem.line ? ` (line ${problem.line})` : ""}.
            </strong>{" "}
            {problem.message} Docker would refuse the file with the same
            complaint, so it is not saved until this is fixed.
          </p>
        ) : null}

        {unset.length > 0 ? (
          <p className="rounded-lg border border-warn-line bg-warn-tint px-3 py-2.5 text-meta text-tx">
            <strong className="font-medium">
              Not set in this stack&rsquo;s variables:{" "}
              {unset.map(({ name, line }) => `${name} (line ${line})`).join(", ")}
              .
            </strong>{" "}
            Docker interpolates each as a blank string. Set them under
            Variables, or give each a default, as in{" "}
            <code className="font-mono">{"${NAME:-value}"}</code>.
          </p>
        ) : null}

        <FormError message={refusal ?? undefined} />
        {permission.allowed ? null : (
          <p id={roleRefusalId} className="text-meta text-tx-2">
            {COMPOSE_UPDATE_REFUSAL}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <SubmitButton
            type="button"
            pending={saving}
            disabled={!permission.allowed || !changed || problem !== null}
            title={permission.allowed ? undefined : COMPOSE_UPDATE_REFUSAL}
            aria-describedby={permission.allowed ? undefined : roleRefusalId}
            onClick={async () => {
              if (!permission.allowed) return;
              setRefusal(null);
              setSaving(true);
              try {
                await save({ composeFile: draft });
                setEdit(null);
                toast.done("Compose file saved.", {
                  description: "Deploy the stack to apply it.",
                });
              } catch (error) {
                setRefusal(errorMessage(error));
              } finally {
                setSaving(false);
              }
            }}
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
          <span className="ml-auto text-meta text-tx-3">
            <Chip>{COMPOSE_TYPE_LABEL[compose.composeType]}</Chip>
          </span>
        </div>

        <DeclaredServices compose={compose} />
      </Card.Body>
    </>
  );
}

/** The half where the file is somewhere else. */
function ClonedFile({ compose }: { compose: ComposeDetail }) {
  return (
    <Card.Body className="flex flex-col gap-3">
      <div className="rounded-lg border border-info-line bg-info-tint px-3.5 py-3">
        <p className="text-body text-tx">
          <strong className="font-medium">
            This stack&rsquo;s file is in its repository
          </strong>{" "}
          — <span className="font-mono text-meta">{compose.composePath}</span>,
          on the branch the Source card names. Cloudgate clones it as part of a
          Deployment and reads it from there.
        </p>
        <p className="mt-2 text-meta text-tx-2">
          There is no route that reads that file back, so there is nothing to show
          here and nothing to edit: the column an editor would write is only read
          for a source of type <span className="font-mono">raw</span>. Change the
          file where it lives, then deploy — or change the source above to a file
          written here.
        </p>
      </div>

      <DeclaredServices compose={compose} />
    </Card.Body>
  );
}
