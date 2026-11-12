import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { traefikApi } from "@/lib/api/endpoints/traefik";

const useActiveOrganizationId = vi.hoisted(() => vi.fn());

// One system boundary, replaced rather than driven: better-auth's session
// store, which `useInvalidate` consults. The reads are replaced at `traefikApi`.
vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useActiveOrganizationId,
}));

const { InstanceDangerZone } = await import("./instance-danger-zone");
const { TraefikSection } = await import("./traefik-section");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useActiveOrganizationId.mockReset();
});

/** Where each restart's confirm is rendered from. */
const SCREENS: Record<string, () => ReactNode> = {
  "Restart Cloudgate": () => <InstanceDangerZone checked={false} />,
  "Restart Traefik": () => <TraefikSection />,
};

/**
 * Every danger-zone button in this folder whose label starts with "Restart",
 * read from the source — so a restart added later is one this test has to be
 * told how to render, rather than one it silently never opens.
 */
function restartButtons(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return readdirSync(here)
    .filter((file) => file.endsWith(".tsx") && !file.endsWith(".test.tsx"))
    .flatMap((file) =>
      [...readFileSync(join(here, file), "utf8").matchAll(
        /button: "(Restart[^"]*)"/g,
      )].map((match) => match[1]),
    )
    .sort();
}

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

/**
 * A restart interrupts; it does not destroy.
 *
 * `DangerZone`'s dialog says "This cannot be undone." unless an action passes
 * `caution`, and both restarts here inherited it — Traefik's for a one-second
 * restart that changes nothing, Cloudgate's for one that keeps every saved
 * thing. Update and restart keeps the line on purpose and is not a restart
 * alone, so it is not in this census.
 */
describe("restart confirms in Settings → Platform", () => {
  it("covers every Restart button in this folder", () => {
    expect(restartButtons()).toEqual(Object.keys(SCREENS).sort());
  });

  it.each(Object.entries(SCREENS))(
    "%s's confirm does not say it cannot be undone",
    async (button, screenFor) => {
      mount(screenFor());
      fireEvent.click(await screen.findByRole("button", { name: button }));
      const dialog = await screen.findByRole("dialog");
      const id = dialog.getAttribute("aria-describedby");
      const caution = (id && document.getElementById(id)?.textContent) || "";

      expect(caution).not.toBe("");
      expect(dialog.textContent ?? "").not.toContain("cannot be undone");
    },
  );
});
