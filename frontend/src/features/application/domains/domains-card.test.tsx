import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";

import type { Domain } from "@/lib/api/endpoints/domains";
import type { TraefikConfigStatus } from "@/lib/api/endpoints/traefik";

import type { useTraefikConfigStatus } from "../traefik-status/use-config-status";
import { DomainsCard } from "./domains-card";
import type { useApplicationDomains } from "./use-domains";

afterEach(cleanup);

const rows = [
  {
    domainId: "d1",
    host: "hello.example.test",
    path: "/",
    port: 3000,
    https: false,
    certificateType: "none",
    stripPath: false,
  },
] as unknown as Domain[];

/** A `useTraefikConfigStatus` result, as the panel hands one down. */
const traefikSaid = (status: TraefikConfigStatus) =>
  ({
    data: status,
    error: null,
    isPending: false,
  }) as unknown as ReturnType<typeof useTraefikConfigStatus>;

const refusedHost = traefikSaid({
  applicationId: "a1",
  appName: "hello",
  state: "checked",
  checkedAt: new Date().toISOString(),
  rejections: [
    {
      routerName: "hello-router-1",
      message: "error parsing regexp: invalid or unsupported Perl syntax",
      domain: { domainId: "d1", host: "hello.example.test" },
      subjects: [
        { kind: "domain", domainId: "d1", host: "hello.example.test" },
      ],
      observedAt: new Date().toISOString(),
    },
  ],
});

const nothingLogged = traefikSaid({
  applicationId: "a1",
  appName: "hello",
  state: "checked",
  checkedAt: new Date().toISOString(),
  rejections: [],
});

function withQuery(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("DomainsCard", () => {
  it("says the route goes live without a Deployment", () => {
    render(
      withQuery(
        <DomainsCard
          domains={
            {
              data: rows,
              isPending: false,
              error: null,
            } as unknown as ReturnType<typeof useApplicationDomains>
          }
          canAdd
          onAdd={() => {}}
          onEdit={() => {}}
          onRemove={() => {}}
        />,
      ),
    );

    const said = document.body.textContent ?? "";
    // The strip told an operator to redeploy a working Application to activate a
    // route that was already being served.
    expect(said).toContain(
      "starts or stops being served within a second — no Deployment needed.",
    );
    expect(said).not.toContain("on the next Deployment");
  });

  it("marks the host a refused router stopped serving", () => {
    render(
      withQuery(
        <DomainsCard
          domains={
            {
              data: rows,
              isPending: false,
              error: null,
            } as unknown as ReturnType<typeof useApplicationDomains>
          }
          status={refusedHost}
          canAdd
          onAdd={() => {}}
          onEdit={() => {}}
          onRemove={() => {}}
        />,
      ),
    );

    // On the row, not only in the notice above it: the table is what an
    // operator scans, and the host still looks exactly like a working one.
    expect(document.body.textContent ?? "").toContain(
      "Not being routed — Traefik refused this host’s router",
    );
  });

  it("marks no row when Traefik logged nothing about this Application", () => {
    render(
      withQuery(
        <DomainsCard
          domains={
            {
              data: rows,
              isPending: false,
              error: null,
            } as unknown as ReturnType<typeof useApplicationDomains>
          }
          status={nothingLogged}
          canAdd
          onAdd={() => {}}
          onEdit={() => {}}
          onRemove={() => {}}
        />,
      ),
    );

    const said = document.body.textContent ?? "";
    expect(said).not.toContain("Not being routed");
    // And it does not turn the silence into a claim about the row either:
    // there is no per-row verdict at all, only the strip's own wording.
    expect(said).toContain("logged nothing");
  });
});

/**
 * The Certificate column names the stored certificate Traefik serves —
 * for a `stored` row, and for a Let's Encrypt row a stored certificate covers,
 * because Traefik serves the stored one before it asks ACME.
 */
describe("domainColumns — the Certificate column", () => {
  const row = (overrides: Partial<Domain>) =>
    ({
      domainId: "d1",
      host: "shop.example.com",
      path: "/",
      port: 3000,
      https: true,
      stripPath: false,
      customCertResolver: null,
      storedCertificate: null,
      ...overrides,
    }) as unknown as Domain;

  const cardSays = (domain: Domain) => {
    render(
      withQuery(
        <DomainsCard
          domains={
            {
              data: [domain],
              isPending: false,
              error: null,
            } as unknown as ReturnType<typeof useApplicationDomains>
          }
          canAdd
          onAdd={() => {}}
          onEdit={() => {}}
          onRemove={() => {}}
        />,
      ),
    );
    return document.body.textContent ?? "";
  };

  it("names the stored certificate a stored row is served with", () => {
    const said = cardSays(
      row({
        certificateType: "stored",
        storedCertificate: { certificateId: "c1", name: "shop cert" },
      }),
    );
    expect(said).toContain("Stored");
    expect(said).toContain("shop cert");
  });

  it("says so when no stored certificate covers a stored row's host", () => {
    expect(cardSays(row({ certificateType: "stored" }))).toContain(
      "No stored certificate covers this host",
    );
  });

  it("does not call a host Let's Encrypt when a stored certificate serves it", () => {
    const said = cardSays(
      row({
        certificateType: "letsencrypt",
        storedCertificate: { certificateId: "c2", name: "wildcard" },
      }),
    );
    expect(said).toContain("wildcard");
    expect(said).toContain("instead of Let's Encrypt");
  });

  it("claims no certificate at all when HTTPS is off", () => {
    const said = cardSays(row({ certificateType: "stored", https: false }));
    expect(said).toContain("Not managed here");
    expect(said).not.toContain("Stored certificate");
    expect(said).not.toContain("No stored certificate covers");

    // A row saved with HTTPS off and Let's Encrypt read "HTTP / Let's Encrypt".
    cleanup();
    const old = cardSays(row({ certificateType: "letsencrypt", https: false }));
    expect(old).toContain("Not managed here");
    expect(old).not.toContain("Let's Encrypt");
  });

  it("still says Let's Encrypt when nothing stored covers the host", () => {
    const said = cardSays(row({ certificateType: "letsencrypt" }));
    expect(said).toContain("Let's Encrypt");
    expect(said).not.toContain("instead of");
  });
});
