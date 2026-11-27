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
  ServerBackup,
} from "@/lib/api/endpoints/bought-servers";

const restore = vi.hoisted(() => ({ mutateAsync: vi.fn() }));
const toast = vi.hoisted(() => ({ done: vi.fn(), error: vi.fn() }));

vi.mock("../buy/use-bought-servers", () => ({
  useRestoreBackup: () => ({ ...restore, isPending: false }),
}));
vi.mock("@/components/console/toast", () => ({ toast }));

const { RestoreBackupModal } = await import("./restore-backup-modal");

const VIEW: BoughtServerView = {
  id: "abc",
  name: "web-1",
  stage: "ready",
  backups: true,
  storageGb: null,
  lines: [],
  monthlyCents: 3000,
  backupsOfferCents: null,
  change: null,
};

const BACKUP: ServerBackup = {
  id: 2,
  takenAt: "2026-11-02T03:00:00.000Z",
  sizeGb: 2.1,
  beingMade: false,
};

function renderModal(
  view: BoughtServerView = VIEW,
  noSafetyCopy = false,
  onOpenChange: (open: boolean) => void = () => {},
) {
  return render(
    <RestoreBackupModal
      view={view}
      backup={BACKUP}
      noSafetyCopy={noSafetyCopy}
      onOpenChange={onOpenChange}
    />,
  );
}

const nameField = () => screen.getByLabelText("Type web-1 to confirm");
const restoreButton = () =>
  screen.getByRole("button", { name: "Restore this Server" });

beforeEach(() => {
  vi.stubEnv("TZ", "UTC");
  restore.mutateAsync.mockResolvedValue(VIEW);
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  restore.mutateAsync.mockReset();
  toast.done.mockReset();
});

describe("RestoreBackupModal", () => {
  it("states the backup's date, the downtime and that everything written since is lost", () => {
    renderModal();

    expect(
      screen.getByText("Restore web-1 to Nov 2, 2026, 3:00 AM?"),
    ).toBeTruthy();
    expect(
      screen.getByText("Everything written to its disk since then is lost."),
    ).toBeTruthy();
    expect(screen.getByText(/is offline while it is restored/)).toBeTruthy();
    expect(
      screen.getByText(/a safety copy of the disk as it is now is kept/),
    ).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/hetzner/i);
  });

  it("says extra storage at /mnt/storage is not restored when the Server has it", () => {
    renderModal({ ...VIEW, storageGb: 100 });

    expect(document.body.textContent).toContain(
      "Extra storage at /mnt/storage is not in a backup, so it is not restored",
    );
  });

  it("says nothing of extra storage on a Server with none", () => {
    renderModal();

    expect(screen.queryByText(/mnt\/storage/)).toBeNull();
  });

  it("restores only once the Server's name is typed, with a safety copy", async () => {
    const onOpenChange = vi.fn();
    renderModal(VIEW, false, onOpenChange);

    fireEvent.change(nameField(), { target: { value: "web-2" } });
    expect(restoreButton().getAttribute("aria-disabled")).toBe("true");
    expect(
      screen.getByText("That does not match the Server's name."),
    ).toBeTruthy();

    fireEvent.change(nameField(), { target: { value: "web-1" } });
    fireEvent.click(restoreButton());

    await waitFor(() =>
      expect(restore.mutateAsync).toHaveBeenCalledWith({
        backupId: 2,
        withoutSafetyCopy: false,
      }),
    );
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(toast.done).toHaveBeenCalledWith("web-1 is being restored.", {
      description: "It is Changing until Server setup has run on it again.",
    });
  });

  it("says no safety copy can be taken for the oldest of 7, and restores only once that is confirmed too", async () => {
    renderModal(VIEW, true);

    expect(
      screen.getByText(
        /This is the oldest of the 7 backups kept, so a safety copy would remove it/,
      ),
    ).toBeTruthy();
    expect(
      screen.queryByText(/a safety copy of the disk as it is now/),
    ).toBeNull();
    fireEvent.change(nameField(), { target: { value: "web-1" } });
    expect(restoreButton().getAttribute("aria-disabled")).toBe("true");

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Restore without a safety copy",
      }),
    );
    fireEvent.click(restoreButton());

    await waitFor(() =>
      expect(restore.mutateAsync).toHaveBeenCalledWith({
        backupId: 2,
        withoutSafetyCopy: true,
      }),
    );
  });

  it("keeps a refusal in the dialog", async () => {
    restore.mutateAsync.mockRejectedValue(new Error("refused"));
    renderModal();

    fireEvent.change(nameField(), { target: { value: "web-1" } });
    fireEvent.click(restoreButton());

    await waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(toast.done).not.toHaveBeenCalled();
  });
});
