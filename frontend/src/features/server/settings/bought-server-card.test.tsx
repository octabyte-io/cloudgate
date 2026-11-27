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
  backUpNow: vi.fn(),
  restore: vi.fn(),
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
vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission: () => ({ allowed: allowed.current, pending: false }),
}));
vi.mock("@/components/console/toast", () => ({ toast }));

const { BoughtServerCard, BOUGHT_SERVER_CHANGE_REFUSAL } =
  await import("./bought-server-card");
const { BACKUPS_POLL_MS } = await import("../buy/use-bought-servers");

const SERVER = {
  serverId: "abc",
  name: "web-1",
  maintenanceSince: null,
} as Server;

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

function renderCard(server: Server = SERVER) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <BoughtServerCard server={server} />
    </QueryClientProvider>,
  );
}

/** The sentence on screen a held control points `aria-describedby` at. */
function describedBy(control: HTMLElement): string | null | undefined {
  const id = control.getAttribute("aria-describedby");
  return id ? document.getElementById(id)?.textContent : null;
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
  api.backUpNow.mockReset();
  api.restore.mockReset();
  vi.useRealTimers();
  vi.unstubAllEnvs();
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

    it("says in one sentence how many backups are kept", async () => {
      api.server.mockResolvedValue(WITH_BACKUPS);
      api.backups.mockResolvedValue(BACKUPS);
      renderCard();

      await screen.findByRole("table", { name: "Server backups of web-1" });
      expect(
        document.querySelector('[data-slot="meta-strip"]')?.textContent,
      ).toMatch(/^3 Server backups kept, at most 7\.Back up now$/);
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

    it("takes a backup now, listed as Being made until it is made, then with its size", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      const taken: ServerBackup = {
        id: 4,
        takenAt: "2026-11-27T15:00:00.000Z",
        sizeGb: null,
        beingMade: true,
      };
      const settled = [BACKUPS[1], BACKUPS[2]];
      api.server.mockResolvedValue(WITH_BACKUPS);
      api.backups.mockResolvedValue(settled);
      api.backUpNow.mockResolvedValue(taken);
      renderCard();

      fireEvent.click(
        await screen.findByRole("button", { name: "Back up now" }),
      );
      expect(screen.getByText("Back up web-1 now?")).toBeTruthy();
      expect(api.backUpNow).not.toHaveBeenCalled();
      api.backups.mockResolvedValue([taken, ...settled]);
      fireEvent.click(
        within(screen.getByRole("dialog")).getByRole("button", {
          name: "Back up now",
        }),
      );

      await waitFor(() => expect(api.backUpNow).toHaveBeenCalledWith("abc"));
      const table = screen.getByRole("table", {
        name: "Server backups of web-1",
      });
      await waitFor(() =>
        expect(within(table).getAllByRole("row")[1].textContent).toMatch(
          /Nov 27, 2026.*Being made/,
        ),
      );
      expect(toast.done).toHaveBeenCalledWith(
        "A backup of web-1 is being made.",
      );

      api.backups.mockResolvedValue([
        { ...taken, sizeGb: 2.4, beingMade: false },
        ...settled,
      ]);
      await vi.advanceTimersByTimeAsync(BACKUPS_POLL_MS);

      await waitFor(() =>
        expect(within(table).getAllByRole("row")[1].textContent).toMatch(
          /Nov 27, 2026.*2\.4 GB/,
        ),
      );
    });

    it("names the oldest of 7 backups in the confirmation, and lists it no more afterwards", async () => {
      // Seven daily backups, the oldest on Tuesday 17 November at 03:00 UTC,
      // read in UTC: the confirmation names it in the reader's own zone.
      vi.stubEnv("TZ", "UTC");
      const seven: ServerBackup[] = [23, 22, 21, 20, 19, 18, 17].map((day) => ({
        id: day,
        takenAt: `2026-11-${day}T03:00:00.000Z`,
        sizeGb: 2.1,
        beingMade: false,
      }));
      const taken: ServerBackup = {
        id: 24,
        takenAt: "2026-11-24T15:00:00.000Z",
        sizeGb: null,
        beingMade: true,
      };
      api.server.mockResolvedValue(WITH_BACKUPS);
      api.backups.mockResolvedValue(seven);
      api.backUpNow.mockResolvedValue(taken);
      renderCard();

      fireEvent.click(
        await screen.findByRole("button", { name: "Back up now" }),
      );
      const dialog = screen.getByRole("dialog");
      expect(dialog.textContent).toMatch(/Tuesday 03:00 will be removed/);
      api.backups.mockResolvedValue([taken, ...seven.slice(0, 6)]);
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Back up now" }),
      );

      const table = screen.getByRole("table", {
        name: "Server backups of web-1",
      });
      await waitFor(() =>
        expect(within(table).getAllByRole("row")[1].textContent).toMatch(
          /Being made/,
        ),
      );
      expect(within(table).getAllByRole("row")).toHaveLength(8);
      expect(table.textContent).not.toMatch(/Nov 17, 2026/);
    });

    it("names no backup to be removed while fewer than 7 are kept", async () => {
      api.server.mockResolvedValue(WITH_BACKUPS);
      api.backups.mockResolvedValue(BACKUPS);
      renderCard();

      fireEvent.click(
        await screen.findByRole("button", { name: "Back up now" }),
      );

      expect(screen.getByRole("dialog").textContent).not.toMatch(
        /will be removed/,
      );
    });

    it("says why a refused backup was not taken", async () => {
      const refused = new ApiError(
        503,
        "This Server can't be backed up right now. Try again later",
      );
      api.server.mockResolvedValue(WITH_BACKUPS);
      api.backUpNow.mockRejectedValue(refused);
      renderCard();

      fireEvent.click(
        await screen.findByRole("button", { name: "Back up now" }),
      );
      fireEvent.click(
        within(screen.getByRole("dialog")).getByRole("button", {
          name: "Back up now",
        }),
      );

      await waitFor(() => expect(toast.error).toHaveBeenCalledWith(refused));
    });

    it("holds Back up now while the Server is not Ready", async () => {
      api.server.mockResolvedValue({
        ...WITH_BACKUPS,
        stage: "changing",
        change: { serverType: "cpx32" },
      });
      renderCard();

      const button = await screen.findByRole("button", { name: "Back up now" });
      expect(button.getAttribute("aria-disabled")).toBe("true");
      expect(button.getAttribute("title")).toBe(
        "This Server can be changed once it is Ready.",
      );
      expect(describedBy(button)).toBe(
        "This Server can be changed once it is Ready.",
      );
      // Said once on screen, by the card's own note.
      expect(
        screen.getAllByText("This Server can be changed once it is Ready."),
      ).toHaveLength(1);
    });

    it("holds Back up now for a role that may not change the Server", async () => {
      allowed.current = false;
      api.server.mockResolvedValue(WITH_BACKUPS);
      renderCard();

      const button = await screen.findByRole("button", { name: "Back up now" });
      expect(button.getAttribute("aria-disabled")).toBe("true");
      expect(button.getAttribute("title")).toBe(
        "Your role in this Organization cannot back up or restore this Server. Ask an owner or an admin.",
      );
      expect(describedBy(button)).toBe(
        "Your role in this Organization cannot back up or restore this Server. Ask an owner or an admin.",
      );
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

  describe("Restore", () => {
    /** The Restore button on the row of the backup taken on `day`. */
    async function restoreOn(day: RegExp) {
      const table = await screen.findByRole("table", {
        name: "Server backups of web-1",
      });
      const row = within(table)
        .getAllByRole("row")
        .find((each) => day.test(each.textContent ?? ""))!;
      return within(row).getByRole("button", { name: "Restore" });
    }

    it("restores a backup from its row once the Server's name is typed, and shows Changing", async () => {
      api.server.mockResolvedValue(WITH_BACKUPS);
      api.backups.mockResolvedValue(BACKUPS);
      const changing: BoughtServerView = {
        ...WITH_BACKUPS,
        stage: "changing",
        change: { restore: { backupTakenAt: BACKUPS[1].takenAt } },
      };
      api.restore.mockResolvedValue(changing);
      renderCard();

      fireEvent.click(await restoreOn(/Nov 26, 2026/));
      const dialog = screen.getByRole("dialog");
      expect(dialog.textContent).toMatch(/Restore web-1 to Nov 26, 2026/);
      api.server.mockResolvedValue(changing);
      fireEvent.change(within(dialog).getByLabelText("Type web-1 to confirm"), {
        target: { value: "web-1" },
      });
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Restore this Server" }),
      );

      await waitFor(() =>
        expect(api.restore).toHaveBeenCalledWith("abc", 2, false),
      );
      expect(await screen.findByText("Changing")).toBeTruthy();
      await waitFor(() =>
        expect(document.body.textContent).toMatch(
          /Restoring the backup of Nov 26, 2026/,
        ),
      );
    });

    it("asks for its own confirmation to restore the oldest of 7 without a safety copy", async () => {
      const seven: ServerBackup[] = [23, 22, 21, 20, 19, 18, 17].map((day) => ({
        id: day,
        takenAt: `2026-11-${day}T12:00:00.000Z`,
        sizeGb: 2.1,
        beingMade: false,
      }));
      api.server.mockResolvedValue(WITH_BACKUPS);
      api.backups.mockResolvedValue(seven);
      api.restore.mockResolvedValue(WITH_BACKUPS);
      renderCard();

      fireEvent.click(await restoreOn(/Nov 17, 2026/));
      const dialog = screen.getByRole("dialog");
      expect(dialog.textContent).toMatch(/so a safety copy would remove it/);
      fireEvent.change(within(dialog).getByLabelText("Type web-1 to confirm"), {
        target: { value: "web-1" },
      });
      fireEvent.click(
        within(dialog).getByRole("checkbox", {
          name: "Restore without a safety copy",
        }),
      );
      fireEvent.click(
        within(dialog).getByRole("button", { name: "Restore this Server" }),
      );

      await waitFor(() =>
        expect(api.restore).toHaveBeenCalledWith("abc", 17, true),
      );
    });

    it("takes a safety copy of any newer one of 7", async () => {
      const seven: ServerBackup[] = [23, 22, 21, 20, 19, 18, 17].map((day) => ({
        id: day,
        takenAt: `2026-11-${day}T12:00:00.000Z`,
        sizeGb: 2.1,
        beingMade: false,
      }));
      api.server.mockResolvedValue(WITH_BACKUPS);
      api.backups.mockResolvedValue(seven);
      renderCard();

      fireEvent.click(await restoreOn(/Nov 18, 2026/));

      expect(screen.getByRole("dialog").textContent).toMatch(
        /a safety copy of the disk as it is now is kept/,
      );
    });

    it("holds Restore on a backup still being made", async () => {
      api.server.mockResolvedValue(WITH_BACKUPS);
      api.backups.mockResolvedValue(BACKUPS);
      renderCard();

      const button = await restoreOn(/Nov 27, 2026/);
      expect(button.getAttribute("aria-disabled")).toBe("true");
      expect(button.getAttribute("title")).toBe(
        "This backup can be restored once it is made.",
      );
      expect(describedBy(button)).toBe("Being made");
    });

    it("holds Restore while the Server is not Ready", async () => {
      api.server.mockResolvedValue({
        ...WITH_BACKUPS,
        stage: "changing",
        change: { serverType: "cpx32" },
      });
      api.backups.mockResolvedValue(BACKUPS);
      renderCard();

      const button = await restoreOn(/Nov 26, 2026/);
      expect(button.getAttribute("aria-disabled")).toBe("true");
      expect(button.getAttribute("title")).toBe(
        "This Server can be changed once it is Ready.",
      );
      expect(describedBy(button)).toBe(
        "This Server can be changed once it is Ready.",
      );
    });

    it("holds Restore for a role that may not change the Server", async () => {
      allowed.current = false;
      api.server.mockResolvedValue(WITH_BACKUPS);
      api.backups.mockResolvedValue(BACKUPS);
      renderCard();

      const button = await restoreOn(/Nov 26, 2026/);
      expect(button.getAttribute("aria-disabled")).toBe("true");
      expect(button.getAttribute("title")).toBe(
        "Your role in this Organization cannot back up or restore this Server. Ask an owner or an admin.",
      );
      expect(describedBy(button)).toBe(
        "Your role in this Organization cannot back up or restore this Server. Ask an owner or an admin.",
      );
    });

    it("holds Restore, saying why, while the Server is in maintenance, and leaves Back up now live", async () => {
      api.server.mockResolvedValue(WITH_BACKUPS);
      api.backups.mockResolvedValue(BACKUPS);
      renderCard({ ...SERVER, maintenanceSince: "2026-11-27T10:00:00.000Z" });

      const button = await restoreOn(/Nov 26, 2026/);
      expect(button.getAttribute("aria-disabled")).toBe("true");
      expect(button.getAttribute("title")).toBe(
        "This Server can be restored once its maintenance is ended.",
      );
      expect(describedBy(button)).toBe(
        "This Server can be restored once its maintenance is ended.",
      );
      expect(
        screen
          .getByRole("button", { name: "Back up now" })
          .getAttribute("aria-disabled"),
      ).not.toBe("true");
    });

    it("lists the safety copy once the Server is Ready again, without a reload", async () => {
      const copy: ServerBackup = {
        id: 9,
        takenAt: "2026-11-27T16:00:00.000Z",
        sizeGb: 2.5,
        beingMade: false,
      };
      api.server.mockResolvedValue({
        ...WITH_BACKUPS,
        stage: "changing",
        change: { restore: { backupTakenAt: BACKUPS[1].takenAt } },
      });
      api.backups.mockResolvedValue([BACKUPS[1], BACKUPS[2]]);
      renderCard();
      const table = await screen.findByRole("table", {
        name: "Server backups of web-1",
      });
      expect(within(table).getAllByRole("row")).toHaveLength(3);

      api.backups.mockResolvedValue([copy, BACKUPS[1], BACKUPS[2]]);
      api.server.mockResolvedValue(WITH_BACKUPS);

      await waitFor(
        () => expect(within(table).getAllByRole("row")).toHaveLength(4),
        { timeout: 6_000 },
      );
      expect(within(table).getAllByRole("row")[1].textContent).toMatch(
        /Nov 27, 2026.*2\.5 GB/,
      );
    });
  });
});
