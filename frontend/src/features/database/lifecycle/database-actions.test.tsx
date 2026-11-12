import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/api-error";
import type { Database, DatabaseKind } from "@/lib/api/endpoints/databases";

const toast = vi.hoisted(() => ({
  done: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));
vi.mock("@/components/console/toast", () => ({ toast }));

const mutation = () => ({
  isPending: false,
  mutateAsync: vi.fn().mockResolvedValue(undefined),
});
const actions = vi.hoisted(() => ({
  current: {} as Record<
    "deploy" | "start" | "stop" | "rebuild",
    { isPending: boolean; mutateAsync: ReturnType<typeof vi.fn> }
  >,
}));
vi.mock("../use-database", async (original) => ({
  ...(await original<typeof import("../use-database")>()),
  useDatabaseActions: () => actions.current,
}));

const { DatabaseActions } = await import("./database-actions");

afterEach(cleanup);
beforeEach(() => {
  actions.current = {
    deploy: mutation(),
    start: mutation(),
    stop: mutation(),
    rebuild: mutation(),
  };
  toast.done.mockClear();
});

function renderActions(
  kind: DatabaseKind,
  cloudAccountId: string | null,
  extra: Record<string, unknown> = {},
) {
  const database = {
    databaseId: "db-1",
    environmentId: "env-1",
    kind,
    name: kind === "postgres" ? "pg-1" : "redis",
    appName: `${kind}-abc`,
    dockerImage: `${kind}:latest`,
    cloudAccountId,
    ...extra,
  } as unknown as Database;
  render(<DatabaseActions database={database} kind={kind} />);
}

const button = (name: string) => screen.getByRole("button", { name });

/**
 * A database in a Cloud account offers a Server database's buttons,
 * minus what AWS cannot do, each off with the backend's own sentence.
 */
describe("DatabaseActions in a Cloud account", () => {
  it("shows ElastiCache's Start and Stop off, saying it can't be stopped, and calls neither", () => {
    renderActions("redis", "cloud-1");

    for (const name of ["Start", "Stop"]) {
      expect(button(name).getAttribute("aria-disabled")).toBe("true");
      expect(button(name).getAttribute("title")).toBe(
        "ElastiCache can't be stopped. Delete it to stop paying.",
      );
      fireEvent.click(button(name));
    }
    expect(actions.current.start.mutateAsync).not.toHaveBeenCalled();
    expect(actions.current.stop.mutateAsync).not.toHaveBeenCalled();
  });

  it.each(["postgres", "redis"] as const)(
    "shows Rebuild off on a %s in a Cloud account, pointing at Delete",
    (kind) => {
      renderActions(kind, "cloud-1");

      expect(button("Rebuild").getAttribute("aria-disabled")).toBe("true");
      expect(button("Rebuild").getAttribute("title")).toBe(
        "Delete the Service and Apply again for a fresh one.",
      );
    },
  );

  it("confirms an RDS Stop with the date AWS starts it again and what still bills", async () => {
    renderActions("postgres", "cloud-1");
    const restarts = new Date(Date.now() + 7 * 24 * 3600 * 1000)
      .toISOString()
      .slice(0, 10);

    expect(button("Start").getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(button("Stop"));
    expect(actions.current.stop.mutateAsync).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      `AWS starts it again on ${restarts}, and storage and backups still bill`,
    );

    const confirm = screen
      .getAllByRole("button", { name: "Stop" })
      .find((one) => one.closest("[role='dialog']"));
    fireEvent.click(confirm!);
    await waitFor(() =>
      expect(actions.current.stop.mutateAsync).toHaveBeenCalledOnce(),
    );
  });

  it("shows an existing database's Start, Stop and Rebuild off with \"Cloudgate uses this database but doesn't manage it.\"", () => {
    const database = {
      databaseId: "db-1",
      environmentId: "env-1",
      kind: "postgres",
      name: "pg-1",
      appName: "postgres-abc",
      dockerImage: "postgres:18",
      cloudAccountId: null,
      existing: { identifier: "acme-prod" },
    } as unknown as Database;
    render(<DatabaseActions database={database} kind="postgres" />);

    for (const name of ["Start", "Stop", "Rebuild"]) {
      expect(button(name).getAttribute("aria-disabled")).toBe("true");
      expect(button(name).getAttribute("title")).toBe(
        "Cloudgate uses this database but doesn't manage it.",
      );
      fireEvent.click(button(name));
    }
    expect(screen.queryByRole("button", { name: /Deploy/ })).toBeNull();
    expect(actions.current.start.mutateAsync).not.toHaveBeenCalled();
    expect(actions.current.stop.mutateAsync).not.toHaveBeenCalled();
    expect(actions.current.rebuild.mutateAsync).not.toHaveBeenCalled();
  });

  // Google's half of the same row.
  it("shows Memorystore's Start and Stop off, saying it can't be stopped, and calls neither", () => {
    renderActions("redis", "cloud-1", {
      memorystore: { highAvailability: false },
    });

    for (const name of ["Start", "Stop"]) {
      expect(button(name).getAttribute("aria-disabled")).toBe("true");
      expect(button(name).getAttribute("title")).toBe(
        "Memorystore can't be stopped. Delete it to stop paying.",
      );
      fireEvent.click(button(name));
    }
    expect(button("Rebuild").getAttribute("title")).toBe(
      "Delete the Service and Apply again for a fresh one.",
    );
    expect(actions.current.start.mutateAsync).not.toHaveBeenCalled();
    expect(actions.current.stop.mutateAsync).not.toHaveBeenCalled();
  });

  it("confirms a Cloud SQL Stop with what still costs money and no date, with Rebuild off", async () => {
    renderActions("postgres", "cloud-1", { cloudSqlStop: null });

    expect(button("Rebuild").getAttribute("aria-disabled")).toBe("true");
    expect(button("Rebuild").getAttribute("title")).toBe(
      "Delete the Service and Apply again for a fresh one.",
    );
    expect(button("Start").getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(button("Stop"));
    expect(actions.current.stop.mutateAsync).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      "Storage, backups and its private address still cost money. It stays stopped until you start it.",
    );
    expect(document.body.textContent).not.toContain("AWS starts it again");

    const confirm = screen
      .getAllByRole("button", { name: "Stop" })
      .find((one) => one.closest("[role='dialog']"));
    fireEvent.click(confirm!);
    await waitFor(() =>
      expect(actions.current.stop.mutateAsync).toHaveBeenCalledOnce(),
    );
  });

  it.each([
    ["postgres", { cloudSqlStop: null }],
    ["redis", { memorystore: { highAvailability: false } }],
  ] as const)(
    "offers no Remove containers, Reload or Restart on a %s on Google Cloud",
    (kind, extra) => {
      renderActions(kind, "cloud-1", extra);

      for (const name of [/Remove containers/, /Reload/, /Restart/]) {
        expect(screen.queryByRole("button", { name })).toBeNull();
      }
    },
  );

  it("leaves a Server database's buttons as they were", () => {
    renderActions("redis", null);

    for (const name of ["Start", "Stop", "Rebuild"]) {
      expect(button(name).getAttribute("aria-disabled")).toBeNull();
      expect(button(name).getAttribute("title")).toBeNull();
    }
    fireEvent.click(button("Stop"));
    expect(actions.current.stop.mutateAsync).toHaveBeenCalledOnce();
  });
});

/**
 * A database no Deploy has created has no service to scale, so Start
 * and Stop are off with the reason beside them, and Deploy stays live.
 */
describe("DatabaseActions before the first Deploy", () => {
  it("turns Start and Stop off, saying Deploy creates the service, and calls neither", () => {
    renderActions("postgres", null, { applicationStatus: "idle" });

    for (const name of ["Start", "Stop"]) {
      expect(button(name).getAttribute("aria-disabled")).toBe("true");
      fireEvent.click(button(name));
    }
    expect(screen.getByText(/Deploy creates it/)).toBeTruthy();
    expect(actions.current.start.mutateAsync).not.toHaveBeenCalled();
    expect(actions.current.stop.mutateAsync).not.toHaveBeenCalled();
    expect(button("Deploy").getAttribute("aria-disabled")).toBeNull();
  });

  it("offers both once the database has been deployed and stopped", () => {
    renderActions("postgres", null, { applicationStatus: "stopped" });

    expect(button("Start").getAttribute("aria-disabled")).toBeNull();
    expect(button("Stop").getAttribute("aria-disabled")).toBeNull();
    expect(screen.queryByText(/Deploy creates it/)).toBeNull();
  });
});

/**
 * A Deploy, Start or Stop the backend failed at once said "the request
 * did not come back … may still be running", so the reason never showed. Only
 * a dropped connection or a proxy's own timeout (no backend body, so no
 * `path`) says that now; anything the backend answered is shown as it said.
 */
describe("DatabaseActions when a lifecycle call fails", () => {
  beforeEach(() => {
    toast.error.mockClear();
    toast.warn.mockClear();
  });

  const failWith = async (error: unknown) => {
    actions.current.deploy.mutateAsync.mockRejectedValue(error);
    renderActions("postgres", null, { applicationStatus: "done" });
    fireEvent.click(button("Deploy"));
    await waitFor(() =>
      expect(
        toast.error.mock.calls.length + toast.warn.mock.calls.length,
      ).toBe(1),
    );
  };

  it.each([
    [
      "a refusal naming what Docker said",
      new ApiError(
        409,
        "The PostgreSQL deploy of postgres-abc failed. Docker said: failed to connect to the docker API",
        { path: "/postgres/db-1/deploy" },
      ),
    ],
    [
      "a Server the backend could not reach",
      new ApiError(503, "This Server could not be reached", {
        path: "/postgres/db-1/deploy",
        code: "HOST_UNREACHABLE",
      }),
    ],
    [
      "a 500 the backend answered itself",
      new ApiError(500, "Internal server error", {
        path: "/postgres/db-1/deploy",
      }),
    ],
  ])("shows %s, not the timeout sentence", async (_, error) => {
    await failWith(error);

    expect(toast.error).toHaveBeenCalledWith(error);
    expect(toast.warn).not.toHaveBeenCalled();
  });

  it.each([
    ["a dropped connection", new TypeError("Failed to fetch")],
    ["a proxy's timeout", new ApiError(504, "Gateway Timeout")],
  ])("keeps 'may still be running' for %s", async (_, error) => {
    await failWith(error);

    expect(toast.warn).toHaveBeenCalledWith(
      "The request did not come back.",
      expect.objectContaining({
        description: expect.stringContaining("may still be running"),
      }),
    );
    expect(toast.error).not.toHaveBeenCalled();
  });
});
