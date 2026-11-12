import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/api-error";
import { errorMessage } from "@/lib/api/error-message";

/**
 * A member removed from the active Organization while signed in.
 *
 * **Why the whole path runs, and not the gate on its own.** Every piece of this
 * already existed and was correct in isolation — the backend refused, the
 * error had a code, the list endpoint answered without the Organization. The
 * defect was that nothing joined them: the refusal never made the console read
 * the membership list again, so the switcher kept the removed Organization,
 * and nothing that did read the list decided anything from it. So the pieces
 * that do the joining are all real here: `makeQueryClient`'s error hook,
 * better-auth's store over a stubbed `fetch`, `DeadSessionExit` and the
 * switcher. Only the server is a double, and it is a stateful one — the
 * `member` rows and the session's active Organization are variables below, and
 * removing someone is deleting a row from them, exactly as the other session's
 * Remove does.
 */

vi.mock("next/navigation", () => ({
  usePathname: () => "/projects",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

const USER_ID = "user_1";
const A = { id: "org_a", name: "ui-org-a" };
const B = { id: "org_b", name: "ui-org-b" };
const C = { id: "org_c", name: "ui-org-c" };

/** The `member` table for this user, and the session row's active id. */
let memberOf: Array<{ id: string; name: string }> = [];
let activeOrganizationId = A.id;
/** What `/organization/list` answers, when a test needs it to lag the table. */
let listed: (() => Array<{ id: string; name: string }>) | null = null;
/** A refusal for `/organization/set-active`, when a test needs one. */
let refuseSetActive: { status: number; code: string; message: string } | null =
  null;

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const authServer = vi.fn(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes("/organization/list")) {
      return json(listed ? listed() : memberOf);
    }
    // Nest's `GET /organizations`, which the switcher reads: the same table,
    // with nothing attached.
    if (/\/organizations$/.test(url)) {
      return json(memberOf.map((each) => ({ ...each, paidBy: null })));
    }
    if (url.includes("/organization/set-active")) {
      if (refuseSetActive) {
        return new Response(JSON.stringify(refuseSetActive), {
          status: refuseSetActive.status,
          headers: { "content-type": "application/json" },
        });
      }
      const raw =
        input instanceof Request ? await input.clone().text() : init?.body;
      const { organizationId } = JSON.parse(String(raw)) as {
        organizationId: string;
      };
      activeOrganizationId = organizationId;
      return json(memberOf.find((each) => each.id === organizationId));
    }
    return json({
      session: { id: "session_1", activeOrganizationId },
      user: { id: USER_ID, email: "member@example.test" },
    });
  },
);

// jsdom has no `matchMedia`, and sonner's `Toaster` asks it for the colour
// scheme. A browser API is the boundary, so it is stubbed rather than the
// console's own toast — the toast renders for real and is read off the page.
vi.stubGlobal(
  "matchMedia",
  (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList,
);

// Before the auth client is imported: `createAuthClient` captures `fetch` as
// the module evaluates (`organizations-section.test.tsx` says why at length).
vi.stubGlobal("fetch", authServer);

const { authClient } = await import("@/lib/auth/client");
const { makeQueryClient } = await import("@/lib/api/query-client");
const { DeadSessionExit } = await import("./dead-session-exit");
const { OrgSwitcher } = await import("./org-switcher");
const { Toaster } = await import("@/components/console/toast");

/**
 * A screen of the console: one tenant read, refused the way every Cloudgate
 * route refuses a caller with no member row (`PermissionService.findMember`).
 */
function ProjectsProbe() {
  const projects = useQuery({
    queryKey: ["org", activeOrganizationId, "projects"],
    queryFn: () => {
      if (!memberOf.some((each) => each.id === activeOrganizationId)) {
        throw new ApiError(403, "Permission denied", {
          path: "/projects",
          code: "YOU_ARE_NOT_A_MEMBER_OF_THIS_ORGANIZATION",
        });
      }
      return Promise.resolve(["cloudgate"]);
    },
  });
  return (
    <div>
      <p>
        {projects.error ? errorMessage(projects.error) : "Projects are here."}
      </p>
      <button type="button" onClick={() => void projects.refetch()}>
        Projects
      </button>
    </div>
  );
}

function renderConsole() {
  return render(
    <QueryClientProvider client={makeQueryClient()}>
      <Toaster />
      <DeadSessionExit>
        <OrgSwitcher />
        <ProjectsProbe />
      </DeadSessionExit>
    </QueryClientProvider>,
  );
}

const switcher = () =>
  screen.getByRole("button", { name: /Switch Organization$/ });

function menuItems() {
  if (screen.queryAllByRole("menuitem").length === 0) {
    fireEvent.click(switcher());
  }
  return screen
    .queryAllByRole("menuitem")
    .map((item) => item.textContent ?? "");
}

const REMOVED = "You are no longer a member of this Organization";
const ROLE = /Your role in this Organization does not allow this/;

beforeEach(() => {
  memberOf = [A, B];
  activeOrganizationId = A.id;
  listed = null;
  refuseSetActive = null;
  // Module singletons: put both stores back to this test's rows.
  authClient.$store.notify("$sessionSignal");
  authClient.$store.notify("$listOrg");
});

afterEach(() => {
  cleanup();
});

async function signedInToA() {
  renderConsole();
  await waitFor(() =>
    expect(switcher().getAttribute("aria-label")).toBe(
      `Organization: ${A.name}. Switch Organization`,
    ),
  );
  expect(screen.getByText("Projects are here.")).toBeTruthy();
}

describe("NotAMember", () => {
  it("replaces the console with one screen that says so, and offers only what they still belong to", async () => {
    await signedInToA();

    // The other session's Remove.
    memberOf = [B];
    // Back in this one, without reloading: click Projects.
    fireEvent.click(screen.getByRole("button", { name: "Projects" }));

    expect(await screen.findByRole("heading", { name: REMOVED })).toBeTruthy();
    // The frame is gone, and the role sentence with it.
    expect(screen.queryByText(ROLE)).toBeNull();
    expect(
      screen.queryByRole("button", { name: /Switch Organization$/ }),
    ).toBeNull();

    const choices = screen.getByRole("list", {
      name: "Organizations you belong to",
    });
    expect(choices.textContent).toContain(B.name);
    expect(choices.textContent).not.toContain(A.name);
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });

  it("recovers into the Organization they pick, with a switcher that no longer lists the one they left", async () => {
    await signedInToA();
    memberOf = [B];
    fireEvent.click(screen.getByRole("button", { name: "Projects" }));
    await screen.findByRole("heading", { name: REMOVED });

    fireEvent.click(screen.getByRole("button", { name: B.name }));

    await waitFor(() =>
      expect(switcher().getAttribute("aria-label")).toBe(
        `Organization: ${B.name}. Switch Organization`,
      ),
    );
    expect(activeOrganizationId).toBe(B.id);
    expect(screen.queryByRole("heading", { name: REMOVED })).toBeNull();
    await waitFor(() =>
      expect(screen.getByText("Projects are here.")).toBeTruthy(),
    );
    expect(menuItems()).toEqual([
      B.name,
      "New organization",
      "Organization settings",
    ]);
  });

  it("still offers a way out when there is no Organization left to switch to", async () => {
    await signedInToA();
    memberOf = [];
    fireEvent.click(screen.getByRole("button", { name: "Projects" }));

    expect(
      await screen.findByRole("heading", {
        name: "You are no longer in any Organization",
      }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
    expect(screen.queryByRole("list")).toBeNull();
    expect(screen.queryByText(ROLE)).toBeNull();
  });

  /**
   * Found by the live check: the dev backend refused the switch with 403
   * `INVALID_ORIGIN`, and this screen did nothing — better-auth's client
   * resolves to `{ data, error }` rather than throwing, so the `catch` around
   * the switch never ran. This screen is the whole console for them, so the
   * refusal has to be said here, and the screen has to stay.
   */
  it("says why a refused switch failed, and stays", async () => {
    await signedInToA();
    memberOf = [B];
    fireEvent.click(screen.getByRole("button", { name: "Projects" }));
    await screen.findByRole("heading", { name: REMOVED });

    refuseSetActive = {
      status: 403,
      code: "INVALID_ORIGIN",
      message: "Invalid origin",
    };
    fireEvent.click(screen.getByRole("button", { name: B.name }));

    const said = errorMessage(
      new ApiError(403, "Invalid origin", { code: "INVALID_ORIGIN" }),
    );
    // Inline, because this screen is the whole console for them — and in the
    // toast, as every other refused switch is.
    expect((await screen.findByRole("alert")).textContent).toBe(said);
    await waitFor(() =>
      expect(screen.getAllByText(said).length).toBeGreaterThanOrEqual(2),
    );
    expect(screen.getByRole("heading", { name: REMOVED })).toBeTruthy();
    expect(activeOrganizationId).toBe(A.id);
  });

  /**
   * The control, and the reason the verdict waits for a second read. better-auth
   * does not refetch its list after an invitation is accepted, so the session
   * can name an Organization the list has not caught up with. That reader has
   * just *joined*, and telling them they were removed is the worst available
   * sentence.
   */
  it("does not call a list that is behind a removal", async () => {
    await signedInToA();

    // They joined C in another tab; this tab's list store is still the old one,
    // and the session has moved.
    memberOf = [A, B, C];
    activeOrganizationId = C.id;
    authClient.$store.notify("$sessionSignal");

    await waitFor(() =>
      expect(switcher().getAttribute("aria-label")).toBe(
        `Organization: ${C.name}. Switch Organization`,
      ),
    );
    expect(screen.queryByRole("heading", { name: REMOVED })).toBeNull();
  });
});
