import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/api-error";
import { licenseApi } from "@/lib/api/endpoints/license";
import type { ConsoleOriginTrust } from "@/lib/api/endpoints/settings";
import { traefikApi } from "@/lib/api/endpoints/traefik";
import type { TraefikConsoleStatus } from "@/lib/api/endpoints/traefik";

const useActiveOrganizationId = vi.hoisted(() => vi.fn());

// better-auth's session store, which the licence read behind the sign-in
// warning keys itself by. Replaced, not driven, as on the Console
// domain card's own spec.
vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useActiveOrganizationId,
}));

const { ConsoleRouterCard } = await import("./console-router-card");

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  useActiveOrganizationId.mockReset();
});

/**
 * The console's own routers, on a screen (H-61).
 *
 * One boundary is replaced — `GET /traefik/config-status/console` — and the card
 * is driven for real through TanStack Query, because what is being asserted is
 * what an operator reads, not which branch ran.
 *
 * The three states are asserted apart for the same reason they are on an
 * Application's Domains tab: `checked` with nothing means *"this is what
 * Traefik's log said"*, Traefik logs nothing at all for a configuration it
 * accepted, and `unavailable` means the log could not be read. Neither may read
 * as "the console is being served".
 */
const status = (over: Partial<TraefikConsoleStatus>): TraefikConsoleStatus => ({
  state: "checked",
  checkedAt: new Date().toISOString(),
  rejections: [],
  ...over,
});

async function mount(
  answer: TraefikConsoleStatus | Error,
  consoleOrigin: ConsoleOriginTrust | null = null,
  licensed = false,
) {
  useActiveOrganizationId.mockReturnValue({
    organizationId: "org-1",
    pending: false,
  });
  vi.spyOn(licenseApi, "status").mockResolvedValue({
    licensed,
    status: licensed ? "active" : "inactive",
    validUntil: null,
    features: [],
  } as never);
  const spy = vi.spyOn(traefikApi, "consoleConfigStatus");
  if (answer instanceof Error) spy.mockRejectedValue(answer);
  else spy.mockResolvedValue(answer);

  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrap = (children: ReactNode) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  render(wrap(<ConsoleRouterCard consoleOrigin={consoleOrigin} />));
  await waitFor(() => expect(spy).toHaveBeenCalled());
}

const shown = async (text: string) =>
  waitFor(() => expect(document.body.textContent ?? "").toContain(text));

describe("ConsoleRouterCard", () => {
  it("says the console is not being served on its domain, and what Traefik said", async () => {
    await mount(
      status({
        rejections: [
          {
            routerName: "cloudgate-router-app",
            message:
              'middleware "redirect-to-https@file" does not exist for entrypoint "web"',
            source: "console-domain",
            middlewares: ["redirect-to-https"],
            observedAt: new Date().toISOString(),
          },
        ],
      }),
    );

    await shown("This console is not being served on its domain.");
    await shown("cloudgate-router-app");
    // Traefik's own sentence: it is the only thing that names the failure.
    await shown("does not exist for entrypoint");
    // Where to go, since there is no Application to hang this on.
    await shown("Console domain settings");
    // The one fact that makes a screen a sensible place for this report at all.
    await shown("still reachable on this machine");
  });

  it("says what the log said rather than that the console is served", async () => {
    await mount(status({}));

    await shown("logged nothing");
    await shown("not a health check");
    // The claim it must never make, and the disclaimer that replaces it.
    await shown("not proof that the console is being served on its domain");
    expect(document.body.textContent ?? "").not.toMatch(/\bhealthy\b|\bok\b/i);
  });

  it("dates the report by when Cloudgate looked, not by when a configuration was written", async () => {
    // `checkedAt` is documented as "when Cloudgate looked, by this instance's
    // clock" and the card used to render it as "when a configuration was last
    // written on this host" — a second, different claim, and the one that let an
    // hour-old observation of an unrelated Application's write read as the
    // verdict on a console domain just saved.
    await mount(status({}));

    await shown("when Cloudgate last read its log");
    expect(document.body.textContent ?? "").not.toContain(
      "was last written on this host",
    );
  });

  it("says Traefik could not be asked rather than that nothing is wrong", async () => {
    await mount(
      status({
        state: "unavailable",
        reason: "No running cloudgate-traefik container on the platform host",
      }),
    );

    await shown("could not ask Traefik");
    await shown("No running cloudgate-traefik container");
    expect(document.body.textContent ?? "").not.toContain("logged nothing");
  });

  it("renders nothing for a Member who is not an operator of this instance", async () => {
    // 403 is the answer for a Member who is not an owner or admin of the
    // instance organization. Not a fault to report: the two files behind this
    // are not theirs, and an error strip would be noise on a screen they can
    // otherwise use.
    await mount(
      new ApiError(
        403,
        "Only an owner or admin of the instance organization can configure the platform host",
        { path: "/traefik/config-status/console" },
      ),
    );

    await waitFor(() =>
      expect(screen.queryByText("Console routing")).toBeNull(),
    );
  });
});

/**
 * Served is not usable. Traefik accepted the routers and Let's Encrypt
 * issued the certificate, and every sign-in on the domain was still refused
 * `403 INVALID_ORIGIN` — while this card, the one an operator reads after the
 * save, reported a clean routing log and nothing else.
 */
describe("ConsoleRouterCard's sign-in warning", () => {
  const untrusted = {
    origin: "https://console.testgc.octabyte.app",
    trusted: false,
  };
  const text = () => document.body.textContent ?? "";

  it("says sign-in on the domain will be refused when its origin is not trusted, beside a clean routing log", async () => {
    await mount(status({}), untrusted);

    await shown("Sign-in on this console\u2019s domain will be refused.");
    await shown("https://console.testgc.octabyte.app");
    await shown("403 INVALID_ORIGIN");
    // The trap was that these two read as one verdict: the log is still said.
    await shown("logged nothing");
  });

  it("names the license and the env route on an unlicensed Organization", async () => {
    await mount(status({}), untrusted, false);

    await shown("needs an enterprise license and this Organization has none");
    await shown("TRUSTED_ORIGINS");
  });

  it("names the Trusted origins card and no restart on a licensed one", async () => {
    await mount(status({}), untrusted, true);

    await shown("which takes effect at once with no restart");
    expect(text()).not.toContain("restart the backend");
  });

  it("says the live screens still need NEXT_PUBLIC_API_URL rebuilt", async () => {
    await mount(status({}), untrusted);

    await shown("NEXT_PUBLIC_API_URL");
  });

  it("says nothing about sign-in when the origin is trusted", async () => {
    await mount(status({}), { ...untrusted, trusted: true });

    await shown("logged nothing");
    expect(text()).not.toContain("will be refused");
  });

  it("says nothing about sign-in when no console domain is set", async () => {
    await mount(status({}), null);

    await shown("logged nothing");
    expect(text()).not.toContain("will be refused");
  });
});
