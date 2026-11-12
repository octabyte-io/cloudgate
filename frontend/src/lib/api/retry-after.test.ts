import { beforeEach, describe, expect, it, vi } from "vitest";

import { unwrap } from "@/lib/auth/auth-error";

import { ApiError, retryAfterSeconds } from "./api-error";
import { api } from "./client";
import { errorMessage } from "./error-message";

const fetchSpy = vi.hoisted(() => vi.fn());

// Before the auth client is imported: better-auth binds `fetch` when the client
// is created, so a stub installed per test would never be the one it calls.
vi.stubGlobal("fetch", (...args: unknown[]) => fetchSpy(...args));

const { signIn } = await import("@/lib/auth/client");

/**
 * **A throttle says when to try again**.
 *
 * better-auth's limiter answers a throttled sign-in with a 429 carrying
 * `X-Retry-After: 9`, counting down. The console dropped the header and said
 * "Wait a few seconds", so the person guessed, retried inside the window, and
 * was refused again — eleven times in six seconds on the run that found it.
 *
 * `fetch` is the boundary, so both surfaces are driven from the wire: the
 * better-auth client every auth screen uses, and `client.ts` for a Cloudgate
 * route (which would carry the standard `Retry-After`).
 */

beforeEach(() => {
  fetchSpy.mockReset();
});

function throttled(headers: Record<string, string>) {
  fetchSpy.mockResolvedValue(
    new Response(
      JSON.stringify({ message: "Too many requests. Please try again later." }),
      {
        status: 429,
        statusText: "Too Many Requests",
        headers: { "Content-Type": "application/json", ...headers },
      },
    ),
  );
}

async function refusal(call: Promise<unknown>): Promise<unknown> {
  try {
    await call;
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to be refused");
}

describe("a throttled sign-in", () => {
  it("names better-auth's own wait", async () => {
    throttled({ "X-Retry-After": "9" });
    const error = await refusal(
      unwrap(signIn.email({ email: "a@example.test", password: "wrong" })),
    );
    expect(errorMessage(error)).toBe(
      "Too many attempts. Try again in 9 seconds.",
    );
  });
});

describe("a throttled Cloudgate route", () => {
  it("names the standard Retry-After", async () => {
    throttled({ "Retry-After": "30" });
    const error = await refusal(api.get("/projects"));
    expect(errorMessage(error)).toBe(
      "Too many attempts. Try again in 30 seconds.",
    );
  });
});

describe("errorMessage, for a 429", () => {
  it("counts one second in the singular", () => {
    expect(
      errorMessage(new ApiError(429, "Too Many Requests", { retryAfter: 1 })),
    ).toBe("Too many attempts. Try again in 1 second.");
  });

  it("still makes sense when nothing says how long", () => {
    expect(errorMessage(new ApiError(429, "Too Many Requests"))).toBe(
      "Too many attempts. Wait a minute, then try again.",
    );
  });
});

describe("retryAfterSeconds", () => {
  it("reads either header, and the standard one first", () => {
    expect(retryAfterSeconds(new Headers({ "x-retry-after": "9" }))).toBe(9);
    expect(retryAfterSeconds(new Headers({ "retry-after": "12" }))).toBe(12);
    expect(
      retryAfterSeconds(
        new Headers({ "retry-after": "12", "x-retry-after": "9" }),
      ),
    ).toBe(12);
  });

  it("falls back to X-Retry-After when Retry-After cannot be read", () => {
    expect(
      retryAfterSeconds(
        new Headers({ "retry-after": "soon", "x-retry-after": "9" }),
      ),
    ).toBe(9);
  });

  it("reads an HTTP date as the seconds until it", () => {
    const now = Date.parse("2026-09-18T12:00:00Z");
    vi.spyOn(Date, "now").mockReturnValue(now);
    expect(
      retryAfterSeconds(
        new Headers({ "retry-after": "Fri, 18 Sep 2026 12:00:20 GMT" }),
      ),
    ).toBe(20);
    vi.restoreAllMocks();
  });

  it("ignores what it cannot read, and a wait that is already over", () => {
    expect(retryAfterSeconds(new Headers())).toBeUndefined();
    expect(retryAfterSeconds(new Headers({ "retry-after": "soon" }))).toBeUndefined();
    expect(retryAfterSeconds(new Headers({ "retry-after": "0" }))).toBeUndefined();
    expect(retryAfterSeconds(new Headers({ "retry-after": "-3" }))).toBeUndefined();
  });
});
