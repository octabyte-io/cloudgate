import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ComposeDetail } from "@/lib/api/endpoints/compose";

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

const mutateAsync = vi.hoisted(() => vi.fn(async () => undefined));
const row = {
  composeId: "cmp-1",
  environmentId: "env-1",
  name: "ui-compose",
  description: "Redis and a worker",
  appName: "ui-compose-abc",
  composeType: "docker-compose",
  composeStatus: "done",
  sourceType: "raw",
  environment: { name: "staging", project: { name: "shop" } },
} as unknown as ComposeDetail;

// The row and the write are the boundaries; the card is real.
vi.mock("../use-compose", async (original) => ({
  ...(await original<typeof import("../use-compose")>()),
  useCompose: () => ({ data: row, error: null }),
  useUpdateCompose: () => ({ mutateAsync }),
}));
vi.mock("../compose-facts-card", () => ({ ComposeFactsCard: () => null }));
vi.mock("../lifecycle/compose-actions", () => ({ ComposeActions: () => null }));
vi.mock("../source/compose-source-card", () => ({ ComposeSourceCard: () => null }));
vi.mock("../editor/compose-file-card", () => ({ ComposeFileCard: () => null }));
vi.mock("@/components/console/toast", () => ({
  toast: { done: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const { COMPOSE_UPDATE_REFUSAL } = await import("../use-compose");
const { default: Panel } = await import("./overview");

afterEach(() => {
  cleanup();
  refused.current.clear();
  mutateAsync.mockClear();
});

function mount({ allowed }: { allowed: boolean }) {
  usePermission.mockImplementation((required: Record<string, string[]>) => ({
    allowed: Object.entries(required).every(([resource, actions]) =>
      actions.every((action) => !refused.current.has(`${resource}:${action}`)),
    ),
    pending: false,
    role: "member",
  }));
  if (!allowed) refused.current.add("service:update");

  render(<Panel id="cmp-1" kind={null} label="Overview" icon="layers" />);

  const name = screen.getByLabelText("Name");
  fireEvent.change(name, { target: { value: "ui-compose-2" } });
  return { name, save: screen.getByRole("button", { name: "Save changes" }) };
}

/**
 * The Identity card's Save. `PATCH /compose/:id` runs
 * `findOwnedForUpdate`, which asks for `service: ['update']`; before this a
 * role without it typed a new name, pressed Save and met a bare 403.
 */
describe("Compose Overview — Identity", () => {
  it("asks for service:update", () => {
    mount({ allowed: true });
    expect(usePermission).toHaveBeenCalledWith({ service: ["update"] });
  });

  it("holds Save off for a role that cannot change the stack, and says why", () => {
    const { save } = mount({ allowed: false });

    expect(save.getAttribute("aria-disabled")).toBe("true");
    expect(save.hasAttribute("disabled")).toBe(false);
    expect(save.getAttribute("title")).toBe(COMPOSE_UPDATE_REFUSAL);
  });

  it("sends nothing when a refused form is submitted anyway", async () => {
    const { name, save } = mount({ allowed: false });

    fireEvent.click(save);
    fireEvent.submit(name.closest("form") as HTMLFormElement);

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(COMPOSE_UPDATE_REFUSAL),
    );
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("offers Save to a role that can, and saves", async () => {
    const { save } = mount({ allowed: true });

    expect(save.getAttribute("aria-disabled")).not.toBe("true");
    expect(save.hasAttribute("title")).toBe(false);

    fireEvent.click(save);
    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        name: "ui-compose-2",
        description: "Redis and a worker",
      }),
    );
  });
});
