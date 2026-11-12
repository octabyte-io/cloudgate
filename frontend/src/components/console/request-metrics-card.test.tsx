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

import { RequestMetricsCard } from "./request-metrics-card";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * The card as a screen holds it: `enabled` is a read the screen refetches in
 * `onEnabled`, modelled here by flipping local state — so "reflects the state
 * afterwards" is the card rendering what the read now says.
 */
function Harness({
  serverId,
  allowed = true,
}: {
  serverId: string | null;
  allowed?: boolean;
}) {
  const [enabled, setEnabled] = useState(false);
  return (
    <RequestMetricsCard
      serverId={serverId}
      enabled={enabled}
      gate={{ allowed, refusal: allowed ? "" : "Only an owner or admin." }}
      onEnabled={async () => setEnabled(true)}
    />
  );
}

function mount(node: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

describe("RequestMetricsCard", () => {
  it("opens the Traefik restart confirmation before it calls anything", async () => {
    const enable = vi
      .spyOn(traefikApi, "enableRequestMetrics")
      .mockResolvedValue({ enabled: true });
    mount(<Harness serverId="srv-1" />);

    fireEvent.click(
      screen.getByRole("button", { name: "Enable request metrics" }),
    );

    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Every connection it is currently serving is dropped");
    expect(dialog.textContent).toContain("this Server");
    expect(enable).not.toHaveBeenCalled();
  });

  it("enables on confirm, for the machine it was given, and then reads on", async () => {
    const enable = vi
      .spyOn(traefikApi, "enableRequestMetrics")
      .mockResolvedValue({ enabled: true });
    mount(<Harness serverId="srv-1" />);

    fireEvent.click(
      screen.getByRole("button", { name: "Enable request metrics" }),
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Enable and restart Traefik",
      }),
    );

    await waitFor(() => expect(enable).toHaveBeenCalledWith("srv-1"));
    await waitFor(() => expect(screen.getByText("On")).toBeTruthy());
    expect(
      screen.queryByRole("button", { name: "Enable request metrics" }),
    ).toBeNull();
    expect(screen.getByText(/127\.0\.0\.1:8082/)).toBeTruthy();
  });

  it("sends no serverId for the platform host", async () => {
    const enable = vi
      .spyOn(traefikApi, "enableRequestMetrics")
      .mockResolvedValue({ enabled: true });
    mount(<Harness serverId={null} />);

    fireEvent.click(
      screen.getByRole("button", { name: "Enable request metrics" }),
    );
    expect((await screen.findByRole("dialog")).textContent).toContain(
      "the platform host",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Enable and restart Traefik" }),
    );

    await waitFor(() => expect(enable).toHaveBeenCalledWith(null));
  });

  it("is off, with the reason, for a caller the restart gate refuses", () => {
    mount(<Harness serverId="srv-1" allowed={false} />);

    const button = screen.getByRole("button", {
      name: "Enable request metrics",
    });
    expect(
      button.hasAttribute("disabled") ||
        button.getAttribute("aria-disabled") === "true",
    ).toBe(true);
    expect(screen.getByText("Only an owner or admin.")).toBeTruthy();
  });
});
