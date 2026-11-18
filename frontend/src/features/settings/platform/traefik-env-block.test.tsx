import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { UseMutationResult } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Gate } from "@/lib/auth/use-permission";

const useInstanceGate = vi.hoisted(() => vi.fn<() => Gate>());

// The instance-authority read is the boundary (ADR-0013); the save is a prop.
vi.mock("./use-platform", async (original) => ({
  ...(await original<typeof import("./use-platform")>()),
  useInstanceGate,
}));
vi.mock("@/components/console/toast", () => ({
  toast: { done: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const { EnvBlock } = await import("./traefik-env-block");

const REFUSAL = "Only an administrator of this Cloudgate instance can do this.";
const EDITED = "TZ=UTC\nCF_API_TOKEN=abc";

afterEach(() => {
  cleanup();
  useInstanceGate.mockReset();
});

function mount({ allowed }: { allowed: boolean }) {
  useInstanceGate.mockReturnValue({ allowed, refusal: allowed ? "" : REFUSAL });
  const mutateAsync = vi.fn(async () => true);
  const save = { mutateAsync, isPending: false } as unknown as UseMutationResult<
    boolean,
    Error,
    string
  >;
  render(
    <EnvBlock
      server="TZ=UTC"
      pending={false}
      save={save}
      recreating={false}
      onSaved={() => undefined}
    />,
  );
  fireEvent.change(screen.getByLabelText("Traefik's environment variables"), {
    target: { value: EDITED },
  });
  return {
    mutateAsync,
    button: screen.getByRole("button", { name: "Save environment" }),
  };
}

/**
 * Save environment: `POST /settings/traefik/env` runs
 * `traefikTargetAuthority`, and the console sends no `serverId`, which is the
 * platform host's branch — `requireInstanceAuthority`.
 */
describe("EnvBlock — Save environment", () => {
  it("is off with the reason for a caller without instance authority, and sends nothing", () => {
    const { mutateAsync, button } = mount({ allowed: false });

    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("title")).toBe(REFUSAL);
    const described = button.getAttribute("aria-describedby");
    expect(described).toBeTruthy();
    expect(document.getElementById(described as string)?.textContent).toBe(REFUSAL);

    fireEvent.click(button);
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("is live for an instance administrator, and saves", async () => {
    const { mutateAsync, button } = mount({ allowed: true });

    expect(button.getAttribute("aria-disabled")).not.toBe("true");
    expect(button.hasAttribute("title")).toBe(false);
    expect(document.body.textContent).not.toContain(REFUSAL);

    fireEvent.click(button);
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith(EDITED));
  });
});

/** Spec #118: the block expands to fill the window, with its own Save. */
describe("EnvBlock — Expand", () => {
  it("opens the edit filling the window and saves it from the top bar", async () => {
    const { mutateAsync } = mount({ allowed: true });

    fireEvent.click(
      screen.getByRole("button", { name: "Expand Environment variables" }),
    );
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByRole("heading", { name: "Environment variables" }),
    ).toBeTruthy();
    const box = within(dialog).getByLabelText(
      "Traefik's environment variables",
    ) as HTMLTextAreaElement;
    expect(box.value).toBe(EDITED);
    expect(within(dialog).getByText("Unsaved changes")).toBeTruthy();

    fireEvent.change(box, { target: { value: `${EDITED}\nLOG=debug` } });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Save environment" }),
    );
    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith(`${EDITED}\nLOG=debug`),
    );
  });

  it("keeps the edit in the block on Back to page", async () => {
    mount({ allowed: true });
    fireEvent.click(
      screen.getByRole("button", { name: "Expand Environment variables" }),
    );
    fireEvent.change(
      within(screen.getByRole("dialog")).getByLabelText(
        "Traefik's environment variables",
      ),
      { target: { value: "TZ=Europe/Paris" } },
    );

    fireEvent.click(screen.getByRole("button", { name: "Back to page" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(
      (screen.getByLabelText("Traefik's environment variables") as HTMLTextAreaElement)
        .value,
    ).toBe("TZ=Europe/Paris");
  });
});
