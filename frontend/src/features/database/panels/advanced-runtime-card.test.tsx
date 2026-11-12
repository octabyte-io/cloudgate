import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Database, DatabaseKind } from "@/lib/api/endpoints/databases";

import type { useUpdateDatabase } from "../use-database";
import { RuntimeCard } from "./advanced-runtime-card";

// The role read is a query; these tests are about the card's words, so the
// role holds what the save asks (the gate is `advanced.test.tsx`'s).
vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission: () => ({ allowed: true, pending: false, role: "owner" }),
}));

afterEach(cleanup);

/**
 * What the Run command card tells an operator the two columns will do, per
 * engine — measured against what the backend emits, not against the card's
 * own earlier copy.
 *
 * The `update` mutation is the only boundary and nothing here saves: what is
 * asserted is what is read before the save.
 */
function mount(kind: DatabaseKind, over: Partial<Database> = {}) {
  const row = {
    databaseId: "db-1",
    environmentId: "env-1",
    command: null,
    args: null,
    replicaSets: false,
    ...over,
  } as unknown as Database;
  const update = {
    mutateAsync: vi.fn(),
  } as unknown as ReturnType<typeof useUpdateDatabase>;
  render(<RuntimeCard row={row} kind={kind} update={update} />);
}

const text = () => document.body.textContent ?? "";
const commandField = () =>
  document.querySelector<HTMLInputElement>('input[name="command"]')!;
const argsField = () =>
  document.querySelector<HTMLTextAreaElement>('textarea[name="args"]')!;

describe("RuntimeCard", () => {
  describe("an engine that runs the row's own command", () => {
    it("suggests no Command, because one replaces the entrypoint that drops privileges", () => {
      mount("postgres");

      // `postgres -c max_connections=200` was the placeholder, and on the
      // official image it runs as root and refuses to start.
      expect(commandField().placeholder).not.toMatch(/postgres/);
      expect(argsField().placeholder).toContain("max_connections=200");
    });

    it("says engine flags go in Arguments with Command empty, and what a Command skips", () => {
      mount("postgres");

      expect(text()).toContain("leave Command empty");
      expect(text()).toContain("put engine flags in Arguments");
      expect(text()).toContain("drops privileges");
      expect(text()).toContain("initialises the data directory");
    });

    it("says the same for a Mongo that is not a replica set", () => {
      mount("mongo", { replicaSets: false });

      expect(text()).toContain("put engine flags in Arguments");
    });
  });

  describe("LibSQL, whose Command replaces the sqld launcher", () => {
    it("says a Command replaces the whole sqld invocation, not that it is ignored", () => {
      mount("libsql");

      expect(text()).not.toContain("saved and then ignored");
      expect(text()).toContain("replaces the whole sqld invocation");
      // The flags `LibsqlService`'s DEFAULT_SQLD_COMMAND actually carries.
      for (const flag of [
        "--db-path iku.db",
        "--http-listen-addr 0.0.0.0:8080",
        "--grpc-listen-addr 0.0.0.0:5001",
        "--admin-listen-addr 0.0.0.0:5000",
      ]) {
        expect(text()).toContain(flag);
      }
      expect(text()).toContain("Arguments are ignored");
    });

    it("warns beside the field when a typed Command drops the external listen address", () => {
      mount("libsql");

      fireEvent.change(commandField(), { target: { value: "sqld" } });

      expect(text()).toContain(
        "This command does not listen on 0.0.0.0:8080",
      );
    });

    it("does not warn for a Command that keeps the listen address", () => {
      mount("libsql");

      fireEvent.change(commandField(), {
        target: {
          value:
            "sqld --db-path iku.db --http-listen-addr 0.0.0.0:8080 --grpc-listen-addr 0.0.0.0:5001 --admin-listen-addr 0.0.0.0:5000",
        },
      });

      expect(text()).not.toContain("does not listen on");
    });
  });

  describe("a replica-set Mongo, whose bootstrap script runs the Command beside mongod", () => {
    it("says Arguments are ignored and a Command runs beside the server", () => {
      mount("mongo", { replicaSets: true });

      expect(text()).not.toContain("saved and then ignored");
      expect(text()).toContain("Arguments are ignored");
      expect(text()).toContain("runs in the background once the replica set is initiated");
      expect(text()).not.toContain("replaces the script's last line");
    });
  });
});
