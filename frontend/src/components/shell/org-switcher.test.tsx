import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { createElement } from "react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  OrganizationCreation,
  OrganizationMembership,
} from "@/lib/api/endpoints/organizations";
import { keys } from "@/lib/api/keys";

const useActiveOrganizationId = vi.hoisted(() => vi.fn());
const list = vi.hoisted(() => vi.fn());
const creation = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useActiveOrganizationId,
}));

vi.mock("@/lib/api/use-invalidate", () => ({
  useInvalidate: () => ({ organizationChanged: vi.fn() }),
}));

// The HTTP client is the boundary: `GET /organizations` and
// `GET /organizations/creation` are Nest's.
vi.mock("@/lib/api/endpoints/organizations", async (original) => {
  const actual =
    await original<typeof import("@/lib/api/endpoints/organizations")>();
  return {
    ...actual,
    organizationsApi: { ...actual.organizationsApi, list, creation },
  };
});

const { OrgSwitcher } = await import("./org-switcher");

/** A row of `GET /organizations`, with only what the switcher reads. */
function org(
  id: string,
  name: string,
  paidBy: OrganizationMembership["paidBy"] = null,
) {
  return { id, name, paidBy } as OrganizationMembership;
}

const ORGS = [org("o1", "Acme Platform Engineering")];

const ALLOWED: OrganizationCreation = {
  allowed: true,
  reason: null,
  code: null,
  licenseHint: false,
  overLimit: null,
  ownedPayingForThemselves: null,
  planHint: null,
};

/**
 * The switcher with its query cache. `organizations` is the list already
 * cached, as on a client that has read it before; `null` is the server,
 * which has no list.
 */
function switcher(organizations: OrganizationMembership[] | null = ORGS) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  if (organizations) client.setQueryData(keys.myOrganizations(), organizations);
  return createElement(
    QueryClientProvider,
    { client },
    createElement(OrgSwitcher),
  );
}

beforeEach(() => {
  useActiveOrganizationId.mockReturnValue({ organizationId: "o1" });
  list.mockResolvedValue(ORGS);
  creation.mockResolvedValue(ALLOWED);
});

afterEach(() => {
  cleanup();
  useActiveOrganizationId.mockReset();
  list.mockReset();
  creation.mockReset();
});

async function openMenu(name = "Acme Platform Engineering") {
  fireEvent.click(
    await screen.findByRole("button", {
      name: `Organization: ${name}. Switch Organization`,
    }),
  );
  return screen.findByRole("menuitem", { name: "New organization" });
}

/** The Organization rows of the open menu, in order, by what they are called. */
function organizationRows() {
  return screen
    .getAllByRole("menuitem")
    .map((item) => item.getAttribute("aria-label") ?? item.textContent ?? "")
    .filter((text) => !/New organization|Organization settings/.test(text));
}

describe("OrgSwitcher", () => {
  /**
   * The server has no Organization list, so it renders the skeleton; a client
   * whose list was already cached rendered the name on its first render, and
   * every console page logged a hydration mismatch.
   */
  it("hydrates over the server's skeleton without a mismatch", async () => {
    // The server: no list yet.
    const html = renderToString(switcher(null));
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain("Acme Platform Engineering");

    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.append(container);
    // The client: the list is already in the cache.
    const onRecoverableError = vi.fn();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    await act(async () => {
      hydrateRoot(container, switcher(ORGS), {
        onRecoverableError,
      });
    });

    expect(onRecoverableError).not.toHaveBeenCalled();
    expect(
      consoleError.mock.calls.some((call) => /hydrat/i.test(String(call[0]))),
    ).toBe(false);
    consoleError.mockRestore();
    expect(container.textContent).toContain("Acme Platform Engineering");
    container.remove();
  });

  it("names the active Organization once it is known", () => {
    render(switcher());
    expect(
      screen.getByRole("button", {
        name: "Organization: Acme Platform Engineering. Switch Organization",
      }),
    ).toBeTruthy();
  });

  it("offers New organization when it would be accepted", async () => {
    render(switcher());
    const item = await openMenu();
    await waitFor(() =>
      expect(item.getAttribute("aria-disabled")).not.toBe("true"),
    );
  });

  it("greys out New organization for the Instance organization's owner, with the license hint", async () => {
    creation.mockResolvedValue({
      allowed: false,
      reason:
        "Without an Enterprise license this instance allows one Organization. Add a license under Settings > License",
      code: "ORGANIZATION_LIMIT",
      licenseHint: true,
      overLimit: null,
    });
    render(switcher());
    const item = await openMenu();

    await waitFor(() =>
      expect(item.getAttribute("aria-disabled")).toBe("true"),
    );
    expect(
      await screen.findByText(
        /Without an Enterprise license this instance allows one Organization\. Add a license/,
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Go to License" }).getAttribute("href"),
    ).toBe("/settings/license");
  });

  it("greys out New organization for everyone else with the plain reason and no hint", async () => {
    creation.mockResolvedValue({
      allowed: false,
      reason:
        "Without an Enterprise license this instance allows one Organization. The instance's administrators can add a license.",
      code: "ORGANIZATION_LIMIT",
      licenseHint: false,
      overLimit: null,
    });
    render(switcher());
    const item = await openMenu();

    await waitFor(() =>
      expect(item.getAttribute("aria-disabled")).toBe("true"),
    );
    expect(
      await screen.findByText(
        /The instance's administrators can add a license\./,
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Go to License" })).toBeNull();
  });

  /**
   * The tree. Who pays comes from `GET /organizations`: the payer's id
   * when the caller is a member of it, so the switcher can nest the Attached
   * Organization under it, and nothing but "another" when they are not.
   */
  describe("as a tree", () => {
    const HOPPER = org("p1", "Hopper Labs");
    const TURING = org("a1", "Turing Works", { organizationId: "p1" });

    it("nests an Attached Organization under its Paying Organization for a member of both", async () => {
      useActiveOrganizationId.mockReturnValue({ organizationId: "p1" });
      // Listed before its payer, as the database may answer.
      render(switcher([TURING, org("o1", "Acme"), HOPPER]));
      await openMenu("Hopper Labs");

      expect(organizationRows()).toEqual([
        "Acme",
        "Hopper Labs",
        "Turing Works, paid by Hopper Labs",
      ]);
      expect(document.body.textContent).not.toContain("another Organization");
    });

    it("puts an Attached Organization at the top level, paid by another, for a member of only it", async () => {
      useActiveOrganizationId.mockReturnValue({ organizationId: "a1" });
      const alone = org("a1", "Turing Works", { organizationId: null });
      render(switcher([org("o1", "Acme"), alone]));
      await openMenu("Turing Works");

      expect(organizationRows()).toEqual([
        "Acme",
        "Turing Works, paid by another Organization",
      ]);
      expect(screen.getByText("Paid by another Organization")).toBeTruthy();
      expect(document.body.textContent).not.toContain("Hopper");
    });

    it("marks a nested Organization selected when it is the active one", async () => {
      useActiveOrganizationId.mockReturnValue({ organizationId: "a1" });
      render(switcher([HOPPER, TURING]));
      await openMenu("Turing Works");

      expect(
        screen
          .getByRole("menuitem", { name: "Turing Works, paid by Hopper Labs" })
          .getAttribute("aria-pressed"),
      ).toBe("true");
      expect(
        screen
          .getByRole("menuitem", { name: "Hopper Labs" })
          .getAttribute("aria-pressed"),
      ).toBe("false");
    });

    it("looks as it always has with nothing attached", async () => {
      render(switcher([ORGS[0], org("o2", "Second")]));
      await openMenu();

      expect(organizationRows()).toEqual([
        "Acme Platform Engineering",
        "Second",
      ]);
      expect(document.body.textContent).not.toMatch(/Paid by|paid by/);
    });
  });

  it("greys out New organization on the Hosted instance as Settings does, with the same pointer", async () => {
    creation.mockResolvedValue({
      allowed: false,
      reason:
        "You already own Northwind, and a person can own one Organization that pays for itself. On Business, Northwind can pay for more Organizations.",
      code: "ORGANIZATION_LIMIT",
      licenseHint: false,
      overLimit: null,
      ownedPayingForThemselves: { count: 1, of: 1 },
      planHint: { kind: "see-plans" },
    });
    render(switcher());
    const item = await openMenu();

    await waitFor(() =>
      expect(item.getAttribute("aria-disabled")).toBe("true"),
    );
    expect(await screen.findByText(/You already own Northwind/)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "See plans" }).getAttribute("href"),
    ).toBe("/settings/billing");
  });
});
