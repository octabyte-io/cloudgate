import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CopyButton } from "./copy-button";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  // jsdom has no `execCommand` at all; each test that needs one defines it.
  delete (document as { execCommand?: unknown }).execCommand;
});

/** The one system boundary here, and the only thing doubled. */
function clipboard(writeText: () => Promise<void>) {
  vi.stubGlobal("navigator", { clipboard: { writeText } });
}

/**
 * The browser as `http://<ip>:3000` presents it: not a secure context,
 * so there is no `navigator.clipboard` to call at all.
 */
function insecureOrigin() {
  vi.stubGlobal("navigator", {});
}

/**
 * The other system boundary: `document.execCommand("copy")`, which copies the
 * document's selection. It records what was selected at the moment it ran,
 * because a copy of the wrong selection is the failure worth catching.
 */
function execCommand(answer: boolean) {
  const selected: string[] = [];
  const command = vi.fn((name: string) => {
    const active = document.activeElement;
    selected.push(
      active instanceof HTMLTextAreaElement
        ? active.value.slice(active.selectionStart, active.selectionEnd)
        : "",
    );
    return name === "copy" && answer;
  });
  Object.defineProperty(document, "execCommand", {
    value: command,
    configurable: true,
    writable: true,
  });
  return { command, selected };
}

/**
 * The sentence `CopyButton` composes, pinned on a rendered button.
 *
 * This is the half of the label gate that says the call sites agree on the *right*
 * thing. `copy-button-label-is-a-noun` holds all twenty-eight labels to a noun,
 * but twenty-eight labels reading `Copy the …` agreed too — and agreed on the
 * name a screen reader read out as "Copy the Copy backup codes" on a live
 * install. So the rule pins the shape of the input and this pins the output:
 * `label="backup codes"` is announced **"Copy the backup codes"**, and the
 * failure line is a sentence about the same noun rather than about a sentence.
 *
 * `backup codes` is the label deliberately, because it is the site the defect
 * was found on.
 */
describe("CopyButton", () => {
  it("names itself with the verb once, for a label that is a noun", () => {
    clipboard(() => Promise.resolve());
    render(<CopyButton value="1234-5678" label="backup codes" />);

    expect(
      screen.getByRole("button", { name: "Copy the backup codes" }),
    ).toBeDefined();
    // The shape of the defect, not merely the absence of the right string: an
    // assertion on the expected name alone passes on a *third* wrong wording.
    expect(
      screen.queryByRole("button", { name: /copy the copy/i }),
    ).toBe(null);
  });

  it("says what could not be copied when the clipboard refuses", async () => {
    clipboard(() => Promise.reject(new Error("not focused")));
    render(<CopyButton value="1234-5678" label="backup codes" />);

    fireEvent.click(screen.getByRole("button"));

    expect(
      await screen.findByRole("button", {
        name: "Could not copy the backup codes. It is selected below — press ⌘C, or Ctrl+C.",
      }),
    ).toBeDefined();
  });

  it("confirms in place, naming the same noun", async () => {
    clipboard(() => Promise.resolve());
    render(<CopyButton value="1234-5678" label="backup codes" />);

    fireEvent.click(screen.getByRole("button"));

    expect(
      await screen.findByRole("button", { name: "backup codes copied" }),
    ).toBeDefined();
  });

  it("copies by selection on an insecure origin, where there is no clipboard API", async () => {
    insecureOrigin();
    const { command, selected } = execCommand(true);
    render(<CopyButton value="cg_u01_secret" label="API key" />);

    fireEvent.click(screen.getByRole("button"));

    expect(
      await screen.findByRole("button", { name: "API key copied" }),
    ).toBeDefined();
    expect(command).toHaveBeenCalledWith("copy");
    // What was selected when the copy ran is the value, whole.
    expect(selected).toEqual(["cg_u01_secret"]);
    // And the scratch field it was selected in is gone again.
    expect(document.querySelectorAll("textarea")).toHaveLength(0);
  });

  it("falls back to the selection when the clipboard API refuses", async () => {
    clipboard(() => Promise.reject(new Error("not focused")));
    const { selected } = execCommand(true);
    render(<CopyButton value="cg_u01_secret" label="API key" />);

    fireEvent.click(screen.getByRole("button"));

    expect(
      await screen.findByRole("button", { name: "API key copied" }),
    ).toBeDefined();
    expect(selected).toEqual(["cg_u01_secret"]);
  });

  it("shows the value selected, and says so in sight, until the next interaction when neither path copies", async () => {
    // Installed before the click, so a timer the failure starts is a fake one
    // this test can run out; real time still passes for the queries.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    insecureOrigin();
    execCommand(false);
    render(<CopyButton value="cg_u01_secret" label="API key" />);

    fireEvent.click(screen.getByRole("button"));

    const sentence =
      "Could not copy the API key. It is selected below — press ⌘C, or Ctrl+C.";
    const message = await screen.findByText(sentence, { selector: "p" });
    // Visible, not only announced: nothing between it and the page hides it.
    expect(message.closest(".sr-only")).toBe(null);

    const field = screen.getByRole("textbox", { name: "API key" });
    expect((field as HTMLTextAreaElement).value).toBe("cg_u01_secret");
    await waitFor(() => expect(document.activeElement).toBe(field));
    const { selectionStart, selectionEnd } = field as HTMLTextAreaElement;
    expect([selectionStart, selectionEnd]).toEqual([0, "cg_u01_secret".length]);

    // The confirmation's two seconds do not apply to a failure: an operator
    // who glanced away must still find it when they look back.
    act(() => vi.advanceTimersByTime(10_000));
    expect(screen.getByText(sentence, { selector: "p" })).toBe(message);

    // Copying it by hand is the interaction that ends it.
    act(() => {
      fireEvent.copy(field);
    });
    expect(screen.getByRole("button", { name: "API key copied" })).toBeDefined();
  });
});
