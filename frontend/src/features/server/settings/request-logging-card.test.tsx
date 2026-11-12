import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { traefikApi } from "@/lib/api/endpoints/traefik";
import { REQUEST_LOGGING_ANCHOR } from "@/lib/shell/tabs/server";

import {
  REQUEST_LOGGING_LIMITS,
  RequestLoggingCard,
} from "./request-logging-card";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * The card as the Server's Settings panel holds it: `enabled` is a read the
 * panel refetches in `onChanged`, modelled here by local state flipped to what
 * the switch asked for.
 */
function Harness({
  initial,
  allowed = true,
}: {
  initial: boolean;
  allowed?: boolean;
}) {
  const [enabled, setEnabled] = useState(initial);
  return (
    <RequestLoggingCard
      serverId="srv-1"
      enabled={enabled}
      gate={{ allowed, refusal: allowed ? "" : "Only an owner or admin." }}
      onChanged={async (next) => setEnabled(next)}
    />
  );
}

function mount(node: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{node}</QueryClientProvider>,
  );
}

const theSwitch = () =>
  screen.getByRole("switch", { name: "Request logging on this Server" });

describe("RequestLoggingCard", () => {
  it("shows the fixed limits as read-only text", () => {
    mount(<Harness initial={false} />);

    expect(REQUEST_LOGGING_LIMITS).toBe(
      "New file every 100 MiB, keeps 3 older files, deletes them after 30 days",
    );
    expect(
      screen.getByText(REQUEST_LOGGING_LIMITS, { exact: false }),
    ).toBeTruthy();
  });

  it("carries an anchor other pages can link straight to", () => {
    const { container } = mount(<Harness initial={false} />);

    expect(REQUEST_LOGGING_ANCHOR).toBe("request-logging");
    const card = container.querySelector(`#${REQUEST_LOGGING_ANCHOR}`);
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain("Request logging");
  });

  it("asks before turning it on, naming the 80/443 drop, and then turns it on", async () => {
    const toggle = vi
      .spyOn(traefikApi, "toggleRequests")
      .mockResolvedValue({ written: true, restartRequired: false });
    mount(<Harness initial={false} />);

    fireEvent.click(theSwitch());

    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain(
      "Open connections on ports 80 and 443 drop for a moment.",
    );
    expect(dialog.textContent).not.toContain("deleted within 30 days");
    expect(toggle).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "Turn on and restart Traefik" }),
    );

    await waitFor(() => expect(toggle).toHaveBeenCalledWith(true, "srv-1"));
    await waitFor(() =>
      expect(theSwitch().getAttribute("aria-checked")).toBe("true"),
    );
  });

  it("asks before turning it off, saying what happens to saved logs, and then turns it off", async () => {
    const toggle = vi
      .spyOn(traefikApi, "toggleRequests")
      .mockResolvedValue({ written: true, restartRequired: false });
    mount(<Harness initial />);

    fireEvent.click(theSwitch());

    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain(
      "Open connections on ports 80 and 443 drop for a moment.",
    );
    expect(dialog.textContent).toContain(
      "Saved logs stay on this Server and are deleted within 30 days.",
    );
    expect(toggle).not.toHaveBeenCalled();

    fireEvent.click(
      screen.getByRole("button", { name: "Turn off and restart Traefik" }),
    );

    await waitFor(() => expect(toggle).toHaveBeenCalledWith(false, "srv-1"));
    await waitFor(() =>
      expect(theSwitch().getAttribute("aria-checked")).toBe("false"),
    );
  });

  it("re-reads the Server when the switch fails too, since the file may have been written", async () => {
    // `POST /settings/traefik/requests` answers 502 when it wrote traefik.yml
    // and Traefik did not restart: the read is what says where it stands.
    vi.spyOn(traefikApi, "toggleRequests").mockRejectedValue(
      new Error("Traefik did not restart"),
    );
    const onChanged = vi.fn(() => Promise.resolve());
    mount(
      <RequestLoggingCard
        serverId="srv-1"
        enabled={false}
        gate={{ allowed: true, refusal: "" }}
        onChanged={onChanged}
      />,
    );

    fireEvent.click(theSwitch());
    await screen.findByRole("dialog");
    fireEvent.click(
      screen.getByRole("button", { name: "Turn on and restart Traefik" }),
    );

    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(true));
  });

  it("changes nothing when the confirmation is cancelled", async () => {
    const toggle = vi.spyOn(traefikApi, "toggleRequests");
    mount(<Harness initial={false} />);

    fireEvent.click(theSwitch());
    await screen.findByRole("dialog");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(toggle).not.toHaveBeenCalled();
    expect(theSwitch().getAttribute("aria-checked")).toBe("false");
  });

  it("is off, with the reason, for a caller the gate refuses", () => {
    mount(<Harness initial={false} allowed={false} />);

    const control = theSwitch();
    expect(
      control.hasAttribute("disabled") ||
        control.getAttribute("aria-disabled") === "true" ||
        control.hasAttribute("data-disabled"),
    ).toBe(true);
    expect(screen.getByText("Only an owner or admin.")).toBeTruthy();
  });
});
