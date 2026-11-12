import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { UseMutationResult } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TraefikPort } from "@/lib/api/endpoints/traefik";
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

const { PortsBlock } = await import("./traefik-ports-block");

const REFUSAL = "Only an administrator of this Cloudgate instance can do this.";
const ROWS: TraefikPort[] = [
  { publishedPort: 9000, targetPort: 9000, protocol: "tcp" },
];

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
    TraefikPort[]
  >;
  render(
    <PortsBlock
      rows={ROWS}
      pending={false}
      save={save}
      recreating={false}
      onSaved={() => undefined}
    />,
  );
  const button = (name: string) => screen.getByRole("button", { name });
  return { mutateAsync, button };
}

function refusedWithReason(button: HTMLElement) {
  expect(button.getAttribute("aria-disabled")).toBe("true");
  expect(button.getAttribute("title")).toBe(REFUSAL);
  const described = button.getAttribute("aria-describedby");
  expect(described).toBeTruthy();
  expect(document.getElementById(described as string)?.textContent).toBe(REFUSAL);
}

/**
 * Save ports, Add a port and Remove: `POST /settings/traefik/ports`
 * runs `traefikTargetAuthority`, and the console sends no `serverId`, which is
 * the platform host's branch — `requireInstanceAuthority`. Add and Remove only
 * edit the draft, but a draft nobody may save is a form the backend refuses
 * after it has been filled in.
 */
describe("PortsBlock — Save ports, Add a port, Remove", () => {
  it("are off with the reason for a caller without instance authority, and change and send nothing", () => {
    const { mutateAsync, button } = mount({ allowed: false });

    for (const name of ["Add a port", "Remove", "Save ports"]) {
      refusedWithReason(button(name));
    }

    fireEvent.click(button("Add a port"));
    fireEvent.click(button("Remove"));
    expect(screen.getAllByRole("button", { name: "Remove" })).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Discard changes" })).toBeNull();

    fireEvent.click(button("Save ports"));
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("are live for an instance administrator, and save the edited list", async () => {
    const { mutateAsync, button } = mount({ allowed: true });

    expect(document.body.textContent).not.toContain(REFUSAL);
    for (const name of ["Add a port", "Remove"]) {
      expect(button(name).getAttribute("aria-disabled")).not.toBe("true");
      expect(button(name).hasAttribute("title")).toBe(false);
    }

    fireEvent.click(button("Remove"));
    fireEvent.click(button("Add a port"));
    // Off until the draft differs, which it now does.
    expect(button("Save ports").getAttribute("aria-disabled")).not.toBe("true");
    expect(button("Save ports").hasAttribute("title")).toBe(false);
    fireEvent.click(button("Save ports"));
    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith([
        { publishedPort: 8080, targetPort: 8080, protocol: "tcp" },
      ]),
    );
  });
});
