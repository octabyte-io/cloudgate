import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Project } from "@/lib/api/endpoints/projects";

import { ProjectChoice } from "./project-choice";
import { NEW_PROJECT } from "./use-templates";

afterEach(cleanup);

const project = (projectId: string, name: string, description = "") =>
  ({ projectId, name, description }) as unknown as Project;

describe("ProjectChoice", () => {
  it("shows New Project and each Project as a card, with its description", () => {
    const onChange = vi.fn();
    render(
      <ProjectChoice
        projects={[
          project("prj-1", "Storefront", "Customer-facing shop"),
          project("prj-2", "Internal tools"),
        ]}
        pending={false}
        value="prj-1"
        onChange={onChange}
      />,
    );

    expect(screen.getByText("Customer-facing shop")).toBeTruthy();
    expect(screen.getByText("An existing Project")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: /Storefront/ })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /New Project/ }));
    expect(onChange).toHaveBeenCalledWith(NEW_PROJECT);
  });

  it("is one picker past five Projects", () => {
    render(
      <ProjectChoice
        projects={Array.from({ length: 6 }, (_, at) =>
          project(`prj-${at}`, `Project ${at}`),
        )}
        pending={false}
        value={null}
        onChange={vi.fn()}
      />,
    );

    expect(screen.queryByRole("button", { name: /New Project/ })).toBeNull();
    expect(screen.getByRole("combobox")).toBeTruthy();
  });
});
