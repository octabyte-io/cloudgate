import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const servers = vi.hoisted(() => vi.fn());
const projects = vi.hoisted(() => vi.fn());
const environments = vi.hoisted(() => vi.fn());

// The three endpoints are the boundary; the session is only here to say which
// Organization is active.
vi.mock("@/lib/api/endpoints/servers", () => ({
  serversApi: { list: () => servers() },
}));
vi.mock("@/lib/api/endpoints/projects", () => ({
  projectsApi: { list: () => projects() },
}));
vi.mock("@/lib/api/endpoints/environments", () => ({
  environmentsApi: { listByProject: (id: string) => environments(id) },
}));
vi.mock("@/lib/auth/client", () => ({
  useActiveOrganizationId: () => ({ organizationId: "org_1", pending: false }),
}));
const reader = vi.hoisted(() => ({ hosted: false, operator: false }));
vi.mock("@/features/operator/use-operator", () => ({
  useIsOperator: () => ({ ...reader, pending: false }),
}));
// Whether buying a Server is offered: the instance's mode, then the offer.
const about = vi.hoisted(() => vi.fn());
const offer = vi.hoisted(() => vi.fn());
vi.mock("@/lib/api/endpoints/settings", () => ({
  settingsApi: { about: () => about() },
}));
vi.mock("@/lib/api/endpoints/bought-servers", () => ({
  boughtServersApi: { offer: () => offer() },
}));

const { usePaletteSources } = await import("./palette-sources");

afterEach(cleanup);
beforeEach(() => {
  reader.hosted = false;
  reader.operator = false;
  about.mockReset().mockResolvedValue({ mode: "self-hosted" });
  offer.mockReset().mockResolvedValue({ offered: false });
  servers.mockReset().mockResolvedValue([]);
  projects.mockReset().mockResolvedValue([]);
  environments.mockReset().mockResolvedValue([]);
});

function sources() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const { result } = renderHook(() => usePaletteSources(true), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  return result;
}

/**
 * Which kinds the palette could not read. An empty list and a refused
 * one both arrive as no rows, and only the first may be called "none yet".
 */
describe("usePaletteSources", () => {
  it("names nothing unavailable when every list answered, even empty", async () => {
    const result = sources();

    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(result.current.unavailable).toEqual([]);
  });

  it("names Servers when their list is refused", async () => {
    servers.mockRejectedValue(new Error("403 Forbidden"));
    const result = sources();

    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(result.current.unavailable).toEqual(["srv"]);
  });

  it("names Environments too when the Project list they hang off fails", async () => {
    projects.mockRejectedValue(new Error("403 Forbidden"));
    const result = sources();

    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(result.current.unavailable).toEqual(["proj", "env"]);
  });

  it("names Environments when one Project's list of them fails", async () => {
    projects.mockResolvedValue([{ projectId: "p1", name: "ui-main" }]);
    environments.mockRejectedValue(new Error("500"));
    const result = sources();

    await waitFor(() => expect(result.current.unavailable).toEqual(["env"]));
  });
});

/**
 * `go:` reads the rail's table, so it offers Requests exactly where the rail
 * does: to everybody, the Hosted instance's customers included, since Requests
 * reads each Server's own access log.
 */
describe("usePaletteSources go: pages", () => {
  const pages = (result: ReturnType<typeof sources>) =>
    result.current.results
      .filter((row) => row.kind === "go")
      .map((row) => row.name);

  it("offers Requests on a Self-hosted instance", () => {
    expect(pages(sources())).toContain("Requests");
  });

  it("offers Requests to a customer on the Hosted instance", () => {
    reader.hosted = true;
    expect(pages(sources())).toContain("Requests");
  });

  it("offers Requests to an Operator on the Hosted instance", () => {
    reader.hosted = true;
    reader.operator = true;
    expect(pages(sources())).toContain("Requests");
  });

  it("offers no Bought Servers page on a Self-hosted instance", async () => {
    const result = sources();

    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(pages(result)).not.toContain("Bought Servers");
    expect(offer).not.toHaveBeenCalled();
  });

  it("offers no Bought Servers page on the Hosted instance while buying is not offered", async () => {
    about.mockResolvedValue({ mode: "hosted" });
    const result = sources();

    await waitFor(() => expect(offer).toHaveBeenCalled());
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(pages(result)).not.toContain("Bought Servers");
  });

  it("offers the Bought Servers page on the Hosted instance with buying offered", async () => {
    about.mockResolvedValue({ mode: "hosted" });
    offer.mockResolvedValue({ offered: true });
    const result = sources();

    await waitFor(() => expect(pages(result)).toContain("Bought Servers"));
    expect(
      result.current.results.find((row) => row.name === "Bought Servers"),
    ).toMatchObject({ kind: "go", href: "/bought-servers" });
  });
});
