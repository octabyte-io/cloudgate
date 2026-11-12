import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { traefikApi } from "@/lib/api/endpoints/traefik";

const useActiveOrganizationId = vi.hoisted(() => vi.fn());

// One system boundary, replaced rather than driven: better-auth's session
// store, which `useInvalidate` consults. The routes are replaced at
// `traefikApi` below.
vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useActiveOrganizationId,
}));

const { RestartTraefikModal } = await import(
  "@/features/requests/restart-traefik-modal"
);
const { TraefikSection } = await import(
  "@/features/settings/platform/traefik-section"
);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useActiveOrganizationId.mockReset();
});

function mount(node: ReactNode) {
  useActiveOrganizationId.mockReturnValue({
    organizationId: "org-1",
    pending: false,
  });
  vi.spyOn(traefikApi, "readConfig").mockResolvedValue("");
  vi.spyOn(traefikApi, "directories").mockResolvedValue([]);
  vi.spyOn(traefikApi, "readEnv").mockResolvedValue("");
  vi.spyOn(traefikApi, "ports").mockResolvedValue([]);
  vi.spyOn(traefikApi, "dashboardEnabled").mockResolvedValue(false);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

/** The open dialog's description — the line under its title — and its whole text. */
async function confirm() {
  const dialog = await screen.findByRole("dialog");
  const id = dialog.getAttribute("aria-describedby");
  return {
    description: (id && document.getElementById(id)?.textContent) || "",
    text: dialog.textContent ?? "",
  };
}

/**
 * The two Restart Traefik confirms.
 *
 * Settings → Traefik's danger zone said "This cannot be undone." — the
 * destructive deletes' line — for a restart that loses nothing, while the
 * Requests screen's confirm for the same `POST /settings/traefik/reload`
 * described the disruption. They now say the same thing, from this module —
 * so this renders both callers rather than the module alone: what is pinned is
 * that each screen actually uses it.
 */
describe("Restart Traefik confirms", () => {
  it("say the same thing on the Requests screen and in Settings, and neither claims it cannot be undone", async () => {
    mount(<RestartTraefikModal open onOpenChange={() => {}} />);
    const requests = await confirm();
    cleanup();

    mount(<TraefikSection />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Restart Traefik" }),
    );
    const settings = await confirm();

    expect(requests.description).not.toBe("");
    expect(settings.description).toBe(requests.description);
    for (const shown of [requests, settings]) {
      expect(shown.text).not.toContain("cannot be undone");
      expect(shown.text).toContain(
        "Every connection it is currently serving is dropped",
      );
    }
  });
});
