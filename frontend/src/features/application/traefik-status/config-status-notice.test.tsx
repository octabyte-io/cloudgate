import { cleanup, render } from "@testing-library/react";
import type { UseQueryResult } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vitest";

import type { TraefikConfigStatus } from "@/lib/api/endpoints/traefik";

import { TraefikConfigStatusNotice } from "./config-status-notice";

afterEach(cleanup);

/**
 * The three states this surface exists to keep apart.
 *
 * H-38's backend is careful that `rejections: []` means *"this is what Traefik's
 * log said"* and never *"your configuration is good"* — Traefik logs nothing at
 * all for a reload it accepted, so an accepted config and a reload that has not
 * happened yet are the same silence. `unavailable` is a third thing again: the
 * log could not be read. Collapsing either of the quiet two into a green tick is
 * the whole failure H-62 files, so each is asserted to say what it knows **and**
 * asserted not to claim the Application is being served.
 */
const status = (over: Partial<TraefikConfigStatus>): TraefikConfigStatus => ({
  applicationId: "app_shop",
  appName: "shop",
  state: "checked",
  checkedAt: new Date().toISOString(),
  rejections: [],
  ...over,
});

const asQuery = (data: TraefikConfigStatus) =>
  ({
    data,
    error: null,
    isPending: false,
  }) as unknown as UseQueryResult<TraefikConfigStatus>;

const shown = () => document.body.textContent ?? "";

describe("TraefikConfigStatusNotice", () => {
  it("names the Domain that stopped routing and what Traefik said", () => {
    render(
      <TraefikConfigStatusNotice
        query={asQuery(
          status({
            rejections: [
              {
                routerName: "shop-router-1",
                message:
                  "error parsing regexp: invalid or unsupported Perl syntax: `(?=`",
                domain: { domainId: "dom_web", host: "shop.example.com" },
                subjects: [
                  {
                    kind: "domain",
                    domainId: "dom_web",
                    host: "shop.example.com",
                  },
                  { kind: "redirect", redirectId: "red_www" },
                  { kind: "security", securityId: "sec_ops" },
                  { kind: "security", securityId: "sec_dev" },
                ],
                observedAt: new Date().toISOString(),
              },
            ],
          }),
        )}
      />,
    );

    const said = shown();
    expect(said).toContain("shop.example.com");
    // Traefik's sentence, verbatim: it is the only thing that names the field.
    expect(said).toContain("invalid or unsupported Perl syntax");
    // The chain, in the nouns of the screens that own those rows — Traefik says
    // which router it dropped and never which link failed to build.
    expect(said).toContain("1 Redirect");
    expect(said).toContain("2 basic-auth users");
  });

  it("says what the log said rather than that the configuration is good", () => {
    render(<TraefikConfigStatusNotice query={asQuery(status({}))} />);

    const said = shown();
    expect(said).toContain("logged nothing");
    // The trap this whole component exists for: silence is not health.
    expect(said).toContain("not a health check");
    expect(said).not.toMatch(/\bhealthy\b|being served correctly|all good/i);
  });

  it("says Traefik could not be asked rather than that nothing is wrong", () => {
    render(
      <TraefikConfigStatusNotice
        query={asQuery(
          status({
            state: "unavailable",
            reason: "No running cloudgate-traefik container on the platform host",
          }),
        )}
      />,
    );

    const said = shown();
    expect(said).toContain("could not ask Traefik");
    expect(said).toContain("No running cloudgate-traefik container");
    expect(said).not.toContain("logged nothing");
  });

  it("distinguishes nothing-observed from could-not-ask", () => {
    const { container: quiet } = render(
      <TraefikConfigStatusNotice query={asQuery(status({}))} />,
    );
    const observed = quiet.textContent ?? "";
    cleanup();

    const { container: unknown_ } = render(
      <TraefikConfigStatusNotice
        query={asQuery(status({ state: "unavailable", reason: "no container" }))}
      />,
    );
    const unavailable = unknown_.textContent ?? "";

    // Two states that mean different things must not render the same words —
    // this is the assertion that fails if a later edit merges them into one
    // reassuring sentence.
    expect(observed).not.toBe(unavailable);
  });
});
