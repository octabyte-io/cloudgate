import { describe, expect, it } from "vitest";

import type { RollbackContext } from "@/lib/api/endpoints/rollbacks";

import { snapshotBranch } from "./rollbacks";

/**
 * A snapshot's stored context, as it actually arrives.
 *
 * `RollbackContext` names its columns optional-and-string, but the JSON carries
 * the row's nulls verbatim — which is the whole defect: `branch` is `null` for
 * every source that is not GitHub. Each carries its repository or URL too, as a
 * real snapshot does: a row without one has no source and no branch.
 */
const ctx = (columns: Record<string, unknown>) => columns as RollbackContext;

/**
 * The "Built from" column, which read `branch` unconditionally and so was blank
 * for four of the five source types that record one.
 */
describe("snapshotBranch", () => {
  it("reads the custom-git column for a git Application", () => {
    // Verbatim from the issue's evidence:
    // `{"sourceType":"git","branch":null,"customGitBranch":"main"}`
    expect(
      snapshotBranch(ctx({
          sourceType: "git",
          customGitUrl: "https://git.example.com/acme/shop.git",
          branch: null,
          customGitBranch: "main",
        })),
    ).toBe("main");
  });

  it("still reads the GitHub column for a github Application", () => {
    expect(snapshotBranch(ctx({ sourceType: "github", repository: "shop", branch: "release" }))).toBe(
      "release",
    );
  });

  it("reads each remaining provider's own column", () => {
    expect(snapshotBranch(ctx({ sourceType: "gitlab", gitlabRepository: "shop", gitlabBranch: "trunk" }))).toBe(
      "trunk",
    );
    expect(snapshotBranch(ctx({ sourceType: "gitea", giteaRepository: "shop", giteaBranch: "next" }))).toBe(
      "next",
    );
    expect(
      snapshotBranch(ctx({
          sourceType: "bitbucket",
          bitbucketRepository: "shop",
          bitbucketBranch: "develop",
        })),
    ).toBe("develop");
  });

  it("has nothing to show for a source with no branch at all", () => {
    expect(snapshotBranch(ctx({ sourceType: "docker", dockerImage: "nginx" }))).toBe(
      null,
    );
    expect(snapshotBranch(ctx({ sourceType: "drop" }))).toBe(null);
    expect(snapshotBranch(null)).toBe(null);
    expect(snapshotBranch(ctx({}))).toBe(null);
  });

  it("survives a snapshot naming a source type this build does not know", () => {
    // `sourceSummary` indexes its provider table by `sourceType`; an unknown one
    // would read `undefined.branchKey` and take the whole table down.
    expect(snapshotBranch(ctx({ sourceType: "mercurial", branch: "default" }))).toBe(
      null,
    );
  });
});
