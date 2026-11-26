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
import {
  volumeBackupsApi,
  type VolumeBackup,
} from "@/lib/api/endpoints/volume-backups";

vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useActiveOrganizationId: () => ({ organizationId: "org-1", pending: false }),
}));

const { MomentRestoreModal } = await import("./moment-restore-modal");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const backup = {
  volumeBackupId: "vb-1",
  name: "Nightly",
  scope: "stack",
  volumeName: null,
} as VolumeBackup;

/** As `GET /volume-backups/:id/moments` answers: newest first. */
const MOMENTS = [
  {
    moment: "2026-11-26T03-00-00-000Z",
    takenAt: "2026-11-26T03:00:00.000Z",
    volumes: ["alpha-files", "zeta-db"],
  },
  {
    moment: "2026-11-25T03-00-00-000Z",
    takenAt: "2026-11-25T03:00:00.000Z",
    volumes: ["alpha-files", "zeta-db"],
  },
];

beforeEach(() => {
  vi.spyOn(volumeBackupsApi, "moments").mockResolvedValue(MOMENTS);
  vi.spyOn(volumeBackupsApi, "runHistory").mockResolvedValue([]);
});

function show(composeType: "docker-compose" | "stack" = "docker-compose") {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MomentRestoreModal
        backup={backup}
        stackName="outline"
        composeType={composeType}
        open
        onOpenChange={() => {}}
      />
    </QueryClientProvider>,
  );
}

async function chooseNewest() {
  const moments = await screen.findByRole("group", { name: "Moments" });
  fireEvent.click(within(moments).getAllByRole("button")[0]);
}

describe("MomentRestoreModal", () => {
  it("lists the moments the destination holds, newest first, with their volumes", async () => {
    show();

    const moments = await screen.findByRole("group", { name: "Moments" });
    const cards = within(moments).getAllByRole("button");
    expect(cards).toHaveLength(2);
    expect(cards[0].textContent).toContain("2026-11-26T03-00-00-000Z");
    expect(cards[1].textContent).toContain("2026-11-25T03-00-00-000Z");
    expect(cards[0].textContent).toContain("alpha-files, zeta-db");
  });

  it("restores nothing until the stack's name is typed back", async () => {
    const restore = vi
      .spyOn(volumeBackupsApi, "restoreMoment")
      .mockResolvedValue(undefined);
    show();
    await chooseNewest();

    fireEvent.click(
      screen.getByRole("button", { name: "Restore this moment" }),
    );
    expect(restore).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Type outline to confirm"), {
      target: { value: "outline" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Restore this moment" }),
    );
    expect(restore).toHaveBeenCalledWith("vb-1", "2026-11-26T03-00-00-000Z");
  });

  it("shows Remove containers, each volume and Start, every one done once the restore succeeds", async () => {
    vi.spyOn(volumeBackupsApi, "restoreMoment").mockResolvedValue(undefined);
    show();
    await chooseNewest();
    fireEvent.change(screen.getByLabelText("Type outline to confirm"), {
      target: { value: "outline" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Restore this moment" }),
    );

    const steps = await screen.findByRole("list", { name: "Steps" });
    await waitFor(() =>
      expect(
        within(steps)
          .getAllByRole("listitem")
          .map((item) => item.textContent),
      ).toEqual([
        "Remove containers●done",
        "Restore alpha-files●done",
        "Restore zeta-db●done",
        "Start●done",
      ]),
    );
  });

  it("names the first step Stop on a swarm stack, and shows the refusal of a failed restore", async () => {
    vi.spyOn(volumeBackupsApi, "restoreMoment").mockRejectedValue(
      new ApiError(
        400,
        "The restore stopped at a step and left the stack stopped",
      ),
    );
    show("stack");
    await chooseNewest();
    fireEvent.change(screen.getByLabelText("Type outline to confirm"), {
      target: { value: "outline" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Restore this moment" }),
    );

    expect(await screen.findByRole("alert")).toBeDefined();
    const steps = screen.getByRole("list", { name: "Steps" });
    expect(within(steps).getAllByRole("listitem")[0].textContent).toBe(
      "Stop⊘not run",
    );
  });
});
