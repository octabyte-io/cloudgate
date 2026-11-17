import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/api/endpoints/databases";
import type { PanelProps } from "@/lib/shell/tab-registry";

/** The role's statements: everything held unless a test refuses it. */
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

// The system boundaries: the row read, the write, and the live log socket.
const update = vi.hoisted(() => ({ mutateAsync: vi.fn(async () => ({})) }));
vi.mock("../use-database", async (original) => ({
  ...(await original<typeof import("../use-database")>()),
  useUpdateDatabase: () => update,
}));
vi.mock("../container-log", () => ({ ContainerLog: () => null }));

const POSTGRES = {
  databaseId: "db-1",
  environmentId: "env-1",
  serverId: null as string | null,
  name: "ui-pg",
  description: null,
  dockerImage: "postgres:18",
  applicationStatus: "done",
};
const shown = vi.hoisted(() => ({
  kind: "postgres",
  row: {} as Record<string, unknown>,
}));
vi.mock("../database-panel", () => ({
  DatabasePanel: ({
    children,
  }: {
    children: (row: Database, kind: string) => React.ReactNode;
  }) => <>{children(shown.row as unknown as Database, shown.kind)}</>,
}));

// The host's kernel reading, by Server id (`""` the platform host): the
// boundary is GET /settings/runtime-info.
const kernels = vi.hoisted(() => ({ refused: {} as Record<string, string> }));
vi.mock("@/lib/api/use-runtime-info", () => ({
  useRuntimeInfo: (
    serverId: string | null,
    { enabled = true }: { enabled?: boolean } = {},
  ) => {
    const kernel = enabled ? kernels.refused[serverId ?? ""] : undefined;
    return {
      data: kernel
        ? { kernel: { observed: kernel }, mongoRefusesKernel: true }
        : undefined,
    };
  },
}));

const { DATABASE_UPDATE_REFUSAL } = await import("../use-database");
const { default: Panel } = await import("./overview");

beforeEach(() => {
  shown.kind = "postgres";
  shown.row = { ...POSTGRES };
});

afterEach(() => {
  cleanup();
  refused.current = new Set();
  kernels.refused = {};
  update.mutateAsync.mockClear();
});

const props = {
  id: "db-1",
  kind: "postgres",
  label: "Overview",
  icon: "db",
} as unknown as PanelProps;

const save = () => screen.getByRole("button", { name: "Save changes" });

/**
 * Identity saves through `PATCH /:kind/:id`, whose
 * `findOwnedForUpdate` asks `service: ['update']` on all six engines.
 */
describe("a database's Identity card", () => {
  it("turns Save off, with the reason, for a role without service:update", () => {
    refused.current = new Set(["service:update"]);
    render(<Panel {...props} />);

    expect(save().getAttribute("aria-disabled")).toBe("true");
    expect(save().getAttribute("title")).toBe(DATABASE_UPDATE_REFUSAL);
  });

  it("sends nothing when it is submitted anyway", async () => {
    refused.current = new Set(["service:update"]);
    render(<Panel {...props} />);

    fireEvent.submit(save().closest("form") as HTMLFormElement);

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        DATABASE_UPDATE_REFUSAL,
      ),
    );
    expect(update.mutateAsync).not.toHaveBeenCalled();
  });

  it("offers Save to a role that holds it, and saves", async () => {
    render(<Panel {...props} />);

    expect(save().getAttribute("aria-disabled")).not.toBe("true");
    expect(save().getAttribute("title")).toBeNull();

    fireEvent.click(save());
    await waitFor(() =>
      expect(update.mutateAsync).toHaveBeenCalledWith({
        name: "ui-pg",
        description: null,
        dockerImage: "postgres:18",
      }),
    );
  });
});

/**
 * A MongoDB 8 on a kernel from 6.19 to 7.0.13 restarts forever while its
 * status reads done (#104); the Overview says why, above the output.
 */
describe("a MongoDB's Overview on a kernel MongoDB 8 refuses", () => {
  const mongo = (dockerImage: string) => {
    shown.kind = "mongo";
    shown.row = {
      ...POSTGRES,
      name: "ackee-mongo",
      serverId: "srv-2604",
      dockerImage,
    };
  };

  it("says it will not start there, and how to update the kernel", () => {
    kernels.refused["srv-2604"] = "7.0.12";
    mongo("mongo:8");
    render(<Panel {...props} />);

    expect(document.body.textContent).toContain(
      "This MongoDB will not start on its host.",
    );
    expect(document.body.textContent).toContain(
      "MongoDB 8 will not start on its Server's kernel, Linux 7.0.12",
    );
  });

  it("says nothing for a mongo:7 on the same kernel, or a postgres", () => {
    kernels.refused["srv-2604"] = "7.0.12";
    mongo("mongo:7");
    render(<Panel {...props} />);
    expect(document.body.textContent).not.toContain("MongoDB 8 will not start");
    cleanup();

    shown.kind = "postgres";
    shown.row = { ...POSTGRES, serverId: "srv-2604" };
    render(<Panel {...props} />);
    expect(document.body.textContent).not.toContain("MongoDB 8 will not start");
  });
});
