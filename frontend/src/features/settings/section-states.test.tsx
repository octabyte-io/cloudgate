import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/api-error";

import { SectionFailed } from "./section-states";

afterEach(cleanup);

/** A card whose read failed says so as a read, and offers to read again. */
describe("SectionFailed", () => {
  const failedRead = new ApiError(500, "Internal server error", { method: "GET" });

  it("says the read failed, not that part of it may have happened", () => {
    render(<SectionFailed title="Disk usage" error={failedRead} />);
    expect(screen.getByText(/could not load this/)).toBeTruthy();
    expect(screen.queryByText(/may have happened/)).toBeNull();
  });

  it("offers Try again when it is given a retry, and calls it", () => {
    const retry = vi.fn();
    render(
      <SectionFailed title="Disk usage" error={failedRead} onRetry={retry} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("offers no button without one", () => {
    render(<SectionFailed title="Disk usage" error={failedRead} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
