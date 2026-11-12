import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Deploy refused because its Server is in **Maintenance** (spec #1420), with
 * the network as the one boundary: `fetch` answers the session read and the
 * deploy route, which refuses as `AllExceptionsFilter` writes it, and the
 * app's own `Toaster` shows whatever the button raised. Nothing of ours is
 * mocked.
 */

// jsdom has no `matchMedia`, and sonner's `Toaster` asks it for the colour
// scheme. A browser API, so it is the thing stubbed.
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

const APPLICATION_ID = "app-1";

function answer(input: RequestInfo | URL): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  const path = new URL(url, "http://console.test").pathname;
  const json = (body: unknown, status = 200) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
  if (path.endsWith("/get-session")) {
    return json({
      session: { id: "session-1", activeOrganizationId: "org-1" },
      user: { id: "user-1", email: "operator@example.test" },
    });
  }
  if (path.endsWith(`/applications/${APPLICATION_ID}/deployments`)) {
    return json(
      {
        statusCode: 409,
        error: "Conflict",
        message: "edge-1 is in maintenance",
        code: "SERVER_IN_MAINTENANCE",
        path: `/applications/${APPLICATION_ID}/deployments`,
        timestamp: "2026-11-12T15:00:00.000Z",
      },
      409,
    );
  }
  return Promise.resolve(new Response("{}", { status: 404 }));
}

// Before the button is imported: `createAuthClient` captures `fetch` as its
// module evaluates.
vi.stubGlobal("fetch", vi.fn(answer));

const { DeployButton } = await import("./deploy-button");
const { Toaster } = await import("@/components/console/toast");

afterEach(cleanup);

describe("DeployButton", () => {
  it("shows the refusal naming the Server when its Server is in maintenance", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <DeployButton applicationId={APPLICATION_ID} />
        <Toaster />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Deploy" }));

    expect(await screen.findByText("edge-1 is in maintenance.")).toBeDefined();
    expect(document.body.textContent).not.toContain("Deployment queued.");
  });
});
