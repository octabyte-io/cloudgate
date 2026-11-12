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
  PreviewDeployment,
  RequestedPreview,
} from "@/lib/api/endpoints/preview-deployments";

import type {
  usePreviewDeployments,
  usePreviewMutations,
} from "../advanced/use-advanced";

/** The role's statements: everything held unless a test refuses it. */
const refused = vi.hoisted(() => ({ current: new Set<string>() }));
vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission: (required: Record<string, string[]>) => ({
    allowed: Object.entries(required).every(([resource, actions]) =>
      actions.every((action) => !refused.current.has(`${resource}:${action}`)),
    ),
    pending: false,
    role: "member",
  }),
}));

vi.mock("@/lib/api/use-web-server-settings", () => ({
  useWebServerSettings: () => ({
    data: { requestedPreviewMaxTtlMinutes: 120 },
  }),
}));

vi.mock("@/components/console/toast", () => ({
  toast: { done: vi.fn(), error: vi.fn() },
}));

const { RequestedPreviewsCard } = await import("./requested-previews-card");
const { PreviewListCard } = await import("./previews-list-card");

afterEach(cleanup);
beforeEach(() => {
  refused.current = new Set();
});

const MINUTE = 60_000;
const inMinutes = (minutes: number) =>
  new Date(Date.now() + minutes * MINUTE).toISOString();

const requested = (
  overrides: Partial<RequestedPreview> = {},
): RequestedPreview => ({
  previewDeploymentId: "req-1",
  trigger: "requested",
  branch: "agent/fix-login",
  appName: "preview-web-app-req1",
  domain: "preview-web-app-req1.preview.example.com",
  url: "https://preview-web-app-req1.preview.example.com",
  previewStatus: "done",
  createdAt: new Date(Date.now() - 5 * MINUTE).toISOString(),
  applicationId: "app-1",
  pullRequestId: null,
  pullRequestNumber: null,
  pullRequestTitle: null,
  pullRequestURL: null,
  requesterId: "agent-1",
  requestedBy: { id: "agent-1", name: "deploy-bot", standing: "member" },
  expiresAt: inMinutes(45),
  expiredAt: null,
  expiryCause: null,
  latestDeploymentId: "dep-123456789",
  ...overrides,
});

const pullRequest = {
  previewDeploymentId: "pr-1",
  trigger: "pullRequest",
  branch: "feature/from-a-pr",
  appName: "preview-web-app-pr1",
  domain: "preview-web-app-pr1.preview.example.com",
  url: "https://preview-web-app-pr1.preview.example.com",
  previewStatus: "done",
  createdAt: new Date().toISOString(),
  applicationId: "app-1",
  pullRequestId: "1",
  pullRequestNumber: "7",
  pullRequestTitle: "A pull request",
  pullRequestURL: "https://github.com/o/r/pull/7",
  requesterId: null,
  requestedBy: null,
  expiresAt: null,
  expiredAt: null,
  expiryCause: null,
  latestDeploymentId: null,
} as PreviewDeployment;

const listed = (rows: PreviewDeployment[]) =>
  ({
    data: rows,
    isPending: false,
    error: null,
  }) as unknown as ReturnType<typeof usePreviewDeployments>;

function mutationsWith(
  overrides: Partial<Record<"redeploy" | "remove" | "extend", unknown>> = {},
) {
  return {
    redeploy: { isPending: false, mutateAsync: vi.fn(async () => undefined) },
    remove: { isPending: false, mutateAsync: vi.fn(async () => undefined) },
    extend: { isPending: false, mutateAsync: vi.fn(async () => undefined) },
    ...overrides,
  } as unknown as ReturnType<typeof usePreviewMutations>;
}

function card(
  rows: PreviewDeployment[],
  {
    allowed = true,
    limit = 3,
    mutations = mutationsWith(),
  }: {
    allowed?: boolean;
    limit?: number;
    mutations?: ReturnType<typeof usePreviewMutations>;
  } = {},
) {
  render(
    <RequestedPreviewsCard
      applicationId="app-1"
      previews={listed(rows)}
      mutations={mutations}
      allowed={allowed}
      limit={limit}
    />,
  );
  return document.body.textContent ?? "";
}

const button = (name: string) => screen.getByRole("button", { name });
const off = (element: HTMLElement) =>
  element.getAttribute("aria-disabled") === "true";

describe("RequestedPreviewsCard", () => {
  it("lists requested previews only, under its own title", () => {
    const text = card([requested(), pullRequest]);

    expect(screen.getByRole("heading", { name: "Requested previews" })).toBeTruthy();
    expect(text).toContain("agent/fix-login");
    expect(text).not.toContain("feature/from-a-pr");
  });

  it("shows the row's columns in order, the host linked at the printed url", () => {
    card([
      requested({
        url: "http://preview-web-app-req1.preview.example.com",
        urlNote: "No certificate covers *.preview.example.com.",
      }),
    ]);
    const heads = screen
      .getAllByRole("columnheader")
      .map((head) => head.textContent?.trim())
      .filter(Boolean);
    expect(heads).toEqual([
      "Branch",
      "Host",
      "Status",
      "Requested by",
      "Expires",
      "Latest build",
      "Created",
      "Actions",
    ]);

    const host = screen.getByRole("link", {
      name: "preview-web-app-req1.preview.example.com",
    });
    expect(host.getAttribute("href")).toBe(
      "http://preview-web-app-req1.preview.example.com",
    );
    expect(host.getAttribute("title")).toBe(
      "No certificate covers *.preview.example.com.",
    );

    const build = screen.getByRole("link", { name: /dep-1234/ });
    expect(build.getAttribute("href")).toBe("/applications/app-1/deployments");
  });

  it("names the requester from the audit row, and tags a removed or suspended one", () => {
    const text = card([
      requested({
        requesterId: null,
        requestedBy: { id: "gone", name: "Ida Rhodes", standing: "removed" },
      }),
      requested({
        previewDeploymentId: "req-2",
        requestedBy: { id: "b", name: "night-bot", standing: "suspended" },
      }),
    ]);

    expect(text).toContain("Ida Rhodes");
    expect(text).toContain("removed");
    expect(text).toContain("night-bot");
    expect(text).toContain("suspended");
  });

  it("warns inside the last ten minutes, with the exact time on hover", () => {
    card([
      requested({ previewDeploymentId: "soon", branch: "soon", expiresAt: inMinutes(8) }),
      requested({ previewDeploymentId: "later", branch: "later", expiresAt: inMinutes(40) }),
    ]);
    const expiryIn = (branch: string) => {
      const row = screen.getByText(branch).closest("tr");
      const time = row?.querySelector("time[data-expiry]");
      if (!time) throw new Error(`no expiry on ${branch}`);
      return time;
    };
    const soon = expiryIn("soon");
    const later = expiryIn("later");
    expect(soon.getAttribute("data-soon")).toBe("true");
    expect(later.getAttribute("data-soon")).toBe("false");
    expect(soon.getAttribute("title")).toBeTruthy();
    expect(soon.textContent).toContain("in 8 minutes");
  });

  it("reads an expired row as expired, teardown pending, with no controls", () => {
    card([
      requested({
        expiresAt: inMinutes(-1),
        expiredAt: inMinutes(-1),
        expiryCause: "expiry",
      }),
    ]);

    expect(document.body.textContent).toContain("expired, teardown pending");
    expect(screen.queryByRole("button", { name: "Extend" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Redeploy" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Expire now" })).toBeNull();
  });

  it("turns Expire now off with its refusal for a viewer without deployment cancel", () => {
    refused.current = new Set(["deployment:cancel"]);
    card([requested()]);

    const expire = button("Expire now");
    expect(off(expire)).toBe(true);
    expect(expire.getAttribute("title")).toMatch(/cannot expire a preview/);
    expect(off(button("Extend"))).toBe(false);
    expect(off(button("Redeploy"))).toBe(false);
  });

  it("turns Extend and Redeploy off with their refusal for a viewer without deployment create", () => {
    refused.current = new Set(["deployment:create"]);
    card([requested()]);

    expect(off(button("Extend"))).toBe(true);
    expect(button("Extend").getAttribute("title")).toMatch(/Your role/);
    expect(off(button("Redeploy"))).toBe(true);
    expect(off(button("Expire now"))).toBe(false);
  });

  it("flips a row to expired, teardown pending on Delete's answer, without waiting on a refetch", async () => {
    const now = new Date().toISOString();
    const remove = {
      isPending: false,
      mutateAsync: vi.fn(async () => ({
        ...requested(),
        expiresAt: now,
        expiredAt: now,
        expiryCause: "delete",
      })),
    };
    // The list stays as it was: the flip is the answer's, not a re-read's.
    card([requested()], { mutations: mutationsWith({ remove }) });

    fireEvent.click(button("Expire now"));

    await waitFor(() =>
      expect(document.body.textContent).toContain("expired, teardown pending"),
    );
    expect(remove.mutateAsync).toHaveBeenCalledWith("req-1");
    expect(screen.queryByRole("button", { name: "Expire now" })).toBeNull();
  });

  it("with the switch off, keeps Expire now and turns Extend and Redeploy off with the switch's reason", () => {
    const text = card([requested()], { allowed: false });

    expect(text).toContain(
      "Requested previews are off. These run until they expire; delete one to stop it now.",
    );
    for (const name of ["Extend", "Redeploy"]) {
      expect(off(button(name))).toBe(true);
      expect(button(name).getAttribute("title")).toBe(
        "Requested previews are not allowed on this Application.",
      );
    }
    expect(off(button("Expire now"))).toBe(false);
  });

  it("says every slot is taken against its own limit, counting expired rows until they go", () => {
    const expired = requested({
      previewDeploymentId: "req-2",
      expiredAt: inMinutes(-1),
      expiryCause: "expiry",
    });
    expect(card([requested(), expired, pullRequest], { limit: 2 })).toContain(
      "Every slot is taken.",
    );
    cleanup();
    expect(card([requested(), pullRequest], { limit: 2 })).not.toContain(
      "Every slot is taken.",
    );
  });

  it("opens the extend modal at the instance maximum and sends the window", async () => {
    const extend = { isPending: false, mutateAsync: vi.fn(async () => ({})) };
    card([requested()], { mutations: mutationsWith({ extend }) });

    fireEvent.click(button("Extend"));
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("120 minutes (2 hours)");
    fireEvent.click(within(dialog).getByRole("button", { name: "Set the new expiry" }));

    await waitFor(() =>
      expect(extend.mutateAsync).toHaveBeenCalledWith({
        id: "req-1",
        ttlMinutes: 60,
      }),
    );
  });

  it("says why it is empty, by the switch", () => {
    expect(card([pullRequest])).toContain("No requested preview is running");
    cleanup();
    expect(card([pullRequest], { allowed: false })).toContain(
      "Requested previews are off for this Application",
    );
  });
});

describe("PreviewListCard", () => {
  it("is the Pull-request previews card, and lists no requested preview", () => {
    render(
      <PreviewListCard
        previews={listed([requested(), pullRequest])}
        mutations={mutationsWith()}
        active
        limit={3}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Pull-request previews" }),
    ).toBeTruthy();
    expect(document.body.textContent).not.toContain("agent/fix-login");
  });

  it("turns Redeploy and Tear down off with their refusals", () => {
    refused.current = new Set(["deployment:create", "deployment:cancel"]);
    render(
      <PreviewListCard
        previews={listed([pullRequest])}
        mutations={mutationsWith()}
        active
        limit={3}
      />,
    );

    for (const name of ["Redeploy", "Tear down"]) {
      expect(off(button(name))).toBe(true);
      expect(button(name).getAttribute("title")).toMatch(/Your role/);
    }
  });
});
