import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/api/endpoints/databases";
import type { PanelProps } from "@/lib/shell/tab-registry";

/**
 * The role's statements: everything held unless a test refuses it, so each
 * test says which statement turns which control off.
 */
const refused = vi.hoisted(() => ({ current: new Set<string>() }));
// Nothing is locked: no repository keeps this config (the locks are
// config-lock.test.tsx's and build-card.test.tsx's).
vi.mock("@/components/console/config-lock", async (original) => ({
  ...(await original<typeof import("@/components/console/config-lock")>()),
  useConfigLock: () => null,
}));
vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission: (required: Record<string, string[]>) => ({
    allowed: Object.entries(required).every(([resource, actions]) =>
      actions.every((action) => !refused.current.has(`${resource}:${action}`)),
    ),
    pending: false,
    role: "member",
  }),
}));

// The system boundaries: the row read, the writes, the router, and the delete
// dialog (whose own behaviour is `delete-database-modal.test.tsx`'s).
const update = vi.hoisted(() => ({ mutateAsync: vi.fn(async () => ({})) }));
const remove = vi.hoisted(() => ({ mutateAsync: vi.fn(async () => ({})) }));
vi.mock("../use-database", async (original) => ({
  ...(await original<typeof import("../use-database")>()),
  useUpdateDatabase: () => update,
  useDatabaseActions: () => ({ remove }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("../lifecycle/delete-database-modal", () => ({
  DeleteDatabaseModal: ({ open }: { open: boolean }) =>
    open ? <p>delete dialog open</p> : null,
}));

const row = vi.hoisted(() => ({
  databaseId: "db-1",
  environmentId: "env-1",
  name: "ui-pg",
  command: null,
  args: null,
  replicas: 1,
  cpuLimit: null,
  cpuReservation: null,
  memoryLimit: null,
  memoryReservation: null,
}));
vi.mock("../database-panel", () => ({
  DatabasePanel: ({
    children,
  }: {
    children: (row: Database, kind: "postgres") => React.ReactNode;
  }) => <>{children(row as unknown as Database, "postgres")}</>,
}));

const { DATABASE_DELETE_REFUSAL, DATABASE_UPDATE_REFUSAL } =
  await import("../use-database");
const { default: Panel } = await import("./advanced");

afterEach(() => {
  cleanup();
  refused.current = new Set();
  update.mutateAsync.mockClear();
  remove.mutateAsync.mockClear();
});

const props = {
  id: "db-1",
  kind: "postgres",
  label: "Advanced",
  icon: "gear",
} as unknown as PanelProps;

/** Run command's Save, then Resources'. */
const saves = () => screen.getAllByRole("button", { name: "Save changes" });
const deleteButton = () => screen.getByRole("button", { name: "Delete ui-pg" });

function expectOff(button: HTMLElement, refusal: string) {
  // §3.10 — `aria-disabled`, so it keeps its tab position.
  expect(button.getAttribute("aria-disabled")).toBe("true");
  expect(button.getAttribute("title")).toBe(refusal);
}

function expectOn(button: HTMLElement) {
  expect(button.getAttribute("aria-disabled")).not.toBe("true");
  expect(button.getAttribute("title")).toBeNull();
}

/**
 * `PATCH /:kind/:id` runs `findOwnedForUpdate` (`service: ['update']`)
 * and `DELETE /:kind/:id` is `@RequirePermission('service', 'delete')`, on all
 * six engines. Before this a role without them filled in a card, or opened the
 * delete dialog and typed the name, and met the 403 only then.
 */
describe("a database's Advanced tab", () => {
  it("turns Run command's and Resources' Save off, with the reason, for a role without service:update", () => {
    refused.current = new Set(["service:update"]);
    render(<Panel {...props} />);

    const [runtime, resources] = saves();
    expectOff(runtime, DATABASE_UPDATE_REFUSAL);
    expectOff(resources, DATABASE_UPDATE_REFUSAL);
    // Delete asks another statement, which this role holds.
    expectOn(deleteButton());
  });

  it("sends nothing when a refused card is submitted anyway", async () => {
    refused.current = new Set(["service:update"]);
    render(<Panel {...props} />);

    for (const save of saves()) {
      // Enter in a field submits the form whatever the button says.
      fireEvent.submit(save.closest("form") as HTMLFormElement);
    }

    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(2));
    for (const alert of screen.getAllByRole("alert")) {
      expect(alert.textContent).toContain(DATABASE_UPDATE_REFUSAL);
    }
    expect(update.mutateAsync).not.toHaveBeenCalled();
  });

  it("turns Delete off, with the reason beside it, for a role without service:delete", () => {
    refused.current = new Set(["service:delete"]);
    render(<Panel {...props} />);

    const button = deleteButton();
    expectOff(button, DATABASE_DELETE_REFUSAL);
    const described = button.getAttribute("aria-describedby");
    expect(described).toBeTruthy();
    expect(document.getElementById(described as string)?.textContent).toBe(
      DATABASE_DELETE_REFUSAL,
    );

    fireEvent.click(button);
    expect(screen.queryByText("delete dialog open")).toBeNull();
    expect(remove.mutateAsync).not.toHaveBeenCalled();
    // The two cards ask service:update, which this role holds.
    for (const save of saves()) expectOn(save);
  });

  it("shows a postgres on Cloud SQL no RDS settings and no Server cards, only where its settings are", () => {
    Object.assign(row, {
      cloudAccountId: "ca-1",
      cloudSqlStop: null,
      instanceClass: "db-g1-small",
      storageGb: 20,
      maxStorageGb: 200,
      multiAz: false,
      backupRetentionDays: 7,
    });
    try {
      render(<Panel {...props} />);

      expect(screen.queryByText("RDS settings")).toBeNull();
      expect(screen.queryAllByRole("button", { name: "Save changes" })).toEqual(
        [],
      );
      expect(screen.getByText("Cloud SQL settings")).toBeTruthy();
      expect(document.body.textContent).toContain(
        "Its backup retention is on the Backups tab.",
      );
    } finally {
      for (const key of [
        "cloudAccountId",
        "cloudSqlStop",
        "instanceClass",
        "storageGb",
        "maxStorageGb",
        "multiAz",
        "backupRetentionDays",
      ]) {
        delete (row as Record<string, unknown>)[key];
      }
    }
  });

  it("offers all three to a role that holds both, and they act", async () => {
    render(<Panel {...props} />);

    for (const save of saves()) expectOn(save);
    expectOn(deleteButton());
    expect(document.body.textContent).not.toContain(DATABASE_UPDATE_REFUSAL);
    expect(document.body.textContent).not.toContain(DATABASE_DELETE_REFUSAL);

    fireEvent.click(saves()[0]);
    await waitFor(() =>
      expect(update.mutateAsync).toHaveBeenCalledWith({
        command: null,
        args: null,
      }),
    );
    fireEvent.click(deleteButton());
    expect(screen.getByText("delete dialog open")).toBeTruthy();
  });
});
