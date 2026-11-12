"use client";

import { useState } from "react";

import { Card } from "@/components/console/card";
import { CodeEditor } from "@/components/console/code-editor";
import { CopyButton } from "@/components/console/copy-button";
import { EmptyState } from "@/components/console/empty-state";
import { Page } from "@/components/console/page";
import { PageHeader } from "@/components/console/page-header";
import { Skeleton } from "@/components/console/skeleton";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api/error-message";
import type { Environment } from "@/lib/api/endpoints/environments";
import type {
  CloudgateLocation,
  RepositoryLocation,
} from "@/lib/api/endpoints/project-config";
import { useServers } from "@/lib/api/use-servers";
import { usePermission } from "@/lib/auth/use-permission";
import { Icon } from "@/lib/design/icons";
import type { PanelProps } from "@/lib/shell/tab-registry";

import { useEnvironments } from "@/features/environment/use-environments";

import { MoveConfigModal } from "../move-config-modal";
import { MoveOutModal } from "../move-out-modal";
import { EnvironmentPlanCard } from "../environment-plan-card";
import {
  MOVE_REFUSAL,
  PLAN_REQUEST_REFUSAL,
  useProjectConfig,
  useSaveProjectConfig,
} from "../use-project-config";

/**
 * A Project's config: the YAML Cloudgate keeps for it, editable
 * as a whole, and each Environment's Plan — what applying the config there
 * would create, change and destroy — with Apply, under the plan, which asks
 * for each destroyed Service's name first.
 *
 * **Saving the YAML applies nothing.** It plans the edited text in every
 * Environment and stores a plan for each; the text itself is stored when one
 * of those plans is applied. So the editor keeps the draft until then, and
 * says that the plans below are what to review.
 *
 * A Project made before Project configs existed has none until the upgrade
 * generates one, and says so rather than showing an empty file.
 *
 * **A repository-kept config has no editor**: Cloudgate keeps no copy
 * of its text. The page names the repository and path, and each
 * Environment's card shows that Environment's copy read-only, as its Config
 * branch has it now, with the commit, a link to the file and the open plan.
 * A Cloudgate-kept config offers the move into a repository; a
 * repository-kept one the move to another repository or path, and the move
 * back out, after which the editor notes the file no longer read.
 */
export default function Panel({ id, label, icon }: PanelProps) {
  const config = useProjectConfig(id);
  const environments = useEnvironments(id);
  const servers = useServers();
  const location = config.data?.location ?? null;
  const serverNames = Object.fromEntries(
    (servers.data ?? []).map((server) => [server.serverId, server.name]),
  );

  return (
    <Page>
      <PageHeader
        title={label}
        icon={icon}
        lede="What this Project runs, as one YAML file, and what applying it would change in each Environment."
      />

      <div className="grid gap-4">
        {config.error ? (
          <p className="text-body text-bad">{errorMessage(config.error)}</p>
        ) : config.isPending ? (
          <Card aria-busy>
            <Card.Body>
              <Skeleton className="h-log w-full rounded-lg" />
            </Card.Body>
          </Card>
        ) : location?.kind === "repository" ? (
          <RepositoryLocationCard
            projectId={id}
            location={location}
            serverNames={serverNames}
            environments={environments.data ?? []}
          />
        ) : location ? (
          <ConfigEditorCard
            // A new stored text (an Apply elsewhere) starts a fresh draft.
            key={location.textHash}
            projectId={id}
            stored={location.text}
            movedOutOf={location.movedOutOf}
            serverNames={serverNames}
          />
        ) : (
          <Card>
            <Card.Body>
              <EmptyState icon="list" title="No Project config yet">
                This Project was created before Project configs existed.
                Cloudgate generates one for it when it is upgraded; until then
                there is nothing to plan.
              </EmptyState>
            </Card.Body>
          </Card>
        )}

        {location
          ? environments.data?.map((environment) => (
              <EnvironmentPlanCard
                key={environment.environmentId}
                projectId={id}
                environment={environment}
                serverNames={serverNames}
                repositoryKept={location.kind === "repository"}
              />
            ))
          : null}
        {location && environments.error ? (
          <p className="text-body text-bad">
            {errorMessage(environments.error)}
          </p>
        ) : null}
      </div>
    </Page>
  );
}

/** Where a repository-kept config is read, and through which connection. */
function RepositoryLocationCard({
  projectId,
  location,
  serverNames,
  environments,
}: {
  projectId: string;
  location: RepositoryLocation;
  serverNames: Readonly<Record<string, string>>;
  environments: readonly Environment[];
}) {
  const [moving, setMoving] = useState<"repository" | "out" | null>(null);
  const canMove = usePermission({ project: ["update"] });
  const title = canMove.allowed ? undefined : MOVE_REFUSAL;
  return (
    <Card>
      <Card.Header
        title="Project config"
        sub={`Kept in ${location.repository} at ${location.path}. Change it there; each Environment below reads it from its own Config branch.`}
        actions={
          <>
            <Button
              variant="gh"
              disabled={!canMove.allowed}
              title={title}
              onClick={() => canMove.allowed && setMoving("repository")}
            >
              Move to another repository
            </Button>
            <Button
              variant="gh"
              disabled={!canMove.allowed}
              title={title}
              onClick={() => canMove.allowed && setMoving("out")}
            >
              Move into Cloudgate
            </Button>
          </>
        }
      />
      <Card.Body>
        {location.connectionName ? (
          <p className="text-body text-tx-2">
            Read through the {location.providerType ?? "git"} connection{" "}
            <span className="font-medium text-tx">
              {location.connectionName}
            </span>
            . Builds and Preview deployments never read it.
          </p>
        ) : (
          <p className="text-body text-bad">
            The connection this config was read through was deleted, so no
            Environment can read it. Move the config to a connection that
            reaches {location.repository}.
          </p>
        )}
      </Card.Body>
      <MoveConfigModal
        projectId={projectId}
        open={moving === "repository"}
        onOpenChange={(open) => setMoving(open ? "repository" : null)}
        serverNames={serverNames}
        from={location}
      />
      <MoveOutModal
        projectId={projectId}
        open={moving === "out"}
        onOpenChange={(open) => setMoving(open ? "out" : null)}
        serverNames={serverNames}
        from={location}
        environments={environments}
      />
    </Card>
  );
}

function ConfigEditorCard({
  projectId,
  stored,
  movedOutOf,
  serverNames,
}: {
  projectId: string;
  stored: string;
  movedOutOf: CloudgateLocation["movedOutOf"];
  serverNames: Readonly<Record<string, string>>;
}) {
  const [draft, setDraft] = useState(stored);
  const [moving, setMoving] = useState(false);
  const save = useSaveProjectConfig(projectId);
  const canPlan = usePermission({ environment: ["read"] });
  const canMove = usePermission({ project: ["update"] });
  const edited = draft !== stored;

  return (
    <Card>
      <Card.Header
        title="Project config"
        sub="Kept in Cloudgate. Edit it here and review each Environment's plan before you apply it, or copy it to commit it beside your code."
        actions={
          <>
            <CopyButton value={draft} label="Project config" />
            <Button
              variant="gh"
              disabled={!canMove.allowed || edited}
              title={
                canMove.allowed
                  ? edited
                    ? "Save or discard your edits first."
                    : undefined
                  : MOVE_REFUSAL
              }
              onClick={() => canMove.allowed && setMoving(true)}
            >
              Move to a repository
            </Button>
            {edited ? (
              <Button
                variant="qt"
                disabled={save.isPending}
                onClick={() => {
                  setDraft(stored);
                  save.reset();
                }}
              >
                Discard edits
              </Button>
            ) : null}
            <Button
              variant="pri"
              disabled={!edited || !canPlan.allowed || save.isPending}
              title={canPlan.allowed ? undefined : PLAN_REQUEST_REFUSAL}
              onClick={() =>
                edited && canPlan.allowed && save.mutate({ text: draft })
              }
            >
              Save and plan
            </Button>
          </>
        }
      />
      <Card.Body>
        {movedOutOf ? (
          <p className="mb-3 flex items-start gap-2 text-body text-tx-2">
            <Icon name="info" className="mt-0.5 flex-none text-tx-3" />
            Moved out of {movedOutOf.repository} at {movedOutOf.path} on{" "}
            {new Date(movedOutOf.movedAt).toLocaleString()}. That file is no
            longer read; changing it changes nothing here.
          </p>
        ) : null}
        {save.error ? (
          <p className="mb-3 text-body text-bad">{errorMessage(save.error)}</p>
        ) : null}
        {save.data && !save.isPending ? (
          <p className="mb-3 flex items-center gap-2 text-body text-tx-2">
            <Icon name="info" className="flex-none text-tx-3" />
            {save.data.stored
              ? "Saved. No Environment has anything to change, so the text is stored as it is."
              : "Planned in each Environment below. Nothing is applied, and the text is stored when you apply a plan of it."}
          </p>
        ) : null}
        <CodeEditor value={draft} onChange={setDraft} label="Project config" />
      </Card.Body>
      <MoveConfigModal
        projectId={projectId}
        open={moving}
        onOpenChange={setMoving}
        serverNames={serverNames}
      />
    </Card>
  );
}
