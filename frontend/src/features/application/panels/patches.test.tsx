import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Application, SourceType } from "@/lib/api/endpoints/applications";

/** The Application this render is about. Set per case. */
let sourceType: SourceType = "docker";

vi.mock("../use-application", () => ({
  useApplication: () => ({
    // Each source column set, so whichever type a case picks has a source.
    data: {
      applicationId: "app_1",
      sourceType,
      dockerImage: "nginx:latest",
      dropBuildPath: "/",
    } as Application,
  }),
}));

const mutation = () => ({ isPending: false, mutateAsync: vi.fn() });
vi.mock("../advanced/use-patches", () => ({
  usePatches: () => ({ data: [], isPending: false, error: null }),
  usePatchMutations: () => ({
    create: mutation(),
    update: mutation(),
    toggle: mutation(),
    remove: mutation(),
    saveFile: mutation(),
    markForDeletion: mutation(),
    ensureRepo: mutation(),
  }),
  useRepoDirectories: () => ({ data: undefined, isPending: false, error: null }),
  useRepoFile: () => ({ data: undefined, original: undefined, isPending: false, error: null }),
}));

vi.mock("@/components/console/resource-list", () => ({
  // The list's own rendering is `ResourceList`'s business; what matters here is
  // whether the panel offers it (and with it, "Add a patch") at all.
  ResourceList: ({ spec }: { spec: { addLabel: string } }) => (
    <button type="button">{spec.addLabel}</button>
  ),
}));

vi.mock("@/components/console/toast", () => ({
  toast: { done: vi.fn(), error: vi.fn() },
}));

const { default: Panel } = await import("./patches");

/**
 * The Patches tab tells the truth about what a patch can do for this source.
 * A Docker image is never built, so a patch is a row no build reads, and
 * the tab used to offer Add and toast "Repository cloned" over nothing.
 */

afterEach(cleanup);

function renderPanel(next: SourceType) {
  sourceType = next;
  render(<Panel id="app_1" kind={null} label="Patches" icon="pencil" />);
}

describe("Patches panel", () => {
  it("explains that patches do not apply to a Docker image and offers neither Add nor Clone", () => {
    renderPanel("docker");

    expect(screen.getByText("Patches do not apply to a Docker image")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add a patch" })).toBeNull();
    expect(screen.queryByRole("button", { name: /clone/i })).toBeNull();
  });

  it("keeps Add for uploaded files, whose builds are patched, and offers no Clone", () => {
    renderPanel("drop");

    expect(screen.getByRole("button", { name: "Add a patch" })).toBeTruthy();
    expect(screen.getByText("There is no repository to browse")).toBeTruthy();
    expect(screen.getByText(/source is uploaded files/)).toBeTruthy();
    expect(screen.queryByText(/Docker image/)).toBeNull();
    expect(screen.queryByRole("button", { name: /clone/i })).toBeNull();
  });

  it("offers Add and Clone for a git source", () => {
    renderPanel("github");

    expect(screen.getByRole("button", { name: "Add a patch" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Clone the source/ })).toBeTruthy();
  });
});
