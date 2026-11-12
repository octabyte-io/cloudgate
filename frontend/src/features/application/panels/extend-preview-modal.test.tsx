import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ExtendPreviewModal } from "./extend-preview-modal";

afterEach(cleanup);

const box = () => screen.getByLabelText(/^Minutes from now/) as HTMLInputElement;

const submit = async () => {
  fireEvent.click(screen.getByRole("button", { name: "Set the new expiry" }));
  await waitFor(() => undefined);
};

/**
 * Extending is choosing a new window from now, not adding time — so the
 * field is minutes from now, starts at the backend's default of 60, names the
 * instance maximum, and refuses anything over it before it is sent.
 */
describe("ExtendPreviewModal", () => {
  it("defaults to 60 minutes and sends it", async () => {
    const extend = vi.fn(async () => undefined);
    render(
      <ExtendPreviewModal
        branch="agent/fix"
        maxMinutes={1440}
        extend={extend}
        open
        onOpenChange={vi.fn()}
      />,
    );

    expect(box().value).toBe("60");
    await submit();
    await waitFor(() => expect(extend).toHaveBeenCalledWith(60));
  });

  it("shows the instance maximum, in minutes and read back", () => {
    render(
      <ExtendPreviewModal
        branch="agent/fix"
        maxMinutes={1440}
        extend={vi.fn()}
        open
        onOpenChange={vi.fn()}
      />,
    );
    const text = document.body.textContent ?? "";

    expect(text).toContain("1440 minutes (24 hours)");
    // A new window, not time added to what was left — and no "+1 h".
    expect(text).toMatch(/from now/);
    expect(screen.queryByRole("button", { name: /\+/ })).toBeNull();
  });

  it("refuses a window over the maximum and sends nothing", async () => {
    const extend = vi.fn(async () => undefined);
    render(
      <ExtendPreviewModal
        branch="agent/fix"
        maxMinutes={120}
        extend={extend}
        open
        onOpenChange={vi.fn()}
      />,
    );

    fireEvent.change(box(), { target: { value: "121" } });
    await submit();

    expect(
      await screen.findByText(
        "This instance's maximum is 120 minutes (2 hours).",
      ),
    ).toBeTruthy();
    expect(extend).not.toHaveBeenCalled();

    fireEvent.change(box(), { target: { value: "120" } });
    await submit();
    await waitFor(() => expect(extend).toHaveBeenCalledWith(120));
  });

  it("still sends when the maximum is unknown, and leaves the refusal to the backend", async () => {
    const extend = vi.fn(async () => undefined);
    render(
      <ExtendPreviewModal
        branch="agent/fix"
        maxMinutes={undefined}
        extend={extend}
        open
        onOpenChange={vi.fn()}
      />,
    );

    fireEvent.change(box(), { target: { value: "5000" } });
    await submit();
    await waitFor(() => expect(extend).toHaveBeenCalledWith(5000));
  });
});
