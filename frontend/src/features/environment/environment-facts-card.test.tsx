import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Environment's rail and its 30-day Token spend, with `fetch` as
 * the boundary: the Environment read and its spend total are real requests
 * through the real API client and hooks.
 */

vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useActiveOrganizationId: () => ({ organizationId: "org-1", pending: false }),
}));

const { EnvironmentFactsCard } = await import("./environment-facts-card");

const figures = (reported: number, estimated: number) => ({
  promptTokens: { reported, estimated },
  completionTokens: { reported: 0, estimated: 0 },
  calls: { ok: 1, runtimeError: 0, clientAborted: 0, refused: 0 },
});

/** The AI models `GET /environments/env-1/token-spend` names. */
const spend = vi.hoisted(() => ({ aiModels: [] as unknown[] }));

function answer(input: RequestInfo | URL): Promise<Response> {
  const path = new URL(String(input), "http://console.test").pathname;
  const json = (body: unknown) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  if (path.endsWith("/environments/env-1/token-spend")) {
    return json({
      from: "2026-09-17",
      to: "2026-10-16",
      total: figures(2048, 0),
      days: [],
      aiModels: spend.aiModels,
    });
  }
  if (path.endsWith("/environments/env-1")) {
    return json({
      environmentId: "env-1",
      projectId: "p-1",
      name: "production",
      description: null,
      env: "",
      createdAt: "2026-09-01T10:00:00.000Z",
      services: [],
    });
  }
  return Promise.resolve(new Response("{}", { status: 404 }));
}

beforeEach(() => {
  spend.aiModels = [];
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
      <EnvironmentFactsCard environmentId="env-1" />
    </QueryClientProvider>,
  );
}

describe("EnvironmentFactsCard, Token spend", () => {
  it("states the 30-day total over the AI models the reader can read", async () => {
    spend.aiModels = [
      { applicationId: "app-1", name: "chat", total: figures(2048, 0) },
    ];
    mount();

    expect(await screen.findByText("2,048 tokens")).toBeTruthy();
    expect(screen.getByText("Token spend, 30 days")).toBeTruthy();
  });

  it("states no Token spend where the reader can read no AI model", async () => {
    mount();

    await screen.findAllByText("production");
    expect(screen.queryByText("Token spend, 30 days")).toBeNull();
  });
});
