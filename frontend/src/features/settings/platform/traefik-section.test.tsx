import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { settingsApi } from "@/lib/api/endpoints/settings";
import { traefikApi } from "@/lib/api/endpoints/traefik";
import type { TraefikConfigKind } from "@/lib/api/endpoints/traefik";

import { TraefikConfigCard } from "./traefik-config-card";
import { CONFIGS, PlatformRequestMetricsCard } from "./traefik-section";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/**
 * What the three file cards tell an operator about the files they edit.
 *
 * The card is rendered rather than the descriptor read, because the claim being
 * pinned is what somebody on `/settings/traefik` reads before deciding a file
 * is theirs to empty.
 */
async function mount(kind: TraefikConfigKind) {
  const spy = vi.spyOn(traefikApi, "readConfig").mockResolvedValue("");
  const descriptor = CONFIGS.find((config) => config.kind === kind);
  if (!descriptor) throw new Error(`no descriptor for ${kind}`);

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <TraefikConfigCard descriptor={descriptor} />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(spy).toHaveBeenCalledWith(kind));
}

describe("the Shared middlewares card", () => {
  it("names the middleware every HTTPS domain depends on", async () => {
    await mount("middlewares");

    // `redirect-to-https` is defined only in this file (deploy/install.sh,
    // servers/server-setup.ts) and named by every HTTPS domain Cloudgate
    // writes, so a card that does not name it invites the operator to delete
    // the redirect out from under them.
    expect(document.body.textContent ?? "").toContain("redirect-to-https");
  });

  it("does not tell the operator that Cloudgate has no use for the file", async () => {
    await mount("middlewares");

    expect(document.body.textContent ?? "").not.toContain(
      "Cloudgate does not use this file",
    );
    expect(document.body.textContent ?? "").not.toContain(
      "Cloudgate writes none of them itself",
    );
  });
});

describe("the platform host's Request metrics card", () => {
  it("says the read failed instead of loading forever", async () => {
    vi.spyOn(settingsApi, "webServer").mockRejectedValue(
      new Error("offline"),
    );
    vi.spyOn(settingsApi, "infrastructureHealth").mockRejectedValue(
      new Error("offline"),
    );
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <PlatformRequestMetricsCard />
      </QueryClientProvider>,
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).not.toBe("");
    expect(document.querySelector("[data-slot=skeleton]")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Enable request metrics" }),
    ).toBeNull();
  });
});
