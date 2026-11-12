import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { toast } from "@/components/console/toast";
import type { ApplicationStatus } from "@/lib/api/endpoints/applications";
import type { Database, VolumePresence } from "@/lib/api/endpoints/databases";

/**
 * What `GET /:kind/:id/volume` answers while the dialog is open — `undefined`
 * is the read still in flight (or refused). Set per case.
 */
let before: VolumePresence | undefined;

// Two boundaries: the volume read, which is HTTP, and the toast, which renders
// through a portal nothing here reads.
vi.mock("../use-database", () => ({
  useDataVolume: () => ({
    data: before === undefined ? undefined : { present: before },
  }),
}));
vi.mock("@/components/console/toast", () => ({
  toast: { done: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const { DeleteDatabaseModal } = await import("./delete-database-modal");

afterEach(() => {
  cleanup();
  vi.mocked(toast.done).mockClear();
  before = undefined;
});

function row(applicationStatus: ApplicationStatus) {
  return {
    databaseId: "db-1",
    kind: "redis",
    name: "ui-rd",
    appName: "redis-9j84b7",
    applicationStatus,
  } as unknown as Database;
}

/** Opens the dialog, reads it, confirms, and returns what it and the toast said. */
async function deleteIt(
  applicationStatus: ApplicationStatus,
  {
    volume,
    leftBehind = null,
  }: { volume?: VolumePresence; leftBehind?: VolumePresence } = {},
) {
  before = volume;
  const onDeleted = vi.fn();
  render(
    <DeleteDatabaseModal
      database={row(applicationStatus)}
      kind="redis"
      open
      onOpenChange={() => {}}
      remove={() => Promise.resolve({ volumeLeftBehind: leftBehind })}
      onDeleted={onDeleted}
    />,
  );
  const said = document.body.textContent ?? "";
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "ui-rd" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Delete database" }));
  await waitFor(() => expect(onDeleted).toHaveBeenCalled());
  const [, options] = vi.mocked(toast.done).mock.calls[0];
  return { said, toast: options?.description ?? "" };
}

/**
 * The dialog, before it is confirmed. The volume is created at a
 * database's first deploy and Delete keeps it, so what the dialog says about it
 * is the Server's answer when there is one, read as the dialog opens:
 * `present: true` is a volume left behind, `false` is nothing to leave. Only
 * when the Server cannot say (`null`, or the read still in flight) does the
 * dialog fall back to the row's status — `done` and `stopped` both mean the
 * service existed, so both claim a volume; `idle` is the column's default and
 * claims nothing. `stopped` is why it can: a Stop once wrote `idle` too,
 * so a stopped database's volume was unclaimable.
 */
describe("DeleteDatabaseModal — the dialog", () => {
  it("a volume on the Server is named as left behind, with how to remove it", async () => {
    const { said } = await deleteIt("idle", { volume: true });

    expect(said).toContain("Volume left behind");
    expect(said).toContain("docker volume rm redis-9j84b7-data");
  });

  it("no volume on the Server is said plainly, with no removal advice", async () => {
    const { said } = await deleteIt("idle", { volume: false });

    expect(said).not.toContain("Volume left behind");
    expect(said).not.toContain("docker volume rm");
    expect(said).toContain("There is no data volume on the Server");
  });

  it("a Server that cannot say leaves a deployed database's volume stated", async () => {
    const { said } = await deleteIt("done", { volume: null });

    expect(said).toContain("Volume left behind");
    expect(said).toContain("docker volume rm redis-9j84b7-data");
  });

  it("a Server that cannot say leaves a stopped database's volume stated", async () => {
    const { said } = await deleteIt("stopped", { volume: null });

    expect(said).toContain("Volume left behind");
    expect(said).toContain("docker volume rm redis-9j84b7-data");
  });

  it("a Server that cannot say leaves an idle database's volume conditional", async () => {
    const { said } = await deleteIt("idle", { volume: null });

    expect(said).not.toContain("Volume left behind");
    expect(said).toContain("only if this database was ever deployed");
    expect(said).toContain("If it never was, there is no volume");
  });

  it("a read still in flight is treated as a Server that cannot say", async () => {
    const { said } = await deleteIt("idle");

    expect(said).not.toContain("Volume left behind");
    expect(said).toContain("only if this database was ever deployed");
  });
});

/**
 * The toast, once the Delete has answered. Its `volumeLeftBehind` is read
 * after the teardown and wins; `null` there falls back to the dialog's read,
 * then to the status.
 */
describe("DeleteDatabaseModal — the toast", () => {
  it("the Delete's own false says nothing is left, whatever the status", async () => {
    expect((await deleteIt("done", { leftBehind: false })).toast).toBe(
      "It had no data volume, so nothing is left on the Server.",
    );
  });

  it("the Delete's own true says the volume is still there, even for an idle row", async () => {
    expect((await deleteIt("idle", { leftBehind: true })).toast).toBe(
      "Its data volume redis-9j84b7-data is still on the Server.",
    );
  });

  it("a Delete that cannot say falls back to the dialog's read", async () => {
    expect((await deleteIt("idle", { volume: false })).toast).toBe(
      "It had no data volume, so nothing is left on the Server.",
    );
  });

  it("neither read answering falls back to what the status can claim", async () => {
    expect((await deleteIt("done")).toast).toBe(
      "Its data volume redis-9j84b7-data is still on the Server.",
    );
    cleanup();
    vi.mocked(toast.done).mockClear();
    const idle = (await deleteIt("idle")).toast;
    expect(idle).not.toContain("is still on the Server");
    expect(idle).toContain("If it was never deployed, nothing is left behind.");
  });
});

/**
 * "Also delete its data volume" (#1413): the glossary's Delete destroys
 * volumes only on request, and this box is the request. Unticked, the Delete
 * asks nothing and the volume stays, as before.
 */
describe("DeleteDatabaseModal — deleting its data", () => {
  async function confirm(
    tick: boolean,
    {
      volume = true,
      status = "done",
      leftBehind = false,
    }: {
      volume?: VolumePresence;
      status?: ApplicationStatus;
      leftBehind?: VolumePresence;
    } = {},
  ) {
    before = volume;
    const remove = vi.fn(() =>
      Promise.resolve({ volumeLeftBehind: leftBehind }),
    );
    const onDeleted = vi.fn();
    render(
      <DeleteDatabaseModal
        database={row(status)}
        kind="redis"
        open
        onOpenChange={() => {}}
        remove={remove}
        onDeleted={onDeleted}
      />,
    );
    if (tick) {
      fireEvent.click(
        screen.getByRole("checkbox", { name: "Also delete its data volume" }),
      );
    }
    const said = document.body.textContent ?? "";
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "ui-rd" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Delete database" }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
    const [, options] = vi.mocked(toast.done).mock.calls[0];
    return { remove, said, told: options?.description ?? "" };
  }

  it("asks the Delete to remove the data volume when the box is ticked", async () => {
    const { remove, said, told } = await confirm(true);

    expect(remove).toHaveBeenCalledWith(true, false);
    expect(said).toContain("Will delete volume");
    expect(said).toContain("Its data is deleted for good.");
    expect(told).toBe(
      "Its data volume redis-9j84b7-data was deleted, so nothing is left on the Server.",
    );
  });

  // The Delete's answer, not the read taken as the dialog opened: a removal
  // that kept the volume comes back as a `volume` line in the report, so a
  // clean answer to a ticked box means it is gone — even when the Server
  // cannot say afterwards (a multi-node swarm answers `null`).
  it("says the volume was deleted when the Server cannot say afterwards", async () => {
    const { told } = await confirm(true, { leftBehind: null });

    expect(told).not.toContain("is still on the Server");
    expect(told).toBe(
      "Its data volume redis-9j84b7-data was deleted, so nothing is left on the Server.",
    );
  });

  it("claims no deletion when there may never have been a volume", async () => {
    const { told } = await confirm(true, {
      volume: null,
      status: "idle",
      leftBehind: false,
    });

    expect(told).not.toContain("Its data volume was deleted");
    expect(told).toBe(
      "Nothing is left on the Server: its data volume redis-9j84b7-data, if it was ever deployed, was deleted.",
    );
  });

  it("keeps the data volume when the box is left unticked", async () => {
    const { remove } = await confirm(false);

    expect(remove).toHaveBeenCalledWith(false, false);
  });

  it("offers no box when the Server has no data volume", () => {
    before = false;
    render(
      <DeleteDatabaseModal
        database={row("idle")}
        kind="redis"
        open
        onOpenChange={() => {}}
        remove={() => Promise.resolve({ volumeLeftBehind: false })}
        onDeleted={() => {}}
      />,
    );

    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});
