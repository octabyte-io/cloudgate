import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Server } from "@/lib/api/endpoints/servers";

const allowed = vi.hoisted(() => ({ current: true }));
const usePermission = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission,
}));

// The write is the boundary; the card and its dialog are real.
const forget = vi.hoisted(() => ({
  mutateAsync: vi.fn(async () => ({})),
  isPending: false,
}));
vi.mock("../use-server", async (original) => ({
  ...(await original<typeof import("../use-server")>()),
  useForgetHostKey: () => forget,
}));
const toastDone = vi.hoisted(() => vi.fn());
vi.mock("@/components/console/toast", () => ({
  toast: { done: toastDone, error: vi.fn(), info: vi.fn() },
}));

const { SERVER_UPDATE_REFUSAL } = await import("../use-server");
const { HostKeyCard } = await import("./host-key-card");

const FINGERPRINT = "SHA256:uNiVztksCsDhcc0u9e8BujQXVUpKZIDTMczCvj3tD2s";

function server(hostKeyFingerprint: string | null): Server {
  return {
    serverId: "srv-1",
    name: "web-1",
    hostKeyFingerprint,
  } as unknown as Server;
}

function show(fingerprint: string | null) {
  usePermission.mockImplementation(() => ({
    allowed: allowed.current,
    pending: false,
    role: "member",
  }));
  render(<HostKeyCard server={server(fingerprint)} />);
}

afterEach(() => {
  cleanup();
  allowed.current = true;
  forget.mutateAsync.mockClear();
  toastDone.mockClear();
  usePermission.mockReset();
});

describe("HostKeyCard", () => {
  it("shows the recorded fingerprint, as ssh-keygen -lf prints it", () => {
    show(FINGERPRINT);

    expect(screen.getByText(FINGERPRINT)).toBeTruthy();
    expect(document.body.textContent).toContain("ssh-keygen -lf");
  });

  it("says none is recorded yet, and offers nothing to forget", () => {
    show(null);

    expect(screen.getByText("not recorded yet")).toBeTruthy();
    const button = screen.getByRole("button", { name: "Forget host key" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
  });

  it("forgets the host key only once the dialog is confirmed", async () => {
    show(FINGERPRINT);

    fireEvent.click(screen.getByRole("button", { name: "Forget host key" }));
    expect(forget.mutateAsync).not.toHaveBeenCalled();
    expect(
      await screen.findByText("Forget the host key of web-1?"),
    ).toBeTruthy();

    const buttons = screen.getAllByRole("button", { name: "Forget host key" });
    fireEvent.click(buttons[buttons.length - 1]);

    await waitFor(() => expect(forget.mutateAsync).toHaveBeenCalledTimes(1));
    expect(toastDone).toHaveBeenCalledWith(
      "Cloudgate forgot the host key of web-1.",
      expect.anything(),
    );
    expect(usePermission).toHaveBeenCalledWith({ server: ["create"] });
  });

  it("refuses a role that cannot change Servers, in the words every gated control uses", () => {
    allowed.current = false;
    show(FINGERPRINT);

    const button = screen.getByRole("button", { name: "Forget host key" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(document.body.textContent).toContain(SERVER_UPDATE_REFUSAL);
  });
});
