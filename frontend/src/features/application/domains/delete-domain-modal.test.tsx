import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { domainsApi, type Domain } from "@/lib/api/endpoints/domains";
import { keys } from "@/lib/api/keys";

const useActiveOrganizationId = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => ({ done: vi.fn(), error: vi.fn() }));

// Two boundaries, replaced rather than driven: better-auth's session store,
// which the domain list's query key and `useInvalidate` read at render, and the
// toast, whose text is one of the three places a removal names its route.
vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useActiveOrganizationId,
}));
vi.mock("@/components/console/toast", () => ({ toast }));

const { DeleteDomainModal } = await import("./delete-domain-modal");

beforeEach(() => {
  useActiveOrganizationId.mockReturnValue({
    organizationId: "org-1",
    pending: false,
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  toast.done.mockReset();
});

const domain = { domainId: "d1", host: "hello-tls.example.test" } as Domain;

/**
 * The provider, holding `siblings` as the Application's domain list — which the
 * Domains tab the dialog opens from has always already fetched.
 */
function withQuery(children: ReactNode, siblings: Domain[] = [domain]) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(keys.domains.byApplication("org-1", "app-1"), siblings);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const onRoot = {
  domainId: "root",
  host: "a.example.com",
  path: "/",
} as Domain;
const onApi = {
  domainId: "api",
  host: "a.example.com",
  path: "/api",
} as Domain;

/**
 * The dialog said the host kept answering until the next Deployment. It does
 * not: `DomainsService.remove` awaits `regenerateTraefikConfig` in the same
 * request and Traefik's file provider reloads in under a second. A Compose
 * stack is the one parent that genuinely waits.
 */
describe("DeleteDomainModal", () => {
  it("tells an Application owner the route is gone straight away", () => {
    render(
      withQuery(
        <DeleteDomainModal
          applicationId="app-1"
          domain={domain}
          open
          onOpenChange={() => {}}
        />,
      ),
    );

    const said = document.body.textContent ?? "";
    expect(said).toContain("This Application stops answering");
    expect(said).toContain("straight away");
    expect(said).toContain("No Deployment is needed.");
    expect(said).not.toContain("after its next Deployment");
  });

  it("still tells a stack owner it waits for a deploy, and calls it a stack", () => {
    render(
      withQuery(
        <DeleteDomainModal
          composeId="cmp-1"
          domain={domain}
          open
          onOpenChange={() => {}}
        />,
      ),
    );

    // A Compose stack's routers travel as labels injected at deploy time, and
    // `regenerateTraefikConfig` returns early for one — so this half of the copy
    // was right all along. The noun was not: the Compose panel passes no `noun`,
    // and this dialog used to call a stack an Application.
    const said = document.body.textContent ?? "";
    expect(said).toContain("This stack stops answering");
    expect(said).toContain("after its next Deployment");
  });

  it("keeps the words either side of the host apart", () => {
    render(
      withQuery(
        <DeleteDomainModal
          applicationId="app-1"
          domain={domain}
          open
          onOpenChange={() => {}}
        />,
      ),
    );

    // The `{" "}` trap: a JSXText node beginning on a new line loses its leading
    // whitespace, so an inline element at the end of a line runs into the next
    // word. This paragraph has three such joins.
    const said = document.body.textContent ?? "";
    expect(said).toContain("on hello-tls.example.test straight away");
    expect(said).toContain("needed. You can add the host back");
  });

  it("names the path of a path domain in its title, its body and its toast", async () => {
    // Removing `/api` asked "Remove a.example.com?" and toasted "a.example.com
    // removed.", so an operator with two rows on one host could not tell which
    // of them was going.
    vi.spyOn(domainsApi, "remove").mockResolvedValue(onApi);
    render(
      withQuery(
        <DeleteDomainModal
          applicationId="app-1"
          domain={onApi}
          open
          onOpenChange={() => {}}
        />,
        [onRoot, onApi],
      ),
    );

    expect(
      screen.getByRole("heading", { name: "Remove a.example.com/api?" }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Remove domain" }));
    await waitFor(() =>
      expect(toast.done).toHaveBeenCalledWith("a.example.com/api removed."),
    );
  });

  it("does not say the host stops answering while another route on it remains", () => {
    // The `/` route on the same host keeps answering — including under `/api`,
    // which it now catches — so "stops answering on a.example.com" was wrong
    // about the one thing the dialog exists to say.
    render(
      withQuery(
        <DeleteDomainModal
          applicationId="app-1"
          domain={onApi}
          open
          onOpenChange={() => {}}
        />,
        [onRoot, onApi],
      ),
    );

    const said = document.body.textContent ?? "";
    expect(said).not.toContain("stops answering on a.example.com ");
    expect(said).toContain("This route stops answering straight away");
    expect(said).toContain(
      "needed. a.example.com keeps answering on its other route, /. A request under /api is served by the / route instead. You can add the route back",
    );
  });

  it("says the path's host goes quiet when the path domain was its only route", () => {
    render(
      withQuery(
        <DeleteDomainModal
          applicationId="app-1"
          domain={onApi}
          open
          onOpenChange={() => {}}
        />,
        [onApi],
      ),
    );

    const said = document.body.textContent ?? "";
    expect(said).toContain(
      "This Application stops answering on a.example.com/api straight away",
    );
    expect(said).not.toContain("keeps answering");
  });
});
