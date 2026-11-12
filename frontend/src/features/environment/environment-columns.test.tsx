import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DataTable } from "@/components/console/data-table";
import type { Environment } from "@/lib/api/endpoints/environments";

import {
  environmentColumns,
  type EnvironmentRowGrants,
} from "./environment-columns";
import {
  ENVIRONMENT_DELETE_REFUSAL,
  ENVIRONMENT_UPDATE_REFUSAL,
} from "./use-environments";

const environment = {
  environmentId: "e1",
  projectId: "p1",
  name: "staging",
  description: "Where a change is tried first.",
  env: "",
  createdAt: "2026-01-01T00:00:00.000Z",
} as unknown as Environment;

afterEach(cleanup);

/**
 * Which of a Project's Environment row actions a role can open.
 *
 * Rename is `PATCH /environments/:id`, whose `findOwnedForUpdate` asks for
 * `environment: ['update']`; Delete is `DELETE /environments/:id`, decorated
 * `environment: ['delete']`. The built-in member holds the first and not the
 * second, so the two are separate booleans.
 *
 * Rendered through `DataTable`, as `project-columns.test.tsx` is, because the
 * menu is Base UI's and it decides what `disabled` becomes in the DOM.
 */
function mount(grants: EnvironmentRowGrants) {
  const actions = { onRename: vi.fn(), onDelete: vi.fn() };

  render(
    <DataTable<Environment>
      label="Environments"
      rows={[environment]}
      getRowId={(row) => row.environmentId}
      columns={environmentColumns({ grants, ...actions })}
    />,
  );

  fireEvent.click(screen.getByRole("button", { name: "Actions for staging" }));

  return {
    actions,
    item: (name: string) => screen.getByRole("menuitem", { name }),
  };
}

describe("environmentColumns", () => {
  it("holds Rename and Delete off for a role that holds neither statement, and says why", () => {
    const { actions, item } = mount({ update: false, remove: false });

    for (const [name, reason] of [
      ["Rename", ENVIRONMENT_UPDATE_REFUSAL],
      ["Delete", ENVIRONMENT_DELETE_REFUSAL],
    ] as const) {
      const row = item(name);
      // §3.10 — `aria-disabled`, so it stays in the menu's roving focus.
      expect(row.getAttribute("aria-disabled")).toBe("true");
      expect(row.getAttribute("title")).toBe(reason);
      fireEvent.click(row);
    }

    expect(actions.onRename).not.toHaveBeenCalled();
    expect(actions.onDelete).not.toHaveBeenCalled();
  });

  it("opens both for a role that holds both", () => {
    const { actions, item } = mount({ update: true, remove: true });

    for (const name of ["Rename", "Delete"]) {
      expect(item(name).getAttribute("aria-disabled")).not.toBe("true");
      expect(item(name).hasAttribute("title")).toBe(false);
    }

    fireEvent.click(item("Delete"));
    expect(actions.onDelete).toHaveBeenCalledWith(environment);
  });

  it("gates Delete on its own statement: the member renames and does not delete", () => {
    const { actions, item } = mount({ update: true, remove: false });

    expect(item("Rename").getAttribute("aria-disabled")).not.toBe("true");
    expect(item("Delete").getAttribute("aria-disabled")).toBe("true");

    fireEvent.click(item("Delete"));
    expect(actions.onDelete).not.toHaveBeenCalled();
  });
});
