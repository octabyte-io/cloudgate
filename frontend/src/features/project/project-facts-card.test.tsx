import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Project's rail and its 30-day Token spend, with `fetch` as the
 * boundary: the Project read and its spend total are real requests through the
 * real API client and hooks.
 */

vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useActiveOrganizationId: () => ({ organizationId: "org-1", pending: false }),
}));

const { ProjectFactsCard } = await import("./project-facts-card");

const figures = (reported: number, estimated: number) => ({
  promptTokens: { reported, estimated },
  completionTokens: { reported: 0, estimated: 0 },
  calls: { ok: 1, runtimeError: 0, clientAborted: 0, refused: 0 },
});

/** The Environments `GET /projects/p-1/token-spend` names. */
const spend = vi.hoisted(() => ({ environments: [] as unknown[] }));

function answer(input: RequestInfo | URL): Promise<Response> {
  const path = new URL(String(input), "http://console.test").pathname;
  const json = (body: unknown) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  if (path.endsWith("/projects/p-1/token-spend")) {
    return json({
      from: "2026-09-17",
      to: "2026-10-16",
      total: figures(1500, 20),
      days: [],
      environments: spend.environments,
    });
  }
  if (path.endsWith("/projects/p-1")) {
    return json({
      projectId: "p-1",
      name: "support",
      description: null,
      env: "",
      createdAt: "2026-09-01T10:00:00.000Z",
    });
  }
  return Promise.resolve(new Response("{}", { status: 404 }));
}

beforeEach(() => {
  spend.environments = [];
  vi.stubGlobal("fetch", vi.fn(answer));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ProjectFactsCard projectId="p-1" environmentCount={3} />
    </QueryClientProvider>,
  );
}

describe("ProjectFactsCard, Token spend", () => {
  it("states the 30-day total, then each Environment holding an AI model", async () => {
    spend.environments = [
      {
        environmentId: "env-1",
        name: "production",
        aiModelCount: 2,
        total: figures(1400, 20),
      },
      {
        environmentId: "env-2",
        name: "staging",
        aiModelCount: 1,
        total: figures(100, 0),
      },
      {
        environmentId: "env-3",
        name: "preview",
        aiModelCount: 0,
        total: figures(0, 0),
      },
    ];
    mount();

    const total = await screen.findByText("1,520 tokens");
    expect(total.closest("dd")?.getAttribute("title")).toBe(
      "1,500 reported by the inference runtime, 20 estimated by the Gateway",
    );
    expect(screen.getByText("Token spend, 30 days")).toBeTruthy();
    expect(screen.getByText("production")).toBeTruthy();
    expect(screen.getByText("1,420 tokens")).toBeTruthy();
    expect(screen.getByText("staging")).toBeTruthy();
    expect(screen.getByText("100 tokens")).toBeTruthy();
    expect(screen.queryByText("preview")).toBeNull();
  });

  it("states no Token spend when no Environment the reader sees holds an AI model", async () => {
    spend.environments = [
      {
        environmentId: "env-1",
        name: "production",
        aiModelCount: 0,
        total: figures(0, 0),
      },
    ];
    mount();

    await screen.findByText("support");
    expect(screen.queryByText("Token spend, 30 days")).toBeNull();
  });
});
