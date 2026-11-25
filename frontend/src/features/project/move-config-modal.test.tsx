import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MovePreview } from "@/lib/api/endpoints/project-config";

const environment = {
  commitSha: "9b1d0c7ee2",
  fileUrl: null,
  unreadPath: null,
  steps: [],
  notes: [],
};

// A move with no path into a repository whose staging branch holds both
// cloudgate.yaml and cloudgate.yml (ADR-0089).
const preview: MovePreview = {
  to: {
    kind: "repository",
    gitProviderId: "gp-1",
    repository: "acme/shop",
    path: "cloudgate.yaml",
    providerType: "github",
    connectionName: "acme",
  },
  reads: [],
  environments: [
    {
      ...environment,
      environmentId: "env-production",
      name: "production",
      branch: "main",
    },
    {
      ...environment,
      environmentId: "env-staging",
      name: "staging",
      branch: "staging",
      unreadPath: "cloudgate.yml",
    },
  ],
};

// The preview, the confirm and the git reads are the boundary.
vi.mock("./use-project-config", async (original) => ({
  ...(await original<typeof import("./use-project-config")>()),
  usePreviewMove: () => ({
    data: preview,
    isPending: false,
    error: null,
    mutate: vi.fn(),
    reset: vi.fn(),
  }),
  useConfirmMove: () => ({
    isPending: false,
    error: null,
    mutate: vi.fn(),
    reset: vi.fn(),
  }),
}));
vi.mock("@/lib/api/use-git-source", () => ({
  useGitConnections: () => ({ data: [], isPending: false }),
  useRepositories: () => ({ data: [], isPending: false }),
}));

// The plan notes ask whether this is the Hosted instance; nothing here
// depends on it.
vi.mock("@/lib/api/use-instance-mode", () => ({
  useInstanceMode: () => ({ data: undefined }),
}));

const { configRepository, MoveConfigModal, MOVE_PROVIDERS, repositoryTarget } =
  await import("./move-config-modal");

afterEach(cleanup);

/**
 * A branch holding both names reads cloudgate.yaml, and the preview says
 * cloudgate.yml is there and not read, on that branch's card only
 * (ADR-0089).
 */
describe("the move preview", () => {
  function card(name: string): HTMLElement {
    const found = screen
      .getByRole("heading", { name })
      .closest<HTMLElement>("[data-slot='card']");
    if (!found) throw new Error(`no card for ${name}`);
    return found;
  }

  it("names cloudgate.yml as found and not read on the branch holding both", () => {
    render(
      <MoveConfigModal
        projectId="prj-1"
        open
        onOpenChange={vi.fn()}
        serverNames={{}}
      />,
    );

    expect(within(card("staging")).getByRole("note").textContent).toBe(
      "Branch staging also has cloudgate.yml, which is not read.",
    );
    expect(within(card("production")).queryByRole("note")).toBeNull();
  });
});

/**
 * The move dialog offers all four hosted providers, and names the
 * chosen repository the way that provider's config reader and the
 * connection resolver address it.
 */
describe("the move dialog's repository", () => {
  it("offers GitHub, GitLab, Gitea and Bitbucket", () => {
    expect(MOVE_PROVIDERS.map((one) => [one.value, one.label])).toEqual([
      ["github", "GitHub"],
      ["gitlab", "GitLab"],
      ["gitea", "Gitea"],
      ["bitbucket", "Bitbucket"],
    ]);
  });

  it("is owner/name on GitHub and Gitea", () => {
    const repository = { key: "acme/shop", owner: "acme", name: "shop" };
    expect(configRepository("github", repository)).toBe("acme/shop");
    expect(configRepository("gitea", repository)).toBe("acme/shop");
  });

  it("is the full project path on GitLab, nested groups and all", () => {
    expect(
      configRepository("gitlab", {
        key: "42",
        owner: "platform",
        name: "Shop",
        pathNamespace: "acme/platform/shop",
        projectId: 42,
      }),
    ).toBe("acme/platform/shop");
  });

  it("is workspace/slug on Bitbucket, not the display name", () => {
    expect(
      configRepository("bitbucket", {
        key: "acme/web-store",
        owner: "acme",
        name: "Web Store",
        slug: "web-store",
      }),
    ).toBe("acme/web-store");
  });
});

/**
 * An empty Path is no path, so the move finds cloudgate.yaml or
 * cloudgate.yml itself (#1344); a typed one is asked for alone.
 */
describe("repositoryTarget", () => {
  it("sends no path when Path is empty or blank", () => {
    for (const path of ["", "   "]) {
      expect(repositoryTarget("gp-1", "acme/shop", path)).toEqual({
        kind: "repository",
        gitProviderId: "gp-1",
        repository: "acme/shop",
      });
    }
  });

  it("sends a typed Path trimmed, cloudgate.yaml included", () => {
    expect(
      repositoryTarget("gp-1", "acme/shop", "  deploy/cloudgate.yml ").path,
    ).toBe("deploy/cloudgate.yml");
    expect(repositoryTarget("gp-1", "acme/shop", "cloudgate.yaml").path).toBe(
      "cloudgate.yaml",
    );
  });
});
