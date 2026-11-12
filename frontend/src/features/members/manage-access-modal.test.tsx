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

import type { MemberWithUser } from "@/lib/api/endpoints/organizations";

const patch = vi.fn();
const listByProject = vi.fn();
const findOne = vi.fn();

vi.mock("@/lib/api/endpoints/organizations", () => ({
  organizationsApi: {
    updateMemberEntitlements: (...args: unknown[]) => patch(...args),
  },
}));

vi.mock("@/lib/api/endpoints/environments", () => ({
  environmentsApi: {
    listByProject: (...args: unknown[]) => listByProject(...args),
    findOne: (...args: unknown[]) => findOne(...args),
  },
}));

vi.mock("@/lib/api/endpoints/projects", () => ({
  projectsApi: {
    list: () => Promise.resolve(PROJECTS),
  },
}));

// The real one reaches the whole session stack for the active Organization;
// what these tests are about is the request body.
vi.mock("@/lib/auth/client", () => ({
  useActiveOrganizationId: () => ({ organizationId: "org_1" }),
}));

vi.mock("@/lib/api/use-invalidate", () => ({
  useInvalidate: () => ({ membership: vi.fn(), project: vi.fn() }),
}));

vi.mock("@/components/console/toast", () => ({
  toast: { done: vi.fn(), error: vi.fn() },
}));

const { ManageAccessModal } = await import("./manage-access-modal");

const PROJECTS = [
  { projectId: "p1", name: "Checkout", description: null },
  { projectId: "p2", name: "Billing", description: null },
];

const member = {
  id: "m1",
  role: "member",
  user: { id: "u1", name: "Ada", email: "ada@example.test" },
  accessedProjects: ["p1"],
  accessedEnvironments: ["e1"],
  accessedServices: ["s1"],
} as MemberWithUser;

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function open() {
  render(<ManageAccessModal member={member} open onOpenChange={vi.fn()} />, {
    wrapper: Wrapper,
  });
}

const box = (name: string) => screen.getByRole("checkbox", { name });

/** base-ui's Checkbox is a `span[role=checkbox]`, so the state is the attribute. */
const ticked = (name: string) => box(name).getAttribute("aria-checked") === "true";

beforeEach(() => {
  patch.mockReset().mockResolvedValue({});
  listByProject.mockReset().mockImplementation((projectId: string) =>
    Promise.resolve(
      projectId === "p1"
        ? [
            {
              environmentId: "e1",
              name: "production",
              projectId: "p1",
              description: null,
            },
          ]
        : [],
    ),
  );
  findOne.mockReset().mockResolvedValue({
    environmentId: "e1",
    name: "production",
    projectId: "p1",
    services: [
      {
        serviceType: "application",
        serviceId: "s1",
        name: "web",
        appName: "web-a1b2c3",
        status: "done",
        serverId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  });
});

afterEach(cleanup);

/**
 * The console side of `PATCH /organizations/members/:id/entitlements`.
 *
 * Both assertions about the body are about the route's replace-per-column
 * semantics, which is the one thing a caller can get wrong quietly: a diff, or a
 * partial body, revokes every grant it does not mention rather than failing.
 */
describe("ManageAccessModal", () => {
  it("reads the member's current grants as its defaults", async () => {
    open();

    await waitFor(() => expect(ticked("Checkout")).toBe(true));
    expect(ticked("Billing")).toBe(false);
    await waitFor(() => expect(ticked("production")).toBe(true));
    await waitFor(() => expect(ticked("web web-a1b2c3")).toBe(true));
  });

  it("sends the whole set it read, not the part that changed", async () => {
    open();
    await waitFor(() => expect(ticked("Billing")).toBe(false));

    fireEvent.click(box("Billing"));
    await waitFor(() => expect(ticked("Billing")).toBe(true));

    fireEvent.click(screen.getByRole("button", { name: "Save access" }));

    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    const [memberId, body] = patch.mock.calls[0];
    expect(memberId).toBe("m1");
    // All three keys, every time: an absent key would leave that column alone,
    // and the two untouched columns have to travel or they are revoked.
    expect(Object.keys(body).sort()).toEqual([
      "accessedEnvironments",
      "accessedProjects",
      "accessedServices",
    ]);
    expect([...body.accessedProjects].sort()).toEqual(["p1", "p2"]);
    expect(body.accessedEnvironments).toEqual(["e1"]);
    expect(body.accessedServices).toEqual(["s1"]);
  });

  it("takes an unticked Project's Environments and Services with it", async () => {
    open();
    await waitFor(() => expect(ticked("Checkout")).toBe(true));
    await waitFor(() => expect(ticked("web web-a1b2c3")).toBe(true));

    fireEvent.click(box("Checkout"));

    // The cascade is what stops a Service being granted without the Project and
    // Environment that reach it, so unticking has to clear all three.
    fireEvent.click(screen.getByRole("button", { name: "Save access" }));
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1));
    expect(patch.mock.calls[0][1]).toEqual({
      accessedProjects: [],
      accessedEnvironments: [],
      accessedServices: [],
    });
  });
});
