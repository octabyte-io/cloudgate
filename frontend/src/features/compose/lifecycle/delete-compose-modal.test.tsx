import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { toast } from "@/components/console/toast";
import { ApiError } from "@/lib/api/api-error";
import type { ComposeDetail, ComposeType } from "@/lib/api/endpoints/compose";
import type { Deployment } from "@/lib/api/endpoints/deployments";

/** The stack's Deployments, as the list query answers them. Set per case. */
let history: { data: Deployment[] | undefined } = { data: [] };

vi.mock("../use-compose", () => ({
  useComposeDeployments: () => history,
}));
// Rendered through a portal nothing here reads.
vi.mock("@/components/console/toast", () => ({
  toast: { done: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const { DeleteComposeModal } = await import("./delete-compose-modal");

afterEach(() => {
  cleanup();
  vi.mocked(toast.done).mockClear();
});

async function deleteIt(composeType: ComposeType) {
  const compose = {
    composeId: "cmp-1",
    environmentId: "env-1",
    name: "ui-repo",
    appName: "compose-q1ivxa",
    composeType,
  } as ComposeDetail;
  const remove = vi.fn(() => Promise.resolve({}));
  const onDeleted = vi.fn();
  render(
    <DeleteComposeModal
      compose={compose}
      open
      onOpenChange={() => {}}
      remove={remove}
      onDeleted={onDeleted}
    />,
  );
  const said = document.body.textContent ?? "";
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "ui-repo" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Delete stack" }));
  await waitFor(() => expect(onDeleted).toHaveBeenCalled());
  const [, options] = vi.mocked(toast.done).mock.calls[0];
  return { said, toast: options?.description ?? "", remove };
}

/**
 * What the delete says about a stack's volumes (the Compose site). A
 * stack creates its volumes at its first deploy, and every deploy writes a
 * Deployment row that is never deleted — so an empty history is proof that
 * nothing was ever created on the deploy target.
 */
describe("DeleteComposeModal — volumes", () => {
  it.each<ComposeType>(["docker-compose", "stack"])(
    "%s never deployed: says nothing was left behind rather than volumes still on the target",
    async (type) => {
      history = { data: [] };
      const { said, toast } = await deleteIt(type);

      expect(toast).not.toContain("still on the deploy target");
      expect(toast).toBe("It was never deployed, so nothing was left on the deploy target.");
      expect(said).not.toContain("Named volumes are left behind.");
      expect(said).not.toContain("Delete its volumes too");
      expect(said).toContain("It was never deployed, so it has no volumes");
    },
  );

  it.each<ComposeType>(["docker-compose", "stack"])(
    "%s deployed: its named volumes are still on the target",
    async (type) => {
      history = { data: [{ deploymentId: "d-1" } as Deployment] };
      const { toast } = await deleteIt(type);

      expect(toast).toBe("Its named volumes are still on the deploy target.");
    },
  );

  it("history still loading: claims nothing it cannot know, and keeps the switch", async () => {
    history = { data: undefined };
    const { said, toast } = await deleteIt("docker-compose");

    expect(said).toContain("Delete its volumes too");
    expect(toast).toBe("Its named volumes are still on the deploy target.");
  });
});

const STACK = {
  composeId: "cmp-1",
  environmentId: "env-1",
  name: "ui-repo",
  appName: "compose-q1ivxa",
  composeType: "docker-compose",
} as ComposeDetail;

/**
 * The dialog opened on "Delete its volumes too", so one Space press
 * added `--volumes` to the teardown. It opens on the typed name instead.
 */
describe("DeleteComposeModal — initial focus", () => {
  it("never opens on the destructive volumes switch", async () => {
    history = { data: [{} as Deployment] };
    render(
      <DeleteComposeModal
        compose={STACK}
        open
        onOpenChange={() => {}}
        remove={vi.fn()}
        onDeleted={vi.fn()}
      />,
    );

    const field = screen.getByRole("textbox");
    await waitFor(() => expect(document.activeElement).toBe(field));
    expect(document.activeElement).not.toBe(screen.getByRole("switch"));
  });
});

/**
 * A stack whose deploy target cannot be reached is kept with a 409, and
 * the dialog offers the forced Delete rather than an API parameter.
 */
describe("DeleteComposeModal — Remove from Cloudgate anyway", () => {
  it("sends the forced Delete after the stack was kept", async () => {
    history = { data: [{} as Deployment] };
    const remove = vi
      .fn()
      .mockRejectedValueOnce(
        new ApiError(409, "kept — or delete with ?force=true", {
          code: "WORKLOAD_PRESENCE_UNKNOWN",
        }),
      )
      .mockResolvedValueOnce({});
    const onDeleted = vi.fn();
    render(
      <DeleteComposeModal
        compose={STACK}
        open
        onOpenChange={() => {}}
        remove={remove}
        onDeleted={onDeleted}
      />,
    );
    const said = document.body.textContent ?? "";
    expect(said).not.toContain("this row is still deleted");
    expect(said).toContain("the stack is kept");

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "ui-repo" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Delete stack" }));
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Remove from Cloudgate anyway",
      }),
    );

    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
    expect(remove).toHaveBeenNthCalledWith(1, false, false);
    expect(remove).toHaveBeenNthCalledWith(2, false, true);
    expect(document.body.textContent).not.toContain("force=true");
  });
});
