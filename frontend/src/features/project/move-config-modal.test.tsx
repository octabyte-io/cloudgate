import { describe, expect, it } from "vitest";

import {
  configRepository,
  MOVE_PROVIDERS,
  repositoryTarget,
} from "./move-config-modal";

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
