import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

/**
 * Expand (spec #118): the file filling the window, saved from its top bar by
 * the card's own Save, so the gate and the empty-file rule hold there too.
 */
describe("TraefikConfigCard — Expand", () => {
  const LABEL = "Main configuration (traefik.yml)";

  function expanded({ allowed }: { allowed: boolean }) {
    useInstanceGate.mockReturnValue({ allowed, refusal: allowed ? "" : REFUSAL });
    render(<TraefikConfigCard descriptor={CONFIGS[0]} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand Main configuration" }));
    const dialog = screen.getByRole("dialog");
    return { dialog, editor: within(dialog).getByLabelText(LABEL) };
  }

  it("opens the file with its title, its path and the card's Save", () => {
    const { dialog, editor } = expanded({ allowed: true });

    expect(within(dialog).getByRole("heading", { name: "Main configuration" })).toBeTruthy();
    expect(dialog.textContent).toContain("traefik.yml");
    expect(within(dialog).getByRole("button", { name: "Save main configuration" })).toBeTruthy();
    expect((editor as HTMLTextAreaElement).value).toBe("entryPoints: {}\n");
  });

  it("saves the edit from the top bar and clears Unsaved changes", async () => {
    const { dialog, editor } = expanded({ allowed: true });
    fireEvent.change(editor, { target: { value: EDITED } });
    expect(within(dialog).getByText("Unsaved changes")).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Save main configuration" }));

    await waitFor(() =>
      expect(writeConfig.mutateAsync).toHaveBeenCalledWith({ kind: "main", content: EDITED }),
    );
    await waitFor(() => expect(within(dialog).queryByText("Unsaved changes")).toBeNull());
  });

  it("says why a save failed in the expanded editor", async () => {
    // fetch's own rejection when the request never landed.
    writeConfig.mutateAsync.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const { dialog, editor } = expanded({ allowed: true });
    fireEvent.change(editor, { target: { value: EDITED } });

    fireEvent.click(within(dialog).getByRole("button", { name: "Save main configuration" }));

    await waitFor(() =>
      expect(within(dialog).getByRole("alert").textContent).toContain(
        "Could not reach the backend.",
      ),
    );
  });

  it("is off in the top bar with the reason for a caller without instance authority", () => {
    const { dialog, editor } = expanded({ allowed: false });
    fireEvent.change(editor, { target: { value: EDITED } });

    const button = within(dialog).getByRole("button", { name: "Save main configuration" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("title")).toBe(REFUSAL);
    fireEvent.click(button);
    expect(writeConfig.mutateAsync).not.toHaveBeenCalled();
  });
});
