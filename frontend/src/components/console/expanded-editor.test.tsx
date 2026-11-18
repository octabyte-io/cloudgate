import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Button } from "@/components/ui/button";

import { ExpandedEditor } from "./expanded-editor";

afterEach(cleanup);

const STORED = "API_URL=https://api.example.com\nLOG_LEVEL=info\n";
const EDITED = "API_URL=https://api.example.com\nLOG_LEVEL=debug\n";

/**
 * A caller as a card is one: it owns the draft and its own Discard and Save,
 * and shows the draft after the expanded editor closes.
 */
function Caller({ save }: { save: (value: string) => void }) {
  const [open, setOpen] = useState(true);
  const [draft, setDraft] = useState(STORED);
  return (
    <>
      <output aria-label="The card's draft">{draft}</output>
      <ExpandedEditor
        open={open}
        onOpenChange={setOpen}
        kind="text"
        title="Variables"
        context="invoice-api · Production"
        label="The variables of invoice-api"
        value={draft}
        onChange={setDraft}
        changed={draft !== STORED}
        actions={
          <>
            <Button type="button" onClick={() => setDraft(STORED)}>
              Discard changes
            </Button>
            <Button type="button" variant="pri" onClick={() => save(draft)}>
              Save the file
            </Button>
          </>
        }
      />
    </>
  );
}

function box() {
  return screen.getByLabelText("The variables of invoice-api");
}

describe("ExpandedEditor as a text box", () => {
  it("shows the file's title, where it belongs, the caller's Save and the file in a text box", () => {
    render(<Caller save={vi.fn()} />);

    const dialog = screen.getByRole("dialog");
    expect(screen.getByRole("heading", { name: "Variables" })).toBeTruthy();
    expect(dialog.textContent).toContain("invoice-api · Production");
    expect(screen.getByRole("button", { name: "Save the file" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back to page" })).toBeTruthy();
    expect(box().tagName).toBe("TEXTAREA");
    expect((box() as HTMLTextAreaElement).value).toBe(STORED);
  });

  it("hands a typed edit to the caller and says it is unsaved", () => {
    render(<Caller save={vi.fn()} />);
    expect(screen.queryByText("Unsaved changes")).toBeNull();

    fireEvent.change(box(), { target: { value: EDITED } });

    expect(screen.getByLabelText("The card's draft").textContent).toBe(EDITED);
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
  });

  it("closes on Escape pressed in the text box, and the edit stays with the caller", async () => {
    render(<Caller save={vi.fn()} />);
    fireEvent.change(box(), { target: { value: EDITED } });

    fireEvent.keyDown(box(), { key: "Escape" });

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByLabelText("The card's draft").textContent).toBe(EDITED);
  });

  it("closes on Back to page, and the edit stays with the caller", async () => {
    render(<Caller save={vi.fn()} />);
    fireEvent.change(box(), { target: { value: EDITED } });

    fireEvent.click(screen.getByRole("button", { name: "Back to page" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByLabelText("The card's draft").textContent).toBe(EDITED);
  });

  it("saves through the caller's own Save, with the edit", () => {
    const save = vi.fn();
    render(<Caller save={save} />);
    fireEvent.change(box(), { target: { value: EDITED } });

    fireEvent.click(screen.getByRole("button", { name: "Save the file" }));

    expect(save).toHaveBeenCalledWith(EDITED);
  });

  it("says how many lines the file has", () => {
    render(<Caller save={vi.fn()} />);
    // Two lines and the empty one after the last newline, as the code
    // editor's gutter numbers them.
    expect(screen.getByRole("dialog").textContent).toContain("3 lines");
  });
});

/**
 * A file the page only shows — an Environment's copy of a repository-kept
 * config, the copy a move would keep — expands the same way, and stays
 * read-only there.
 */
describe("ExpandedEditor as a read-only view", () => {
  it("shows the file in a box that cannot be typed in, with no Unsaved changes", () => {
    render(
      <ExpandedEditor
        open
        onOpenChange={vi.fn()}
        kind="text"
        title="Project config"
        context="cloudgate.yaml on main"
        label="Project config on main"
        value={STORED}
      />,
    );

    const view = screen.getByLabelText("Project config on main") as HTMLTextAreaElement;
    expect(view.value).toBe(STORED);
    expect(view.readOnly).toBe(true);
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    expect(screen.getByRole("button", { name: "Back to page" })).toBeTruthy();
  });
});
