import type { Column } from "@/components/console/data-table";
import { Menu } from "@/components/console/menu";
import { RowLink, RowSub, RowTime } from "@/components/console/rows/cells";
import { Skeleton } from "@/components/console/skeleton";
import { Button } from "@/components/ui/button";
import type { Project } from "@/lib/api/endpoints/projects";
import type { Tag } from "@/lib/api/endpoints/tags";
import { Icon } from "@/lib/design/icons";

import { TagChips } from "@/features/tags/tag-chips";

import { PROJECT_DELETE_REFUSAL, PROJECT_UPDATE_REFUSAL } from "./use-projects";

export type ProjectRowActions = {
  onRename: (project: Project) => void;
  onTags: (project: Project) => void;
  onDelete: (project: Project) => void;
};

/**
 * Which of the row menu's three items the caller's role can actually reach.
 *
 * Two booleans rather than three, because Rename and Tags are one statement:
 * `PATCH /projects/:id` and both `projectTag` verbs are all `project:
 * ['update']` — CONTEXT.md puts assigning a Tag on the Project side, since the
 * write is keyed on the projectId and nothing in the `tag` statement is about a
 * Project. Delete is its own.
 *
 * They arrive as props because this is a plain function that builds column
 * declarations and cannot call a hook; the screen holds the `usePermission`
 * calls beside the dialogs it already holds.
 */
export type ProjectRowGrants = {
  /** `project: ['update']` — Rename, and the Tags picker. */
  update: boolean;
  /** `project: ['delete']`. */
  remove: boolean;
};

/**
 * The Projects list, one declaration per column (the reference's `viewProjects`,
 * e-console.html:3349-3388).
 *
 * **Two of the reference's columns are absent rather than empty.** It shows a
 * Services count and a Deploy targets list; neither is free here. An
 * Environment's services arrive with `GET /environments/:id`
 * — the *detail* read,
 * not the list — so a count on this table costs one request per Environment per
 * Project, on top of the one per row the Environments count already costs. An
 * `environment` row carries no server at all; the prototype marked its own deploy
 * target as proposed. A column of em dashes is not a column (F07's rule, in
 * `rows/server-row.tsx`), and neither is one that fans out.
 *
 * The Environments count and the Tags **are** here, and each costs one request
 * per row (`use-projects.ts`). Both render a Skeleton until their request lands:
 * a `0` while the count is in flight is the confident wrong answer.
 *
 * **The row menu is gated on what the caller's role carries**
 * All three items
 * used to open regardless, so a base member — who holds none of
 * `project: ['update', 'delete']` — could pick Tags, tick two labels, and get a
 * 403 from a dialog that had already told them the ticks were theirs to make.
 * The whole menu is gated rather than only the Tags picker the issue names:
 * these three sit a keystroke apart, and one live item beside two off ones reads
 * as a broken menu rather than as a role.
 */
export function projectColumns({
  environmentCounts,
  tagsByProject,
  grants,
  actions,
}: {
  environmentCounts: Map<string, number | undefined>;
  tagsByProject: Map<string, Tag[] | undefined>;
  grants: ProjectRowGrants;
  actions: ProjectRowActions;
}): Column<Project>[] {
  return [
    {
      id: "name",
      head: "Project",
      tone: "key",
      compare: (a, b) => a.name.localeCompare(b.name),
      cell: (row) => (
        <>
          <RowLink href={`/projects/${row.projectId}`}>{row.name}</RowLink>
          {row.description ? (
            <RowSub className="max-w-80">{row.description}</RowSub>
          ) : null}
        </>
      ),
    },
    {
      id: "environments",
      head: "Environments",
      tone: "num",
      compare: (a, b) =>
        (environmentCounts.get(a.projectId) ?? -1) -
        (environmentCounts.get(b.projectId) ?? -1),
      cell: (row) => {
        const count = environmentCounts.get(row.projectId);
        return count === undefined ? (
          <Skeleton className="ml-auto w-6" />
        ) : (
          count
        );
      },
    },
    {
      id: "tags",
      head: "Tags",
      cell: (row) => <TagChips tags={tagsByProject.get(row.projectId)} />,
    },
    {
      id: "created",
      head: "Created",
      compare: (a, b) => a.createdAt.localeCompare(b.createdAt),
      cell: (row) => <RowTime iso={row.createdAt} />,
    },
    {
      id: "actions",
      head: <span className="sr-only">Actions</span>,
      tone: "num",
      className: "w-11",
      cell: (row) => (
        <Menu
          align="end"
          trigger={
            <Button size="icon-xs" aria-label={`Actions for ${row.name}`}>
              <Icon name="sliders" size={15} />
            </Button>
          }
        >
          {/* `disabled` on `Menu.Item`, not `aria-disabled` by hand: Base UI's
              item renders a div and marks a disabled one `aria-disabled`,
              keeping it in the menu's roving focus so a keyboard user reaches it
              and hears the reason. `title` carries the same sentence to a
              pointer. The guarded `onClick` is belt and braces on the primitive
              swallowing the activation, and it is what the tests assert. */}
          <Menu.Group label={row.name}>
            <Menu.Item
              icon="pencil"
              disabled={!grants.update}
              title={grants.update ? undefined : PROJECT_UPDATE_REFUSAL}
              onClick={() => grants.update && actions.onRename(row)}
            >
              Rename
            </Menu.Item>
            <Menu.Item
              icon="tag"
              disabled={!grants.update}
              title={grants.update ? undefined : PROJECT_UPDATE_REFUSAL}
              onClick={() => grants.update && actions.onTags(row)}
            >
              Tags
            </Menu.Item>
          </Menu.Group>
          <Menu.Separator />
          <Menu.Item
            icon="trash"
            destructive
            disabled={!grants.remove}
            title={grants.remove ? undefined : PROJECT_DELETE_REFUSAL}
            onClick={() => grants.remove && actions.onDelete(row)}
          >
            Delete
          </Menu.Item>
        </Menu>
      ),
    },
  ];
}
