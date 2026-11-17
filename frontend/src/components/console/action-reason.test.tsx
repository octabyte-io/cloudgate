import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ActionReason } from "./action-reason";

afterEach(cleanup);

/**
 * jsdom lays nothing out, so the two classes that do the work are what is
 * asserted: without `contain-inline-size` a page header's action row grows to
 * the sentence on one line and its last button runs off the page, and without
 * `w-full` the sentence sits between two buttons instead of under the row.
 */
describe("ActionReason", () => {
  it("takes a line of its own and none of the row's width", () => {
    render(<ActionReason id="why">Deploy puts it there.</ActionReason>);

    const reason = screen.getByText("Deploy puts it there.");
    expect(reason.id).toBe("why");
    expect(reason.classList.contains("w-full")).toBe(true);
    expect(reason.classList.contains("contain-inline-size")).toBe(true);
  });
});
