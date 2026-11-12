import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const device = vi.hoisted(() => ({
  lookUp: vi.fn(),
  approve: vi.fn(),
  deny: vi.fn(),
}));
vi.mock("@/lib/auth/client", () => ({ device }));

const search = vi.hoisted(() => ({ params: new URLSearchParams() }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => search.params,
}));

const { DeviceApproval } = await import("./device-approval");

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  search.params = new URLSearchParams();
});

const pending = {
  data: { user_code: "WDJBMJHT", status: "pending" },
  error: null,
};

/**
 * The console's half of `cloudgate login`: the person checks the code
 * their terminal printed, then approves or denies it, with their session.
 */
describe("DeviceApproval", () => {
  it("looks up the code the link carried, and approving it logs the terminal in", async () => {
    search.params = new URLSearchParams({ user_code: "WDJB-MJHT" });
    device.lookUp.mockResolvedValue(pending);
    device.approve.mockResolvedValue({ data: { success: true }, error: null });
    render(<DeviceApproval />);

    expect((screen.getByLabelText("Code") as HTMLInputElement).value).toBe(
      "WDJB-MJHT",
    );
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
    expect(await screen.findByText("Your terminal is logged in")).toBeTruthy();
    expect(device.lookUp).toHaveBeenCalledWith("WDJBMJHT");
    expect(device.approve).toHaveBeenCalledWith("WDJBMJHT");
    expect(device.deny).not.toHaveBeenCalled();
  });

  it("denies a code the person does not recognise", async () => {
    device.lookUp.mockResolvedValue(pending);
    device.deny.mockResolvedValue({ data: { success: true }, error: null });
    render(<DeviceApproval />);

    fireEvent.change(screen.getByLabelText("Code"), {
      target: { value: "wdjb mjht" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: "Deny" }));

    expect(await screen.findByText("Login denied")).toBeTruthy();
    expect(device.deny).toHaveBeenCalledWith("WDJBMJHT");
    expect(device.approve).not.toHaveBeenCalled();
  });

  it("says so, and offers nothing to approve, for a code the Instance does not know", async () => {
    device.lookUp.mockResolvedValue({
      data: null,
      error: { status: 400, message: "Invalid user code" },
    });
    render(<DeviceApproval />);

    fireEvent.change(screen.getByLabelText("Code"), {
      target: { value: "AAAA-BBBB" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(
      await screen.findByText(
        "That code is not one this Instance knows, or it has expired. Run cloudgate login again for a new one.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });
});
