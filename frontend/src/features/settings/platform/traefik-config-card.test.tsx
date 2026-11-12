import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Gate } from "@/lib/auth/use-permission";

const useInstanceGate = vi.hoisted(() => vi.fn<() => Gate>());
const writeConfig = vi.hoisted(() => ({
  mutateAsync: vi.fn(async () => true),
  isPending: false,
}));

// The instance-authority read is the boundary (ADR-0013), and so are the file's
// read and write. CodeMirror is a `next/dynamic` island jsdom cannot run, so a
// textarea stands in for it.
vi.mock("./use-platform", async (original) => ({
  ...(await original<typeof import("./use-platform")>()),
  useInstanceGate,
  useTraefikConfig: () => ({
    data: "entryPoints: {}\n",
    isPending: false,
    error: null,
  }),
  usePlatformMutations: () => ({ writeConfig }),
}));
vi.mock("@/components/console/code-editor", () => ({
  CodeEditor: ({
    label,
    value,
    onChange,
  }: {
    label: string;
    value: string;
    onChange: (next: string) => void;
  }) => (
    <textarea aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}));
vi.mock("@/components/console/toast", () => ({
  toast: { done: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const { TraefikConfigCard } = await import("./traefik-config-card");
const { CONFIGS } = await import("./traefik-section");

const REFUSAL = "Only an administrator of this Cloudgate instance can do this.";
const EDITED = "entryPoints:\n  web: {}\n";

afterEach(() => {
  cleanup();
  useInstanceGate.mockReset();
  writeConfig.mutateAsync.mockClear();
});

function mount({ allowed }: { allowed: boolean }) {
  useInstanceGate.mockReturnValue({ allowed, refusal: allowed ? "" : REFUSAL });
  const descriptor = CONFIGS[0];
  render(<TraefikConfigCard descriptor={descriptor} />);
  fireEvent.change(
    screen.getByLabelText(`${descriptor.title} (${descriptor.path})`),
    { target: { value: EDITED } },
  );
  return {
    button: screen.getByRole("button", {
      name: `Save ${descriptor.title.toLowerCase()}`,
    }),
  };
}

/**
 * Save on the three named files: `POST /settings/traefik/config`,
 * `…/web-server-config` and `…/middlewares-config` each call
 * `requireInstanceAuthority` and nothing else, so the card reads the instance
 * gate.
 */
describe("TraefikConfigCard — Save", () => {
  it("is off with the reason for a caller without instance authority, and sends nothing", () => {
    const { button } = mount({ allowed: false });

    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("title")).toBe(REFUSAL);
    const described = button.getAttribute("aria-describedby");
    expect(described).toBeTruthy();
    expect(document.getElementById(described as string)?.textContent).toBe(REFUSAL);

    fireEvent.click(button);
    expect(writeConfig.mutateAsync).not.toHaveBeenCalled();
  });

  it("is live for an instance administrator, and saves", async () => {
    const { button } = mount({ allowed: true });

    expect(button.getAttribute("aria-disabled")).not.toBe("true");
    expect(button.hasAttribute("title")).toBe(false);
    expect(document.body.textContent).not.toContain(REFUSAL);

    fireEvent.click(button);
    await waitFor(() =>
      expect(writeConfig.mutateAsync).toHaveBeenCalledWith({
        kind: "main",
        content: EDITED,
      }),
    );
  });
});
