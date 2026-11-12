import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { UseQueryResult } from "@tanstack/react-query";
import Link from "next/link";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { ResourceSpec } from "@/components/console/resource-spec";
import { ApiError } from "@/lib/api/api-error";

import { ResourceList } from "./resource-list";

vi.mock("@/lib/api/use-servers", () => ({
  useServers: () => ({ data: [] }),
}));

/**
 * The statements the caller holds, by `resource:action` — the verdict itself is
 * `permissionVerdict`'s and pinned in `use-permission.test.ts`; what this file
 * asks is what `ResourceList` does with it. `roleRefusal` and
 * `readGate` stay real.
 */
const held = vi.hoisted(() => ({ current: new Set<string>() }));
vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission: (required: Record<string, string[]>) => ({
    allowed: Object.entries(required).every(([resource, actions]) =>
      actions.every((action) => held.current.has(`${resource}:${action}`)),
    ),
    pending: false,
    role: "member",
  }),
}));

/**
 * **A row's delete that left something on a machine says so**.
 *
 * Schedules, database backups and volume backups are `ResourceList` rows, and
 * now their delete removes the run logs on the machine that wrote them
 * and answers with `unreclaimedArtifacts` when that machine would not. The
 * delete dialog closes the moment the remove resolves, so the list is what has
 * to show the answer — an earlier defect was a field added to a response that
 * nothing rendered, and this is the test that it was not repeated here.
 */

afterEach(() => {
  cleanup();
  held.current = new Set(["schedule:create", "schedule:update", "schedule:delete"]);
});
held.current = new Set(["schedule:create", "schedule:update", "schedule:delete"]);

type Row = { id: string; name: string };

function spec(remove: () => Promise<unknown>): ResourceSpec<Row, { name: string }> {
  return {
    noun: "schedule",
    plural: "schedules",
    title: "Schedules",
    icon: "spark",
    addLabel: "Add a schedule",
    emptyTitle: "No schedules",
    emptyBody: "None.",
    tableLabel: "Schedules",
    columns: [{ id: "name", head: "Name", cell: (row: Row) => row.name }],
    getRowId: (row: Row) => row.id,
    rowName: (row: Row) => row.name,
    schema: z.object({ name: z.string() }) as never,
    fields: [{ name: "name", label: "Name" }],
    toDefaults: () => ({ name: "" }),
    create: async () => undefined,
    update: async () => undefined,
    remove,
    permissions: {
      create: { schedule: ["create"] },
      update: { schedule: ["update"] },
      remove: { schedule: ["delete"] },
    },
  } as unknown as ResourceSpec<Row, { name: string }>;
}

const query = {
  data: [{ id: "s1", name: "ui-tick" }],
  error: null,
  isPending: false,
} as unknown as UseQueryResult<Row[]>;

async function removeTheRow() {
  fireEvent.click(screen.getByRole("button", { name: "Remove" }));
  fireEvent.click(await screen.findByRole("button", { name: "Remove schedule" }));
}

describe("ResourceList", () => {
  it("shows what a remove left on a machine, after the delete dialog has closed", async () => {
    render(
      <ResourceList
        spec={spec(async () => ({
          id: "s1",
          unreclaimedArtifacts: [
            {
              kind: "deployment-logs",
              appName: "schedule-47rn16",
              serverId: null,
              path: "/etc/cloudgate/logs/schedule-47rn16",
            },
          ],
        }))}
        query={query}
      />,
    );

    await removeTheRow();

    expect(
      await screen.findByText(
        "ui-tick was removed, but not everything was cleaned up",
      ),
    ).toBeTruthy();
    expect(screen.getByText("/etc/cloudgate/logs/schedule-47rn16")).toBeTruthy();
    expect(screen.getByText("Deployment logs")).toBeTruthy();
  });

  it("shows nothing after a remove that left nothing behind", async () => {
    const remove = vi.fn(async () => ({ id: "s1" }));
    render(<ResourceList spec={spec(remove)} query={query} />);

    await removeTheRow();
    await vi.waitFor(() => expect(remove).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(screen.queryByText(/not everything was cleaned up/)).toBeNull();
  });

  // The U-run saw removing the last row of a list with a `note` crash
  // the page with an `insertBefore` NotFoundError. It never reproduced outside
  // that run's automated Chrome, and jsdom cannot move a node behind React's
  // back, so this pins the React side only: the note and the table give way
  // to the empty state on the remove's refetch, and React reports no error.
  it("lands on the empty state when the refetch after removing the last row of a noted list returns none", async () => {
    const reported = vi.spyOn(console, "error").mockImplementation(() => {});
    const remove = vi.fn(async () => ({ id: "s1" }));
    const note = <p>A change lands on the next run.</p>;
    const { rerender } = render(
      <ResourceList spec={spec(remove)} query={query} note={note} />,
    );
    expect(screen.getByText("A change lands on the next run.")).toBeTruthy();

    await removeTheRow();
    await vi.waitFor(() => expect(remove).toHaveBeenCalled());
    rerender(
      <ResourceList
        spec={spec(remove)}
        query={{ ...query, data: [] } as unknown as UseQueryResult<Row[]>}
        note={note}
      />,
    );

    expect(await screen.findByText("No schedules")).toBeTruthy();
    expect(screen.queryByText("ui-tick")).toBeNull();
    expect(screen.queryByText("A change lands on the next run.")).toBeNull();
    expect(reported).not.toHaveBeenCalled();
    reported.mockRestore();
  });

  // A role without the statement met the 403 only after filling the
  // form in. The three controls are off up front, each saying why.
  it("turns Add, Edit and Remove off with the reason for a role without their statements", () => {
    held.current = new Set();
    render(<ResourceList spec={spec(async () => undefined)} query={query} />);

    const add = screen.getByRole("button", { name: "Add a schedule" });
    const edit = screen.getByRole("button", { name: "Edit" });
    const remove = screen.getByRole("button", { name: "Remove" });
    for (const control of [add, edit, remove]) {
      expect(control.getAttribute("aria-disabled")).toBe("true");
    }
    expect(add.getAttribute("title")).toBe(
      "Your role in this Organization cannot add a schedule. Ask an owner or an admin to do it, or to change your role.",
    );
    expect(remove.getAttribute("title")).toMatch(/cannot remove this schedule/);

    fireEvent.click(remove);
    expect(screen.queryByRole("button", { name: "Remove schedule" })).toBeNull();
  });

  it("asks for each write's own statement, not one for all three", () => {
    held.current = new Set(["schedule:update"]);
    render(<ResourceList spec={spec(async () => undefined)} query={query} />);

    expect(
      screen.getByRole("button", { name: "Edit" }).getAttribute("aria-disabled"),
    ).not.toBe("true");
    expect(
      screen
        .getByRole("button", { name: "Add a schedule" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
  });

  it("takes a refused list as the answer for a surface no statement names", () => {
    held.current = new Set();
    const refusal = new ApiError(403, "Only owners and admins can manage AI settings");
    render(
      <ResourceList
        spec={{ ...spec(async () => undefined), permissions: "same-as-list" }}
        query={{ data: undefined, error: refusal, isPending: false } as never}
      />,
    );
    const add = screen.getByRole("button", { name: "Add a schedule" });
    expect(add.getAttribute("aria-disabled")).toBe("true");
    expect(add.getAttribute("title")).toBeTruthy();
  });

  it("leaves a same-as-list surface live while its list reads", () => {
    held.current = new Set();
    render(
      <ResourceList
        spec={{ ...spec(async () => undefined), permissions: "same-as-list" }}
        query={query}
      />,
    );
    expect(
      screen
        .getByRole("button", { name: "Add a schedule" })
        .getAttribute("aria-disabled"),
    ).not.toBe("true");
  });
});

/**
 * An empty list showed Add twice, once in the header and once in its
 * empty state; and with nothing a row needs to exist yet (a backup schedule
 * with no destination), both opened a form that could never be submitted.
 */
describe("ResourceList — the Add control", () => {
  const empty = {
    data: [],
    error: null,
    isPending: false,
  } as unknown as UseQueryResult<Row[]>;

  it("offers Add once on an empty list, in its empty state", () => {
    render(<ResourceList spec={spec(async () => undefined)} query={empty} />);

    expect(screen.getAllByRole("button", { name: "Add a schedule" })).toHaveLength(1);
  });

  it("keeps Add in the header once the list has rows", () => {
    render(<ResourceList spec={spec(async () => undefined)} query={query} />);

    expect(screen.getAllByRole("button", { name: "Add a schedule" })).toHaveLength(1);
  });

  it("puts addInstead where Add would be, and no Add at all", () => {
    render(
      <ResourceList
        spec={{
          ...spec(async () => undefined),
          addInstead: <Link href="/settings/destinations">Connect a destination</Link>,
        }}
        query={empty}
      />,
    );

    expect(screen.queryByRole("button", { name: "Add a schedule" })).toBeNull();
    expect(
      screen.getAllByRole("link", { name: "Connect a destination" }),
    ).toHaveLength(1);
  });
});
