import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/api-error";
import type { OperatorOrphanMachine } from "@/lib/api/endpoints/operator";

const api = vi.hoisted(() => ({
  orphanMachines: vi.fn(),
  deleteOrphanMachine: vi.fn(),
}));
const invalidated = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api/endpoints/operator", () => ({ operatorApi: api }));
vi.mock("@/lib/api/use-invalidate", () => ({
  useInvalidate: () => ({ operatorBoughtServers: invalidated }),
}));

const { OrphanMachinesSection } = await import("./orphan-machines-section");

afterEach(() => {
  cleanup();
  api.orphanMachines.mockReset();
  api.deleteOrphanMachine.mockReset();
  invalidated.mockReset();
});

const LOST: OperatorOrphanMachine = {
  providerServerId: 4242,
  name: "cloudgate-lost",
  location: "hel1",
  labels: {
    "cloudgate-organization": "org-hopper",
    "cloudgate-server": "lostserver000001",
  },
  createdAt: "2026-11-01T09:00:00.000Z",
  foundAt: "2026-11-10T10:51:00.000Z",
  seenAt: "2026-11-10T12:51:00.000Z",
};

function renderSection(machines: OperatorOrphanMachine[] = [LOST]) {
  api.orphanMachines.mockResolvedValue(machines);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <OrphanMachinesSection />
    </QueryClientProvider>,
  );
}

async function rowOf(name: string): Promise<HTMLElement> {
  const table = await screen.findByRole("table", {
    name: "Machines nothing owns",
  });
  return within(table).getByText(name).closest("tr") as HTMLElement;
}

async function openDelete() {
  fireEvent.click(
    within(await rowOf("cloudgate-lost")).getByRole("button", {
      name: "Delete",
    }),
  );
  return screen.findByRole("dialog");
}

/**
 * The Operator page's Machines nothing owns (#1402): what the hourly check
 * found, with its labels and age, and Delete after the machine's name is
 * typed.
 */
describe("OrphanMachinesSection", () => {
  it("lists each machine with its id, Location, labels and age", async () => {
    renderSection();

    const row = await rowOf("cloudgate-lost");
    expect(row.textContent).toContain("4242");
    expect(row.textContent).toContain("hel1");
    expect(row.textContent).toContain("cloudgate-organization=org-hopper");
    expect(row.textContent).toContain("cloudgate-server=lostserver000001");
    expect(
      within(row)
        .getAllByRole("time")
        .map((time) => time.getAttribute("datetime")),
    ).toContain("2026-11-01T09:00:00.000Z");
  });

  it("says when the check found none", async () => {
    renderSection([]);

    expect(await screen.findByText("No machines nothing owns")).toBeTruthy();
  });

  it("deletes a machine once its name is typed, and refreshes the list", async () => {
    api.deleteOrphanMachine.mockResolvedValue(undefined);
    renderSection();

    const dialog = await openDelete();
    const button = within(dialog).getByRole("button", {
      name: "Delete this machine",
    });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(dialog.textContent).toContain("Volume");
    expect(dialog.textContent).toContain("Primary IPs");

    fireEvent.change(within(dialog).getByRole("textbox"), {
      target: { value: "cloudgate-lost" },
    });
    fireEvent.click(button);

    await waitFor(() =>
      expect(api.deleteOrphanMachine).toHaveBeenCalledWith(4242),
    );
    await waitFor(() => expect(invalidated).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("keeps the refusal in the dialog", async () => {
    api.deleteOrphanMachine.mockRejectedValue(
      new ApiError(
        409,
        "Machine 4242 belongs to a live Bought Server now, so it was not deleted",
      ),
    );
    renderSection();

    const dialog = await openDelete();
    fireEvent.change(within(dialog).getByRole("textbox"), {
      target: { value: "cloudgate-lost" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Delete this machine" }),
    );

    expect(
      await within(dialog).findByText(/belongs to a live Bought Server now/),
    ).toBeTruthy();
  });
});
