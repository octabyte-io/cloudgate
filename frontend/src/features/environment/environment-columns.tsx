import type { Column } from "@/components/console/data-table";
import { Menu } from "@/components/console/menu";
import { RowLink, RowSub, RowTime } from "@/components/console/rows/cells";
import { Button } from "@/components/ui/button";
import type { Environment } from "@/lib/api/endpoints/environments";
import { Icon } from "@/lib/design/icons";

import { countVariables } from "@/lib/format/env-blob";

import {
  ENVIRONMENT_DELETE_REFUSAL,
  ENVIRONMENT_UPDATE_REFUSAL,
} from "./use-environments";

/**
 * Which of the row menu's two items the caller's role can reach:
 * `update` is `environment: ['update']` (Rename), `remove` is
 * `environment: ['delete']` (Delete). Props, because this builds column
 * declarations and cannot call a hook — the Environments panel reads them.
 */
export type EnvironmentRowGrants = {
  update: boolean;
  remove: boolean;
};

/**
 * A Project's Environments, one declaration per column (the reference's
 * `viewProject`, e-console.html:3882-3897).
 *
 * **Three of the reference's five columns are absent, each for its own reason.**
 * Runtime read `environment.runtime`, which the prototype itself marked as
 * proposed and the schema does not have. Deploy target is a column now,
 * but it says only where a *new* Service lands, not where this Environment
 * runs, so a list column would read as the latter; it lives on the Settings
 * tab, where the hint beside it says so. Services is the interesting one:
 * `GET /environments/:id` carries them
 * and the **list** route
 * this table reads does not, so a count here — and the status roll-up over it —
 * would cost one detail read per row. That is a fan-out to decide on its own
 * merits, not something to slip into a column; the Services tab has the real list.
 *
 * What is left is real, and the Variables count is free — it is parsed from the
 * blob already on the row rather than fetched.
 *
 * The description rides under the name the way a Project's does in the Projects
 * list, and is the
 * only place a name like `blue` or `pr-482` gets to say what it is for.
 */
export function environmentColumns({
  grants,
  onRename,
  onDelete,
}: {
  grants: EnvironmentRowGrants;
  onRename: (environment: Environment) => void;
  onDelete: (environment: Environment) => void;
}): Column<Environment>[] {
  return [
    {
      id: "name",
      head: "Environment",
      tone: "key",
      compare: (a, b) => a.name.localeCompare(b.name),
      cell: (row) => (
        <>
          <RowLink href={`/environments/${row.environmentId}`}>
            {row.name}
          </RowLink>
          {row.description ? (
            <RowSub className="max-w-80">{row.description}</RowSub>
          ) : null}
        </>
      ),
    },
    {
      id: "variables",
      head: "Variables",
      tone: "num",
      compare: (a, b) => countVariables(a.env) - countVariables(b.env),
      cell: (row) => countVariables(row.env),
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
          {/* `disabled` on `Menu.Item` is `aria-disabled` in the DOM, so an
              off item keeps its place in the roving focus and `title` carries
              the reason; the guarded `onClick` is what a forced press meets,
              as on the Projects list's row menu. */}
          <Menu.Group label={row.name}>
            <Menu.Item
              icon="pencil"
              disabled={!grants.update}
              title={grants.update ? undefined : ENVIRONMENT_UPDATE_REFUSAL}
              onClick={() => grants.update && onRename(row)}
            >
              Rename
            </Menu.Item>
          </Menu.Group>
          <Menu.Separator />
          <Menu.Item
            icon="trash"
            destructive
            disabled={!grants.remove}
            title={grants.remove ? undefined : ENVIRONMENT_DELETE_REFUSAL}
            onClick={() => grants.remove && onDelete(row)}
          >
            Delete
          </Menu.Item>
        </Menu>
      ),
    },
  ];
}
