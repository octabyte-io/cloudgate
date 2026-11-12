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

// The repository-kept config's lock, when a test sets one: the Environment's
// copy is a boundary.
const lock = vi.hoisted(() => ({
  current: null as null | Record<string, unknown>,
}));
vi.mock("@/components/console/config-lock", async (original) => ({
  ...(await original<typeof import("@/components/console/config-lock")>()),
  useConfigLock: () => lock.current,
}));

// The system boundaries: the row read and the writes. The two cards above
// Credentials have their own tests.
const update = vi.hoisted(() => ({ mutateAsync: vi.fn(async () => ({})) }));
vi.mock("../use-database", async (original) => ({
  ...(await original<typeof import("../use-database")>()),
  useUpdateDatabase: () => update,
  useDatabaseActions: () => ({ saveExternalPorts: { mutateAsync: vi.fn() } }),
}));
vi.mock("../credentials/connection-card", () => ({
  ConnectionCard: () => <p>Server connection card</p>,
}));
vi.mock("../credentials/external-ports-card", () => ({
  ExternalPortsCard: () => <p>External ports card</p>,
}));

const PG_ROW = {
  kind: "postgres",
  databaseId: "db-1",
  environmentId: "env-1",
  name: "ui-pg",
  appName: "postgres-ui-pg-x1y2z3",
  description: null,
  dockerImage: "postgres:18",
  applicationStatus: "done",
  databaseName: "app",
  databaseUser: "app",
  databasePassword: "s3cret",
};
/** The row and engine the panel renders; a test swaps them. */
const shown = vi.hoisted(() => ({
  row: null as null | Record<string, unknown>,
  kind: "postgres" as "postgres" | "mysql" | "redis",
}));
vi.mock("../database-panel", () => ({
  DatabasePanel: ({
    children,
  }: {
    children: (
      row: Database,
      kind: "postgres" | "mysql" | "redis",
    ) => React.ReactNode;
  }) => <>{children(shown.row as unknown as Database, shown.kind)}</>,
}));

const { DATABASE_UPDATE_REFUSAL } = await import("../use-database");
const { default: Panel } = await import("./credentials");

beforeEach(() => {
  shown.row = PG_ROW;
  shown.kind = "postgres";
});

afterEach(() => {
  cleanup();
  refused.current = new Set();
  lock.current = null;
  update.mutateAsync.mockClear();
});

const props = {
  id: "db-1",
  kind: "postgres",
  label: "Credentials",
  icon: "key",
} as unknown as PanelProps;

const save = () => screen.getByRole("button", { name: "Save changes" });

/**
 * Credentials saves through `PATCH /:kind/:id`, whose
 * `findOwnedForUpdate` asks `service: ['update']` on all six engines.
 */
describe("a database's Credentials card", () => {
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
    await waitFor(() => expect(update.mutateAsync).toHaveBeenCalledTimes(1));
  });
});

/**
 * On a repository-kept config, a postgres's database and user are the
 * file's when it states them, and locked in the card itself; the password
 * stays Cloudgate's.
 */
describe("a database's Credentials card on a repository-kept config", () => {
  const LOCK = {
    repository: "acme/shop",
    path: "cloudgate.yaml",
    branch: "main",
    fileUrl: null,
    appliedCommit: null,
    listed: { env: [], build_args: [], build_secrets: [] },
  };

  it("locks the database name and user the file states, and leaves the password", () => {
    lock.current = { ...LOCK, stated: new Set(["database", "user"]) };
    render(<Panel {...props} />);

    for (const label of [/^Database name/, /^User/]) {
      const input = screen.getByLabelText(label);
      expect(input.hasAttribute("readonly")).toBe(true);
      expect(input.getAttribute("title")).toContain("cloudgate.yaml");
    }
    expect(screen.getByText(/database name and user are set by the Project config/)).toBeTruthy();
  });

  it("leaves a field the file does not state editable", () => {
    lock.current = { ...LOCK, stated: new Set() };
    render(<Panel {...props} />);

    expect(
      screen.getByLabelText(/^Database name/).hasAttribute("readonly"),
    ).toBe(false);
    expect(screen.queryByText(/set by the Project config/)).toBeNull();
  });
});

/**
 * A database Cloudgate made on a cloud is reached at the address its
 * Cloud run saved, over TLS, with the password its cloud has: never the
 * Server's `appName`, its generated password, or a published port.
 */
describe("a cloud database's Credentials tab", () => {
  const PEM =
    "-----BEGIN CERTIFICATE-----\nMIIBmemorystore\n-----END CERTIFICATE-----";
  const MEMORYSTORE = {
    ...PG_ROW,
    kind: "redis",
    name: "redis",
    appName: "redis-cache-a1b2c3",
    dockerImage: "redis:8",
    databaseName: undefined,
    databaseUser: undefined,
    databasePassword: undefined,
    cloudAccountId: "ca-google",
    region: "europe-west1",
    hasAuthToken: false,
    memorystore: { highAvailability: false },
    memorystoreEndpoint: { host: "10.64.16.4", port: 6379, ca: PEM },
    elasticacheEndpoint: null,
  };
  const ELASTICACHE = {
    ...MEMORYSTORE,
    cloudAccountId: "ca-aws",
    region: "eu-central-1",
    hasAuthToken: true,
    memorystore: null,
    memorystoreEndpoint: null,
    elasticacheEndpoint: {
      host: "master.cloudgate-redis.abc123.euc1.cache.amazonaws.com",
      port: 6379,
    },
    replica: false,
    snapshotRetentionDays: 1,
  };
  const RDS = {
    ...PG_ROW,
    cloudAccountId: "ca-aws",
    region: "eu-central-1",
    rdsEndpoint: {
      host: "shop-production-pg-1.c9akciq32.eu-central-1.rds.amazonaws.com",
      port: 5432,
    },
    cloudSqlEndpoint: null,
  };

  function renderRow(
    row: Record<string, unknown>,
    kind: "postgres" | "mysql" | "redis",
  ) {
    shown.row = row;
    shown.kind = kind;
    return render(<Panel {...props} />);
  }

  /** Nothing of the Server's: its name as a host, its card, a published port. */
  function expectNoServerConnection(appName: string) {
    expect(document.body.textContent).not.toContain(appName);
    expect(screen.queryByText("Server connection card")).toBeNull();
    expect(screen.queryByText("External ports card")).toBeNull();
  }

  it("shows a redis on Memorystore at its private address, with no password and its rediss:// URL", () => {
    renderRow(MEMORYSTORE, "redis");

    expect(screen.getByText("10.64.16.4")).toBeTruthy();
    expect(screen.getByText("6379")).toBeTruthy();
    expect(screen.getByText("Required")).toBeTruthy();
    expect(
      screen.getByText(
        "No password. Only this Environment's private network reaches it, over TLS",
      ),
    ).toBeTruthy();
    expect(screen.getByText("rediss://10.64.16.4:6379")).toBeTruthy();
    expect(screen.queryByLabelText(/^Password/)).toBeNull();
    expect(document.body.textContent).not.toContain("MIIBmemorystore");
    expectNoServerConnection(MEMORYSTORE.appName);
  });

  it("shows a redis on ElastiCache at its endpoint, its AUTH token only as set", () => {
    renderRow(ELASTICACHE, "redis");

    expect(screen.getByText(ELASTICACHE.elasticacheEndpoint.host)).toBeTruthy();
    expect(screen.getByText("AUTH token: set")).toBeTruthy();
    expect(
      screen.getByText(
        `rediss://default:<AUTH token>@${ELASTICACHE.elasticacheEndpoint.host}:6379`,
      ),
    ).toBeTruthy();
    expect(screen.queryByLabelText(/^Password/)).toBeNull();
    expectNoServerConnection(ELASTICACHE.appName);
  });

  it("shows a postgres on RDS at its endpoint, with its login and Credentials form", () => {
    renderRow(RDS, "postgres");

    expect(screen.getByText(RDS.rdsEndpoint.host)).toBeTruthy();
    expect(screen.getByText("5432")).toBeTruthy();
    expect(screen.getByText("Required")).toBeTruthy();
    expect(screen.getByLabelText(/^User/)).toBeTruthy();
    expect(screen.getByLabelText(/^Password/)).toBeTruthy();
    expectNoServerConnection(RDS.appName);
  });

  it("shows a mysql on RDS at its endpoint with its mysql:// string, TLS offered and not required", () => {
    const host = "cloudgate-db1.c9akciq32.eu-central-1.rds.amazonaws.com";
    renderRow(
      {
        ...RDS,
        kind: "mysql",
        dockerImage: "mysql:8.4",
        rdsEndpoint: { host, port: 3306 },
      },
      "mysql",
    );

    expect(screen.getByText(host)).toBeTruthy();
    expect(screen.getByText("3306")).toBeTruthy();
    expect(screen.getByText("Offered, not required")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Show secrets/ }));
    expect(
      screen.getByText(`mysql://app:s3cret@${host}:3306/app`),
    ).toBeTruthy();
    expectNoServerConnection(RDS.appName);
  });

  it("says a cloud database with no saved address is not made yet", () => {
    renderRow({ ...MEMORYSTORE, memorystoreEndpoint: null }, "redis");

    expect(
      screen.getByText(
        "Not made yet: its address appears once its Cloud run has made it",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/^rediss:/)).toBeNull();
    expectNoServerConnection(MEMORYSTORE.appName);
  });

  it("leaves a redis on a Server as it was: its connection, ports and password", () => {
    renderRow(
      {
        ...MEMORYSTORE,
        cloudAccountId: null,
        region: null,
        memorystore: null,
        memorystoreEndpoint: null,
        databasePassword: "s3cret",
      },
      "redis",
    );

    expect(screen.getByText("Server connection card")).toBeTruthy();
    expect(screen.getByText("External ports card")).toBeTruthy();
    expect(screen.getByLabelText(/^Password/)).toBeTruthy();
  });
});

/**
 * The edit form's password hint was the create form's ("leave it empty
 * when creating and one is generated"), an emptied field kept the old password
 * while reading as removed, and the form held the stored password in plain
 * text behind its own eye toggle beside the card's Show secrets.
 */
describe("a database's Credentials card password", () => {
  const field = () => screen.getByLabelText("Password") as HTMLInputElement;

  it("starts empty, says empty keeps the current password, and never holds the stored one", () => {
    render(<Panel {...props} />);

    expect(field().value).toBe("");
    expect(field().placeholder).toBe("Unchanged");
    expect(document.body.textContent).toContain(
      "Leave it empty to keep the current password.",
    );
    expect(document.body.textContent).not.toContain("when creating");
    expect(document.body.innerHTML).not.toContain("s3cret");
  });

  it("sends no password when left empty, so the stored one is kept", async () => {
    render(<Panel {...props} />);

    fireEvent.submit(save().closest("form") as HTMLFormElement);

    await waitFor(() => expect(update.mutateAsync).toHaveBeenCalled());
    expect(update.mutateAsync.mock.calls[0]).toEqual([
      expect.not.objectContaining({ databasePassword: expect.anything() }),
    ]);
  });

  it("sends a typed password, then reads Unchanged again once saved", async () => {
    render(<Panel {...props} />);

    fireEvent.change(field(), { target: { value: "N3wPassw0rd" } });
    fireEvent.submit(save().closest("form") as HTMLFormElement);

    await waitFor(() =>
      expect(update.mutateAsync).toHaveBeenCalledWith(
        expect.objectContaining({ databasePassword: "N3wPassw0rd" }),
      ),
    );
    await waitFor(() => expect(field().value).toBe(""));
  });
});
