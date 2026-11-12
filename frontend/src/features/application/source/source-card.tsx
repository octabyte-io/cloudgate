import { useState } from "react";

import { Card } from "@/components/console/card";
import { Chip } from "@/components/console/chip";
import { KVList, KVRow } from "@/components/console/kv-list";
import { PickCard, PickGrid } from "@/components/console/pick-card";
import { Button } from "@/components/ui/button";
import type {
  Application,
  SourceType,
  UpdateApplicationInput,
} from "@/lib/api/endpoints/applications";
import type { GitProviderKind } from "@/lib/api/endpoints/git-providers";
import { useGitConnections } from "@/lib/api/use-git-source";
import { usePermission } from "@/lib/auth/use-permission";
import {
  ConfigLockNote,
  lockRefusal,
  useConfigLock,
} from "@/components/console/config-lock";
import { Icon, type IconName } from "@/lib/design/icons";
import { hasSource } from "@/lib/format/source";

import { CustomGitForm } from "./custom-git-form";
import { DockerSourceForm } from "./docker-source-form";
import { DropSourceForm } from "./drop-source-form";
import { GitSourceForm } from "./git-source-form";
import { APPLICATION_UPDATE_REFUSAL } from "../use-application";
import {
  deploysOnPush,
  GIT_PROVIDERS,
  isGitProviderKind,
  sourceSummary,
} from "./providers";

/**
 * Where this Application's code comes from.
 *
 * Reading and editing are two states of one card, the way F08's variables card
 * works: the resting state is the answer, and "Change source" opens the choice.
 * That matters more here than anywhere else on the screen, because the choice is
 * seven-way and five of the seven have a different form behind them — a card that
 * was permanently a radio grid plus a form would be most of the Overview tab.
 *
 * **All seven source types are offered**, `drop` (upload a zip) included.
 * It used to be left out, and a `drop` row shown read-only with no Change
 * source, on the grounds that nothing could upload the archive — a sentence that
 * outlived `POST /applications/:id/drop` and stranded any Application an upload
 * had set, since the only way back to another source was the API.
 *
 * **A row with no source says so**. `source_type` defaults to `github`, so
 * a fresh Application's row claims GitHub with no repository, and the card used
 * to render that default as the operator's configuration — Type GitHub, Deploys
 * on a push, automatic — beside a prompt to set the source. `hasSource` reads the
 * column the type needs instead, and the resting state is one sentence with
 * Change source as the way on. Deploying such a row is refused by the backend
 * with the same rule.
 */
export function SourceCard({
  application,
  save,
}: {
  application: Application;
  save: (input: UpdateApplicationInput) => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  // Every source form saves through `PATCH /applications/:id` (or its `drop`
  // upload), which is `service: ['update']`.
  const canChange = usePermission({ service: ["update"] });
  const [choice, setChoice] = useState<SourceType>(application.sourceType);
  // The branch and the connection stay Cloudgate's, so the form stays open
  // with the provider, repository, path and image locked inside it.
  const lock = useConfigLock(
    application.environmentId,
    "application",
    application.applicationId,
  );

  const locked = lock ? lockRefusal(lock) : undefined;

  const summary = sourceSummary(application);
  const set = hasSource(application);
  // Read only for a row with no source, to open Change source on one that
  // works. Same keys as the provider form's, so they are cached.
  const connected: Record<GitProviderKind, boolean> = {
    github: hasConnection(useGitConnections("github", !set).data),
    gitlab: hasConnection(useGitConnections("gitlab", !set).data),
    bitbucket: hasConnection(useGitConnections("bitbucket", !set).data),
    gitea: hasConnection(useGitConnections("gitea", !set).data),
  };
  const dropped = set && application.sourceType === "drop";

  return (
    <Card>
      <Card.Header
        title="Source"
        sub={
          dropped
            ? "Files uploaded to this Application."
            : "What the next Deployment builds."
        }
        headingLevel={2}
        actions={
          editing ? null : (
            <Button
              size="xs"
              disabled={!canChange.allowed}
              title={canChange.allowed ? undefined : APPLICATION_UPDATE_REFUSAL}
              onClick={() => {
                if (!canChange.allowed) return;
                setChoice(
                  set ? application.sourceType : openingSource(connected),
                );
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
        {lock ? (
          <ConfigLockNote
            lock={lock}
            what="The provider, repository, path and image are"
            rest="The branch and the git connection are Cloudgate's."
          />
        ) : null}
        {editing ? (
          <div className="flex animate-fade flex-col gap-3.5">
            <PickGrid label="Where the code comes from">
              {OFFERED.map((type) => (
                <PickCard
                  key={type}
                  icon={SOURCE_META[type].icon}
                  title={SOURCE_META[type].title}
                  description={SOURCE_META[type].description}
                  selected={choice === type}
                  // The provider is the file's: only the saved one is offered,
                  // and the lock note above says where it is changed.
                  inert={locked !== undefined && type !== application.sourceType}
                  onClick={() => setChoice(type)}
                />
              ))}
            </PickGrid>

            {/* Keyed on the choice: picking another source fades its form
                in where the last one was. */}
            <div key={choice} className="animate-fade border-t border-line pt-3.5">
              {isGitProviderKind(choice) ? (
                <GitSourceForm
                  row={application}
                  spec={GIT_PROVIDERS[choice]}
                  save={save}
                  onDone={() => setEditing(false)}
                  locked={locked}
                />
              ) : choice === "docker" ? (
                <DockerSourceForm
                  application={application}
                  save={save}
                  onDone={() => setEditing(false)}
                  locked={locked}
                />
              ) : choice === "drop" ? (
                <DropSourceForm
                  application={application}
                  onDone={() => setEditing(false)}
                />
              ) : (
                <CustomGitForm
                  row={application}
                  save={save}
                  onDone={() => setEditing(false)}
                  locked={locked}
                />
              )}
            </div>
          </div>
        ) : !set ? (
          <p className="text-body text-tx-2">
            No source yet. Choose where the code comes from with Change source,
            then deploy.
          </p>
        ) : (
          <KVList>
            <KVRow
              label="Type"
              value={
                <span className="inline-flex items-center gap-1.75">
                  <Icon
                    name={SOURCE_META[application.sourceType].icon}
                    size={14}
                    className="text-tx-3"
                  />
                  {summary.label}
                </span>
              }
            />
            {summary.detail ? (
              <KVRow
                label={
                  application.sourceType === "docker" ? "Image" : "Repository"
                }
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
            {application.sourceType !== "docker" && !dropped ? (
              <KVRow
                label="Deploys on"
                value={
                  deploysOnPush(application) ? (
                    <span className="inline-flex items-center gap-1.75">
                      A push to the branch
                      <Chip>automatic</Chip>
                    </span>
                  ) : (
                    "Nothing — deploys are manual"
                  )
                }
              />
            ) : null}
          </KVList>
        )}
      </Card.Body>
    </Card>
  );
}

function hasConnection(list: readonly unknown[] | undefined): boolean {
  return (list?.length ?? 0) > 0;
}

/**
 * Where Change source opens on a row with no source yet: the first git
 * provider with a connection, in the order they are offered, or Any git URL
 * when none has one. It opened on the column's `github` default, and with no
 * GitHub connected that pane has no Save, so the first thing shown was a dead
 * end.
 */
export function openingSource(
  connected: Record<GitProviderKind, boolean>,
): SourceType {
  const provider = OFFERED.find(
    (type): type is GitProviderKind =>
      isGitProviderKind(type) && connected[type],
  );
  return provider ?? "git";
}

/** All seven, in the order the choice is read. */
const OFFERED: SourceType[] = [
  "github",
  "gitlab",
  "bitbucket",
  "gitea",
  "docker",
  "git",
  "drop",
];

const SOURCE_META: Record<
  SourceType,
  { title: string; description: string; icon: IconName }
> = {
  github: {
    title: "GitHub",
    description:
      "Built from a repository a connected GitHub account can reach.",
    icon: "branch",
  },
  gitlab: {
    title: "GitLab",
    description: "Built from a project on gitlab.com or your own GitLab.",
    icon: "branch",
  },
  bitbucket: {
    title: "Bitbucket",
    description: "Built from a repository in a Bitbucket workspace.",
    icon: "branch",
  },
  gitea: {
    title: "Gitea",
    description: "Built from a repository on a Gitea instance you run.",
    icon: "branch",
  },
  docker: {
    title: "Docker image",
    description:
      "Runs an image that is already built. Nothing is compiled here.",
    icon: "box",
  },
  git: {
    title: "Any git URL",
    description:
      "Cloned from a URL you give, with an SSH key if it is private.",
    icon: "net",
  },
  drop: {
    title: "Uploaded files",
    description:
      "A zip of the code, uploaded from this computer. Nothing is cloned.",
    icon: "ul",
  },
};
