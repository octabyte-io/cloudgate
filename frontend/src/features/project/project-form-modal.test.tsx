import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/api-error";
import type { Project } from "@/lib/api/endpoints/projects";

const push = vi.fn();
const create = vi.fn();
const update = vi.fn();
const done = vi.fn();
const errorToast = vi.fn();

vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

vi.mock("@/lib/api/endpoints/projects", () => ({
  projectsApi: {
    create: (...args: unknown[]) => create(...args),
    update: (...args: unknown[]) => update(...args),
  },
}));

// The real one reaches the auth client for the active Organization, which is
// the whole session stack; what this test is about is where the dialog lands.
vi.mock("@/lib/api/use-invalidate", () => ({
  useInvalidate: () => ({ project: vi.fn() }),
}));

vi.mock("@/components/console/toast", () => ({
  toast: {
    done: (...args: unknown[]) => done(...args),
    error: (...args: unknown[]) => errorToast(...args),
  },
}));

const { ProjectFormModal } = await import("./project-form-modal");

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function open(project: Project | null, onOpenChange = vi.fn()) {
  render(
    <ProjectFormModal project={project} open onOpenChange={onOpenChange} />,
    { wrapper: Wrapper },
  );
  return onOpenChange;
}

beforeEach(() => {
  push.mockReset();
  create.mockReset();
  update.mockReset();
  done.mockReset();
  errorToast.mockReset();
});

afterEach(cleanup);

/** What a screen reader says after the input's name: its hint and its error. */
function descriptionOf(input: HTMLElement): string {
  return (input.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");
}

/**
 * The dialog says
 * "Its Environments and services come next" and the toast says "Add an
 * Environment to it", and a new Project has none — so the create lands on the
 * Project, whose first tab is where an Environment is made. The id is the one
 * `POST /projects` answered with, not anything the dialog knew beforehand.
 */
describe("ProjectFormModal", () => {
  it("creates the Project and lands on its Environments tab", async () => {
    create.mockResolvedValue({ projectId: "prj_new", name: "ui-main" });
    const onOpenChange = open(null);

    fireEvent.change(screen.getByLabelText(/Name/), {
      target: { value: "  ui-main  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Project" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/projects/prj_new"));
    expect(create).toHaveBeenCalledWith({ name: "ui-main", description: "" });
    expect(done).toHaveBeenCalledWith("Project ui-main created.", {
      description: "Add an Environment to it to start deploying.",
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("renames in place, without navigating anywhere", async () => {
    update.mockResolvedValue({ projectId: "prj_1", name: "renamed" });
    const onOpenChange = open({
      projectId: "prj_1",
      name: "before",
      description: "",
    } as Project);

    fireEvent.change(screen.getByLabelText(/Name/), {
      target: { value: "renamed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(update).toHaveBeenCalledWith("prj_1", {
      name: "renamed",
      description: "",
    });
    expect(push).not.toHaveBeenCalled();
  });

  it("stays put when the create is refused", async () => {
    const refusal = Object.assign(new Error("nope"), { status: 500 });
    create.mockRejectedValue(refusal);
    const onOpenChange = open(null);

    fireEvent.change(screen.getByLabelText(/Name/), {
      target: { value: "ui-main" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Project" }));

    await waitFor(() => expect(errorToast).toHaveBeenCalledWith(refusal));
    expect(push).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
  });
  /**
   * A Project's name is unique in its Organization, and the refusal is a
   * 409 about the name just typed — so it is said under Name, not above the
   * buttons or in a toast, on the create and on the rename alike.
   */
  it.each([
    ["create", null, "Create Project"],
    [
      "rename",
      { projectId: "prj_1", name: "before", description: "" },
      "Save changes",
    ],
  ] as const)(
    "says a taken name under Name on a %s",
    async (_verb, project, button) => {
      const conflict = new ApiError(
        409,
        "A Project with this name already exists in your organization",
      );
      create.mockRejectedValue(conflict);
      update.mockRejectedValue(conflict);
      const onOpenChange = open(project as Project | null);

      const name = screen.getByLabelText(/Name/);
      fireEvent.change(name, { target: { value: "ui-tags" } });
      fireEvent.click(screen.getByRole("button", { name: button }));

      await waitFor(() =>
        expect(descriptionOf(name)).toContain(
          "A Project with this name already exists in your organization",
        ),
      );
      expect(name.getAttribute("aria-invalid")).toBe("true");
      expect(errorToast).not.toHaveBeenCalled();
      expect(onOpenChange).not.toHaveBeenCalledWith(false);
      expect(push).not.toHaveBeenCalled();
    },
  );
});
