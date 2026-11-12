import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/api/endpoints/databases";

// Two boundaries: the final-snapshot read, which is HTTP, and the toast.
const preview = {
  current: {
    cloud: "aws",
    name: "shop-production-pg-1-final-2026-10-17",
    region: "eu-central-1",
    sizeGb: 20,
    monthlyUsd: 1.9,
    sentence:
      "keeps snapshot shop-production-pg-1-final-2026-10-17, about $1.90 a month, until you delete it in AWS",
  },
};
vi.mock("../use-cloud-delete", () => ({
  useFinalSnapshot: () => ({ data: preview.current }),
}));
vi.mock("@/components/console/toast", () => ({
  toast: { done: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const { CloudDeleteDatabaseModal } =
  await import("./cloud-delete-database-modal");

const AWS_PREVIEW = { ...preview.current };
afterEach(() => {
  cleanup();
  preview.current = { ...AWS_PREVIEW };
});

const pg = {
  databaseId: "pg-x",
  kind: "postgres",
  name: "pg-1",
  appName: "postgres-abc",
  cloudAccountId: "ca-1",
  region: "eu-central-1",
} as unknown as Database;

function open(
  remove: (deleteData: boolean) => Promise<unknown>,
  database: Database = pg,
) {
  render(
    <CloudDeleteDatabaseModal
      database={database}
      kind="postgres"
      open
      onOpenChange={() => {}}
      remove={remove}
    />,
  );
}

/**
 * A cloud database's Delete says before it is pressed what it keeps
 * and costs, and offers one box for the data to go.
 */
describe("CloudDeleteDatabaseModal", () => {
  it("says the snapshot it keeps and about what it costs, and deletes keeping it", async () => {
    const remove = vi.fn(() => Promise.resolve({}));
    open(remove);

    expect(screen.getByLabelText("What the Delete keeps").textContent).toBe(
      "Deleting keeps snapshot shop-production-pg-1-final-2026-10-17, about $1.90 a month, until you delete it in AWS.",
    );
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "pg-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Delete database" }));

    await waitFor(() => expect(remove).toHaveBeenCalledWith(false));
  });

  it("with its box ticked, says the data is deleted for good and sends it", async () => {
    const remove = vi.fn(() => Promise.resolve({}));
    open(remove);

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Also delete its data (no final snapshot)",
      }),
    );
    expect(screen.getByLabelText("What the Delete keeps").textContent).toBe(
      "Its data is deleted for good: no final snapshot is taken, so nothing of it can be restored.",
    );
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "pg-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Delete database" }));

    await waitFor(() => expect(remove).toHaveBeenCalledWith(true));
  });

  it("on Google Cloud says the backup it keeps until deleted in Google Cloud, and its box takes no backup", () => {
    preview.current = {
      cloud: "gcp",
      name: "shop-production-pg-1-final-2026-10-26",
      region: "eu",
      sizeGb: 10,
      monthlyUsd: 0.8,
      sentence:
        "keeps backup shop-production-pg-1-final-2026-10-26, about $0.80 a month, until you delete it in Google Cloud",
    };
    open(() => Promise.resolve({}), {
      ...pg,
      region: "europe-west1",
      cloudSqlEndpoint: null,
    } as Database);

    expect(screen.getByLabelText("What the Delete keeps").textContent).toBe(
      "Deleting keeps backup shop-production-pg-1-final-2026-10-26, about $0.80 a month, until you delete it in Google Cloud.",
    );
    expect(screen.getByText(/destroys the Cloud SQL instance/)).toBeTruthy();
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Also delete its data (no final backup)",
      }),
    );
    expect(screen.getByLabelText("What the Delete keeps").textContent).toBe(
      "Its data is deleted for good: no final backup is taken, so nothing of it can be restored.",
    );
  });
});
