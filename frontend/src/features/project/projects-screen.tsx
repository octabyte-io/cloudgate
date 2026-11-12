"use client";

import { useMemo, useState } from "react";

import { Card } from "@/components/console/card";
import { Cols } from "@/components/console/cols";
import { DataTable } from "@/components/console/data-table";
import { EmptyState } from "@/components/console/empty-state";
import { MetaStrip } from "@/components/console/meta-strip";
import { Page } from "@/components/console/page";
import { PageHeader } from "@/components/console/page-header";
import { SearchInput } from "@/components/console/search-input";
import { Skeleton } from "@/components/console/skeleton";
import { Toolbar, ToolbarGap } from "@/components/console/toolbar";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api/error-message";
import type { Project } from "@/lib/api/endpoints/projects";
import { usePermission } from "@/lib/auth/use-permission";
import { Icon } from "@/lib/design/icons";

import { TagFilter } from "@/features/tags/tag-filter";
import { useTags } from "@/features/tags/use-tags";

import { HierarchyCard } from "./hierarchy-card";
import { ProjectDialogs, type ProjectDialog } from "./project-dialogs";
import { projectColumns } from "./project-columns";
import {
  PROJECT_CREATE_REFUSAL,
  useEnvironmentCounts,
  useProjects,
  useProjectTags,
} from "./use-projects";

/**
 * Every Project in the Organization (the reference's `viewProjects`).
 *
 * The screen holds the dialogs rather than the table doing so, because all four
 * of them — new, rename, tags, delete — are about *a* Project and only one can
 * be open at a time. One `useState` for which Project and one for which dialog
 * keeps a row's menu item to a single call, and means a dialog is never mounted
 * inside a row that is about to be sorted out from under it.
 *
 * **It holds the permission reads for the same reason**
 * `projectColumns`
 * is a function that builds column declarations rather than a component, so it
 * cannot call a hook; asking here and passing the answer down keeps the two
 * statements read once per screen instead of once per row, and puts them beside
 * the dialogs those same statements decide the reachability of.
 */
export function ProjectsScreen() {
  const projects = useProjects();
  const tags = useTags();
  const canWrite = usePermission({ project: ["update"] });
  const canDelete = usePermission({ project: ["delete"] });
  const canCreate = usePermission({ project: ["create"] });

  const [query, setQuery] = useState("");
  const [tagFilter, setTagFilter] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<ProjectDialog>("none");
  const [target, setTarget] = useState<Project | null>(null);

  // The ticks that still name a Tag, and the only selection anything below
  // reads. `tagFilter` is what was ticked, and deleting a Tag — from
  // Manage tags here, or in another session this list refetches from — does
  // not reach into it: a dead id went on being counted by the trigger, ticked
  // nothing in the popover, and matched no Project, so the list went empty
  // with no box to untick. Derived rather than pruned in an effect, so no
  // render ever holds the stale set; while the Tags have not loaded there is
  // nothing to prune against, and a selection only exists once they have.
  const liveTagFilter = useMemo(() => {
    if (!tags.data) return tagFilter;
    const live = new Set(tags.data.map((tag) => tag.tagId));
    return new Set([...tagFilter].filter((tagId) => live.has(tagId)));
  }, [tagFilter, tags.data]);

  const rows = useMemo(() => projects.data ?? [], [projects.data]);
  const environmentCounts = useEnvironmentCounts(rows);
  const tagsByProject = useProjectTags(rows);

  const shown = rows.filter((project) => {
    const text = query.trim().toLowerCase();
    const matchesText =
      text === "" ||
      project.name.toLowerCase().includes(text) ||
      (project.description ?? "").toLowerCase().includes(text);

    if (!matchesText) return false;
    if (liveTagFilter.size === 0) return true;

    // A Project whose Tags have not arrived is held out of a *filtered* list
    // rather than shown: including it would put a row in a filtered result that
    // may not belong in it, which is worse than a row arriving a moment late.
    const mine = tagsByProject.get(project.projectId);
    return (mine ?? []).some((tag) => liveTagFilter.has(tag.tagId));
  });

  const filtering = query.trim() !== "" || liveTagFilter.size > 0;
  const firstRun = projects.data !== undefined && rows.length === 0;

  function open(next: ProjectDialog, project: Project | null = null) {
    setTarget(project);
    setDialog(next);
  }

  return (
    <Page>
      <PageHeader
        title="Projects"
        icon="folder"
        lede="Everything this Organization deploys, grouped by what ships together."
        actions={
          <>
            {/* "Manage tags", not "Tags": the filter beside the search is
                already called Tags, and two controls a hand's width apart
                carrying the same word is how someone opens the wrong one. */}
            <Button onClick={() => open("manage-tags")}>
              <Icon name="tag" size={15} />
              Manage tags
            </Button>
            <Button
              variant="pri"
              disabled={!canCreate.allowed}
              title={canCreate.allowed ? undefined : PROJECT_CREATE_REFUSAL}
              onClick={() => canCreate.allowed && open("new")}
            >
              <Icon name="plus" size={15} />
              New Project
            </Button>
          </>
        }
      />

      {/* The hierarchy aside is first-run help: it stays only until
          the Organization has a Project, after which the rail itself shows the
          hierarchy and the aside was a permanent paragraph beside the list. */}
      <Cols
        aside={firstRun ? <HierarchyCard /> : undefined}
        asideLabel={firstRun ? "About Projects" : undefined}
      >
        <Toolbar>
          <SearchInput
            label="Search Projects"
            placeholder="Search Projects"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <TagFilter
            tags={tags.data ?? []}
            selected={liveTagFilter}
            onChange={setTagFilter}
          />
          <ToolbarGap />
        </Toolbar>

        <Card>
          {projects.isPending ? (
            <Card.Body>
              <div className="grid gap-2.5" aria-busy="true">
                <Skeleton className="h-row" />
                <Skeleton className="h-row" />
                <Skeleton className="h-row" />
              </div>
            </Card.Body>
          ) : projects.error ? (
            <Card.Body>
              <p className="text-body text-tx-2">
                {errorMessage(projects.error)}
              </p>
            </Card.Body>
          ) : (
            <>
              <MetaStrip>
                {filtering ? (
                  <>
                    Showing <strong>{shown.length}</strong> of{" "}
                    <strong>{rows.length}</strong>.
                  </>
                ) : (
                  <>
                    <strong>{rows.length}</strong>{" "}
                    {rows.length === 1 ? "Project" : "Projects"} here.
                  </>
                )}
              </MetaStrip>
              {/* Mounts once, when the skeleton gives way: the rows arrive as one
                  block. A refetch keeps it mounted, so it never replays. */}
              <Card.Body flush className="animate-rise">
                <DataTable
                  label="Projects"
                  rows={shown}
                  getRowId={(row) => row.projectId}
                  defaultSort={{ id: "name", dir: "asc" }}
                  columns={projectColumns({
                    environmentCounts,
                    tagsByProject,
                    grants: {
                      update: canWrite.allowed,
                      remove: canDelete.allowed,
                    },
                    actions: {
                      onRename: (project) => open("rename", project),
                      onTags: (project) => open("tags", project),
                      onDelete: (project) => open("delete", project),
                    },
                  })}
                  empty={
                    filtering ? (
                      <EmptyState icon="search" title="No Project matches">
                        Clear the search and the tag filter to see every
                        Project.
                      </EmptyState>
                    ) : (
                      <EmptyState
                        icon="folder"
                        title="Make your first Project"
                        action={
                          <Button
                            size="sm"
                            variant="pri"
                            disabled={!canCreate.allowed}
                            title={
                              canCreate.allowed
                                ? undefined
                                : PROJECT_CREATE_REFUSAL
                            }
                            onClick={() => canCreate.allowed && open("new")}
                          >
                            New Project
                          </Button>
                        }
                      >
                        Create one for each product you ship. Its Environments
                        hold the Applications, databases and Compose stacks you
                        deploy.
                      </EmptyState>
                    )
                  }
                />
              </Card.Body>
            </>
          )}
        </Card>
      </Cols>

      <ProjectDialogs
        dialog={dialog}
        target={target}
        onClose={() => setDialog("none")}
      />
    </Page>
  );
}
