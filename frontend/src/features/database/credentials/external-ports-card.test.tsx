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
import type { Database } from "@/lib/api/endpoints/databases";

// The toast renders through a portal nothing here reads.
vi.mock("@/components/console/toast", () => ({
  toast: { done: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

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

const { ExternalPortsCard } = await import("./external-ports-card");
const { DATABASE_PORTS_REFUSAL } = await import("../use-database");

afterEach(() => {
  cleanup();
  vi.mocked(toast.done).mockClear();
  refused.current = new Set();
});

/**
 * Saving a port on a stopped database no longer starts it: the backend
 * writes the port onto the service with no tasks and answers the row still
 * `stopped`. The card has to say so before the save and after it — the old
 * footer promised a redeploy that no longer happens.
 */
async function saveOn(before: ApplicationStatus, answer: ApplicationStatus) {
  const database = {
    databaseId: "db-1",
    name: "ui-pg",
    applicationStatus: before,
    externalPort: null,
  } as unknown as Database;
  render(
    <ExternalPortsCard
      database={database}
      kind="postgres"
      save={() => Promise.resolve({ applicationStatus: answer })}
    />,
  );
  const said = document.body.textContent ?? "";
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "5433" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save ports" }));
  await waitFor(() => expect(toast.done).toHaveBeenCalled());
  const [, options] = vi.mocked(toast.done).mock.calls[0];
  return { said, toast: String(options?.description ?? "") };
}

describe("ExternalPortsCard", () => {
  it("says a stopped database stays stopped and takes the port on its next start", async () => {
    const { said, toast } = await saveOn("stopped", "stopped");

    expect(said).toContain("saving does not start it");
    expect(said).toContain("next start");
    expect(said).not.toContain("redeploys the service");
    expect(toast).toBe(
      "ui-pg is stopped, so the new ports take effect when it is next started.",
    );
  });

  it("still warns a running database that saving redeploys it", async () => {
    const { said, toast } = await saveOn("done", "done");

    expect(said).toContain("Saving redeploys the service straight away");
    expect(toast).toBe("ui-pg was redeployed onto the new ports.");
  });
});

/**
 * `POST /:kind/:id/external-port` is `@RequirePermission('service',
 * 'create')` and runs `findOwnedForUpdate`, which asks `service: ['update']`
 * — on all six engines, LibSQL's plural route included. The base member holds
 * `update` and not `create`, so it typed a port, pressed Save and met a 403.
 */
describe("ExternalPortsCard for a role that cannot publish a port", () => {
  function mount() {
    const save = vi.fn(async () => ({ applicationStatus: "done" }));
    const database = {
      databaseId: "db-1",
      name: "ui-pg",
      applicationStatus: "done",
      externalPort: null,
    } as unknown as Database;
    render(<ExternalPortsCard database={database} kind="postgres" save={save} />);
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "5433" },
    });
    return { save, button: screen.getByRole("button", { name: "Save ports" }) };
  }

  it.each(["service:create", "service:update"])(
    "turns Save ports off, with the reason beside it, without %s",
    (statement) => {
      refused.current = new Set([statement]);
      const { button } = mount();

      expect(button.getAttribute("aria-disabled")).toBe("true");
      expect(button.getAttribute("title")).toBe(DATABASE_PORTS_REFUSAL);
      const described = button.getAttribute("aria-describedby");
      expect(described).toBeTruthy();
      expect(document.getElementById(described as string)?.textContent).toBe(
        DATABASE_PORTS_REFUSAL,
      );
    },
  );

  it("sends nothing when it is submitted anyway", async () => {
    refused.current = new Set(["service:create"]);
    const { button, save } = mount();

    fireEvent.click(button);
    fireEvent.submit(button.closest("form") as HTMLFormElement);

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        DATABASE_PORTS_REFUSAL,
      ),
    );
    expect(save).not.toHaveBeenCalled();
  });

  it("offers Save ports to a role that holds both, and saves", async () => {
    const { button, save } = mount();

    expect(button.getAttribute("aria-disabled")).not.toBe("true");
    expect(button.getAttribute("title")).toBeNull();
    expect(document.body.textContent).not.toContain(DATABASE_PORTS_REFUSAL);

    fireEvent.click(button);
    await waitFor(() => expect(save).toHaveBeenCalledWith({ externalPort: 5433 }));
  });
});
