import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { LocalShellCard } from "./local-shell-card";

afterEach(cleanup);

const user = () => screen.getByLabelText("SSH user") as HTMLInputElement;
const port = () => screen.getByLabelText("SSH port") as HTMLInputElement;
const openShell = () =>
  fireEvent.click(screen.getByRole("button", { name: "Open a shell" }));

describe("a shell on the platform's own host", () => {
  it("offers the fields the gateway cannot look up, already filled in", () => {
    // Both are required for `serverId=local` and there is no Server row to read
    // them from. Prefilled, so a stock install is one click — the
    // ergonomics of a registered Server's Terminal tab, which asks nothing.
    render(<LocalShellCard />);

    expect(user().value).toBe("root");
    expect(port().value).toBe("22");
  });

  it("says who may open one, and still offers the form to everybody", () => {
    // The gate is the gateway's (ADR-0010): it closes 4403 with a reason the
    // terminal renders. A role read in the browser would be a claim about
    // authority made where the caller controls the answer, so this is copy.
    render(<LocalShellCard />);

    expect(document.body.textContent).toContain(
      "Only an owner or an admin can open it",
    );
    expect(screen.getByRole("button", { name: "Open a shell" })).toBeDefined();
  });

  it("opens the session on the defaults", () => {
    render(<LocalShellCard />);
    openShell();

    expect(screen.queryByLabelText("SSH user")).toBe(null);
    expect(document.body.textContent).toContain("This session asked for");
  });

  it("names what the session asked for without claiming it connected", () => {
    // This line read "Signed in over SSH as root on port 22" whenever
    // `session` was set — below a terminal reading "The Server refused this
    // session", and below "This session has ended". The socket is
    // `terminal-session.tsx`'s and this card never sees it, so the sentence
    // reports the request and points at the terminal for the outcome.
    render(<LocalShellCard />);
    openShell();

    const text = document.body.textContent ?? "";
    expect(text).toContain("This session asked for");
    expect(text).toContain("Whether the host accepted it");
    expect(text).not.toContain("Signed in");
  });

  it("keeps the form up when a field cannot be sent", () => {
    render(<LocalShellCard />);
    fireEvent.change(port(), { target: { value: "" } });
    openShell();

    expect(document.body.textContent).toContain("1 to 65535");
    // No socket was opened: the gateway's answer to an empty port is to close
    // the connection, which on screen is a terminal that failed for no reason.
    expect(screen.getByLabelText("SSH user")).toBeDefined();
  });

  it("keeps the user field on the wrap basis and its width cap", () => {
    // No test asserted either class at first, which is how a basis the fix put
    // out of scope by name ("leave the basis alone") changed in the same commit as
    // the cap and nothing failed. `Field` puts its `className` on its own root
    // through `cn("min-w-0 gap-1.5", className)`, an ancestor of both the label
    // and the control — so the class is queried for and the field it wraps is
    // checked, rather than the DOM depth being guessed at with `closest`.
    render(<LocalShellCard />);

    const field = document.querySelector('[class*="flex-[1_1_150px]"]');
    expect(field).not.toBeNull();
    expect(field?.className).toContain("max-w-64");
    expect(field?.contains(user())).toBe(true);
  });

  it("starts the two fields at the same top and keeps the submit button out of their row", () => {
    // The actual fix, and the part with real user-visible cost: `items-end`
    // bottom-aligned the port field against the *hint* under the user field, so
    // at 380px "SSH port" rendered level with that sentence and its input sat
    // below both. A future tidy-up putting the button back in the row, or
    // restoring `items-end`, is the same defect again.
    render(<LocalShellCard />);

    // Off the *port* field's root rather than the user field's, so this case
    // still fails for its own reason if the basis above ever changes again.
    const row = document.querySelector('[class*="w-28"]')?.parentElement;
    expect(row).toBeDefined();
    expect(row?.className).toContain("items-start");
    expect(row?.className).not.toContain("items-end");
    expect(row?.contains(port())).toBe(true);
    expect(
      row?.contains(screen.getByRole("button", { name: "Open a shell" })),
    ).toBe(false);
  });

  it("goes back to the fields to change the user, rather than editing a live session", () => {
    render(<LocalShellCard />);
    fireEvent.change(user(), { target: { value: "deploy" } });
    openShell();
    fireEvent.click(
      screen.getByRole("button", { name: "Change the user or port" }),
    );

    expect(user().value).toBe("deploy");
  });
});
