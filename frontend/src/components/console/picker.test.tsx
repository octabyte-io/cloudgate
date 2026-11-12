import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Picker } from "./picker";

afterEach(cleanup);

/**
 * The **Add a database** modal's Server field, which is the shape the defect was
 * found in: a "none" option whose value is `""`, sitting first, and a form that
 * starts with nothing chosen.
 */
function ServerField({
  onValueChange = () => {},
}: {
  onValueChange?: (value: string) => void;
}) {
  const [value, setValue] = useState("");
  return (
    <Picker
      options={[
        { value: "", label: "This Cloudgate host" },
        { value: "srv-1", label: "vps-local", detail: "10.0.0.1" },
      ]}
      placeholder="This Cloudgate host"
      value={value}
      onValueChange={(next) => {
        setValue(next);
        onValueChange(next);
      }}
    />
  );
}

/** Base UI's trigger opens on `mousedown`, so a bare `click` is what opens it. */
async function openTheList() {
  const trigger = screen.getByRole("combobox");
  fireEvent.click(trigger);
  await waitFor(() =>
    expect(screen.queryAllByRole("option").length).toBeGreaterThan(0),
  );
  return trigger;
}

function choose(name: RegExp) {
  const option = screen.getByRole("option", { name });
  fireEvent.pointerDown(option, { pointerType: "mouse" });
  fireEvent.click(option, { detail: 1 });
}

describe("Picker", () => {
  it("closes the list when the option worth an empty string is chosen", async () => {
    const onValueChange = vi.fn();
    render(<ServerField onValueChange={onValueChange} />);

    const trigger = await openTheList();
    choose(/This Cloudgate host/);

    // Both halves matter. The report's evidence was `aria-expanded="false"` with
    // a fully opaque listbox still on screen, so "it says it is closed" is not
    // the assertion — "it is gone" is.
    await waitFor(() => expect(screen.queryAllByRole("option")).toHaveLength(0));
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    const positioner = document.querySelector(
      "[data-slot=select-content]",
    )?.parentElement;
    expect(positioner === undefined || positioner === null).toBe(false);
    expect(positioner?.hasAttribute("hidden")).toBe(true);
    expect(onValueChange).toHaveBeenCalledWith("");
  });

  it("marks that option chosen rather than leaving the list with nothing selected", async () => {
    render(<ServerField />);

    await openTheList();

    // `""` reaching Base UI reads as "nothing chosen", which is what left the
    // option unselectable. It carries a value of its own now, so the list knows
    // which row it is sitting on.
    expect(
      screen
        .getByRole("option", { name: /This Cloudgate host/ })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("goes back to that option after another one was chosen", async () => {
    const onValueChange = vi.fn();
    render(<ServerField onValueChange={onValueChange} />);

    await openTheList();
    choose(/vps-local/);
    await waitFor(() =>
      expect(screen.getByRole("combobox").textContent).toContain("vps-local"),
    );

    await openTheList();
    choose(/This Cloudgate host/);

    await waitFor(() =>
      expect(screen.getByRole("combobox").textContent).toContain(
        "This Cloudgate host",
      ),
    );
    expect(onValueChange).toHaveBeenLastCalledWith("");
  });

  it("still reads as nothing chosen where no option carries an empty string", async () => {
    render(
      <Picker
        options={[{ value: "main", label: "main" }]}
        placeholder="Choose a branch"
        value=""
        onValueChange={() => {}}
      />,
    );

    // The sentinel is for lists that *offer* the empty value. Handing it to one
    // that does not would make an untouched picker report itself filled, which
    // is what drives the placeholder and a `Field`'s filled state.
    const trigger = screen.getByRole("combobox");
    expect(trigger.textContent).toContain("Choose a branch");
    expect(trigger.hasAttribute("data-placeholder")).toBe(true);
  });

  it("anchors the list to its trigger so a scrolling dialog cannot strand it", async () => {
    render(<ServerField />);
    await openTheList();

    // Base UI's item-aligned mode pins the positioner with `position: fixed` and
    // turns anchor tracking off, which is the popup that hangs at a viewport
    // coordinate while its trigger scrolls away. Anchored below the trigger,
    // floating-ui's `autoUpdate` re-anchors on every ancestor scroll. jsdom
    // measures nothing, so the mode itself is what is pinned here.
    const popup = document.querySelector("[data-slot=select-content]");
    expect(popup?.getAttribute("data-align-trigger")).toBe("false");
  });
});
