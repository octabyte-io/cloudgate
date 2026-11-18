import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const usePermission = vi.hoisted(() => vi.fn());
const save = vi.hoisted(() => ({
  mutate: vi.fn(),
  reset: vi.fn(),
  isPending: false,
  error: null as unknown,
  data: undefined as unknown,
}));

const STORED = "services:\n  web:\n    kind: web\n";
const EDITED = "services:\n  web:\n    kind: web\n    replicas: 2\n";

// The reads and the save are the boundary: the config, its Project, the
// Environments and Servers it is planned against, and the caller's
// statements. CodeMirror is a `next/dynamic` island jsdom cannot run, so a
// textarea stands in for it.
vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission,
}));
vi.mock("../use-project-config", async (original) => ({
  ...(await original<typeof import("../use-project-config")>()),
  useProjectConfig: () => ({
    data: {
      projectId: "prj-1",
      location: {
        kind: "cloudgate",
        text: STORED,
        textHash: "h1",
        updatedAt: "2026-11-01T00:00:00.000Z",
        movedOutOf: null,
      },
    },
    isPending: false,
    error: null,
  }),
  useSaveProjectConfig: () => save,
}));
vi.mock("../use-projects", async (original) => ({
  ...(await original<typeof import("../use-projects")>()),
  useProject: () => ({ data: { projectId: "prj-1", name: "shop" } }),
}));
vi.mock("@/features/environment/use-environments", async (original) => ({
  ...(await original<typeof import("@/features/environment/use-environments")>()),
  useEnvironments: () => ({ data: [], error: null }),
}));
vi.mock("@/lib/api/use-servers", async (original) => ({
  ...(await original<typeof import("@/lib/api/use-servers")>()),
  useServers: () => ({ data: [] }),
}));
vi.mock("@/components/console/code-editor", () => ({
  CodeEditor: ({
    label,
    value,
    onChange,
  }: {
    label: string;
    value: string;
    onChange?: (next: string) => void;
  }) => (
    <textarea
      aria-label={label}
      value={value}
      readOnly={onChange === undefined}
      onChange={(event) => onChange?.(event.target.value)}
    />
  ),
}));

const { default: Panel } = await import("./config");
const { PLAN_REQUEST_REFUSAL } = await import("../use-project-config");

afterEach(() => {
  cleanup();
  usePermission.mockReset();
  save.mutate.mockClear();
  save.data = undefined;
});

function expanded({ allowed }: { allowed: boolean }) {
  usePermission.mockReturnValue({ allowed, pending: false, role: "member" });
  render(
    <QueryClientProvider client={new QueryClient()}>
      <Panel id="prj-1" kind={null} label="Config" icon="list" />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Expand Project config" }));
  const dialog = screen.getByRole("dialog");
  return { dialog, editor: within(dialog).getByLabelText("Project config") };
}

/**
 * Expand (spec #118): the Project config filling the window, planned from its
 * top bar by the card's own Save and plan, so its gate holds there too.
 */
describe("ConfigEditorCard — Expand", () => {
  it("opens the config with its title, its Project's name, Save and plan and its YAML status", () => {
    const { dialog, editor } = expanded({ allowed: true });

    expect(within(dialog).getByRole("heading", { name: "Project config" })).toBeTruthy();
    expect(dialog.textContent).toContain("shop");
    expect(within(dialog).getByRole("button", { name: "Save and plan" })).toBeTruthy();
    expect(dialog.textContent).toContain("Valid YAML");
    expect((editor as HTMLTextAreaElement).value).toBe(STORED);
  });

  it("plans the edit from the top bar", () => {
    const { dialog, editor } = expanded({ allowed: true });
    fireEvent.change(editor, { target: { value: EDITED } });
    expect(within(dialog).getByText("Unsaved changes")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Discard edits" })).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Save and plan" }));

    expect(save.mutate).toHaveBeenCalledWith({ text: EDITED });
  });

  it("says on its status line that a plan from the top bar was made and nothing applied", () => {
    // The save as it stands once the plan request has answered.
    save.data = { stored: false };
    const { dialog, editor } = expanded({ allowed: true });
    fireEvent.change(editor, { target: { value: EDITED } });

    fireEvent.click(within(dialog).getByRole("button", { name: "Save and plan" }));

    expect(save.mutate).toHaveBeenCalledWith({ text: EDITED });
    expect(dialog.textContent).toContain("Planned in each Environment. Nothing is applied.");
    // Still open: the result is read where the save was made.
    expect(screen.getByRole("dialog")).toBe(dialog);
  });

  it("says when the edit is not valid YAML", () => {
    const { dialog, editor } = expanded({ allowed: true });
    fireEvent.change(editor, { target: { value: "services: [\n" } });

    expect(dialog.textContent).toContain("Not valid YAML");
  });

  it("closes on Back to page, and the edit stays in the card", async () => {
    const { dialog, editor } = expanded({ allowed: true });
    fireEvent.change(editor, { target: { value: EDITED } });

    fireEvent.click(within(dialog).getByRole("button", { name: "Back to page" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect((screen.getByLabelText("Project config") as HTMLTextAreaElement).value).toBe(EDITED);
  });

  it("is off in the top bar with the reason for a role that cannot plan", () => {
    const { dialog, editor } = expanded({ allowed: false });
    fireEvent.change(editor, { target: { value: EDITED } });

    const button = within(dialog).getByRole("button", { name: "Save and plan" });
    expect(button.hasAttribute("disabled") || button.getAttribute("aria-disabled") === "true").toBe(true);
    expect(button.getAttribute("title")).toBe(PLAN_REQUEST_REFUSAL);
    fireEvent.click(button);
    expect(save.mutate).not.toHaveBeenCalled();
  });
});
