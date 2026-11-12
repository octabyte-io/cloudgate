import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  BoughtServerView,
  SizeChoice,
} from "@/lib/api/endpoints/bought-servers";

const api = vi.hoisted(() => ({
  sizes: vi.fn(),
  setSize: vi.fn(),
}));
const allowed = vi.hoisted(() => ({ current: true }));
const toast = vi.hoisted(() => ({
  done: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));

vi.mock("@/lib/auth/client", () => ({
  useActiveOrganizationId: () => ({ organizationId: "org-1" }),
}));
vi.mock("@/lib/api/endpoints/bought-servers", () => ({
  boughtServersApi: api,
}));
vi.mock("@/lib/api/use-invalidate", () => ({
  useInvalidate: () => ({ billing: () => Promise.resolve() }),
}));
vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission: () => ({ allowed: allowed.current, pending: false }),
}));
vi.mock("@/components/console/toast", () => ({ toast }));

const { BoughtServerSizeRow, SIZE_DOWNTIME_WARNING, SIZE_DISK_NOTE } =
  await import("./bought-server-size");

const VIEW: BoughtServerView = {
  id: "abc",
  name: "web-1",
  stage: "ready",
  backups: true,
  storageGb: null,
  lines: [
    { kind: "server", monthlyCents: 900 },
    { kind: "backups", monthlyCents: 200 },
  ],
  monthlyCents: 1100,
  backupsOfferCents: null,
  change: null,
};

const SMALL: SizeChoice = {
  id: "cx23",
  family: "shared",
  vcpus: 2,
  memoryGb: 4,
  diskGb: 40,
  monthlyCents: 900,
  backupsMonthlyCents: 200,
  available: true,
  smallerDisk: false,
  current: true,
};
const BIG: SizeChoice = {
  id: "cpx22",
  family: "amd",
  vcpus: 3,
  memoryGb: 4,
  diskGb: 80,
  monthlyCents: 2500,
  backupsMonthlyCents: 500,
  available: true,
  smallerDisk: false,
  current: false,
};

function renderRow(view = VIEW, why: string | null = null) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <BoughtServerSizeRow view={view} why={why} />
    </QueryClientProvider>,
  );
}

async function openPicker() {
  // The sizes are in once the row names the current one.
  await screen.findByText(/vCPU/);
  const button = screen.getByRole("button", { name: "Change size" });
  expect(button.getAttribute("aria-disabled")).not.toBe("true");
  fireEvent.click(button);
}

beforeEach(() => {
  allowed.current = true;
  api.sizes.mockResolvedValue([SMALL, BIG]);
});

afterEach(() => {
  cleanup();
  api.sizes.mockReset();
  api.setSize.mockReset();
  toast.done.mockReset();
  toast.error.mockReset();
});

describe("BoughtServerSizeRow", () => {
  it("describes the size by what it is, never by its code", async () => {
    const { container } = renderRow();

    expect(
      await screen.findByText("2 vCPU · 4 GB RAM · 40 GB disk"),
    ).toBeTruthy();
    expect(container.textContent).not.toMatch(/cx23|cpx22/);
  });

  it("warns of the power-off and the disk first, and says a move up is charged now", async () => {
    api.setSize.mockResolvedValue(VIEW);
    renderRow();
    await openPicker();

    expect(screen.getByText("Change the size of web-1?")).toBeTruthy();
    expect(screen.getByText(SIZE_DOWNTIME_WARNING)).toBeTruthy();
    expect(screen.getByText(SIZE_DISK_NOTE)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/cx23|cpx22/);

    fireEvent.click(screen.getByLabelText(/3 vCPU · 4 GB RAM · 80 GB disk/));
    expect(
      screen.getByText(
        "It costs $30/month with backups. The difference for the rest of this month of your plan is charged now.",
      ),
    ).toBeTruthy();
    expect(api.setSize).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "Pay and change size" }),
    );

    await waitFor(() =>
      expect(api.setSize).toHaveBeenCalledWith("abc", "cpx22"),
    );
    expect(toast.done).toHaveBeenCalledWith(
      "web-1 now runs on 3 vCPU · 4 GB RAM · 80 GB disk.",
    );
  });

  it("says a move down is credited on the next invoice", async () => {
    api.sizes.mockResolvedValue([
      { ...SMALL, current: false },
      { ...BIG, current: true },
    ]);
    renderRow({
      ...VIEW,
      backups: false,
      lines: [{ kind: "server", monthlyCents: 2500 }],
      monthlyCents: 2500,
    });
    await openPicker();

    fireEvent.click(screen.getByLabelText(/2 vCPU · 4 GB RAM · 40 GB disk/));

    expect(
      screen.getByText(
        "It costs $9/month. The unused part of this month is credited on your next invoice.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Change size" })).toBeTruthy();
  });

  it("holds a sold-out size back", async () => {
    api.sizes.mockResolvedValue([SMALL, { ...BIG, available: false }]);
    renderRow();
    await openPicker();

    const radio = screen.getByLabelText(/3 vCPU · 4 GB RAM · 80 GB disk/);
    expect(radio.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Unavailable right now")).toBeTruthy();
  });

  it("holds back a size whose disk is smaller than the Server's", async () => {
    api.sizes.mockResolvedValue([
      { ...SMALL, current: false, smallerDisk: true },
      { ...BIG, current: true },
    ]);
    renderRow();
    await openPicker();

    const radio = screen.getByLabelText(/2 vCPU · 4 GB RAM · 40 GB disk/);
    expect(radio.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Disk too small")).toBeTruthy();
  });

  it("holds the button while the Server can't be changed, saying why", async () => {
    renderRow(VIEW, "This Server can be changed once it is Ready.");

    const button = await screen.findByRole("button", { name: "Change size" });
    expect(button.getAttribute("aria-disabled") === "true").toBe(true);
    expect(button.getAttribute("title")).toBe(
      "This Server can be changed once it is Ready.",
    );
  });

  it("holds the button for a role that may not change what the Server is charged for", async () => {
    allowed.current = false;
    renderRow();

    const button = await screen.findByRole("button", { name: "Change size" });
    expect(button.getAttribute("aria-disabled") === "true").toBe(true);
  });

  it("names the size it is moving to while it changes", async () => {
    renderRow({
      ...VIEW,
      stage: "changing",
      change: { serverType: "cpx22" },
    });

    expect(
      await screen.findByText("Moving to 3 vCPU · 4 GB RAM · 80 GB disk."),
    ).toBeTruthy();
  });
});
