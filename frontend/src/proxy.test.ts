// @vitest-environment node
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { config, proxy } from "./proxy";

/**
 * **The `/dev/*` galleries are behind the sign-in gate in a production build**.
 *
 * They used to sit in the matcher's negative lookahead on the grounds that they
 * "make no authenticated calls" — and `/dev/data` created a Project, an
 * Environment, an Application and a Deployment, and every one of the five
 * routes answered 200 to a signed-out `curl` on a production install. Under
 * `next dev` they stay open, because that is where the design system is
 * reviewed; `next build` inlines `NODE_ENV` as `"production"`, so that branch
 * does not exist in what ships.
 *
 * Two halves, because either alone can pass while the gate is open: the matcher
 * has to *reach* `/dev/*` (Next never calls `proxy` for a path it excludes),
 * and `proxy` has to refuse it.
 */

const DEV_PATHS = [
  "/dev/tokens",
  "/dev/primitives",
  "/dev/primitives/data",
  "/dev/rows",
  "/dev/data",
];

/** Next compiles a matcher source into an anchored pattern. */
const matcher = new RegExp(`^${config.matcher[0]}$`);

function request(path: string, cookie?: string): NextRequest {
  return new NextRequest(new URL(path, "http://console.test"), {
    headers: cookie ? { cookie } : {},
  });
}

const SESSION = "better-auth.session_token=abc.def";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("proxy", () => {
  describe("the MCP endpoint", () => {
    it("/mcp never reaches the gate, so a cookieless Agent is not sent to sign in", () => {
      expect(matcher.test("/mcp")).toBe(false);
    });

    it.each(["/mcp-tools", "/mcpx", "/mcp/extra"])(
      "%s is still behind the gate: the exemption is the one path",
      (path) => {
        vi.stubEnv("NODE_ENV", "production");
        expect(matcher.test(path)).toBe(true);
        expect(proxy(request(path)).status).toBe(307);
      },
    );
  });

  describe("the Gateway", () => {
    it.each(["/ai/app_1/v1/chat/completions", "/ai/app_1/v1/models"])(
      "%s never reaches the gate, so a cookieless caller is not sent to sign in",
      (path) => {
        expect(matcher.test(path)).toBe(false);
      },
    );

    it.each(["/ai", "/aim"])(
      "%s is still behind the gate: the exemption is the /ai/ prefix",
      (path) => {
        vi.stubEnv("NODE_ENV", "production");
        expect(matcher.test(path)).toBe(true);
        expect(proxy(request(path)).status).toBe(307);
      },
    );
  });

  describe("the /dev/* galleries", () => {
    it.each(DEV_PATHS)("%s reaches the proxy at all", (path) => {
      expect(matcher.test(path)).toBe(true);
    });

    it.each(DEV_PATHS)(
      "%s sends a signed-out visitor to sign in, in a production build",
      (path) => {
        vi.stubEnv("NODE_ENV", "production");
        const response = proxy(request(path));
        expect(response.status).toBe(307);
        expect(response.headers.get("location")).toBe(
          `http://console.test/sign-in?next=${encodeURIComponent(path)}`,
        );
      },
    );

    it.each(DEV_PATHS)(
      "%s is served to a signed-in visitor, in a production build",
      (path) => {
        vi.stubEnv("NODE_ENV", "production");
        const response = proxy(request(path, SESSION));
        expect(response.status).toBe(200);
        expect(response.headers.get("location")).toBeNull();
      },
    );

    it.each(DEV_PATHS)(
      "%s is served signed out under next dev, where the design system is reviewed",
      (path) => {
        vi.stubEnv("NODE_ENV", "development");
        const response = proxy(request(path));
        expect(response.headers.get("location")).toBeNull();
      },
    );

    it("a console route is gated under next dev too — the exception is /dev alone", () => {
      vi.stubEnv("NODE_ENV", "development");
      for (const path of ["/settings/instance", "/devices", "/developer"]) {
        expect(matcher.test(path)).toBe(true);
        expect(proxy(request(path)).status).toBe(307);
      }
    });
  });
});
