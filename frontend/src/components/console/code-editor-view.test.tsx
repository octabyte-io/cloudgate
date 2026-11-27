import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { CodeEditorView } from "./code-editor-view";

afterEach(() => {
  cleanup();
  localStorage.clear();
});

const LONG = `image: ${"a".repeat(200)}`;

/**
 * An editor scrolls sideways until someone asks it to wrap; a read-only view
 * always wraps. `cm-lineWrapping` is the class CodeMirror puts on its content
 * while `EditorView.lineWrapping` is on.
 */
describe("CodeEditorView", () => {
  it("does not wrap an editable file until Wrap lines is switched on, and remembers it", () => {
    const { container } = render(
      <CodeEditorView value={LONG} onChange={() => {}} label="Compose file" />,
    );
    const content = () => container.querySelector(".cm-content")!;
    const toggle = screen.getByRole("switch", { name: "Wrap lines" });

    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(content().classList.contains("cm-lineWrapping")).toBe(false);

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(content().classList.contains("cm-lineWrapping")).toBe(true);
    expect(localStorage.getItem("cloudgate.editor.wrapLines")).toBe("true");
  });

  it("always wraps a read-only view, with no switch", () => {
    const { container } = render(<CodeEditorView value={LONG} label="Plan" />);
    expect(screen.queryByRole("switch", { name: "Wrap lines" })).toBeNull();
    expect(
      container.querySelector(".cm-content")!.classList.contains("cm-lineWrapping"),
    ).toBe(true);
  });
});
