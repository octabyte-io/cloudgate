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
  deploymentsApi,
  type Deployment,
} from "@/lib/api/endpoints/deployments";
import {
  volumeBackupsApi,
  type VolumeBackup,
} from "@/lib/api/endpoints/volume-backups";

vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useActiveOrganizationId: () => ({ organizationId: "org-1", pending: false }),
}));

// The log box is `DeploymentLog`'s business and has its own test; what this
// dialog decides is what its steps say.
vi.mock("@/features/application/deploy/deployment-log", () => ({
  DeploymentLog: () => null,
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

function show(swarm = false) {
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MomentRestoreModal
        backup={backup}
        stackName="outline"
        swarm={swarm}
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

async function confirmNewest() {
  await chooseNewest();
  fireEvent.change(screen.getByLabelText("Type outline to confirm"), {
    target: { value: "outline" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Restore this moment" }));
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
    show(true);
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

  it("reads the run's log once a failed restore settles, so each step says what happened", async () => {
    // The run is recorded only once the POST is under way, so the history
    // read at the press has none, and the one after it settles has it.
    const run = {
      deploymentId: "dep-restore",
      title: "Stack Restore",
      status: "error",
    } as Deployment;
    vi.spyOn(volumeBackupsApi, "runHistory")
      .mockResolvedValueOnce([])
      .mockResolvedValue([run]);
    const readLogs = vi
      .spyOn(deploymentsApi, "readLogs")
      .mockResolvedValue(
        [
          "Step started: Remove containers",
          "Step done: Remove containers",
          "Step started: Restore alpha-files",
          "Step done: Restore alpha-files",
          "Step started: Restore zeta-db",
          "tar: ./data: Cannot write: No space left on device",
          "❌ Moment restore stopped at Restore zeta-db",
          "",
        ].join("\n"),
      );
    vi.spyOn(volumeBackupsApi, "restoreMoment").mockRejectedValue(
      new ApiError(400, "The restore stopped at a step"),
    );
    show();
    await confirmNewest();

    const steps = await screen.findByRole("list", { name: "Steps" });
    await waitFor(() =>
      expect(
        within(steps)
          .getAllByRole("listitem")
          .map((item) => item.textContent),
      ).toEqual([
        "Remove containers●done",
        "Restore alpha-files●done",
        "Restore zeta-db✕failed",
        "Start⊘not run",
      ]),
    );
    expect(readLogs).toHaveBeenCalledWith("dep-restore", expect.any(Number));
  });
});
