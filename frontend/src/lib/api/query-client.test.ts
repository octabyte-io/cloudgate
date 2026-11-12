import { describe, expect, it } from "vitest";

import { ApiError } from "./api-error";
import {
  isDeadSession,
  retryUnlessTheAnswerWillNotChange,
} from "./query-client";

/**
 * The one place a 401 is acted on (§3.5), and
 * what it does is end the session rather than redirect to `/sign-in` — a
 * redirect left the dead cookie set, and `src/proxy.ts` reads nothing but the
 * cookie, so it bounced straight back to the screen that had just 401'd.
 *
 * Two ways to get it wrong, both silent, both now destructive rather than merely
 * annoying. Hence a test for two lines.
 */

describe("isDeadSession", () => {
  it("acts on a 401 from a console screen", () => {
    expect(isDeadSession(new ApiError(401, "Unauthorized"), "/servers")).toBe(
      true,
    );
  });

  it("does not read a role refusal as a dead session", () => {
    // A 403 means they are signed in and their role does not carry the action.
    // Ending the session would misdescribe it and lose their place.
    expect(isDeadSession(new ApiError(403, "Forbidden"), "/servers")).toBe(
      false,
    );
  });

  it("leaves every other refusal alone", () => {
    expect(isDeadSession(new ApiError(404, "Not Found"), "/servers")).toBe(
      false,
    );
    expect(isDeadSession(new ApiError(500, "Server error"), "/servers")).toBe(
      false,
    );
    // Not every rejection is an `ApiError` — a socket or a bug throws too.
    expect(isDeadSession(new Error("Failed to fetch"), "/servers")).toBe(false);
    expect(isDeadSession(undefined, "/servers")).toBe(false);
  });

  it("never signs anyone out of a door", () => {
    // The doors read public config on the way in (`/auth/sign-up-open`,
    // `/sso/show-sign-in`). One of those failing must not destroy the session
    // being established on the screen it failed on.
    for (const door of [
      "/sign-in",
      "/sign-up",
      "/2fa",
      "/forgot-password",
      "/reset-password",
    ]) {
      expect(isDeadSession(new ApiError(401, "Unauthorized"), door)).toBe(
        false,
      );
    }
  });

  it("acts on a 401 from the invitation screen, which is not a door", () => {
    // `/accept-invitation` is deliberately outside `AUTH_PATHS` — it is the one
    // screen a signed-in and a signed-out visitor both have business on, so a
    // dead session there is a dead session.
    expect(
      isDeadSession(new ApiError(401, "Unauthorized"), "/accept-invitation"),
    ).toBe(true);
  });
});

/**
 * The retry policy every query in the console inherits.
 *
 * The case worth pinning is the 503 the docker and swarm reads publish for a
 * Server that was never reached: three attempts at an SSH connect that has
 * already spent `ssh2`'s 20-second `readyTimeout` is a minute of spinner for an
 * answer that did not change. It was fixed here rather than per query because
 * three queries in `useStackContainers` had inherited it without noticing, and
 * the four hand-written `retry: false` overrides on the Server's Docker tab were
 * already the same fix written out by hand.
 *
 * **The bare 503 is the assertion that earns its place**, not the named one: a
 * fix written as "never retry a 503" passes every other case here and quietly
 * stops retrying the platform's own transient failures, which is what the
 * default is for.
 */
describe("retryUnlessTheAnswerWillNotChange", () => {
  it("does not retry a 503 the backend named HOST_UNREACHABLE", () => {
    const notReached = new ApiError(503, "This Server could not be reached", {
      code: "HOST_UNREACHABLE",
    });

    // At `failureCount: 0` — the first attempt has already cost the 20 seconds.
    expect(retryUnlessTheAnswerWillNotChange(0, notReached)).toBe(false);
  });

  it("does not retry a 503 named PLATFORM_HOST_UNREACHABLE either", () => {
    // The platform host has its own code so the console could stop
    // saying the Server sentence about it. The retry policy makes the same call
    // for both arms, and for the load-bearing half of the argument rather
    // than its arithmetic: there is no 20-second SSH dial on this arm — the
    // platform host's reads are `child_process` — but a `docker` binary that
    // cannot be spawned will not appear inside the next two attempts.
    const notReached = new ApiError(
      503,
      "The platform host could not be reached",
      { code: "PLATFORM_HOST_UNREACHABLE" },
    );

    expect(retryUnlessTheAnswerWillNotChange(0, notReached)).toBe(false);
  });

  it("does not retry a 503 named TEMPLATES_CATALOGUE_NOT_CONFIGURED", () => {
    // The backend refused before fetching anything, and it will refuse the same
    // way until it is restarted with other settings.
    const notConfigured = new ApiError(503, "No template catalogue is configured", {
      code: "TEMPLATES_CATALOGUE_NOT_CONFIGURED",
    });

    expect(retryUnlessTheAnswerWillNotChange(0, notConfigured)).toBe(false);
  });

  it("still retries a 503 the backend did not name", () => {
    // Nothing here says which machine was not reached, so this is the platform's
    // own 503 and a second attempt is exactly what the default is for.
    expect(
      retryUnlessTheAnswerWillNotChange(
        0,
        new ApiError(503, "Service Unavailable"),
      ),
    ).toBe(true);
  });

  it("does not retry a 4xx", () => {
    expect(
      retryUnlessTheAnswerWillNotChange(0, new ApiError(404, "Not Found")),
    ).toBe(false);
    expect(
      retryUnlessTheAnswerWillNotChange(0, new ApiError(403, "Forbidden")),
    ).toBe(false);
  });

  it("gives everything else two retries and no more", () => {
    const transient = new ApiError(500, "Server error");

    expect(retryUnlessTheAnswerWillNotChange(0, transient)).toBe(true);
    expect(retryUnlessTheAnswerWillNotChange(1, transient)).toBe(true);
    expect(retryUnlessTheAnswerWillNotChange(2, transient)).toBe(false);
    // Not every rejection is an `ApiError` — a fetch that never landed is a
    // `TypeError`, and it is the other thing worth retrying.
    expect(
      retryUnlessTheAnswerWillNotChange(0, new TypeError("fetch failed")),
    ).toBe(true);
  });
});
