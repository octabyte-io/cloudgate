import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DataTable } from "@/components/console/data-table";
import type { Project } from "@/lib/api/endpoints/projects";

import { projectColumns, type ProjectRowGrants } from "./project-columns";
import { PROJECT_DELETE_REFUSAL, PROJECT_UPDATE_REFUSAL } from "./use-projects";

const project = {
  projectId: "p1",
  name: "Storefront",
  description: "What customers see.",
  createdAt: "2026-01-01T00:00:00.000Z",
} as unknown as Project;

afterEach(cleanup);

/**
 * Which of the Projects list's three row actions a role can open.
 *
 * The Tags picker is the one that broke — both `projectTag` verbs are
 * `project: ['update']`, and the dialog opened for anybody, took two
 * ticks and then 403'd. Rename is the same statement through a different door
 * and Delete is its own, so all three are here: the interesting failure is a
 * menu that gates one of them and not its neighbours.
 *
 * Rendered through `DataTable` rather than by calling the column's `cell`
 * directly, because the menu is Base UI's and it is the primitive, not this
 * file, that decides what `disabled` becomes in the DOM.
 */
function mount(grants: ProjectRowGrants) {
  const actions = {
    onRename: vi.fn(),
    onTags: vi.fn(),
    onDelete: vi.fn(),
  };

  render(
    <DataTable<Project>
      label="Projects"
      rows={[project]}
      getRowId={(row) => row.projectId}
      columns={projectColumns({
        environmentCounts: new Map([["p1", 2]]),
        tagsByProject: new Map([["p1", []]]),
        grants,
        actions,
      })}
    />,
  );

  fireEvent.click(
    screen.getByRole("button", { name: "Actions for Storefront" }),
  );

  return {
    actions,
    item: (name: string) => screen.getByRole("menuitem", { name }),
  };
}

describe("projectColumns", () => {
  it("holds Rename, Tags and Delete off for a role that holds neither statement", () => {
    const { actions, item } = mount({ update: false, remove: false });

    for (const [name, reason] of [
      ["Rename", PROJECT_UPDATE_REFUSAL],
      ["Tags", PROJECT_UPDATE_REFUSAL],
      ["Delete", PROJECT_DELETE_REFUSAL],
    ] as const) {
      const row = item(name);
      // §3.10 — an off action, so `aria-disabled` and not the native attribute:
      // a menu item that leaves the roving focus is one nobody can ask about.
      expect(row.getAttribute("aria-disabled")).toBe("true");
      expect(row.getAttribute("title")).toBe(reason);
      fireEvent.click(row);
    }

    expect(actions.onRename).not.toHaveBeenCalled();
    expect(actions.onTags).not.toHaveBeenCalled();
    expect(actions.onDelete).not.toHaveBeenCalled();
  });

  it("opens all three for a role that holds both", () => {
    const { actions, item } = mount({ update: true, remove: true });

    for (const name of ["Rename", "Tags", "Delete"]) {
      expect(item(name).getAttribute("aria-disabled")).not.toBe("true");
      expect(item(name).hasAttribute("title")).toBe(false);
    }

    fireEvent.click(item("Tags"));
    expect(actions.onTags).toHaveBeenCalledWith(project);
  });

  it("gates Delete on its own statement rather than on the Project write", () => {
    // The two are separate grants and a licensed custom role can hold either
    // without the other, so one boolean for both would be wrong in one
    // direction for that role.
    const { actions, item } = mount({ update: true, remove: false });

    expect(item("Tags").getAttribute("aria-disabled")).not.toBe("true");
    expect(item("Delete").getAttribute("aria-disabled")).toBe("true");

    fireEvent.click(item("Delete"));
    expect(actions.onDelete).not.toHaveBeenCalled();
  });
});
