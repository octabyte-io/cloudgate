import { describe, expect, it } from "vitest";

import { AuthError } from "@/lib/auth/auth-error";

import { ApiError, isUnreachableHost, pointerOf } from "./api-error";

/**
 * `isUnnamedRefusal`, and the emptiness check it rests on (H-48).
 *
 * Five screens write a better sentence for a 403 than `errorMessage()` can, and
 * each of them read `status === 403` to decide when to say it — so a **banned**
 * operator, whose refusal is a 403 on every Cloudgate route, was told their role
 * was the problem at all five. This getter is the narrow guard that replaced the
 * status read: an uncoded 403 keeps its bespoke sentence, and only a refusal the
 * backend went to the trouble of naming is handed back to `errorMessage()`.
 *
 * The interesting half is `code === ""` rather than a truthiness test on some
 * `undefined`. `ApiError.code` is a `string` that defaults to `""` in the
 * constructor, `client.ts` writes `""` for a body without one, and
 * `AllExceptionsFilter` never puts an empty `code` on the wire — so `""` is the
 * one spelling of "unnamed" that exists, and the cases below are what say so
 * rather than the reader having to trust three files at once.
 */
describe("ApiError.isUnnamedRefusal", () => {
  it("is true for a 403 the backend did not name", () => {
    expect(new ApiError(403, "Forbidden resource").isUnnamedRefusal).toBe(true);
  });

  it("is true for a 403 whose body carried no code at all", () => {
    // What `client.ts` builds from `{ statusCode, error, message, path }` — the
    // shape of almost every refusal in the tree.
    const error = new ApiError(403, "Forbidden resource", {
      path: "/settings/runtime-info",
      code: "",
    });

    expect(error.isUnnamedRefusal).toBe(true);
  });

  it("is false for the one refusal the backend does name", () => {
    const error = new ApiError(403, "This account is banned", {
      code: "BANNED_USER",
    });

    expect(error.isUnnamedRefusal).toBe(false);
  });

  it("is false when better-auth is the surface that named it", () => {
    // `AuthError` reaches `ApiError.code` through the constructor rather than
    // declaring its own field (H-26), so the getter must not care which door the
    // refusal came through.
    const error = new AuthError({
      status: 403,
      code: "YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION",
      message: "You are not the recipient of the invitation",
    });

    expect(error.isUnnamedRefusal).toBe(false);
  });

  it("is false for every status that is not a refusal", () => {
    for (const status of [400, 401, 404, 409, 500]) {
      expect(new ApiError(status, "Refused").isUnnamedRefusal).toBe(false);
    }
  });
});

/**
 * X11-4. The second code on this contract, and the getter reads the status too:
 * `HOST_UNREACHABLE` means "nobody reached the machine this read is about" on a 503
 * and nothing at all anywhere else.
 */
describe("ApiError.isUnreachableHost", () => {
  it("is true for the 503 the docker and swarm reads publish", () => {
    const error = new ApiError(503, "This Server could not be reached", {
      code: "HOST_UNREACHABLE",
    });

    expect(error.isUnreachableHost).toBe(true);
    expect(isUnreachableHost(error)).toBe(true);
  });

  it("is false for a 503 the backend did not name", () => {
    expect(new ApiError(503, "Service Unavailable").isUnreachableHost).toBe(
      false,
    );
  });

  it("is false for the code on any other status", () => {
    for (const status of [200, 403, 500, 502, 504]) {
      expect(
        new ApiError(status, "Refused", { code: "HOST_UNREACHABLE" })
          .isUnreachableHost,
      ).toBe(false);
    }
  });

  it("is false for anything that is not an ApiError at all", () => {
    expect(isUnreachableHost(new Error("boom"))).toBe(false);
    expect(isUnreachableHost(null)).toBe(false);
  });

  it("covers the platform host too, so the retry policy skips both", () => {
    // The platform host has a code of its own. This getter is the union
    // on purpose — the retry policy wants "nothing was read, and it will not
    // read differently", which is true of both arms — and the narrowing that
    // matters happens in the words, not here.
    const platform = new ApiError(
      503,
      "The platform host could not be reached",
      { code: "PLATFORM_HOST_UNREACHABLE" },
    );

    expect(platform.isUnreachableHost).toBe(true);
    expect(isUnreachableHost(platform)).toBe(true);
  });
});

/**
 * The two arms apart, which is what the split added and what `errorMessage()`
 * branches on: one code for two subjects meant the console said the Server
 * sentence — *check that its SSH key still works* — about a machine with no
 * `server` row and no SSH key in the loop.
 *
 * The pairing is asserted in one file because the pairing is the property: each
 * arm has to be true for its own code and **false for the other's**, and a
 * getter written as a substring test would pass the positive halves alone
 * (`PLATFORM_HOST_UNREACHABLE` contains `HOST_UNREACHABLE`).
 */
describe("ApiError.isUnreachableServer and isUnreachablePlatformHost", () => {
  const onServer = new ApiError(503, "This Server could not be reached", {
    code: "HOST_UNREACHABLE",
  });
  const onPlatformHost = new ApiError(
    503,
    "The platform host could not be reached",
    { code: "PLATFORM_HOST_UNREACHABLE" },
  );

  it("each answers for its own machine and denies the other's", () => {
    expect(onServer.isUnreachableServer).toBe(true);
    expect(onServer.isUnreachablePlatformHost).toBe(false);

    expect(onPlatformHost.isUnreachablePlatformHost).toBe(true);
    expect(onPlatformHost.isUnreachableServer).toBe(false);
  });

  it("reads the status as well, on both arms", () => {
    // Same reason `isUnreachableHost` does: either code means one thing on a
    // 503 and nothing at all anywhere else.
    for (const status of [200, 403, 500, 502, 504]) {
      expect(
        new ApiError(status, "Refused", { code: "HOST_UNREACHABLE" })
          .isUnreachableServer,
      ).toBe(false);
      expect(
        new ApiError(status, "Refused", { code: "PLATFORM_HOST_UNREACHABLE" })
          .isUnreachablePlatformHost,
      ).toBe(false);
    }
  });

  it("leaves an unnamed 503 as neither", () => {
    const unnamed = new ApiError(503, "Service Unavailable");

    expect(unnamed.isUnreachableServer).toBe(false);
    expect(unnamed.isUnreachablePlatformHost).toBe(false);
    expect(unnamed.isUnreachableHost).toBe(false);
  });
});

/**
 * A catalogue read on an instance with templates off. The
 * status and the code, like the host arms above: the code means one thing on a
 * 503 and nothing anywhere else, and an unnamed 503 is not this.
 */
describe("ApiError.isCatalogueNotConfigured", () => {
  it("answers for a 503 carrying its code", () => {
    expect(
      new ApiError(503, "No template catalogue is configured", {
        code: "TEMPLATES_CATALOGUE_NOT_CONFIGURED",
      }).isCatalogueNotConfigured,
    ).toBe(true);
  });

  it("reads the status as well", () => {
    for (const status of [200, 400, 500, 502, 504]) {
      expect(
        new ApiError(status, "Refused", {
          code: "TEMPLATES_CATALOGUE_NOT_CONFIGURED",
        }).isCatalogueNotConfigured,
      ).toBe(false);
    }
  });

  it("leaves an unnamed 503 and an unreachable host alone", () => {
    expect(new ApiError(503, "Service Unavailable").isCatalogueNotConfigured).toBe(false);
    expect(
      new ApiError(503, "This Server could not be reached", {
        code: "HOST_UNREACHABLE",
      }).isCatalogueNotConfigured,
    ).toBe(false);
  });
});

/**
 * A write a repository-kept Project config refuses carries where the
 * change is made instead, and the console links to the file from it.
 */
describe("pointerOf", () => {
  it("reads the published pointer, a missing branch or link as null", () => {
    expect(
      pointerOf({
        repository: "acme/shop",
        path: "cloudgate.yaml",
        branch: "main",
        fileUrl: "https://github.com/acme/shop/blob/c0ffee1/cloudgate.yaml",
      }),
    ).toEqual({
      repository: "acme/shop",
      path: "cloudgate.yaml",
      branch: "main",
      fileUrl: "https://github.com/acme/shop/blob/c0ffee1/cloudgate.yaml",
    });
    expect(
      pointerOf({ repository: "acme/shop", path: "cloudgate.yaml", branch: null }),
    ).toEqual({
      repository: "acme/shop",
      path: "cloudgate.yaml",
      branch: null,
      fileUrl: null,
    });
  });

  it("answers null for a body without one, or one in another shape", () => {
    expect(pointerOf(undefined)).toBeNull();
    expect(pointerOf({ repository: "acme/shop" })).toBeNull();
    expect(new ApiError(409, "refused").pointer).toBeNull();
  });
});
