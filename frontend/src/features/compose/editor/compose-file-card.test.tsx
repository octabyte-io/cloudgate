import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ComposeDetail } from "@/lib/api/endpoints/compose";

const usePermission = vi.hoisted(() => vi.fn());

// The caller's effective statements are the boundary. CodeMirror is a
// `next/dynamic` island jsdom cannot run, so a textarea stands in for it; the
// services list reads its own query and is not what this pins.
vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission,
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
vi.mock("./declared-services", () => ({ DeclaredServices: () => null }));
vi.mock("@/components/console/toast", () => ({
  toast: { done: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const { COMPOSE_UPDATE_REFUSAL } = await import("../use-compose");
const { ComposeFileCard } = await import("./compose-file-card");

const compose = {
  composeId: "cmp-1",
  name: "ui-compose",
  composeType: "docker-compose",
  sourceType: "raw",
  composeFile: "services:\n  web:\n    image: nginx\n",
} as unknown as ComposeDetail;

const EDITED = "services:\n  web:\n    image: nginx:1.27\n";

afterEach(() => {
  cleanup();
  usePermission.mockReset();
});

/** The editor with a verdict, edited so `changed` is not the reason. */
function mount({ allowed }: { allowed: boolean }) {
  usePermission.mockReturnValue({ allowed, pending: false, role: "member" });
  const save = vi.fn(async () => undefined);
  render(<ComposeFileCard compose={compose} save={save} />);
  fireEvent.change(screen.getByLabelText("The compose file for ui-compose"), {
    target: { value: EDITED },
  });
  return { save, button: screen.getByRole("button", { name: "Save the file" }) };
}

/**
 * Save the file: `PATCH /compose/:id` with `composeFile`, which
 * `findOwnedForUpdate` holds to `service: ['update']`.
 */
describe("ComposeFileCard — Save the file", () => {
  it("asks for service:update", () => {
    mount({ allowed: true });
    expect(usePermission).toHaveBeenCalledWith({ service: ["update"] });
  });

  it("is off with the reason for a role that cannot change the stack, and sends nothing", () => {
    const { save, button } = mount({ allowed: false });

    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("title")).toBe(COMPOSE_UPDATE_REFUSAL);
    const described = button.getAttribute("aria-describedby");
    expect(described).toBeTruthy();
    expect(document.getElementById(described as string)?.textContent).toBe(
      COMPOSE_UPDATE_REFUSAL,
    );

    fireEvent.click(button);
    expect(save).not.toHaveBeenCalled();
  });

  it("is live for a role that can, and saves", async () => {
    const { save, button } = mount({ allowed: true });

    expect(button.getAttribute("aria-disabled")).not.toBe("true");
    expect(button.hasAttribute("title")).toBe(false);
    expect(document.body.textContent).not.toContain(COMPOSE_UPDATE_REFUSAL);

    fireEvent.click(button);
    await waitFor(() => expect(save).toHaveBeenCalledWith({ composeFile: EDITED }));
  });
});

/**
 * Expand: the same file, filling the window, saved from its top bar
 * (spec #118). The card holds the draft, so closing keeps the edit there.
 */
describe("ComposeFileCard — Expand", () => {
  const LABEL = "The compose file for ui-compose";

  function expanded() {
    usePermission.mockReturnValue({ allowed: true, pending: false, role: "member" });
    const save = vi.fn(async () => undefined);
    render(<ComposeFileCard compose={compose} save={save} />);
    fireEvent.click(screen.getByRole("button", { name: "Expand" }));
    const dialog = screen.getByRole("dialog");
    return { save, dialog, editor: within(dialog).getByLabelText(LABEL) };
  }

  /** The card's own editor, not the expanded one. */
  function cardEditor() {
    return screen
      .getAllByLabelText(LABEL)
      .find((el) => !el.closest("[role=dialog]")) as HTMLTextAreaElement;
  }

  it("opens the file with its name, the stack's name, Discard and Save", () => {
    const { dialog, editor } = expanded();

    expect(within(dialog).getByRole("heading", { name: "Compose file" })).toBeTruthy();
    expect(dialog.textContent).toContain("ui-compose");
    expect(within(dialog).getByRole("button", { name: "Discard changes" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Save the file" })).toBeTruthy();
    expect((editor as HTMLTextAreaElement).value).toBe(compose.composeFile);
  });

  it("saves the edit from the top bar and clears Unsaved changes", async () => {
    const { save, dialog, editor } = expanded();
    fireEvent.change(editor, { target: { value: EDITED } });
    expect(within(dialog).getByText("Unsaved changes")).toBeTruthy();

    fireEvent.click(within(dialog).getByRole("button", { name: "Save the file" }));

    await waitFor(() => expect(save).toHaveBeenCalledWith({ composeFile: EDITED }));
    await waitFor(() => expect(within(dialog).queryByText("Unsaved changes")).toBeNull());
  });

  it("does not save a file that is not valid YAML from the top bar, and says so", () => {
    const { save, dialog, editor } = expanded();
    fireEvent.change(editor, { target: { value: "services: [\n" } });

    const button = within(dialog).getByRole("button", { name: "Save the file" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(button);
    expect(save).not.toHaveBeenCalled();
    expect(dialog.textContent).toContain("Not valid YAML");
  });

  it("closes on Escape, and the edit stays in the card", async () => {
    const { editor } = expanded();
    fireEvent.change(editor, { target: { value: EDITED } });

    fireEvent.keyDown(editor, { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(cardEditor().value).toBe(EDITED);
    expect(document.body.textContent).toContain("Unsaved changes.");
  });

  it("closes on Back to page, and the edit stays in the card", async () => {
    const { dialog, editor } = expanded();
    fireEvent.change(editor, { target: { value: EDITED } });

    fireEvent.click(within(dialog).getByRole("button", { name: "Back to page" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(cardEditor().value).toBe(EDITED);
  });
});
