import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Server } from "@/lib/api/endpoints/servers";
import { roleRefusal } from "@/lib/auth/use-permission";

/**
 * `usePermission`'s verdict, held by statement. Everything is held unless a
 * case takes it away; the decision itself is pinned in `use-permission.test.ts`.
 */
const refused = vi.hoisted(() => ({ current: new Set<string>() }));
const usePermission = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission,
}));

// The writes are the boundary; the cards are real. The delete dialog's own
// behaviour is its own concern — here it only says whether it opened.
const update = vi.hoisted(() => ({ mutateAsync: vi.fn(async () => ({})) }));
vi.mock("../use-server", async (original) => ({
  ...(await original<typeof import("../use-server")>()),
  useUpdateServer: () => update,
}));
vi.mock("./delete-server-modal", () => ({
  DeleteServerModal: ({ open }: { open: boolean }) =>
    open ? <p>delete dialog open</p> : null,
}));
vi.mock("@/components/console/toast", () => ({
  toast: { done: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const { SERVER_UPDATE_REFUSAL, SERVER_DELETE_REFUSAL } =
  await import("../use-server");
const { ConnectionCard } = await import("./connection-card");
const { IdentityCard } = await import("./identity-card");
const { SetupCommandCard } = await import("./setup-command-card");
const { DangerCard } = await import("./server-danger-card");

const server = {
  serverId: "srv-1",
  name: "ui-server",
  description: "The box under the desk",
  serverType: "deploy",
  ipAddress: "10.0.0.5",
  port: 22,
  username: "root",
  command: "",
} as unknown as Server;

afterEach(() => {
  cleanup();
  refused.current.clear();
  update.mutateAsync.mockClear();
  usePermission.mockReset();
});

function hold(refusing: string[]) {
  for (const statement of refusing) refused.current.add(statement);
  usePermission.mockImplementation((required: Record<string, string[]>) => ({
    allowed: Object.entries(required).every(([resource, actions]) =>
      actions.every((action) => !refused.current.has(`${resource}:${action}`)),
    ),
    pending: false,
    role: "member",
  }));
}

it("says the role's reason in the words every gated control uses", () => {
  expect(SERVER_UPDATE_REFUSAL).toBe(roleRefusal("change this Server"));
  expect(SERVER_DELETE_REFUSAL).toBe(roleRefusal("delete a Server"));
});

/**
 * The three cards on a Server's Settings tab. `PATCH /servers/:id`
 * carries `@RequirePermission('server', 'create')` — the vocabulary has no
 * `server: ['update']` — so a role without it filled a card in, pressed Save
 * and met a bare 403.
 */
describe.each([
  {
    card: "Server",
    Card: IdentityCard,
    unit: "IdentityCard",
    field: "Name",
    value: "ui-server-2",
    sent: {
      name: "ui-server-2",
      description: "The box under the desk",
      serverType: "deploy",
    },
  },
  {
    card: "Connection",
    Card: ConnectionCard,
    unit: "ConnectionCard",
    field: "Address",
    value: "10.0.0.6",
    sent: { ipAddress: "10.0.0.6", port: 22, username: "root" },
  },
  {
    card: "Setup command",
    Card: SetupCommandCard,
    unit: "SetupCommandCard",
    // An optional field's label carries the word "optional" after its name.
    field: /^Setup command/,
    value: "echo hi",
    sent: { command: "echo hi" },
  },
])("$unit — Save", ({ Card, field, value, sent }) => {
  function mount(refusing: string[]) {
    hold(refusing);
    render(<Card server={server} />);
    const input = screen.getByLabelText(field);
    fireEvent.change(input, { target: { value } });
    return {
      input,
      save: screen.getByRole("button", { name: "Save changes" }),
    };
  }

  it("asks for server:create, what the route checks", () => {
    mount([]);
    expect(usePermission).toHaveBeenCalledWith({ server: ["create"] });
  });

  it("holds Save off for a role that cannot change the Server, and says why", () => {
    const { save } = mount(["server:create"]);

    expect(save.getAttribute("aria-disabled")).toBe("true");
    expect(save.hasAttribute("disabled")).toBe(false);
    expect(save.getAttribute("title")).toBe(SERVER_UPDATE_REFUSAL);
  });

  it("sends nothing when a refused form is submitted anyway", async () => {
    const { input, save } = mount(["server:create"]);

    fireEvent.click(save);
    fireEvent.submit(input.closest("form") as HTMLFormElement);

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        SERVER_UPDATE_REFUSAL,
      ),
    );
    expect(update.mutateAsync).not.toHaveBeenCalled();
  });

  it("offers Save to a role that can, and saves", async () => {
    const { save } = mount([]);

    expect(save.getAttribute("aria-disabled")).not.toBe("true");
    expect(save.hasAttribute("title")).toBe(false);

    fireEvent.click(save);
    await waitFor(() => expect(update.mutateAsync).toHaveBeenCalledWith(sent));
  });
});

/**
 * Delete: `DELETE /servers/:id` is `@RequirePermission('server',
 * 'delete')`, which the base member does not hold.
 */
describe("DangerCard — Delete", () => {
  function mount(refusing: string[]) {
    hold(refusing);
    render(<DangerCard server={server} />);
    return screen.getByRole("button", { name: "Delete" });
  }

  it("asks for server:delete, what the route checks", () => {
    mount([]);
    expect(usePermission).toHaveBeenCalledWith({ server: ["delete"] });
  });

  it("is off for a role without it, says why beside it, and opens nothing", () => {
    const button = mount(["server:delete"]);

    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("title")).toBe(SERVER_DELETE_REFUSAL);
    const described = button.getAttribute("aria-describedby");
    expect(described && document.getElementById(described)?.textContent).toBe(
      SERVER_DELETE_REFUSAL,
    );

    fireEvent.click(button);
    expect(screen.queryByText("delete dialog open")).toBeNull();
  });

  it("opens the dialog for a role that can", () => {
    const button = mount([]);

    expect(button.getAttribute("aria-disabled")).not.toBe("true");
    expect(button.hasAttribute("title")).toBe(false);
    expect(screen.queryByText(SERVER_DELETE_REFUSAL)).toBeNull();

    fireEvent.click(button);
    expect(screen.getByText("delete dialog open")).not.toBeNull();
  });
});
