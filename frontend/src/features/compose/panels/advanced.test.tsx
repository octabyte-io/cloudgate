import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ComposeDetail } from "@/lib/api/endpoints/compose";

/**
 * `usePermission`'s verdict, held by statement. Everything is held unless a
 * case takes it away; the decision itself is pinned in `use-permission.test.ts`.
 */
const refused = vi.hoisted(() => ({ current: new Set<string>() }));
const usePermission = vi.hoisted(() =>
  vi.fn((required: Record<string, string[]>) => ({
    allowed: Object.entries(required).every(([resource, actions]) =>
      actions.every((action) => !refused.current.has(`${resource}:${action}`)),
    ),
    pending: false,
    role: "member",
  })),
);
vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission,
}));

const mutateAsync = vi.hoisted(() => vi.fn(async () => undefined));
const row = {
  composeId: "cmp-1",
  environmentId: "env-1",
  name: "ui-compose",
  appName: "ui-compose-abc",
  composeType: "docker-compose",
  command: "",
  sourceType: "github",
  composePath: "./docker-compose.yml",
  enableSubmodules: false,
  watchPaths: null,
  environment: { name: "staging", project: { name: "shop" } },
} as unknown as ComposeDetail;

// The row and the writes are the boundaries; the cards are real.
vi.mock("../use-compose", async (original) => ({
  ...(await original<typeof import("../use-compose")>()),
  useCompose: () => ({ data: row, error: null }),
  useUpdateCompose: () => ({ mutateAsync }),
  useComposeActions: () => ({ remove: { mutateAsync: vi.fn() } }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("../compose-facts-card", () => ({ ComposeFactsCard: () => null }));
vi.mock("../advanced/isolation-card", () => ({ IsolationCard: () => null }));
// The dialog is its own test's; what this screen decides is whether it opens.
vi.mock("../lifecycle/delete-compose-modal", () => ({
  DeleteComposeModal: ({ open }: { open: boolean }) =>
    open ? <p>the delete dialog</p> : null,
}));
vi.mock("@/components/console/toast", () => ({
  toast: { done: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const { COMPOSE_DELETE_REFUSAL, COMPOSE_UPDATE_REFUSAL } = await import("../use-compose");
const { default: Panel } = await import("./advanced");

afterEach(() => {
  cleanup();
  refused.current.clear();
  mutateAsync.mockClear();
  usePermission.mockClear();
});

function mount(refuse: string[] = []) {
  for (const statement of refuse) refused.current.add(statement);
  render(<Panel id="cmp-1" kind={null} label="Advanced" icon="layers" />);
  const saves = screen.getAllByRole("button", { name: "Save changes" });
  return {
    applied: saves[0],
    repository: saves[1],
    remove: screen.getByRole("button", { name: /^Delete ui-compose/ }),
  };
}

/**
 * The Advanced tab's three writes. Both cards save through
 * `PATCH /compose/:id`, which `findOwnedForUpdate` holds to
 * `service: ['update']`; Delete is `DELETE /compose/:id`, decorated
 * `service: ['delete']`.
 */
describe("Compose Advanced — the two cards", () => {
  it("asks for service:update and service:delete", () => {
    mount();
    expect(usePermission).toHaveBeenCalledWith({ service: ["update"] });
    expect(usePermission).toHaveBeenCalledWith({ service: ["delete"] });
  });

  it("holds both Saves off for a role that cannot change the stack, and says why", () => {
    const { applied, repository } = mount(["service:update"]);
    for (const save of [applied, repository]) {
      expect(save.getAttribute("aria-disabled")).toBe("true");
      expect(save.getAttribute("title")).toBe(COMPOSE_UPDATE_REFUSAL);
    }
  });

  it("sends nothing when a refused card is submitted anyway", async () => {
    const { applied, repository } = mount(["service:update"]);

    for (const save of [applied, repository]) {
      fireEvent.click(save);
      fireEvent.submit(save.closest("form") as HTMLFormElement);
    }

    await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(2));
    for (const alert of screen.getAllByRole("alert")) {
      expect(alert.textContent).toContain(COMPOSE_UPDATE_REFUSAL);
    }
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("offers both to a role that can, and saves", async () => {
    const { applied, repository } = mount();
    for (const save of [applied, repository]) {
      expect(save.getAttribute("aria-disabled")).not.toBe("true");
      expect(save.hasAttribute("title")).toBe(false);
    }

    fireEvent.submit(repository.closest("form") as HTMLFormElement);
    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        composePath: "./docker-compose.yml",
        enableSubmodules: false,
        watchPaths: null,
      }),
    );
  });
});

describe("Compose Advanced — Delete", () => {
  it("is off with the reason for a role without service:delete, and opens nothing", () => {
    const { remove } = mount(["service:delete"]);

    expect(remove.getAttribute("aria-disabled")).toBe("true");
    expect(remove.getAttribute("title")).toBe(COMPOSE_DELETE_REFUSAL);
    const described = remove.getAttribute("aria-describedby");
    expect(described).toBeTruthy();
    expect(document.getElementById(described as string)?.textContent).toBe(
      COMPOSE_DELETE_REFUSAL,
    );

    fireEvent.click(remove);
    expect(screen.queryByText("the delete dialog")).toBeNull();
  });

  it("is live for a role that holds it, and opens the dialog", () => {
    // Only the update is taken away: Delete answers to its own statement.
    const { remove } = mount(["service:update"]);

    expect(remove.getAttribute("aria-disabled")).not.toBe("true");
    expect(remove.hasAttribute("title")).toBe(false);
    expect(document.body.textContent).not.toContain(COMPOSE_DELETE_REFUSAL);

    fireEvent.click(remove);
    expect(screen.getByText("the delete dialog")).toBeTruthy();
  });
});
