"use client";

import { useState } from "react";

import { Chip } from "@/components/console/chip";
import { Dot } from "@/components/console/dot";
import { Page } from "@/components/console/page";
import { useStarred } from "@/components/shell/favourites";
import { useRecents } from "@/components/shell/recents";
import type { IconName } from "@/lib/design/icons";
import { Button } from "@/components/ui/button";
import { usePermission } from "@/lib/auth/use-permission";
import { counted } from "@/lib/format/plural";
import { ProjectFormModal } from "@/features/project/project-form-modal";
import { PROJECT_CREATE_REFUSAL } from "@/features/project/use-projects";
import { AddServerDialogs } from "@/features/server/fleet/add-server-dialogs";
import { SERVER_CREATE_REFUSAL } from "@/features/server/use-server";
import { serverMark } from "@/lib/design/server-mark";

import { HomeRow } from "./home-row";
import { ListCard } from "./list-card";
import { QuickSearch } from "./quick-search";
import { useHomeData } from "./use-home-data";

/**
 * The Organization home (e-console.html:2785-2860).
 *
 * The reference's shape, mostly kept: a search field, two lists of what you
 * own, a recents column. One card is ours: Starred, the
 * reader the header's star never had, beside Recents because it is the same
 * kind of list. What is gone is everything that had no
 * data behind it — and the omissions are most of the reference's page, so they are
 * worth naming:
 *
 * - **The "Terraform provisioning is in preview" chip and the two fleet charts.**
 *   Provisioning has no backend at all (`00-INDEX.md`, locked decision 1) and the
 *   charts need the metrics gateway, which arrives with F14.
 * - **The Recommendations banner** (`recs()`), which is built entirely out of
 *   cloud accounts that do not exist and an `unreachable` Server status that is not
 *   in the enum. There is no honest finding to put in it yet.
 * - **The summary strip.** Its two tiles this page could fill, Servers and
 *   Projects, said again what the cards' own headers already say ("2 total · 2
 *   reachable"), one screen apart, so the strip is gone rather than kept as a
 *   repeat. The other two are buildable and not free: "Deployments today" wants
 *   the organization-wide feed read here, and "Services" one request per
 *   Environment. A figure here
 *   would be the most confident number on the page: the bar is not
 *   "obtainable", it is "right by the time anybody reads it".
 *
 * What is left is real, and it is what the done criteria ask for: the Servers and
 * Projects this Organization actually has, and where you actually were.
 */
export function OrganizationHome() {
  const {
    servers,
    projects,
    shownServers,
    shownProjects,
    serverReach: reach,
    environmentCount,
  } = useHomeData();
  const recents = useRecents();
  const starred = useStarred();
  const canCreateProject = usePermission({ project: ["create"] });
  const canCreateServer = usePermission({ server: ["create"] });
  // Every opening a fresh form: both are `useApiForm`, which reads
  // `defaultValues` once. A trip from Add a Server to the keys dialog comes back
  // to Add as it was, with the new key chosen (`AddServerDialogs`).
  const [dialog, setDialog] = useState<"none" | "project" | "server">("none");
  const [managingKeys, setManagingKeys] = useState(false);
  const [opening, setOpening] = useState(0);
  function open(next: "project" | "server") {
    setOpening((n) => n + 1);
    setDialog(next);
  }
  const closeOn = (next: boolean) => {
    if (!next) setDialog("none");
  };

  // `?? 0` is deliberately absent: a count nobody has answered yet is not zero,
  // so a card's header says nothing until it has one.
  const serverCount = servers.data?.length;
  const projectCount = projects.data?.length;

  return (
    <Page>
      <QuickSearch />

      <div className="grid grid-cols-[repeat(auto-fit,minmax(var(--spacing-tile),1fr))] gap-4.5">
        <ListCard
          title="Servers"
          count={
            serverCount === undefined
              ? undefined
              : `${serverCount} total · ${reach.reachable} reachable`
          }
          all={{ href: "/servers", label: "All Servers" }}
          pending={servers.isPending}
          error={servers.error}
          empty="Add a Server for Cloudgate to deploy onto: any machine it can reach over SSH."
          emptyAction={
            <CreateFirst
              label="Add a Server"
              allowed={canCreateServer.allowed}
              refusal={SERVER_CREATE_REFUSAL}
              onClick={() => open("server")}
            />
          }
        >
          {shownServers.length > 0
            ? shownServers.map((server) => (
                <HomeRow
                  key={server.serverId}
                  href={`/servers/${server.serverId}`}
                  icon="hdd"
                  label={server.name}
                  mark={<Dot mark={serverMark(server)} />}
                />
              ))
            : null}
        </ListCard>

        <ListCard
          title="Projects"
          count={projectCount === undefined ? undefined : `${projectCount} total`}
          all={{ href: "/projects", label: "All Projects" }}
          pending={projects.isPending}
          error={projects.error}
          empty="Create a Project for each product you ship. Its Environments hold what you deploy."
          emptyAction={
            <CreateFirst
              label="New Project"
              allowed={canCreateProject.allowed}
              refusal={PROJECT_CREATE_REFUSAL}
              onClick={() => open("project")}
            />
          }
        >
          {shownProjects.length > 0
            ? shownProjects.map((project) => {
                const count = environmentCount(project.projectId);
                return (
                  <HomeRow
                    key={project.projectId}
                    href={`/projects/${project.projectId}`}
                    icon="folder"
                    label={project.name}
                    mark={
                      // Absent while unknown, never a zero: a Project whose count
                      // has not arrived is not a Project with no Environments.
                      count === undefined ? null : (
                        <Chip aria-label={counted(count, "Environment", "Environments")}>
                          {count}
                        </Chip>
                      )
                    }
                  />
                );
              })
            : null}
        </ListCard>

        <BrowserListCard
          title="Recents"
          count="Where you were last"
          icon="clock"
          empty="Open a Server, a Project or an Environment and it shows up here."
          entries={recents}
        />
        <BrowserListCard
          title="Starred"
          count="Marked with the star in a header"
          icon="star"
          empty="Star a Server, a Project or an Environment beside its name to keep it here."
          entries={starred}
        />
      </div>

      {/* The list screens' own two dialogs, so the first Project and the first
          Server are made the same way as every later one. Both go to what they
          made on success. */}
      <ProjectFormModal
        key={`project-${opening}`}
        project={null}
        open={dialog === "project"}
        onOpenChange={closeOn}
      />
      <AddServerDialogs
        opening={opening}
        adding={dialog === "server"}
        onAddingChange={(next) => setDialog(next ? "server" : "none")}
        managingKeys={managingKeys}
        onManagingKeysChange={setManagingKeys}
        servers={servers.data ?? []}
      />
    </Page>
  );
}

/**
 * The control that makes the first one, held off with the reason for a
 * role that cannot — the same treatment the Projects screen gives New Project,
 * so a member is not handed a dialog that ends in a 403.
 */
function CreateFirst({
  label,
  allowed,
  refusal,
  onClick,
}: {
  label: string;
  allowed: boolean;
  refusal: string;
  onClick: () => void;
}) {
  return (
    <Button
      size="sm"
      variant="pri"
      disabled={!allowed}
      title={allowed ? undefined : refusal}
      onClick={() => allowed && onClick()}
    >
      {label}
    </Button>
  );
}

/**
 * Where you were last, and what you starred — this browser's two lists.
 *
 * Recents is written by the shell the moment a resource scope resolves its
 * name, so a pasted URL counts the same as a click, and kept per Organization
 * because every href in it is tenant-scoped (`recents.ts`). Starred is written
 * by the star in a resource's header and filtered to this Organization
 * (`favourites.ts`). Never pending: both are the browser's own memory, so there
 * is nothing to wait for — and empty until the operator does something, which
 * is an honest thing for a new account to say.
 */
function BrowserListCard({
  title,
  count,
  icon,
  empty,
  entries,
}: {
  title: string;
  count: string;
  icon: IconName;
  empty: string;
  entries: { id: string; label: string; href: string }[];
}) {
  return (
    <ListCard title={title} count={count} pending={false} error={null} empty={empty}>
      {entries.length > 0
        ? entries.map((entry) => {
            // The label is "parent / name", written by the shell. The parent is
            // context and the name is the thing, so they are set apart.
            const [path, name] = splitLabel(entry.label);
            return (
              <HomeRow
                key={entry.id}
                href={entry.href}
                icon={icon}
                path={path}
                label={name}
              />
            );
          })
        : null}
    </ListCard>
  );
}

function splitLabel(label: string): [string | undefined, string] {
  const at = label.lastIndexOf(" / ");
  return at === -1
    ? [undefined, label]
    : [label.slice(0, at + 3), label.slice(at + 3)];
}
