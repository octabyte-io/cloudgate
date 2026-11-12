import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/api-error";
import type { AiProvider, EnabledAiProvider } from "@/lib/api/endpoints/ai";

const enabled = vi.hoisted(() => vi.fn());
const list = vi.hoisted(() => vi.fn());

// The HTTP client is the boundary; everything else runs. `useRouter` and the
// invalidator are replaced because they belong to a screen this dialog only
// leaves through, and neither is reachable from the state under test.
vi.mock("@/lib/api/endpoints/ai", async (original) => {
  const actual = await original<typeof import("@/lib/api/endpoints/ai")>();
  return { ...actual, aiApi: { ...actual.aiApi, enabled, list } };
});

vi.mock("@/lib/auth/client", () => ({
  useActiveOrganizationId: () => ({ organizationId: "org_1", pending: false }),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

vi.mock("@/lib/api/use-invalidate", () => ({
  useInvalidate: () => ({ compose: vi.fn() }),
}));

vi.mock("@/components/console/toast", () => ({
  toast: { done: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const { DraftServiceModal } = await import("./draft-service-modal");

/**
 * What the dialog says when it cannot draft anything, which is two states and
 * not one.
 *
 * `GET /ai/enabled-providers` answers the enabled rows only, so an Organization
 * whose single provider is switched off looks exactly like an Organization that
 * has never configured one — and was told, byte for byte, to go and add a
 * provider on the screen already showing theirs reading "Turned off". The two
 * branches are asserted against each other here: the zero-provider sentence is
 * pinned verbatim because it is still right and is wanted unchanged, and
 * the switched-off one is asserted to be a different sentence that says so.
 */

const NONE_CONFIGURED =
  "No AI provider is available. Add one under Settings → AI, then come back — nothing else on this screen changes.";

/**
 * Every branch names the AI section, so every branch links to it
 * — it was plain
 * text naming "Organization settings", which the strip stopped being called
 * when Account joined it.
 */
async function linksToAiSettings() {
  const link = await screen.findByRole("link", { name: "Settings → AI" });
  expect(link.getAttribute("href")).toBe("/settings/ai");
}

function provider(name: string): AiProvider {
  return {
    aiId: `ai_${name}`,
    name,
    apiUrl: "https://example.test/v1",
    model: "nex-agi/nex-n2.5-mini:free",
    isEnabled: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    organizationId: "org_1",
  };
}

function withQuery(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** The dialog's own prose, with the stepper's and the footer's words dropped. */
async function said() {
  render(
    withQuery(
      <DraftServiceModal
        environmentId="env_1"
        environmentName="production"
        deployTarget={{ kind: "platform-host" }}
        open
        onOpenChange={vi.fn()}
      />,
    ),
  );
  await waitFor(() => expect(enabled).toHaveBeenCalled());
  return screen
    .getByRole("dialog")
    .textContent?.replace(/\s+/g, " ")
    .trim() as string;
}

afterEach(() => {
  cleanup();
  enabled.mockReset();
  list.mockReset();
});

describe("DraftServiceModal", () => {
  it("sends an Organization with no provider at all to add one", async () => {
    enabled.mockResolvedValue([] satisfies EnabledAiProvider[]);
    list.mockResolvedValue([] satisfies AiProvider[]);

    expect(await said()).toContain(NONE_CONFIGURED);
    await linksToAiSettings();
  });

  it("names the provider that is switched off and says to turn it back on", async () => {
    enabled.mockResolvedValue([] satisfies EnabledAiProvider[]);
    list.mockResolvedValue([provider("ui-ai")]);

    await said();

    await waitFor(() =>
      expect(
        screen.getByRole("dialog").textContent?.replace(/\s+/g, " "),
      ).toContain(
        "ui-ai is turned off. Turn it back on under Settings → AI, then come back — nothing else on this screen changes.",
      ),
    );
    // And it is no longer the sentence that asks for a second provider.
    expect(screen.getByRole("dialog").textContent).not.toContain(
      "No AI provider is available",
    );
    await linksToAiSettings();
  });

  it("counts them when an Organization has several and every one is off", async () => {
    enabled.mockResolvedValue([] satisfies EnabledAiProvider[]);
    list.mockResolvedValue([provider("ui-ai"), provider("spare")]);

    await said();

    await waitFor(() =>
      expect(
        screen.getByRole("dialog").textContent?.replace(/\s+/g, " "),
      ).toContain("All 2 of this Organization’s AI providers are turned off."),
    );
    await linksToAiSettings();
  });

  it("keeps the add-one sentence for a member the provider list is refused to", async () => {
    // `GET /ai` is owner/admin only, so a member cannot be told which of the two
    // states they are in — and cannot act on either. A refusal is not an empty
    // list (§3.5), so this branch is chosen deliberately rather than inherited:
    // the sentence that was always there is the one this screen can still
    // stand behind.
    enabled.mockResolvedValue([] satisfies EnabledAiProvider[]);
    list.mockRejectedValue(
      new ApiError(403, "Only owners and admins can manage AI settings", {
        path: "/ai",
      }),
    );

    expect(await said()).toContain(NONE_CONFIGURED);
  });
});
