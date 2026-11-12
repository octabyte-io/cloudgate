import { describe, expect, it } from "vitest";

import { ApiError } from "@/lib/api/api-error";
import { errorMessage } from "@/lib/api/error-message";

import { AuthError, INSTANCE_AUTHORITY_SENTENCE } from "./auth-error";
import { readGate } from "./use-permission";

/**
 * What an operator reads when better-auth refuses this address's origin.
 *
 * Saving a console domain produced an HTTPS console on which every sign-in was
 * refused `403 INVALID_ORIGIN`, and the sentence on the sign-in screen told the
 * operator to edit the backend's environment file and restart it. The backend
 * resolves its allowlist from the database on every request — `TRUSTED_ORIGINS`
 * merged with the owners' Trusted origins list — so an origin added on that card
 * works with no restart. The sentence may still name the restart, because the
 * card needs an enterprise licence and this screen is pre-auth and cannot know
 * whether there is one; what it may not do is present the restart as *the* fix.
 */

const INVALID_ORIGIN_SENTENCE =
  "The backend does not trust this address, so it refused the request. An owner can trust it from the address the console already works on, under Settings → Single sign-on → Trusted origins, which takes effect at once and needs an enterprise licence. Without a licence, add this address's origin to TRUSTED_ORIGINS in the backend's environment — scheme and host only, no path or trailing slash — and restart the backend.";

const refused = () =>
  errorMessage(
    new AuthError({
      status: 403,
      code: "INVALID_ORIGIN",
      message: "Invalid origin",
    }),
  );

describe("INVALID_ORIGIN", () => {
  it("is said in full, rather than as the role sentence a bare 403 gets", () => {
    expect(refused()).toBe(INVALID_ORIGIN_SENTENCE);
  });

  it("names the Trusted origins card before any restart, as the route that works at once", () => {
    const sentence = refused();
    const card = sentence.indexOf("Trusted origins");
    const restart = sentence.indexOf("restart");

    expect(card).toBeGreaterThan(-1);
    expect(sentence).toContain("takes effect at once");
    expect(card).toBeLessThan(restart);
  });

  it("offers the restart only as the route for an instance without a licence", () => {
    const sentence = refused();
    // Everything from the first mention of a restart is the licence-less
    // branch, and it says so in its opening words.
    const restartClause = sentence.slice(
      sentence.lastIndexOf(".", sentence.indexOf("restart")) + 1,
    );

    expect(restartClause.trim()).toMatch(/^Without a licence,/);
    expect(sentence.match(/restart/g)).toHaveLength(1);
  });
});

/**
 * What a caller reads when a route refuses them **instance authority**
 * (ADR-0013): only an owner or admin of the instance organization may act on
 * the platform host. Before the code this was the bare 403's role sentence,
 * "Ask an owner or an admin to do it, or to change your role", said to people
 * who may already *be* the owner of their Organization, where no role grants
 * it.
 */
describe("INSTANCE_AUTHORITY_REQUIRED", () => {
  const instanceRefusal = new ApiError(
    403,
    "Only an owner or admin of the instance organization can configure the platform host",
    { code: "INSTANCE_AUTHORITY_REQUIRED" },
  );

  it("says who can do it, without sending the reader to their own Organization's owner", () => {
    const sentence = errorMessage(instanceRefusal);

    expect(sentence).toBe(INSTANCE_AUTHORITY_SENTENCE);
    expect(sentence).not.toMatch(/ask an owner/i);
    expect(sentence).not.toMatch(/your role/i);
  });

  it("is what a control gated on that read is turned off with", () => {
    expect(readGate({ error: instanceRefusal })).toEqual({
      allowed: false,
      refusal: INSTANCE_AUTHORITY_SENTENCE,
    });
  });

  it("leaves every other 403 as it was", () => {
    expect(errorMessage(new ApiError(403, "Permission denied"))).toBe(
      "Your role in this Organization does not allow this. Ask an owner or an admin to do it, or to change your role.",
    );
  });
});
