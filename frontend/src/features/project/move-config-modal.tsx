import { useState } from "react";

import { Field } from "@/components/console/field";
import { Modal } from "@/components/console/modal";
import { Picker } from "@/components/console/picker";
import { toast } from "@/components/console/toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { errorMessage } from "@/lib/api/error-message";
import {
  connectionId,
  type GitProviderKind,
  type SourceRepository,
} from "@/lib/api/endpoints/git-providers";
import type {
  RepositoryLocation,
  RepositoryTarget,
} from "@/lib/api/endpoints/project-config";
import { Icon } from "@/lib/design/icons";

import { useGitConnections, useRepositories } from "@/lib/api/use-git-source";
import { providerOf } from "@/features/integrations/git-providers/providers";

import { MovePreviewList } from "./move-preview-list";
import { useConfirmMove, usePreviewMove } from "./use-project-config";

const KINDS: readonly GitProviderKind[] = [
  "github",
  "gitlab",
  "gitea",
  "bitbucket",
];

/** The hosted providers a config can be kept on. A custom git URL is none. */
export const MOVE_PROVIDERS = KINDS.map((kind) => ({
  value: kind,
  label: providerOf(kind).label,
}));

/**
 * The repository as the provider's config reader and the connection resolver
 * address it: GitLab's full project path, Bitbucket's workspace/slug, and
 * owner/name on GitHub and Gitea.
 */
export function configRepository(
  kind: GitProviderKind,
  repository: SourceRepository,
): string {
  switch (kind) {
    case "gitlab":
      return (
        repository.pathNamespace ?? `${repository.owner}/${repository.name}`
      );
    case "bitbucket":
      return `${repository.owner}/${repository.slug ?? repository.name}`;
    default:
      return `${repository.owner}/${repository.name}`;
  }
}

/**
 * The move's target. An empty Path sends no `path`, so the move finds
 * `cloudgate.yaml` or `cloudgate.yml` itself and answers the one it found
 * (#1344); substituting `cloudgate.yaml` here would ask for that file
 * alone, with no search.
 */
export function repositoryTarget(
  gitProviderId: string,
  repository: string,
  path: string,
): RepositoryTarget {
  const named = path.trim();
  return {
    kind: "repository",
    gitProviderId,
    repository,
    ...(named === "" ? {} : { path: named }),
  };
}

/**
 * Moving a Project's config into a repository (US60–US63, US66):
 * pick a provider (GitHub, GitLab, Gitea or Bitbucket), one of its
 * connections, one of its repositories and the file's path, then
 * **Preview**, which reads every Environment's copy from its Config branch
 * and shows the plan it would leave open there. **Move** confirms what the
 * preview showed, and is refused if any copy changed since. A move applies
 * nothing: each plan waits for its own Apply on the config page.
 *
 * Changing any input drops the preview, so Move always confirms the
 * repository and path on screen.
 *
 * With `from` set, the config is already kept in that repository and this is
 * the move to another repository or path: the same preview and
 * confirm, each Environment reading its Config branch at the new place.
 */
export function MoveConfigModal({
  projectId,
  open,
  onOpenChange,
  serverNames,
  from = null,
}: {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  serverNames: Readonly<Record<string, string>>;
  from?: RepositoryLocation | null;
}) {
  const [kind, setKind] = useState<GitProviderKind>("github");
  const [connectionKey, setConnectionKey] = useState("");
  const [repository, setRepository] = useState("");
  const [path, setPath] = useState("");
  const connections = useGitConnections(kind, open);
  const repositories = useRepositories(kind, connectionKey, open);
  const preview = usePreviewMove(projectId);
  const confirm = useConfirmMove(projectId);
  const label = providerOf(kind).label;

  const connection = (connections.data ?? []).find(
    (one) => connectionId(kind, one) === connectionKey,
  );
  const target: RepositoryTarget | null =
    connection && repository !== ""
      ? repositoryTarget(connection.gitProviderId, repository, path)
      : null;
  const shown = preview.data && !preview.isPending ? preview.data : null;
  // The path the preview read: the one named, or the one it found.
  const shownPath =
    shown?.to.kind === "repository" ? shown.to.path : (target?.path ?? null);

  const changed = (apply: () => void) => {
    apply();
    preview.reset();
    confirm.reset();
  };
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
        title={
          from
            ? "Move the config to another repository"
            : "Move the config into a repository"
        }
        description={`${from ? `Kept in ${from.repository} at ${from.path} now. ` : ""}Each Environment then reads the file from its own Config branch — the repository's default branch unless its settings name another. Moving applies nothing.`}
      />
      <Modal.Body className="grid gap-4">
        <div className="grid gap-3.5">
          <Field
            name="provider"
            label="Provider"
            manual
            hint="A hosted repository keeps the config. A custom git URL cannot."
          >
            <Picker
              options={MOVE_PROVIDERS}
              value={kind}
              onValueChange={(value) =>
                changed(() => {
                  setKind(value as GitProviderKind);
                  setConnectionKey("");
                  setRepository("");
                })
              }
            />
          </Field>
          <Field name="connection" label={`${label} connection`} manual>
            <Picker
              options={(connections.data ?? []).map((one) => ({
                value: connectionId(kind, one),
                label: one.gitProvider.name,
              }))}
              pending={connections.isPending}
              placeholder="Choose a connection"
              value={connectionKey}
              onValueChange={(value) =>
                changed(() => {
                  setConnectionKey(value);
                  setRepository("");
                })
              }
            />
          </Field>
          <Field name="repository" label="Repository" manual>
            <Picker
              options={(repositories.data ?? []).map((one) => {
                const name = configRepository(kind, one);
                return { value: name, label: name };
              })}
              pending={connectionKey !== "" && repositories.isPending}
              disabled={connectionKey === ""}
              placeholder="Choose a repository"
              value={repository}
              onValueChange={(value) => changed(() => setRepository(value))}
            />
          </Field>
          <Field
            name="path"
            label="Path"
            manual
            hint="Where the file is in the repository. cloudgate.yaml or cloudgate.yml at the root unless you name another."
          >
            <Input
              autoComplete="off"
              className="font-mono"
              placeholder="cloudgate.yaml or cloudgate.yml"
              value={path}
              onChange={(event) =>
                changed(() => setPath(event.currentTarget.value))
              }
            />
          </Field>
        </div>

        {preview.error ? (
          <p className="text-body text-bad">{errorMessage(preview.error)}</p>
        ) : null}
        {confirm.error ? (
          <p className="text-body text-bad">{errorMessage(confirm.error)}</p>
        ) : null}

        {shown ? (
          <>
            {shownPath ? (
              <p className="text-body text-tx-2">
                Reads <span className="font-mono">{shownPath}</span> from{" "}
                {target?.repository}.
              </p>
            ) : null}
            <MovePreviewList preview={shown} serverNames={serverNames} />
          </>
        ) : null}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="qt" onClick={() => close(false)}>
          Cancel
        </Button>
        <Button
          variant="gh"
          disabled={target === null || preview.isPending}
          onClick={() => target && preview.mutate(target)}
        >
          <Icon name="refresh" size={15} />
          Preview
        </Button>
        <Button
          variant="pri"
          disabled={target === null || shown === null || confirm.isPending}
          onClick={() =>
            target &&
            shown &&
            confirm.mutate(
              { to: target, reads: shown.reads },
              {
                onSuccess: () => {
                  toast.done("Config moved.", {
                    description: `Each Environment now reads ${shownPath ?? "the config"} from ${target.repository}. Nothing was applied; review each plan before you apply it.`,
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
