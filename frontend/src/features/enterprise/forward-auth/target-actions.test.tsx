import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ForwardAuthTarget } from "@/lib/api/endpoints/forward-auth";

const removeProxy = vi.hoisted(() => vi.fn());
const removeSettings = vi.hoisted(() => vi.fn());
const useActiveOrganizationId = vi.hoisted(() => vi.fn());

// The HTTP client and better-auth's session store, replaced at the boundary.
vi.mock("@/lib/api/endpoints/forward-auth", async (original) => {
  const actual =
    await original<typeof import("@/lib/api/endpoints/forward-auth")>();
  return {
    ...actual,
    forwardAuthApi: { ...actual.forwardAuthApi, removeProxy, removeSettings },
  };
});

vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useActiveOrganizationId,
}));

const { TargetActions } = await import("./target-actions");

afterEach(() => {
  cleanup();
  removeProxy.mockReset();
  removeSettings.mockReset();
  useActiveOrganizationId.mockReset();
});

const target: ForwardAuthTarget = {
  serverId: null,
  name: "Cloudgate Server (local)",
  ipAddress: null,
  status: "running",
  message: null,
  authDomain: "auth.example.com",
  https: true,
  certificateType: "letsencrypt",
  customCertResolver: null,
  callbackUrl: "https://auth.example.com/oauth2/callback",
};

function renderActions(over: Partial<ForwardAuthTarget> = {}) {
  useActiveOrganizationId.mockReturnValue({
    organizationId: "org-1",
    pending: false,
  });
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <TargetActions
        target={{ ...target, ...over }}
        providers={[]}
        configured
        onEditDomain={() => {}}
        onChooseProvider={() => {}}
      />
    </QueryClientProvider>,
  );
}

/**
 * A secondary finding: "Remove the proxy" stopped a running service and
 * broke every gated domain on the first click, while the SCIM card on the same
 * page asks before revoking a token.
 */
describe("TargetActions", () => {
  it("asks before removing the proxy, and says what stops working", () => {
    renderActions();

    fireEvent.click(screen.getByRole("button", { name: "Remove the proxy" }));

    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByText(
        "Remove the proxy on Cloudgate Server (local)?",
      ),
    ).toBeTruthy();
    expect(dialog.textContent).toMatch(/every domain gated by it/i);
    expect(removeProxy).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(removeProxy).not.toHaveBeenCalled();
  });

  it("removes the proxy once confirmed", async () => {
    removeProxy.mockResolvedValue({ ok: true });
    renderActions();

    fireEvent.click(screen.getByRole("button", { name: "Remove the proxy" }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Remove the proxy",
      }),
    );

    await waitFor(() => expect(removeProxy).toHaveBeenCalledWith(null));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("names the router file it could not remove, where the operator can copy it", async () => {
    const path = "/etc/cloudgate/traefik/dynamic/forward-auth-domain.yml";
    removeProxy.mockResolvedValue({
      ok: true,
      unreclaimedArtifacts: [
        {
          kind: "traefik-config",
          appName: "forward-auth-domain",
          serverId: null,
          path,
        },
      ],
    });
    renderActions();

    fireEvent.click(screen.getByRole("button", { name: "Remove the proxy" }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Remove the proxy",
      }),
    );

    const dialog = await screen.findByRole("dialog", {
      name: /its router was not/,
    });
    expect(within(dialog).getByText(path)).toBeTruthy();
    expect(dialog.textContent).toMatch(/502/);
    // The shared left-behind panel (CODING_STANDARDS §1.4), not a copy of it,
    // and none of its delete wording, which is false here: the row is kept.
    expect(dialog.querySelector('[data-slot="teardown-report"]')).not.toBeNull();
    expect(dialog.textContent).not.toMatch(/row is deleted|answer 404/i);
    expect(
      within(dialog).getByRole("button", { name: "I have a copy of this" }),
    ).toBeTruthy();
  });

  /**
   * A proxy whose tasks all exit is still a deployed service: it is the
   * one most in need of removing, and "Deploy the proxy" was offered instead.
   */
  it("offers to remove a proxy that is deployed but failing", () => {
    renderActions({ status: "failing", message: "0/1 replicas running" });

    expect(screen.getByRole("button", { name: "Remove the proxy" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Deploy the proxy" })).toBeNull();
  });

  it("asks before clearing the domain", async () => {
    removeSettings.mockResolvedValue({ ok: true });
    renderActions();

    fireEvent.click(screen.getByRole("button", { name: "Clear the domain" }));
    const dialog = screen.getByRole("dialog");
    expect(removeSettings).not.toHaveBeenCalled();

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Clear the domain" }),
    );
    await waitFor(() => expect(removeSettings).toHaveBeenCalledWith(null));
  });
});
