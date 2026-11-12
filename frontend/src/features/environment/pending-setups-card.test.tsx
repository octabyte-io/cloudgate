import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  PendingSetup,
  PendingSetupList,
} from "@/lib/api/endpoints/pending-setups";

/**
 * The Environment's Pending setups card, with `fetch` as the boundary: the
 * list and the cancel are real requests through the real API client and
 * hooks, so what is asserted is what the browser would send and show.
 */

vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useActiveOrganizationId: () => ({ organizationId: "org-1", pending: false }),
}));
const canUpdate = vi.hoisted(() => ({ allowed: true }));
vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission: () => ({
    allowed: canUpdate.allowed,
    pending: false,
    role: canUpdate.allowed ? "owner" : "member",
  }),
}));

const { PendingSetupsCard } = await import("./pending-setups-card");

const GHOST: PendingSetup = {
  pendingSetupId: "ps-1",
  environmentId: "env-1",
  templateId: "ghost",
  templateName: "Ghost",
  revision: "abc1234",
  setupName: "blog",
  configNames: ["blog-app", "blog-db"],
  createdAt: "2026-11-01T10:00:00.000Z",
  expiresAt: "2026-12-01T10:00:00.000Z",
  autoApply: null,
  values: [
    {
      configName: "blog-app",
      variable: "ADMIN_EMAIL",
      made: "asked",
      hasValue: true,
    },
    {
      configName: "blog-app",
      variable: "SESSION_SECRET",
      made: "generated (base64, 32 bytes)",
      hasValue: true,
    },
  ],
};

const listed = vi.hoisted(() => ({
  body: { pendingSetups: [], expired: [] } as PendingSetupList,
}));
const fetchSpy = vi.fn();

function answer(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const path = new URL(String(input), "http://console.test").pathname;
  const json = (body: unknown) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  if (
    path.endsWith("/environments/env-1/pending-setups/ps-1") &&
    init?.method === "DELETE"
  ) {
    const [cancelled] = listed.body.pendingSetups;
    listed.body = { ...listed.body, pendingSetups: [] };
    return json({ pendingSetup: cancelled, plan: null });
  }
  if (path.endsWith("/environments/env-1/pending-setups")) {
    return json(listed.body);
  }
  return Promise.resolve(new Response("{}", { status: 404 }));
}

beforeEach(() => {
  canUpdate.allowed = true;
  listed.body = { pendingSetups: [GHOST], expired: [] };
  fetchSpy.mockReset().mockImplementation(answer);
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <PendingSetupsCard environmentId="env-1" projectId="p-1" />
    </QueryClientProvider>,
  );
}

describe("PendingSetupsCard", () => {
  it("lists each Pending setup with its parts and a count of its values, never a value", async () => {
    mount();

    const table = await screen.findByRole("table", { name: "Pending setups" });
    const row = within(table).getByText("blog").closest("tr");
    expect(row).not.toBeNull();
    expect(within(row!).getByText(/Ghost template/)).toBeTruthy();
    expect(within(row!).getByText("blog-app, blog-db")).toBeTruthy();
    expect(
      within(row!).getByText("2 values, kept encrypted until Apply"),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "review the plan" })
        .getAttribute("href"),
    ).toBe("/projects/p-1/config#plan-env-1");
  });

  it("cancels a setup after asking, and lists it no longer", async () => {
    mount();

    fireEvent.click(
      await screen.findByRole("button", { name: "Cancel setup" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Cancel the blog setup?")).toBeTruthy();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Cancel setup" }),
    );

    await waitFor(() =>
      expect(
        fetchSpy.mock.calls.some(
          ([input, init]) =>
            String(input).endsWith("/environments/env-1/pending-setups/ps-1") &&
            (init as RequestInit | undefined)?.method === "DELETE",
        ),
      ).toBe(true),
    );
    // Nothing left to say, so the card goes.
    await waitFor(() =>
      expect(
        screen.queryByRole("table", { name: "Pending setups" }),
      ).toBeNull(),
    );
  });

  it("turns Cancel off with the reason for a role without environment: update", async () => {
    canUpdate.allowed = false;
    mount();

    const button = await screen.findByRole("button", { name: "Cancel setup" });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("title")).toMatch(/cancel a Pending setup/);
    fireEvent.click(button);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says when the sweep dropped a setup left unused for 30 days", async () => {
    listed.body = {
      pendingSetups: [],
      expired: [
        {
          expiredSetupId: "ex-1",
          templateId: "ghost",
          templateName: "Ghost",
          setupName: "docs",
          configNames: ["docs-app", "docs-db"],
          setUpAt: "2026-10-01T10:00:00.000Z",
          expiredAt: "2026-10-31T10:00:00.000Z",
        },
      ],
    };
    mount();

    const note = await screen.findByText(/30 days after it was set up/);
    expect(note.textContent).toContain("docs");
    expect(note.textContent).toContain("Ghost template");
    expect(note.textContent).toContain("docs-app, docs-db");
    expect(screen.queryByRole("table", { name: "Pending setups" })).toBeNull();
  });

  it("renders nothing for an Environment with no Pending setup and no note", async () => {
    listed.body = { pendingSetups: [], expired: [] };
    const { container } = mount();

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    await waitFor(() => expect(container.textContent).toBe(""));
  });
});
