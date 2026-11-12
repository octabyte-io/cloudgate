import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { OrganizationMembership } from "@/lib/api/endpoints/organizations";

const list = vi.hoisted(() => vi.fn());
const update = vi.hoisted(() => vi.fn());
const create = vi.hoisted(() => vi.fn());
const creation = vi.hoisted(() => vi.fn());

// Two boundaries replaced, and only two. The HTTP client is one — `GET
// /organizations`, `POST /organizations` and `PATCH /organizations/:id` are
// Nest's, and this test is not about them. The toast is the other, because it
// renders through a portal nothing here reads. **better-auth's client is
// deliberately NOT mocked**: its store is the thing under test, so a double in
// its place would assert the wiring against itself and pass whether or not the
// signal is ever raised.
vi.mock("@/lib/api/endpoints/organizations", async (original) => {
  const actual =
    await original<typeof import("@/lib/api/endpoints/organizations")>();
  return {
    ...actual,
    organizationsApi: {
      ...actual.organizationsApi,
      list,
      update,
      create,
      creation,
    },
  };
});

vi.mock("@/components/console/toast", () => ({
  toast: { done: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const ORG_ID = "lDFCV2iUkYQVLqAhNF9jE";
const USER_ID = "user_1";

/** The `organization` table, as far as this test is concerned. */
let rows: Array<{ id: string; name: string }> = [];

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/** better-auth's two reads, answered off the same rows the console writes. */
const authServer = vi.fn((input: RequestInfo | URL) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes("/organization/list")) return Promise.resolve(json(rows));
  return Promise.resolve(
    json({
      session: { id: "session_1", activeOrganizationId: ORG_ID },
      user: { id: USER_ID, email: "owner@example.test" },
    }),
  );
});

// **Stubbed before the auth client is imported, and that ordering is the test
// working at all.** `createAuthClient` hands better-fetch a `customFetchImpl`
// captured while the module evaluates, so a stub installed in `beforeEach` is
// one the auth client never looks at — it reaches past it to node's own fetch
// and the store settles on "fetch failed". Hence the dynamic imports below:
// everything that pulls `@/lib/auth/client` in has to land after this line.
vi.stubGlobal("fetch", authServer);

const { OrgSwitcher } = await import("@/components/shell/org-switcher");
const { authClient } = await import("@/lib/auth/client");
const { OrganizationsSection } = await import("./organizations-section");

/**
 * The masthead switcher and the Organizations card, written through and read
 * back.
 *
 * **Why both components in one render.** The defect was never visible inside
 * either of them: the table, the danger zone and the toast all showed the new
 * name, and the switcher beside them kept the old one until a full reload. It
 * is a disagreement between two stores — TanStack's, which
 * `invalidate.membership()` refreshes, and better-auth's `$listOrg`, which is
 * what `OrgSwitcher` actually reads and which nothing was refreshing. A test of
 * one component on its own cannot see a disagreement between two.
 *
 * **So better-auth runs for real, over a stubbed `fetch`.** `authClient` is a
 * module singleton built on nanostores: `useListOrganizations` refetches
 * `/organization/list` when the `$listOrg` signal flips, and raising that
 * signal is the fix. The stub above is the server, and what it answers changes
 * when — and only when — a mocked write has been through, exactly as the
 * `organization` table does.
 */

function membership(row: { id: string; name: string }): OrganizationMembership {
  return {
    ...row,
    slug: null,
    logo: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    metadata: null,
    ownerId: USER_ID,
    paidBy: null,
    member: {
      id: `member_${row.id}`,
      organizationId: row.id,
      userId: USER_ID,
      role: "owner",
      createdAt: "2026-01-01T00:00:00.000Z",
      isDefault: row.id === ORG_ID,
      accessedProjects: [],
      accessedServices: [],
      accessedEnvironments: [],
    },
  };
}

function renderBoth() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <OrgSwitcher />
      <OrganizationsSection />
    </QueryClientProvider>,
  );
}

const switcher = () =>
  screen.getByRole("button", { name: /Switch Organization$/ });

/**
 * The switcher's menu, which is the other half of what the issue asks for.
 *
 * Opened at most once, so this can be read inside a `waitFor` without the
 * second call closing what the first one opened.
 */
function menuItems() {
  if (screen.queryAllByRole("menuitem").length === 0) {
    fireEvent.click(switcher());
  }
  return screen.queryAllByRole("menuitem").map((item) => item.textContent ?? "");
}

beforeEach(() => {
  rows = [{ id: ORG_ID, name: "ui-org-b" }];
  // `authClient` is a module singleton, so its list store survives `cleanup`
  // and would still be holding the previous test's rows. Putting the table
  // back means telling it, the same way the console does.
  authClient.$store.notify("$listOrg");
  list.mockImplementation(() => Promise.resolve(rows.map(membership)));
  update.mockImplementation((id: string, body: { name: string }) => {
    const row = rows.find((each) => each.id === id);
    if (row) row.name = body.name;
    rows = [...rows];
    return Promise.resolve(membership(rows[0]));
  });
  creation.mockResolvedValue({
    allowed: true,
    reason: null,
    code: null,
    licenseHint: false,
    overLimit: null,
    ownedPayingForThemselves: null,
    planHint: null,
  });
  create.mockImplementation((body: { name: string }) => {
    const row = { id: "org_c", name: body.name };
    rows = [...rows, row];
    return Promise.resolve(membership(row));
  });
});

afterEach(() => {
  cleanup();
  list.mockReset();
  update.mockReset();
  create.mockReset();
  creation.mockReset();
});

describe("OrganizationsSection", () => {
  it("moves the masthead switcher to the new name as soon as a rename succeeds", async () => {
    renderBoth();

    await waitFor(() =>
      expect(switcher().getAttribute("aria-label")).toBe(
        "Organization: ui-org-b. Switch Organization",
      ),
    );

    fireEvent.click(await screen.findByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByLabelText(/Name/), {
      target: { value: "ui-org-b-renamed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Rename Organization" }));

    await waitFor(() => expect(update).toHaveBeenCalled());

    // The table is the control: it reads TanStack's copy and was never wrong.
    // The switcher reads better-auth's, and is the half that needed a reload.
    await waitFor(() =>
      expect(screen.getAllByText("ui-org-b-renamed").length).toBeGreaterThan(0),
    );
    await waitFor(() =>
      expect(switcher().getAttribute("aria-label")).toBe(
        "Organization: ui-org-b-renamed. Switch Organization",
      ),
    );
    // Label, visible text and menu entry, because the issue names all three and
    // they come off the one store.
    expect(switcher().textContent).toContain("ui-org-b-renamed");
    expect(menuItems()).toContain("ui-org-b-renamed");
  });

  it("puts a newly created Organization in the switcher's menu without a reload", async () => {
    renderBoth();

    await waitFor(() =>
      expect(switcher().getAttribute("aria-label")).toBe(
        "Organization: ui-org-b. Switch Organization",
      ),
    );

    // Create settles through the same helper the rename does, which is why it was
    // asked to be checked rather than assumed: it was unobserved, and an
    // Organization missing from the menu until a reload is the same defect.
    const newOrganization = screen.getByRole("button", {
      name: "New organization",
    });
    await waitFor(() =>
      expect(newOrganization.getAttribute("aria-disabled")).not.toBe("true"),
    );
    fireEvent.click(newOrganization);
    fireEvent.change(screen.getByLabelText(/Name/), {
      target: { value: "ui-org-c" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create Organization" }));

    await waitFor(() => expect(create).toHaveBeenCalled());
    await waitFor(() => expect(menuItems()).toContain("ui-org-c"));
    // Still where you were: creating one does not switch you into it, so the
    // button keeps naming the Organization the session is actually in.
    expect(switcher().getAttribute("aria-label")).toBe(
      "Organization: ui-org-b. Switch Organization",
    );
  });

  /**
   * The zero-membership case: removed from every Organization while signed
   * in, the card drew its column headers over no rows under "The Organizations
   * you belong to" — which reads as a list that failed to load.
   */
  it("says there is no Organization rather than drawing an empty table", async () => {
    rows = [];
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <OrganizationsSection />
      </QueryClientProvider>,
    );

    expect(
      await screen.findByRole("heading", {
        name: "You are not in any Organization",
      }),
    ).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(
      screen.getByRole("button", { name: "New organization" }),
    ).toBeTruthy();
  });
  /**
   * The one-Organization limit (ADR-0059): refused, "New organization" stays
   * on screen, greyed out, with the route's own sentence on one line.
   */
  describe("New organization on a Self-hosted instance at its limit", () => {
    const STAFF =
      "Without an Enterprise license this instance allows one Organization. Add a license under Settings > License";
    const PLAIN =
      "Without an Enterprise license this instance allows one Organization. The instance's administrators can add a license";

    function renderSection() {
      return render(
        <QueryClientProvider
          client={
            new QueryClient({ defaultOptions: { queries: { retry: false } } })
          }
        >
          <OrganizationsSection />
        </QueryClientProvider>,
      );
    }

    it("is greyed out with the license hint for the Instance organization's owners and admins", async () => {
      creation.mockResolvedValue({
        allowed: false,
        reason: STAFF,
        code: "ORGANIZATION_LIMIT",
        licenseHint: true,
        overLimit: null,
      });
      renderSection();

      expect(
        await screen.findByText(/Add a license under Settings > License\./),
      ).toBeTruthy();
      expect(
        screen
          .getByRole("button", { name: "New organization" })
          .getAttribute("aria-disabled"),
      ).toBe("true");
      expect(
        screen
          .getByRole("link", { name: "Go to License" })
          .getAttribute("href"),
      ).toBe("/settings/license");
    });

    it("is greyed out with the plain reason, and no hint, for everyone else", async () => {
      creation.mockResolvedValue({
        allowed: false,
        reason: PLAIN,
        code: "ORGANIZATION_LIMIT",
        licenseHint: false,
        overLimit: null,
      });
      renderSection();

      expect(
        await screen.findByText(
          /The instance's administrators can add a license\./,
        ),
      ).toBeTruthy();
      expect(
        screen
          .getByRole("button", { name: "New organization" })
          .getAttribute("aria-disabled"),
      ).toBe("true");
      expect(screen.queryByRole("link", { name: "Go to License" })).toBeNull();
    });

    it("says the instance is over the limit, with the count when the backend gives one", async () => {
      creation.mockResolvedValue({
        allowed: false,
        reason: STAFF,
        code: "ORGANIZATION_LIMIT",
        licenseHint: true,
        overLimit: { count: 3 },
      });
      renderSection();

      const note = await screen.findByRole("note");
      expect(note.textContent).toContain(
        "This instance is over the free version's limit of one Organization. Existing ones keep working.",
      );
      expect(note.textContent).toContain("It has 3 Organizations.");
    });

    it("gives no count when the backend gives none", async () => {
      creation.mockResolvedValue({
        allowed: false,
        reason: PLAIN,
        code: "ORGANIZATION_LIMIT",
        licenseHint: false,
        overLimit: { count: null },
      });
      renderSection();

      const note = await screen.findByRole("note");
      expect(note.textContent).not.toMatch(/\d/);
    });

    it("says nothing about a limit when the instance is within it", async () => {
      renderSection();
      await screen.findByText("ui-org-b");
      expect(screen.queryByRole("note")).toBeNull();
    });
  });

  /**
   * The Hosted limit (ADR-0059): a person owns one Organization that pays for
   * itself. The card says how many they own, and a refusal stays on screen
   * with the backend's sentence and, for owners and admins, where to go.
   */
  describe("New organization on the Hosted instance", () => {
    const OWNS =
      "You already own Northwind, and a person can own one Organization that pays for itself";

    function renderSection() {
      return render(
        <QueryClientProvider
          client={
            new QueryClient({ defaultOptions: { queries: { retry: false } } })
          }
        >
          <OrganizationsSection />
        </QueryClientProvider>,
      );
    }

    it("says how many the reader owns that pay for themselves", async () => {
      creation.mockResolvedValue({
        allowed: false,
        reason: `${OWNS}. On Business, Northwind can pay for more Organizations`,
        code: "ORGANIZATION_LIMIT",
        licenseHint: false,
        overLimit: null,
        ownedPayingForThemselves: { count: 1, of: 1 },
        planHint: { kind: "see-plans" },
      });
      renderSection();

      expect(
        await screen.findByText(
          "You own 1 of 1 you can own yourself. Attached ones you own do not count.",
        ),
      ).toBeTruthy();
    });

    it("says it while they own none, too", async () => {
      creation.mockResolvedValue({
        allowed: true,
        reason: null,
        code: null,
        licenseHint: false,
        overLimit: null,
        ownedPayingForThemselves: { count: 0, of: 1 },
        planHint: null,
      });
      renderSection();

      expect(
        await screen.findByText(
          "You own 0 of 1 you can own yourself. Attached ones you own do not count.",
        ),
      ).toBeTruthy();
    });

    it("greys out New organization for a Starter owner, with the reason and See plans", async () => {
      creation.mockResolvedValue({
        allowed: false,
        reason: `${OWNS}. On Business, Northwind can pay for more Organizations`,
        code: "ORGANIZATION_LIMIT",
        licenseHint: false,
        overLimit: null,
        ownedPayingForThemselves: { count: 1, of: 1 },
        planHint: { kind: "see-plans" },
      });
      renderSection();

      expect(
        await screen.findByText(
          /On Business, Northwind can pay for more Organizations\./,
        ),
      ).toBeTruthy();
      expect(
        screen
          .getByRole("button", { name: "New organization" })
          .getAttribute("aria-disabled"),
      ).toBe("true");
      expect(
        screen.getByRole("link", { name: "See plans" }).getAttribute("href"),
      ).toBe("/settings/billing");
    });

    it("points an owner or admin on Business at adding one to its plan", async () => {
      creation.mockResolvedValue({
        allowed: false,
        reason: `${OWNS}. Northwind can pay for more Organizations on its plan`,
        code: "ORGANIZATION_LIMIT",
        licenseHint: false,
        overLimit: null,
        ownedPayingForThemselves: { count: 1, of: 1 },
        planHint: { kind: "add-to-plan", organizationName: "Northwind" },
      });
      renderSection();

      const link = await screen.findByRole("link", {
        name: "Add an Organization to Northwind's plan",
      });
      expect(link.getAttribute("href")).toBe("/settings/billing");
      expect(screen.queryByRole("link", { name: "See plans" })).toBeNull();
    });

    it("gives everyone else the reason with no pointer", async () => {
      creation.mockResolvedValue({
        allowed: false,
        reason: OWNS,
        code: "ORGANIZATION_LIMIT",
        licenseHint: false,
        overLimit: null,
        ownedPayingForThemselves: { count: 1, of: 1 },
        planHint: null,
      });
      renderSection();

      expect(await screen.findByText(`${OWNS}.`)).toBeTruthy();
      expect(screen.queryByRole("link", { name: "See plans" })).toBeNull();
      expect(
        screen.queryByRole("link", { name: /Add an Organization to/ }),
      ).toBeNull();
    });
  });

  it("says nothing about how many they own on a Self-hosted instance", async () => {
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <OrganizationsSection />
      </QueryClientProvider>,
    );
    await screen.findByText("ui-org-b");
    expect(screen.queryByText(/you can own yourself/)).toBeNull();
  });
});
