import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BoughtServerView } from "@/lib/api/endpoints/bought-servers";
import type { Server } from "@/lib/api/endpoints/servers";

const api = vi.hoisted(() => ({
  server: vi.fn(),
  setBackups: vi.fn(),
  catalogue: vi.fn(),
  growStorage: vi.fn(),
}));
const allowed = vi.hoisted(() => ({ current: true }));
const toast = vi.hoisted(() => ({
  done: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));

vi.mock("@/lib/api/use-instance-mode", () => ({
  useInstanceMode: () => ({ data: "hosted", isPending: false }),
}));
vi.mock("@/lib/auth/client", () => ({
  useActiveOrganizationId: () => ({ organizationId: "org-1" }),
}));
vi.mock("@/lib/api/endpoints/bought-servers", () => ({
  boughtServersApi: api,
}));
vi.mock("@/lib/api/use-invalidate", () => ({
  useInvalidate: () => ({
    boughtServers: () => Promise.resolve(),
    billing: () => Promise.resolve(),
  }),
}));
vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission: () => ({ allowed: allowed.current, pending: false }),
}));
vi.mock("@/components/console/toast", () => ({ toast }));

const { BoughtServerCard, BOUGHT_SERVER_CHANGE_REFUSAL } =
  await import("./bought-server-card");

const SERVER = { serverId: "abc", name: "web-1" } as Server;

const READY: BoughtServerView = {
  id: "abc",
  name: "web-1",
  stage: "ready",
  backups: false,
  storageGb: null,
  lines: [{ kind: "server", monthlyCents: 2500 }],
  monthlyCents: 2500,
  backupsOfferCents: 500,
  change: null,
};

/** Bought with 100 GB of extra storage: $10 a month. */
const WITH_STORAGE: BoughtServerView = {
  ...READY,
  storageGb: 100,
  lines: [...READY.lines, { kind: "storage", monthlyCents: 1000 }],
  monthlyCents: 3500,
};

const CATALOGUE = {
  locations: [],
  sizes: [],
  storage: { minGb: 10, maxGb: 10240, perGbMonthly: 0.09204 },
};

function renderCard() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <BoughtServerCard server={SERVER} />
    </QueryClientProvider>,
  );
}

const growButton = () => screen.findByRole("button", { name: "Grow" });

beforeEach(() => {
  allowed.current = true;
  api.server.mockResolvedValue(WITH_STORAGE);
  api.catalogue.mockResolvedValue(CATALOGUE);
});

afterEach(() => {
  cleanup();
  for (const fn of Object.values(api)) fn.mockReset();
  toast.done.mockReset();
  toast.error.mockReset();
});

describe("Extra storage on a Bought Server's Settings", () => {
  it("shows its size, price and mount point, and that it isn't in backups and never shrinks", async () => {
    renderCard();

    const row = await screen.findByText(/^100 GB · \$10\/month/);
    expect(row.textContent).toBe(
      "100 GB · $10/month, mounted at /mnt/storage. It isn't in backups: back it up to a Destination outside this Server with volume backups. It can grow but never shrink.",
    );
  });

  it("shows nothing for a Server bought without it", async () => {
    api.server.mockResolvedValue(READY);
    renderCard();

    await screen.findByText("$25/month on your plan's invoice.");
    expect(screen.queryByText("Extra storage")).toBeNull();
    expect(screen.queryByRole("button", { name: "Grow" })).toBeNull();
  });

  it("asks before growing, with the new price, the charge now, and that it can't shrink", async () => {
    api.growStorage.mockResolvedValue({ ...WITH_STORAGE, storageGb: 250 });
    renderCard();
    fireEvent.click(await growButton());

    expect(screen.getByText("Grow the extra storage of web-1?")).toBeTruthy();
    expect(
      screen.getByText(
        "The rest of this month of your plan is charged now, then it renews with it. The filesystem is grown for you.",
      ),
    ).toBeTruthy();
    expect(screen.getByText(/can.t shrink again/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText(/New size, now 100 GB/), {
      target: { value: "250" },
    });
    // tidy(250 × 0.09204 = 23.01) = $24
    expect(screen.getByText(/New size, now 100 GB · \$24\/month/)).toBeTruthy();
    fireEvent.click(
      screen.getByRole("button", { name: "Pay and grow to 250 GB" }),
    );

    await waitFor(() =>
      expect(api.growStorage).toHaveBeenCalledWith("abc", 250),
    );
    expect(toast.done).toHaveBeenCalledWith(
      "The extra storage of web-1 is now 250 GB.",
    );
  });

  it("refuses a smaller size before anything is sent", async () => {
    renderCard();
    fireEvent.click(await growButton());

    fireEvent.change(screen.getByLabelText(/New size, now 100 GB/), {
      target: { value: "50" },
    });

    expect(
      screen.getByText("Extra storage can only grow. Choose more than 100 GB."),
    ).toBeTruthy();
    const pay = screen.getByRole("button", { name: "Pay and grow" });
    expect(
      pay.hasAttribute("disabled") ||
        pay.getAttribute("aria-disabled") === "true",
    ).toBe(true);
    fireEvent.click(pay);
    expect(api.growStorage).not.toHaveBeenCalled();
  });

  it("shows the size it is growing to and holds Grow while it changes", async () => {
    api.server.mockResolvedValue({
      ...WITH_STORAGE,
      stage: "changing",
      change: { storageGb: 250 },
    });
    renderCard();

    expect(await screen.findByText(/^250 GB/)).toBeTruthy();
    const grow = await growButton();
    expect(
      grow.hasAttribute("disabled") ||
        grow.getAttribute("aria-disabled") === "true",
    ).toBe(true);
  });

  it("holds Grow for a role that may not change what the Server is charged for", async () => {
    allowed.current = false;
    renderCard();

    expect((await growButton()).getAttribute("title")).toBe(
      BOUGHT_SERVER_CHANGE_REFUSAL,
    );
  });
});
