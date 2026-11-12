import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Application } from "@/lib/api/endpoints/applications";
import type { Compose } from "@/lib/api/endpoints/compose";

// The one boundary: the connection, repository and branch queries. The form,
// its fields and the provider table are real.
vi.mock("@/lib/api/use-git-source", () => {
  const settled = {
    data: [],
    error: null,
    isPending: false,
    refetch: vi.fn(),
  };
  return {
    useGitConnections: () => settled,
    useRepositories: () => settled,
    useBranches: () => settled,
    connectionOptions: () => [{ id: "conn-1", name: "acme" }],
  };
});
vi.mock("@/components/console/toast", () => ({
  toast: { done: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const { GitSourceForm } = await import("./git-source-form");
const { GIT_PROVIDERS } = await import("./providers");
const { COMPOSE_PATH } = await import("@/features/compose/source/compose-source");

afterEach(cleanup);

const application = {
  applicationId: "app-1",
  sourceType: "github",
  githubId: "conn-1",
  owner: "acme",
  repository: "shop",
  branch: "main",
  autoDeploy: true,
  triggerType: "push",
} as unknown as Application;

const compose = {
  composeId: "cmp-1",
  sourceType: "github",
  githubId: "conn-1",
  owner: "acme",
  repository: "shop",
  branch: "main",
  composePath: "./docker-compose.yml",
  autoDeploy: true,
  triggerType: "push",
} as unknown as Compose;

function renderForm(
  row: Application | Compose,
  kind: keyof typeof GIT_PROVIDERS,
) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <GitSourceForm
        row={row}
        spec={GIT_PROVIDERS[kind]}
        path={"composeId" in row ? COMPOSE_PATH : undefined}
        save={async () => undefined}
        onDone={() => undefined}
      />
    </QueryClientProvider>,
  );
  return document.body.textContent ?? "";
}

/**
 * **The form offers push controls only where a push deploys**.
 *
 * The Source card says "Nothing — deploys are manual" for every source no push
 * reaches, and the form under it used to offer "Deploy on: Push / Tag" and a
 * "Deploy automatically" switch for all of them — GitLab, Bitbucket and Gitea
 * Applications and every Compose stack — a working-looking control over a
 * trigger that does not exist. It asks `pushCanDeploy`, the card's own rule.
 */
describe("GitSourceForm — push controls", () => {
  it("offers them on a GitHub Application, and says a tag deploys nothing", () => {
    const text = renderForm(application, "github");

    expect(screen.getByRole("switch")).toBeTruthy();
    expect(text).toContain("Deploy automatically");
    expect(text).toContain("A new tag deploys nothing yet");
    expect(text).not.toContain("Nothing — deploys are manual");
  });

  it("keeps a saved Tag row editable, with Tag chosen and Push offered", () => {
    renderForm({ ...application, triggerType: "tag" } as Application, "github");

    expect(
      screen.getByRole("button", { name: "Tag" }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(screen.getByRole("button", { name: "Push" })).toBeTruthy();
  });

  it.each(["gitlab", "bitbucket", "gitea"] as const)(
    "offers none on a %s Application, and says deploys are manual",
    (kind) => {
      const text = renderForm(application, kind);

      expect(screen.queryByRole("switch")).toBeNull();
      expect(text).not.toContain("Deploy automatically");
      expect(text).not.toContain("Deploy on");
      expect(text).toContain("Nothing — deploys are manual");
    },
  );

  it("offers none on a Compose stack, even from GitHub", () => {
    const text = renderForm(compose, "github");

    expect(screen.queryByRole("switch")).toBeNull();
    expect(text).not.toContain("Deploy automatically");
    expect(text).toContain("Nothing — deploys are manual");
  });
});
