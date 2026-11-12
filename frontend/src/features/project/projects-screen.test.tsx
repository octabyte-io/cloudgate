import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Project } from "@/lib/api/endpoints/projects";
import type { Tag } from "@/lib/api/endpoints/tags";

const PROJECTS = [
  { projectId: "prj_a", name: "alpha", description: "" },
  { projectId: "prj_b", name: "bravo", description: "" },
  { projectId: "prj_c", name: "charlie", description: "" },
] as Project[];

const ghost = { tagId: "tag_ghost", name: "ghost" } as Tag;

// What `GET /tags` answers with right now; a test swaps it to play a delete.
let orgTags: Tag[] = [];
// What `GET /projects` answers with; a test empties it to play a first run.
let projects: Project[] = PROJECTS;

vi.mock("./use-projects", () => ({
  PROJECT_CREATE_REFUSAL: "",
  useProjects: () => ({ data: projects, isPending: false, error: null }),
  useEnvironmentCounts: () => new Map(),
  // No Project carries a Tag, so any live filter shows nothing.
  useProjectTags: () => new Map(PROJECTS.map((each) => [each.projectId, []])),
}));

vi.mock("@/features/tags/use-tags", () => ({
  useTags: () => ({ data: orgTags }),
}));

vi.mock("@/lib/auth/use-permission", () => ({
  usePermission: () => ({ allowed: true }),
}));

// The dialogs and the aside reach the session stack; this is about the list.
vi.mock("./project-dialogs", () => ({ ProjectDialogs: () => null }));
vi.mock("./hierarchy-card", () => ({ HierarchyCard: () => <p>The hierarchy</p> }));

const { ProjectsScreen } = await import("./projects-screen");

const trigger = () => screen.getByRole("button", { name: /^Filter by tag/ });
const rowNames = () =>
  PROJECTS.map((each) => each.name).filter((name) => screen.queryByText(name));

beforeEach(() => {
  orgTags = [ghost];
  projects = PROJECTS;
});

afterEach(cleanup);

/**
 * The filter's
 * selection outlived the Tag it named. Deleting a ticked Tag left its id in
 * the screen's state, so the trigger kept counting it, nothing was ticked, and
 * every Project was hidden — and with no Tags left the popover had no Clear
 * filter, so only a reload brought the list back.
 */
describe("ProjectsScreen's tag filter", () => {
  it("stops counting and filtering by a Tag once it is deleted", () => {
    const { rerender } = render(<ProjectsScreen />);

    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole("checkbox"));
    expect(trigger().getAttribute("aria-label")).toBe(
      "Filter by tag, 1 selected",
    );
    expect(rowNames()).toEqual([]);

    // Manage tags → Delete, and the list refetches without it.
    orgTags = [];
    rerender(<ProjectsScreen />);

    expect(trigger().getAttribute("aria-label")).toBe(
      "Filter by tag, 0 selected",
    );
    expect(rowNames()).toEqual(["alpha", "bravo", "charlie"]);
    expect(screen.getByText(/Projects here\./)).toBeTruthy();
  });
});

/**
 * The hierarchy aside is first-run help. Beside a list of Projects it was
 * a permanent paragraph, and the rail already shows the hierarchy.
 */
describe("ProjectsScreen's hierarchy aside", () => {
  it("is shown while the Organization has no Project", () => {
    projects = [];
    render(<ProjectsScreen />);
    expect(screen.getByRole("complementary", { name: "About Projects" })).toBeTruthy();
    expect(screen.getByText("The hierarchy")).toBeTruthy();
  });

  it("is gone once there is one", () => {
    render(<ProjectsScreen />);
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(screen.queryByText("The hierarchy")).toBeNull();
  });
});
