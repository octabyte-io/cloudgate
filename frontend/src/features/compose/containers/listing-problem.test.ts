import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api/api-error";

import { listingProblem } from "./use-stack-containers";

/**
 * Why a Compose stack's Image and Ports columns are empty. It was one
 * sentence — "needs a different permission and did not answer" — said to an
 * owner, who holds every permission, when Docker simply could not be reached.
 */
describe("listingProblem", () => {
  it("names an unreachable Docker plainly, and blames no permission", () => {
    const why = listingProblem(
      new ApiError(503, "This Server could not be reached", {
        code: "HOST_UNREACHABLE",
      }),
      undefined,
    );
    expect(why).toContain("could not be reached");
    expect(why).not.toContain("permission");
  });

  it("names the permission only for a refusal", () => {
    expect(listingProblem(new ApiError(403, "Forbidden"), undefined)).toContain(
      "permission",
    );
  });

  it("says Docker would not list them when it answered with nothing", () => {
    expect(listingProblem(null, null)).toContain("would not list");
  });

  it("is null when the listing answered", () => {
    expect(listingProblem(null, [])).toBeNull();
  });
});
