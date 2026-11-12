import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/api-error";
import type { ApplicationDetail } from "@/lib/api/endpoints/applications";
import type { Environment } from "@/lib/api/endpoints/environments";
import type { Project } from "@/lib/api/endpoints/projects";

/**
 * The resource scope, rendered through the real provider and the real masthead
 * identity — only the network, the router and the session are stood in for.
 * These are the three things a resolved scope feeds besides the rail: the
 * breadcrumb, the document title and Recents.
 */

const pathname = vi.hoisted(() => ({ current: "/" }));
// A user per test where Recents is read: the stores are module-level and cache
// what they have read, so a cleared `localStorage` does not empty them.
const who = vi.hoisted(() => ({ userId: "owner" }));
const api = vi.hoisted(() => ({
  project: vi.fn(),
  projects: vi.fn(),
  environment: vi.fn(),
  environments: vi.fn(),
  application: vi.fn(),
}));

vi.mock("next/navigation", async (original) => ({
  ...(await original<typeof import("next/navigation")>()),
  usePathname: () => pathname.current,
}));

vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useSession: () => ({
    data: { user: { id: who.userId }, session: { activeOrganizationId: "org" } },
    isPending: false,
  }),
  useActiveOrganizationId: () => ({ organizationId: "org", pending: false }),
}));

vi.mock("@/lib/api/endpoints/projects", async (original) => ({
  ...(await original<typeof import("@/lib/api/endpoints/projects")>()),
  projectsApi: { findOne: api.project, list: api.projects },
}));
vi.mock("@/lib/api/endpoints/environments", async (original) => ({
  ...(await original<typeof import("@/lib/api/endpoints/environments")>()),
  environmentsApi: {
    findOne: api.environment,
    listByProject: api.environments,
  },
}));
vi.mock("@/lib/api/endpoints/applications", async (original) => ({
  ...(await original<typeof import("@/lib/api/endpoints/applications")>()),
  applicationsApi: { findOne: api.application },
}));

// A Self-hosted reader unless a test says otherwise.
const reader = vi.hoisted(() => ({ hosted: false, operator: false }));
vi.mock("@/features/operator/use-operator", () => ({
  useIsOperator: () => ({ ...reader, pending: false }),
}));

const { ScopeProvider, useScope } = await import("./scope-provider");
const { ScopeIdentity } = await import("./scope-identity");
const { recordRecent, useRecents } = await import("./recents");
const { RailEntry } = await import("./rail-entries");
const { organizationNav } = await import("./nav");

const PROJECT = { projectId: "prj-1", name: "ui-main" } as Project;
const ENVIRONMENT = {
  environmentId: "env-1",
  name: "staging",
  projectId: "prj-1",
} as Environment;
const APPLICATION = {
  applicationId: "app-1",
  name: "whoami",
  applicationStatus: "idle",
  environment: {
    environmentId: "env-1",
    name: "production",
    project: { projectId: "prj-1", name: "ui-main" },
  },
} as unknown as ApplicationDetail;

let test = 0;
function freshOwner() {
  who.userId = `owner-${++test}`;
  return { userId: who.userId, organizationId: "org" };
}

function mount(at: string, beside?: React.ReactNode) {
  pathname.current = at;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ScopeProvider>
        <ScopeIdentity />
        {beside}
      </ScopeProvider>
    </QueryClientProvider>,
  );
}

/**
 * One subscriber, read as often as needed. Not a `renderHook` per read: inside
 * `waitFor` each one mutates the DOM, which re-runs `waitFor`'s callback, which
 * renders another — and the query under test never gets a turn.
 */
function watchRecents() {
  const { result } = renderHook(() => useRecents());
  return () => result.current.map((each) => each.id);
}

beforeEach(() => {
  localStorage.clear();
  api.project.mockResolvedValue(PROJECT);
  api.projects.mockResolvedValue([PROJECT]);
  api.environment.mockResolvedValue(ENVIRONMENT);
  api.environments.mockResolvedValue([ENVIRONMENT]);
  api.application.mockResolvedValue(APPLICATION);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  for (const title of document.querySelectorAll("title")) title.remove();
});

/**
 * `ui-main /
 * staging` reads as a breadcrumb, and the parent was plain text.
 */
describe("ScopeIdentity's parents", () => {
  it("links an Environment's Project to the Project, and leaves its own name as text", async () => {
    mount("/environments/env-1/variables");

    const parent = await screen.findByRole("link", { name: "ui-main" });

    expect(parent.getAttribute("href")).toBe("/projects/prj-1");
    // The current name is where you are, not a way to get there.
    expect(screen.queryByRole("link", { name: "staging" })).toBeNull();
  });

  it("names an Application's Project as well as its Environment, each a link", async () => {
    mount("/applications/app-1");

    const project = await screen.findByRole("link", { name: "ui-main" });

    expect(project.getAttribute("href")).toBe("/projects/prj-1");
    expect(
      screen.getByRole("link", { name: "production" }).getAttribute("href"),
    ).toBe("/environments/env-1");
    expect(project.parentElement?.textContent).toBe(
      "ui-main / production / whoami",
    );
  });
});

/**
 * Every Project's
 * Settings was `Settings · Cloudgate`, and a missing Project was titled after
 * its default tab.
 */
describe("a resource scope's document title", () => {
  it("names the resource and its parents beside the tab", async () => {
    mount("/environments/env-1/variables");

    await waitFor(() =>
      expect(document.title).toBe("Variables · ui-main / staging · Cloudgate"),
    );
  });

  it("titles a Project's tab with the Project", async () => {
    mount("/projects/prj-1/settings");

    await waitFor(() =>
      expect(document.title).toBe("Settings · ui-main · Cloudgate"),
    );
  });

  it("offers no tabs in the rail for a Project that is not there", async () => {
    api.project.mockRejectedValue(new ApiError(404, "Project not found"));
    let seen: { nav: unknown[]; missing: boolean } | null = null;
    function Spy() {
      seen = useScope();
      return null;
    }

    mount("/projects/gone/settings", <Spy />);

    await waitFor(() => expect(seen?.missing).toBe(true));
    expect(seen!.nav).toEqual([]);
  });

  it("titles a Project that is not there as not found, not as its first tab", async () => {
    api.project.mockRejectedValue(new ApiError(404, "Project not found"));

    mount("/projects/gone");

    await waitFor(() => expect(document.title).toBe("Not found · Cloudgate"));
  });

  it("stays the document's title when the route's own title mounts after it", async () => {
    mount("/projects/prj-1/settings");
    await waitFor(() =>
      expect(document.title).toBe("Settings · ui-main · Cloudgate"),
    );

    // What Next's streamed metadata does a commit later: a fresh `<title>`,
    // put first in `<head>` by React, which makes it the document's title.
    const late = document.createElement("title");
    late.textContent = "Settings · Cloudgate";
    document.head.prepend(late);

    await waitFor(() =>
      expect(document.title).toBe("Settings · ui-main · Cloudgate"),
    );
  });
});

/**
 * A Recents row
 * outlived the resource it pointed at.
 */
describe("Recents, from a resource scope", () => {
  const GONE = { id: "gone", label: "ui-scratch", href: "/projects/gone" };
  const LIVE = { id: "prj-2", label: "ui-tags", href: "/projects/prj-2" };
  let OWNER = freshOwner();

  beforeEach(() => {
    OWNER = freshOwner();
  });

  it("records a service with its Project and Environment as ancestors", async () => {
    mount("/applications/app-1");

    await screen.findByRole("link", { name: "ui-main" });

    const [entry] = renderHook(() => useRecents()).result.current;
    expect(entry).toEqual({
      id: "app-1",
      label: "ui-main / production / whoami",
      href: "/applications/app-1",
      ancestors: ["prj-1", "env-1"],
    });
  });

  it("drops the entry of a scope that answers 404", async () => {
    recordRecent(OWNER, LIVE);
    recordRecent(OWNER, GONE);
    api.project.mockRejectedValue(new ApiError(404, "Project not found"));
    const recentIds = watchRecents();

    mount("/projects/gone");

    await waitFor(() => expect(recentIds()).toEqual(["prj-2"]));
  });

  it("keeps the entry of a scope whose read failed for any other reason", async () => {
    recordRecent(OWNER, LIVE);
    recordRecent(OWNER, GONE);
    api.project.mockRejectedValue(new ApiError(503, "Bad gateway"));
    const recentIds = watchRecents();

    mount("/projects/gone");

    await waitFor(() => expect(api.project).toHaveBeenCalled());
    // Settled on the failure, and a 503 says nothing about whether it exists.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(recentIds()).toEqual(["gone", "prj-2"]);
  });
});

/**
 * Requests reads each Server's own access log, so the Organization rail offers
 * it to every reader — on the Hosted instance a customer as well as an
 * Operator.
 */
describe("the Organization rail's Requests", () => {
  afterEach(() => {
    reader.hosted = false;
    reader.operator = false;
  });

  function railLabels(): string[] {
    let seen: ReturnType<typeof useScope> | null = null;
    function Spy() {
      seen = useScope();
      return null;
    }
    mount("/", <Spy />);
    return seen!.nav.flatMap((entry) =>
      entry.kind === "item" || entry.kind === "group" ? [entry.label] : [],
    );
  }

  it("is offered on a Self-hosted instance", () => {
    expect(railLabels()).toContain("Requests");
  });

  it("is offered to a customer on the Hosted instance", () => {
    reader.hosted = true;
    expect(railLabels()).toContain("Requests");
  });

  it("is offered to an Operator on the Hosted instance", () => {
    reader.hosted = true;
    reader.operator = true;
    expect(railLabels()).toContain("Requests");
  });
});

/**
 * The masthead's
 * star was write-only — it lit up on its own header and was shown nowhere else.
 * The Organization rail's Starred group is its reader, rendered here from the
 * real nav table beside the real toggle.
 */
describe("Starred, from a resource scope", () => {
  const STARRED = organizationNav().find(
    (entry) => entry.kind === "group" && entry.id === "starred",
  );

  beforeEach(() => {
    freshOwner();
  });

  it("lists a starred Environment by its path, and drops it when unstarred", async () => {
    mount(
      "/environments/env-1",
      <RailEntry entry={STARRED!} onNavigate={() => {}} />,
    );
    await screen.findByRole("link", { name: "ui-main" });
    fireEvent.click(screen.getByRole("button", { name: "Starred" }));
    expect(screen.getByText("Nothing starred yet.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Star staging" }));

    const row = screen.getByRole("link", { name: "ui-main / staging" });
    expect(row.getAttribute("href")).toBe("/environments/env-1");

    fireEvent.click(screen.getByRole("button", { name: "Unstar staging" }));

    // Gone at once, from the same store the toggle wrote — no reload.
    expect(screen.queryByRole("link", { name: "ui-main / staging" })).toBeNull();
    expect(screen.getByText("Nothing starred yet.")).toBeTruthy();
  });
});
