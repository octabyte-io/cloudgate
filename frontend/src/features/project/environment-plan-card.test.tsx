import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Environment } from "@/lib/api/endpoints/environments";

const TEXT = "services:\n  web:\n    kind: web\n";
const FILE_URL = "https://github.com/acme/shop/blob/release/cloudgate.yaml";

const idle = { mutate: vi.fn(), isPending: false, error: null };

// The reads are the boundary: the Environment's copy as its Config branch has
// it, its plan, the Cloud accounts and the caller's statements. CodeMirror is a
// `next/dynamic` island jsdom cannot run, so a textarea stands in for it.
vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission: () => ({ allowed: true, pending: false, role: "member" }),
}));
vi.mock("@/lib/api/use-config-copy", async (original) => ({
  ...(await original<typeof import("@/lib/api/use-config-copy")>()),
  useEnvironmentConfigCopy: () => ({
    data: {
      kind: "repository",
      environmentId: "env-1",
      repository: "acme/shop",
      path: "cloudgate.yaml",
      configBranch: "release",
      copy: { text: TEXT, commitSha: "4f2c9e1aa0", branch: "release", fileUrl: FILE_URL },
      refusal: null,
      services: [],
    },
    isPending: false,
    error: null,
  }),
}));
vi.mock("@/lib/api/use-cloud-accounts", async (original) => ({
  ...(await original<typeof import("@/lib/api/use-cloud-accounts")>()),
  useCloudAccounts: () => ({ data: [] }),
}));
vi.mock("./use-project-config", async (original) => ({
  ...(await original<typeof import("./use-project-config")>()),
  usePlan: () => ({ data: { plan: null }, isPending: false, error: null }),
  useRequestPlan: () => idle,
  useDismissPlan: () => idle,
  useApplyPlan: () => idle,
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

const { EnvironmentPlanCard } = await import("./environment-plan-card");

afterEach(cleanup);

const environment = {
  environmentId: "env-1",
  name: "Production",
  configBranch: "release",
  deployTarget: { kind: "server", serverId: "srv-1" },
} as unknown as Environment;

/**
 * Expand (spec #118) on an Environment's copy of a repository-kept config:
 * the same file filling the window, read-only, as the card shows it.
 */
describe("EnvironmentPlanCard — Expand", () => {
  function expanded() {
    render(
      <EnvironmentPlanCard
        projectId="prj-1"
        environment={environment}
        serverNames={{}}
        repositoryKept
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Expand" }));
    const dialog = screen.getByRole("dialog");
    return { dialog, view: within(dialog).getByLabelText("Project config on release") };
  }

  it("opens the Environment's copy read-only, with the Environment, the file, the commit and its YAML status", () => {
    const { dialog, view } = expanded();

    expect(within(dialog).getByRole("heading", { name: "Project config" })).toBeTruthy();
    expect(dialog.textContent).toContain("Production");
    expect(dialog.textContent).toContain("cloudgate.yaml");
    expect(dialog.textContent).toContain("4f2c9e1");
    expect(dialog.textContent).toContain("Valid YAML");
    expect((view as HTMLTextAreaElement).value).toBe(TEXT);
    expect((view as HTMLTextAreaElement).readOnly).toBe(true);
    expect(within(dialog).queryByText("Unsaved changes")).toBeNull();
  });

  it("links to the file where it is changed", () => {
    const { dialog } = expanded();
    expect(
      within(dialog).getByRole("link", { name: "Open the file" }).getAttribute("href"),
    ).toBe(FILE_URL);
  });

  it("closes on Back to page", async () => {
    const { dialog } = expanded();
    fireEvent.click(within(dialog).getByRole("button", { name: "Back to page" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
