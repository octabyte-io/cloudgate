import { describe, expect, it } from "vitest";

import { GIT_PROVIDERS } from "@/features/application/source/providers";

import { hasSource, SOURCE_COLUMN } from "./source";

/**
 * The rule the Source cards and the deploy refusal share. The cases are
 * `backend/test/deployments/missing-source.spec.ts`'s, one per source type, so a
 * change to one side that the other does not make shows up as a disagreement
 * between two lists that read the same.
 */
describe("hasSource", () => {
  it.each([
    ["github", "repository", "shop"],
    ["gitlab", "gitlabRepository", "shop"],
    ["gitea", "giteaRepository", "shop"],
    ["bitbucket", "bitbucketRepository", "shop"],
    ["git", "customGitUrl", "git@example.com:acme/shop.git"],
    ["docker", "dockerImage", "nginx:1.27"],
    ["drop", "dropBuildPath", "/"],
  ] as const)("reads a %s row by its %s", (sourceType, column, value) => {
    expect(hasSource({ sourceType, [column]: null })).toBe(false);
    expect(hasSource({ sourceType, [column]: "   " })).toBe(false);
    expect(hasSource({ sourceType, [column]: value })).toBe(true);
  });

  it("has a raw stack's source always set", () => {
    expect(hasSource({ sourceType: "raw" })).toBe(true);
  });

  it("does not read another type's column", () => {
    expect(hasSource({ sourceType: "gitlab", repository: "shop" })).toBe(false);
  });

  it("reads each provider by the column its source forms write", () => {
    for (const spec of Object.values(GIT_PROVIDERS)) {
      expect(SOURCE_COLUMN[spec.kind]).toBe(spec.repositoryKey);
    }
  });
});
