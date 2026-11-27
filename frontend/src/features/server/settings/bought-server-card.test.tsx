import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/api-error";
import type {
  BoughtServerView,
  ServerBackup,
} from "@/lib/api/endpoints/bought-servers";
import type { Server } from "@/lib/api/endpoints/servers";

const api = vi.hoisted(() => ({
  server: vi.fn(),
  setBackups: vi.fn(),
  sizes: vi.fn(() => Promise.resolve([])),
  backups: vi.fn(),
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

const WITH_BACKUPS: BoughtServerView = {
  ...READY,
  backups: true,
  lines: [...READY.lines, { kind: "backups", monthlyCents: 500 }],
  monthlyCents: 3000,
  backupsOfferCents: null,
};

/** Three Server backups as the API lists them: newest first, the newest still being made. */
const BACKUPS: ServerBackup[] = [
  {
    id: 3,
    takenAt: "2026-11-27T12:00:00.000Z",
    sizeGb: null,
    beingMade: true,
  },
  {
    id: 2,
    takenAt: "2026-11-26T12:00:00.000Z",
    sizeGb: 2.31,
    beingMade: false,
  },
  {
    id: 1,
    takenAt: "2026-11-25T12:00:00.000Z",
    sizeGb: 0.42,
    beingMade: false,
  },
];

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

const backupsSwitch = () => screen.findByRole("switch", { name: "Backups" });

beforeEach(() => {
  allowed.current = true;
  api.server.mockResolvedValue(READY);
  api.backups.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  api.server.mockReset();
  api.setBackups.mockReset();
  api.backups.mockReset();
  toast.done.mockReset();
  toast.error.mockReset();
});

describe("BoughtServerCard", () => {
  it("shows nothing for a Server that was not bought", async () => {
    api.server.mockRejectedValue(new ApiError(404, "Server not found"));
    const { container } = renderCard();

    await waitFor(() => expect(api.server).toHaveBeenCalledWith("abc"));
    expect(container.textContent).toBe("");
  });

  it("shows what the Server is charged and what backups would cost", async () => {
    renderCard();

    expect(
      await screen.findByText("$25/month on your plan's invoice."),
    ).toBeTruthy();
    expect(screen.getByText(/Off · \$5\/month when on/)).toBeTruthy();
  });

  it("asks before turning backups on, saying the cost and that today's part is charged now", async () => {
    api.setBackups.mockResolvedValue(WITH_BACKUPS);
    renderCard();
    fireEvent.click(await backupsSwitch());

    expect(screen.getByText("Turn on backups for web-1?")).toBeTruthy();
    expect(
      screen.getByText(
        "Backups cost $5/month. The rest of this month of your plan is charged now, then they renew with it.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(/Turning them off later deletes every backup at once/),
    ).toBeTruthy();
    expect(api.setBackups).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "Pay and turn on backups" }),
    );

    await waitFor(() =>
      expect(api.setBackups).toHaveBeenCalledWith("abc", true),
    );
    expect(toast.done).toHaveBeenCalledWith("Backups are on for web-1.");
  });

  it("warns that every backup is deleted at once before turning them off, and credits the rest", async () => {
    api.server.mockResolvedValue(WITH_BACKUPS);
    api.setBackups.mockResolvedValue(READY);
    renderCard();
    fireEvent.click(await backupsSwitch());

    expect(screen.getByText("Turn off backups for web-1?")).toBeTruthy();
    expect(
      screen.getByText(
        "Every backup of this Server is deleted at once, and can't be brought back.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "The unused part of this month is credited on your next invoice.",
      ),
    ).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Turn off and delete backups" }),
    );

    await waitFor(() =>
      expect(api.setBackups).toHaveBeenCalledWith("abc", false),
    );
  });

  it("changes nothing when the confirmation is closed", async () => {
    api.server.mockResolvedValue(WITH_BACKUPS);
    renderCard();
    fireEvent.click(await backupsSwitch());

    fireEvent.click(screen.getByRole("button", { name: "Keep backups" }));

    await waitFor(() =>
      expect(screen.queryByText("Turn off backups for web-1?")).toBeNull(),
    );
    expect(api.setBackups).not.toHaveBeenCalled();
  });

  it("says why a refused change left the Server as it was", async () => {
    const refused = new ApiError(
      409,
      "The change could not be made, so its payment was refunded in full and the Server is as it was",
      { code: "BOUGHT_SERVER_CHANGE_REFUSED" },
    );
    api.setBackups.mockRejectedValue(refused);
    renderCard();
    fireEvent.click(await backupsSwitch());
    fireEvent.click(
      screen.getByRole("button", { name: "Pay and turn on backups" }),
    );

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(refused));
  });

  it("shows Changing and holds the switch while a change runs", async () => {
    api.server.mockResolvedValue({
      ...READY,
      stage: "changing",
      change: { backups: true },
    });
    renderCard();

    expect(await screen.findByText("Changing")).toBeTruthy();
    const toggle = await backupsSwitch();
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(
      toggle.hasAttribute("disabled") ||
        toggle.getAttribute("aria-disabled") === "true",
    ).toBe(true);
  });

  it("holds the switch for a role that may not change what the Server is charged for", async () => {
    allowed.current = false;
    renderCard();

    const toggle = await backupsSwitch();
    expect(toggle.getAttribute("title")).toBe(BOUGHT_SERVER_CHANGE_REFUSAL);
  });

  describe("Server backups", () => {
    it("lists each backup newest first, with the day it was taken, its size, and Being made while it is", async () => {
      api.server.mockResolvedValue(WITH_BACKUPS);
      api.backups.mockResolvedValue(BACKUPS);
      renderCard();

      const table = await screen.findByRole("table", {
        name: "Server backups of web-1",
      });
      expect(api.backups).toHaveBeenCalledWith("abc");
      const rows = within(table).getAllByRole("row").slice(1);
      expect(rows.map((row) => row.textContent)).toEqual([
        expect.stringMatching(/Nov 27, 2026.*Being made/),
        expect.stringMatching(/Nov 26, 2026.*2\.3 GB/),
        expect.stringMatching(/Nov 25, 2026.*420 MB/),
      ]);
      expect(rows[0].querySelector("time")?.getAttribute("datetime")).toBe(
        "2026-11-27T12:00:00.000Z",
      );
      expect(document.body.textContent).not.toMatch(/hetzner/i);
    });

    it("says the first backup is taken within a day while backups are on and none exist yet", async () => {
      api.server.mockResolvedValue(WITH_BACKUPS);
      renderCard();

      expect(
        await screen.findByText("The first backup is taken within a day."),
      ).toBeTruthy();
    });

    it("says the list could not be read rather than that there are none", async () => {
      api.server.mockResolvedValue(WITH_BACKUPS);
      api.backups.mockRejectedValue(
        new ApiError(503, "This Server's backups can't be read right now"),
      );
      renderCard();

      expect((await screen.findByRole("alert")).textContent).toBeTruthy();
      expect(
        screen.queryByText("The first backup is taken within a day."),
      ).toBeNull();
    });

    it("shows no list, and asks for none, while backups are off", async () => {
      renderCard();

      await backupsSwitch();
      expect(screen.queryByRole("table")).toBeNull();
      expect(
        screen.queryByText("The first backup is taken within a day."),
      ).toBeNull();
      expect(api.backups).not.toHaveBeenCalled();
    });
  });
});
