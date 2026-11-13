import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { apiOriginFrom } from "./api-origin.mjs";

const SERVER = fileURLToPath(new URL("../server.mjs", import.meta.url));

/**
 * `node server.mjs` — what the `cloudgate-console` unit runs — with this
 * environment and nothing inherited about the API. A refusal happens before
 * Next is prepared, so no build is needed to see one.
 */
function boot(apiUrl) {
  const env = { ...process.env, PORT: "3999", NODE_ENV: "production" };
  delete env.CLOUDGATE_API_URL;
  if (apiUrl !== undefined) env.CLOUDGATE_API_URL = apiUrl;
  return spawnSync(process.execPath, [SERVER], {
    env,
    encoding: "utf8",
    timeout: 20_000,
  });
}

/**
 * The console used to fall back to `http://localhost:4000` when its address
 * was missing, and the result was a console that signs in and serves REST
 * while every live feed dials the operator's own machine. It now stops at
 * boot and says which variable to set (ADR-0082).
 */
describe("server.mjs at boot", () => {
  it("stops with a sentence naming CLOUDGATE_API_URL when it is missing", () => {
    const run = boot(undefined);

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain("CLOUDGATE_API_URL is not set.");
  });

  it("stops with a sentence naming CLOUDGATE_API_URL when it is not http or https", () => {
    const run = boot("ftp://203.0.113.10:4000");

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain(
      'CLOUDGATE_API_URL must be an http:// or https:// address, such as http://203.0.113.10:4000, not "ftp://203.0.113.10:4000".',
    );
  });
});

describe("apiOriginFrom", () => {
  it("answers the origin of an http or https address", () => {
    expect(apiOriginFrom("http://203.0.113.10:4000")).toBe(
      "http://203.0.113.10:4000",
    );
    expect(apiOriginFrom("https://console.example.com/")).toBe(
      "https://console.example.com",
    );
  });

  it("refuses an empty value as missing", () => {
    expect(() => apiOriginFrom("  ")).toThrow("CLOUDGATE_API_URL is not set.");
  });

  it("refuses a value that is not an address at all", () => {
    expect(() => apiOriginFrom("203.0.113.10:4000")).toThrow(
      "CLOUDGATE_API_URL must be an http:// or https:// address",
    );
  });
});
