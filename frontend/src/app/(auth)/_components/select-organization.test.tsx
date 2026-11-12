import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getSession = vi.hoisted(() => vi.fn());
const list = vi.hoisted(() => vi.fn());
const setActive = vi.hoisted(() => vi.fn());

vi.mock("@/lib/auth/client", () => ({
  getSession,
  organization: { list, setActive },
}));

const search = vi.hoisted(() => ({ params: new URLSearchParams() }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => search.params,
}));

// Unbranded unless a test says otherwise.
const branding = vi.hoisted(() => ({ appName: null as string | null }));
vi.mock("@/lib/api/use-branding", () => ({
  useBrandingOrDefault: () => ({ appName: branding.appName }),
}));

vi.mock("@/lib/auth/use-sign-out", () => ({
  useSignOut: () => ({ signOutNow: vi.fn(), pending: false }),
}));

const { SelectOrganization } = await import("./select-organization");

beforeEach(() => {
  // A session that has not been put in an Organization — the one sign-in sends
  // here. A test about an already-settled session says so.
  getSession.mockResolvedValue({
    data: { session: { activeOrganizationId: null } },
    error: null,
  });
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  search.params = new URLSearchParams();
  branding.appName = null;
  document.title = "";
});

function renderScreen() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <SelectOrganization />
    </QueryClientProvider>,
  );
}

/**
 * A row marked `aria-disabled` while a choice is in flight does not send a
 * second one — the aria-disabled census, the one site of it outside a `Button`.
 * `MenuRow` is a native `<button>`, which Base UI does not wrap, so nothing
 * swallows its click on its behalf: the handler has to refuse.
 */
describe("SelectOrganization", () => {
  it("sends one choice, however many rows are pressed while it is in flight", async () => {
    list.mockResolvedValue({
      data: [
        { id: "org_a", name: "Alpha" },
        { id: "org_b", name: "Beta" },
      ],
      error: null,
    });
    // Never settles, so the first choice stays in flight for the whole test.
    setActive.mockReturnValue(new Promise(() => {}));

    renderScreen();

    fireEvent.click(await screen.findByRole("button", { name: "Alpha" }));
    const beta = screen.getByRole("button", { name: "Beta" });
    await vi.waitFor(() =>
      expect(beta.getAttribute("aria-disabled")).toBe("true"),
    );
    fireEvent.click(beta);
    // A mutation that was let through reaches `setActive` a tick later.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(setActive).toHaveBeenCalledOnce();
    expect(setActive).toHaveBeenCalledWith({ organizationId: "org_a" });
  });
});

/**
 * **The tab says what the heading says** (U13 AUTH-16).
 *
 * The route's title is "Choose an Organization", which is right for the
 * question this screen usually asks — and was the tab's title over "No
 * organization yet" too, the state sign-in *does* send people to.
 */
describe("SelectOrganization, for an account in no Organization", () => {
  beforeEach(() => {
    list.mockResolvedValue({ data: [], error: null });
  });

  it("titles the document after its heading", async () => {
    renderScreen();

    expect(
      await screen.findByRole("heading", {
        level: 1,
        name: "No organization yet",
      }),
    ).toBeTruthy();
    expect(document.title).toBe("No organization yet · Cloudgate");
  });

  it("names a white-labelled instance in that title", async () => {
    branding.appName = "Acme Deploy";
    renderScreen();

    await screen.findByRole("heading", { level: 1, name: "No organization yet" });
    expect(document.title).toBe("No organization yet · Acme Deploy");
  });
});

/**
 * **A settled session is not asked**. The SSO callback arrives here
 * whatever the session needs, because it never passes through a form that could
 * decide — so a session that already has an Organization goes straight on.
 */
describe("SelectOrganization, for a session already in an Organization", () => {
  it("forwards to where they were headed without offering a choice", async () => {
    search.params = new URLSearchParams({ next: "/projects/p_1" });
    getSession.mockResolvedValue({
      data: { session: { activeOrganizationId: "org_a" } },
      error: null,
    });
    const replace = vi.fn();
    const location = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { replace, href: "http://localhost/select-organization" },
    });
    try {
      renderScreen();

      await vi.waitFor(() =>
        expect(replace).toHaveBeenCalledWith("/projects/p_1"),
      );
      expect(list).not.toHaveBeenCalled();
      expect(screen.queryByRole("button")).toBeNull();
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: location,
      });
    }
  });
});
