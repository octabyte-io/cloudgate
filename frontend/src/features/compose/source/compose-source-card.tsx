import { useId, useState } from "react";

import { Card } from "@/components/console/card";
import { Chip } from "@/components/console/chip";
import { KVList, KVRow } from "@/components/console/kv-list";
import { PickCard, PickGrid } from "@/components/console/pick-card";
import { SubmitButton } from "@/components/console/submit-button";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import type {
  ComposeDetail,
  ComposeSourceType,
  UpdateComposeInput,
} from "@/lib/api/endpoints/compose";
import { usePermission } from "@/lib/auth/use-permission";
import { Icon } from "@/lib/design/icons";
import { hasSource } from "@/lib/format/source";
import { CustomGitForm } from "@/features/application/source/custom-git-form";
import { GitSourceForm } from "@/features/application/source/git-source-form";
import {
  deploysOnPush,
  GIT_PROVIDERS,
} from "@/features/application/source/providers";

import {
  COMPOSE_PATH,
  COMPOSE_SOURCE_META,
  COMPOSE_SOURCES,
  composeSourceSummary,
  isGitProviderKind,
} from "./compose-source";
import { COMPOSE_UPDATE_REFUSAL } from "../use-compose";

/**
 * Where this stack's compose file comes from.
 *
 * Reading and editing are two states of one card — F08's variables shape, F09's
 * source shape — because the choice is six-way and five of the six have a form
 * behind them.
 *
 * **The forms are F09's, not copies of them.** A `compose` row holds the git
 * columns under the same names as an `application` row, so `GitSourceForm` and
 * `CustomGitForm` serve both; the one difference is which column the path field
 * writes, which `COMPOSE_PATH` supplies. Writing a second set would mean fixing
 * every provider bug twice, which is the thing F09's own table exists to prevent.
 *
 * **`raw` has no form**, and that is the honest shape: choosing it sets one column
 * and the *file* is edited in the card below this one. So the choice is a
 * sentence and a Save.
 *
 * **A stack with no source says so**. One created "From a repository"
 * keeps `source_type`'s `github` default and no repository, and the card used to
 * render that as Type GitHub, Deploys on a push, automatic. `hasSource` is the
 * Application card's rule, and the backend refuses a deploy on the same one.
 *
 * **Change source is off, with the reason, for a role the save would be
 * refused**. Every form behind it saves through `PATCH /compose/:id`,
 * which `findOwnedForUpdate` holds to `service: ['update']` — the Application
 * card's gate, on this route. The forms are a step behind it, so they carry
 * none of their own.
 */
export function ComposeSourceCard({
  compose,
  save,
}: {
  compose: ComposeDetail;
  save: (input: UpdateComposeInput) => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  const [choice, setChoice] = useState<ComposeSourceType>(compose.sourceType);
  const canChange = usePermission({ service: ["update"] });
  const refusalId = useId();

  const summary = composeSourceSummary(compose);
  const raw = compose.sourceType === "raw";
  const set = hasSource(compose);

  return (
    <Card>
      <Card.Header
        title="Source"
        sub={
          raw
            ? "The file is stored here, and edited below."
            : "What the next Deployment clones."
        }
        headingLevel={2}
        actions={
          editing ? null : (
            <Button
              size="xs"
              disabled={!canChange.allowed}
              title={canChange.allowed ? undefined : COMPOSE_UPDATE_REFUSAL}
              aria-describedby={canChange.allowed ? undefined : refusalId}
              onClick={() => {
                if (!canChange.allowed) return;
                setChoice(compose.sourceType);
                setEditing(true);
              }}
            >
              <Icon name="pencil" size={14} />
              Change source
            </Button>
          )
        }
      />

      <Card.Body className="flex flex-col gap-3.5">
        {editing || canChange.allowed ? null : (
          <p id={refusalId} className="text-meta text-tx-2">
            {COMPOSE_UPDATE_REFUSAL}
          </p>
        )}
        {editing ? (
          <>
            <PickGrid label="Where the compose file comes from">
              {COMPOSE_SOURCES.map((type) => (
                <PickCard
                  key={type}
                  icon={COMPOSE_SOURCE_META[type].icon}
                  title={COMPOSE_SOURCE_META[type].title}
                  description={COMPOSE_SOURCE_META[type].description}
                  selected={choice === type}
                  onClick={() => setChoice(type)}
                />
              ))}
            </PickGrid>

            <div className="border-t border-line pt-3.5">
              {isGitProviderKind(choice) ? (
                <GitSourceForm
                  row={compose}
                  spec={GIT_PROVIDERS[choice]}
                  path={COMPOSE_PATH}
                  save={save}
                  onDone={() => setEditing(false)}
                />
              ) : choice === "git" ? (
                <CustomGitForm
                  row={compose}
                  path={COMPOSE_PATH}
                  save={save}
                  onDone={() => setEditing(false)}
                />
              ) : (
                <RawSourceChoice
                  save={save}
                  onDone={() => setEditing(false)}
                />
              )}
            </div>
          </>
        ) : !set ? (
          <p className="text-body text-tx-2">
            No source yet. Choose where the compose file comes from with Change
            source, then deploy.
          </p>
        ) : (
          <KVList>
            <KVRow
              label="Type"
              value={
                <span className="inline-flex items-center gap-1.75">
                  <Icon
                    name={COMPOSE_SOURCE_META[compose.sourceType].icon}
                    size={14}
                    className="text-tx-3"
                  />
                  {summary.label}
                </span>
              }
            />
            {summary.detail ? (
              <KVRow
                label="Repository"
                value={summary.detail}
                title={summary.detail}
                mono
              />
            ) : null}
            {summary.branch ? (
              <KVRow
                label="Branch"
                value={summary.branch}
                title={summary.branch}
                mono
              />
            ) : null}
            {raw ? null : (
              <>
                <KVRow
                  label="Compose file"
                  value={compose.composePath}
                  title={compose.composePath}
                  mono
                />
                {/* Never true for a stack today — no route deploys one
                    on a push — but asked of the rule the Application card and
                    the form read, so the three change together. */}
                <KVRow
                  label="Deploys on"
                  value={
                    deploysOnPush(compose) ? (
                      <span className="inline-flex items-center gap-1.75">
                        A push to the branch
                        <Chip>automatic</Chip>
                      </span>
                    ) : (
                      "Nothing — deploys are manual"
                    )
                  }
                />
              </>
            )}
          </KVList>
        )}
      </Card.Body>
    </Card>
  );
}

/**
 * `raw` in one decision. Nothing to fill in — the column is the whole change, and
 * the file itself is the card below.
 */
function RawSourceChoice({
  save,
  onDone,
}: {
  save: (input: UpdateComposeInput) => Promise<unknown>;
  onDone: () => void;
}) {
  const [saving, setSaving] = useState(false);

  return (
    <div className="flex flex-col gap-3.5">
      <p className="max-w-lede text-body text-tx-2">
        The compose file will be stored in Cloudgate and written to the deploy
        target on every Deployment. Nothing is cloned, so there is no branch and
        no automatic deploy — pressing Deploy is what applies a change.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <SubmitButton
          type="button"
          pending={saving}
          onClick={async () => {
            setSaving(true);
            try {
              await save({ sourceType: "raw" });
              toast.done("Source saved.", {
                description: "Edit the file below, then deploy.",
              });
              onDone();
            } catch (error) {
              toast.error(error);
            } finally {
              setSaving(false);
            }
          }}
        >
          Save source
        </SubmitButton>
        <Button type="button" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
