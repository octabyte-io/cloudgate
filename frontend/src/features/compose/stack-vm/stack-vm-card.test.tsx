import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ComposeDetail, StackVmFacts } from "@/lib/api/endpoints/compose";

vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission: () => ({ allowed: true, pending: false, role: "member" }),
}));
vi.mock("@/lib/api/use-invalidate", () => ({
  useInvalidate: () => ({ compose: vi.fn() }),
}));
vi.mock("@/components/console/toast", () => ({
  toast: { done: vi.fn(), error: vi.fn() },
}));
const saveStackVm = vi.hoisted(() => vi.fn(async () => ({})));
vi.mock("@/lib/api/endpoints/compose", async (original) => ({
  ...(await original<typeof import("@/lib/api/endpoints/compose")>()),
  composeApi: { saveStackVm },
}));

const { StackVmCard } = await import("./stack-vm-card");
const { ComposeFactsCard } = await import("../compose-facts-card");

afterEach(() => {
  cleanup();
  saveStackVm.mockClear();
});

const FACTS: StackVmFacts = {
  cloud: "aws",
  region: "eu-west-1",
  made: false,
  machineType: "t3.small",
  machine: "2 vCPU, 2 GB",
  sizeName: "medium",
  dataDiskGb: 20,
  snapshotDays: 7,
  console: { sizeName: null, dataDiskGb: null },
  monthlyUsd: 19.4,
};

function stack(facts: StackVmFacts | null): ComposeDetail {
  return {
    composeId: "cmp_1",
    name: "wiki",
    appName: "compose-wiki-x1",
    configName: "wiki",
    environmentId: "env_1",
    composeStatus: "idle",
    composeType: "docker-compose",
    sourceType: "raw",
    composePath: "./docker-compose.yml",
    isolatedDeployment: false,
    createdAt: "2026-11-10T10:00:00.000Z",
    serverId: null,
    server: null,
    environment: {
      environmentId: "env_1",
      name: "production",
      project: { projectId: "prj_1", name: "Shop" },
    },
    // A stack with Stack VM facts is in a Cloud account, as the API answers.
    cloudAccountId: facts ? "ca_1" : null,
    region: facts?.region ?? null,
    stackVmFacts: facts,
  } as unknown as ComposeDetail;
}

function renderCard(facts: StackVmFacts | null) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <StackVmCard compose={stack(facts)} />
    </QueryClientProvider>,
  );
}

/**
 * The stack page's Stack VM (#1372, ADR-0070): its machine type with CPU
 * and memory, its data disk and price, whether the plan has made it, and
 * the size and disk settings its next plan applies.
 */
describe("StackVmCard", () => {
  it("shows the machine type, data disk, cost, and that its plan is still to be applied", () => {
    renderCard(FACTS);

    expect(screen.getByText("t3.small (2 vCPU, 2 GB)")).toBeTruthy();
    expect(
      screen.getByText("20 GB, snapshotted daily, each snapshot kept 7 days"),
    ).toBeTruthy();
    expect(screen.getByText("About $19.40 a month")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "plan" }).getAttribute("href"),
    ).toBe("/projects/prj_1/config");
  });

  it("is absent on a stack with no Stack VM", () => {
    renderCard(null);
    expect(screen.queryByText("Stack VM")).toBeNull();
  });

  it("saves the size and a grown data disk as the stack's own setting", async () => {
    renderCard({ ...FACTS, made: true });

    fireEvent.change(screen.getByLabelText(/Data disk \(GB\)/), {
      target: { value: "50" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));

    await waitFor(() =>
      expect(saveStackVm).toHaveBeenCalledWith("cmp_1", {
        size: "medium",
        dataDiskGb: 50,
      }),
    );
  });

  it("refuses a data disk smaller than the one it has", async () => {
    renderCard({ ...FACTS, made: true, dataDiskGb: 40 });

    fireEvent.change(screen.getByLabelText(/Data disk \(GB\)/), {
      target: { value: "30" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));

    expect(
      await screen.findByText(/The data disk only grows: it has 40 GB/),
    ).toBeTruthy();
    expect(saveStackVm).not.toHaveBeenCalled();
  });

  it("starts the size at the one set in the console", () => {
    renderCard({ ...FACTS, console: { sizeName: "large", dataDiskGb: null } });
    expect(screen.getByText("large")).toBeTruthy();
  });
});

describe("ComposeFactsCard, a stack on its Stack VM", () => {
  it("says it runs on its Stack VM, never a Server or this host", () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <ComposeFactsCard compose={stack({ ...FACTS, made: true })} />
      </QueryClientProvider>,
    );

    expect(
      screen.getByText("Its Stack VM, t3.small in eu-west-1"),
    ).toBeTruthy();
    expect(screen.queryByText("Server")).toBeNull();
    expect(screen.queryByText("This Cloudgate host")).toBeNull();
  });
});
