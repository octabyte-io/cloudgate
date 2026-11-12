import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TagFilter } from "./tag-filter";

afterEach(cleanup);

/**
 * Clear filter
 * lived only in the branch that lists Tags, so a selection the Organization no
 * longer has any Tags for could not be cleared from the popover at all.
 * `ProjectsScreen` no longer hands the component such a selection, but the way
 * out of a filter does not get to depend on that.
 */
describe("TagFilter", () => {
  it("offers Clear filter while something is selected, even with no Tags left", () => {
    const onChange = vi.fn();
    render(
      <TagFilter tags={[]} selected={new Set(["tag_gone"])} onChange={onChange} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /^Filter by tag/ }));
    expect(screen.getByText(/No tags yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));

    expect(onChange).toHaveBeenCalledWith(new Set());
  });
});
