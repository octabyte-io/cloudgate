import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { VariablesCard } from "./variables-card";

afterEach(cleanup);

const BLOB = '# U02 fixture\nUI_PROJECT_VAR=from-project\nUI_MULTI="line one\nline two"\nAPI_TOKEN="first\nabc=def"';

const OPEN = { allowed: true, refusal: "" };
const REFUSAL =
  "Your role in this Organization cannot change this Application's variables. Ask an owner or an admin to do it, or to change your role.";

function cellOf(key: string): HTMLElement {
  const row = screen.getByRole("cell", { name: key }).closest("tr");
  if (!row) throw new Error(`no row for ${key}`);
  return row.querySelectorAll("td")[1] as HTMLElement;
}

/**
 * The reading table shows what a deploy reads: a quoted value that spans
 * lines is one row, with its line breaks kept and no quote characters, and the
 * secret mask still covers such a value until someone asks for it.
 */
describe("VariablesCard", () => {
  it("lists a multi-line quoted value as one row with its line breaks kept", () => {
    render(<VariablesCard env={BLOB} save={async () => undefined} noun="Project" gate={OPEN} />);

    expect(screen.getAllByRole("row")).toHaveLength(1 + 3);
    expect(screen.queryByRole("cell", { name: "abc" })).toBeNull();

    const value = cellOf("UI_MULTI").querySelector(".whitespace-pre-wrap");
    expect(value?.textContent).toBe("line one\nline two");
  });

  it("masks a multi-line secret until Show values", () => {
    render(<VariablesCard env={BLOB} save={async () => undefined} noun="Project" gate={OPEN} />);

    expect(cellOf("API_TOKEN").textContent).not.toContain("first");
    fireEvent.click(screen.getByRole("button", { name: "Show values" }));
    expect(cellOf("API_TOKEN").textContent).toBe("first\nabc=def");
  });

  // The `ui-deployer` role was handed Edit, typed into the block, and
  // met the 403 on Save. The card is told up front and says why.
  it("turns Edit and Add variables off with the reason when the gate refuses", () => {
    const { unmount } = render(
      <VariablesCard
        env={BLOB}
        save={async () => undefined}
        noun="Application"
        gate={{ allowed: false, refusal: REFUSAL }}
      />,
    );
    const edit = screen.getByRole("button", { name: "Edit" });
    expect(edit.getAttribute("aria-disabled")).toBe("true");
    expect(edit.getAttribute("title")).toBe(REFUSAL);
    fireEvent.click(edit);
    expect(screen.queryByRole("textbox")).toBeNull();
    unmount();

    render(
      <VariablesCard
        env=""
        save={async () => undefined}
        noun="Application"
        gate={{ allowed: false, refusal: REFUSAL }}
      />,
    );
    const add = screen.getByRole("button", { name: "Add variables" });
    expect(add.getAttribute("aria-disabled")).toBe("true");
    expect(add.getAttribute("title")).toBe(REFUSAL);
  });

  it("offers Add variables once on an empty card, with no Edit beside it", () => {
    render(<VariablesCard env="" save={async () => undefined} noun="Environment" gate={OPEN} />);
    expect(screen.getAllByRole("button", { name: "Add variables" })).toHaveLength(1);
    // Two primaries for one action: the header's Edit opened the same block.
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
  });

  it("leaves Edit live when the gate allows it", () => {
    render(<VariablesCard env={BLOB} save={async () => undefined} noun="Application" gate={OPEN} />);
    const edit = screen.getByRole("button", { name: "Edit" });
    expect(edit.getAttribute("aria-disabled")).not.toBe("true");
    fireEvent.click(edit);
    expect(screen.getByRole("textbox")).toBeTruthy();
  });

  // On a repository-kept config the file sets the names; values stay
  // editable here, and a new name is said beside the block before any Save.
  it("keeps values editable and refuses a new name the file does not list, inline", () => {
    render(
      <VariablesCard
        env={"API_KEY=one\n"}
        save={async () => undefined}
        noun="Application"
        gate={OPEN}
        names={{
          allowed: new Set(["API_KEY", "LISTED"]),
          refusal: "New variable names are set by the Project config.",
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const block = screen.getByRole("textbox");
    const save = () => screen.getByRole("button", { name: "Save variables" });

    fireEvent.change(block, { target: { value: "API_KEY=two\nLISTED=x\n" } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(save().hasAttribute("disabled") || save().getAttribute("aria-disabled") === "true").toBe(false);

    fireEvent.change(block, { target: { value: "API_KEY=two\nNEW_ONE=x\n" } });
    expect(screen.getByRole("alert").textContent).toContain("NEW_ONE");
    expect(save().hasAttribute("disabled") || save().getAttribute("aria-disabled") === "true").toBe(true);
  });

  // The block was saved as "4 variables are now set here" with a line
  // dropped, a duplicate overwritten, a bad name and an unset reference.
  it("names each bad line, stops the save for a mistake and only warns for an unset reference", () => {
    render(
      <VariablesCard
        env=""
        save={async () => undefined}
        noun="Application"
        gate={OPEN}
        references={{ project: "", environment: "", wired: [] }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Add variables" }));
    const block = screen.getByRole("textbox");
    const save = () => screen.getByRole("button", { name: "Save variables" });
    const off = () =>
      save().hasAttribute("disabled") ||
      save().getAttribute("aria-disabled") === "true";

    fireEvent.change(block, {
      target: { value: "GOOD=1\nbad line\n1BAD=x\nDUP=a\nDUP=b" },
    });
    const said = screen.getByRole("list", { name: "Problems in these lines" })
      .textContent;
    expect(said).toContain("Line 2: This is not KEY=value");
    expect(said).toContain("Line 3: 1BAD is not a name");
    expect(said).toContain("Line 4: DUP is set again on line 5");
    expect(off()).toBe(true);

    fireEvent.change(block, {
      target: { value: "GOOD=1\nREF=${{environment.NOPE}}" },
    });
    expect(
      screen.getByRole("list", { name: "Problems in these lines" }).textContent,
    ).toContain("Line 2 (warning): ${{environment.NOPE}}: NOPE is not set on the Environment");
    expect(off()).toBe(false);
  });
});
