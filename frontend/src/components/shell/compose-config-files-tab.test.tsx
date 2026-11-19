import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ComposeDetail } from "@/lib/api/endpoints/compose";
import type { Mount } from "@/lib/api/endpoints/mounts";
import type { RequiredPermissions } from "@/lib/auth/use-permission";

/**
 * A Compose stack's **Config files** tab (spec #134): there, after Shell,
 * for a stack with at least one `file` mount, and absent for one with none or
 * for a role that cannot read volumes. Rendered through the real provider;
 * only the network, the router, the session and the role are stood in for.
 */

const api = vi.hoisted(() => ({ compose: vi.fn(), mounts: vi.fn() }));
const refused = vi.hoisted(() => ({ statements: [] as string[] }));

vi.mock("next/navigation", async (original) => ({
  ...(await original<typeof import("next/navigation")>()),
  usePathname: () => "/compose/cmp-1",
}));

vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useSession: () => ({
    data: { user: { id: "owner" }, session: { activeOrganizationId: "org" } },
    isPending: false,
  }),
  useActiveOrganizationId: () => ({ organizationId: "org", pending: false }),
}));

vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission: (required: RequiredPermissions) => ({
    allowed: !Object.entries(required).some(([resource, actions]) =>
      actions.some((action) => refused.statements.includes(`${resource}:${action}`)),
    ),
    pending: false,
  }),
}));

vi.mock("@/lib/api/endpoints/compose", async (original) => ({
  ...(await original<typeof import("@/lib/api/endpoints/compose")>()),
  composeApi: { findOne: api.compose },
}));
vi.mock("@/lib/api/endpoints/mounts", async (original) => ({
  ...(await original<typeof import("@/lib/api/endpoints/mounts")>()),
  mountsApi: { listByService: api.mounts },
}));

vi.mock("@/features/operator/use-operator", () => ({
  useIsOperator: () => ({ hosted: false, operator: false, pending: false }),
}));

const { ScopeProvider, useScope } = await import("./scope-provider");

const STACK = {
  composeId: "cmp-1",
  name: "grafana",
  composeType: "docker-compose",
  composeStatus: "done",
  environment: {
    environmentId: "env-1",
    name: "production",
    project: { projectId: "prj-1", name: "ui-main" },
  },
} as unknown as ComposeDetail;

const GRAFANA_INI = {
  mountId: "mnt-1",
  type: "file",
  filePath: "grafana.ini",
  content: "[server]\nhttp_port = 3000\n",
  serviceType: "compose",
  composeId: "cmp-1",
} as unknown as Mount;

/** The rail's tab labels, read once the stack and its mounts are in. */
function railLabels(): () => string[] {
  const seen: { labels: string[] } = { labels: [] };
  function Probe() {
    const { nav } = useScope();
    seen.labels = nav.flatMap((entry) =>
      entry.kind === "item" ? [entry.label] : [],
    );
    return null;
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ScopeProvider>
        <Probe />
      </ScopeProvider>
    </QueryClientProvider>,
  );
  return () => seen.labels;
}

beforeEach(() => {
  api.compose.mockResolvedValue(STACK);
  refused.statements = [];
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  for (const title of document.querySelectorAll("title")) title.remove();
});

describe("a Compose stack's Config files tab", () => {
  it("is in the rail after Shell for a stack with a file mount", async () => {
    api.mounts.mockResolvedValue([GRAFANA_INI]);
    const labels = railLabels();

    await waitFor(() => expect(labels()).toContain("Config files"));
    const tabs = labels();
    expect(tabs.indexOf("Config files")).toBe(tabs.indexOf("Shell") + 1);
    expect(api.mounts).toHaveBeenCalledWith("cmp-1", "compose");
  });

  it("is absent for a stack with no file mount", async () => {
    api.mounts.mockResolvedValue([]);
    const labels = railLabels();

    await waitFor(() => expect(api.mounts).toHaveBeenCalled());
    await waitFor(() => expect(labels()).toContain("Shell"));
    expect(labels()).not.toContain("Config files");
  });

  it("is absent for a role that cannot read volumes, and their mounts are not asked for", async () => {
    refused.statements = ["volume:read"];
    api.mounts.mockResolvedValue([GRAFANA_INI]);
    const labels = railLabels();

    await waitFor(() => expect(labels()).toContain("Shell"));
    expect(labels()).not.toContain("Config files");
    expect(api.mounts).not.toHaveBeenCalled();
  });
});
