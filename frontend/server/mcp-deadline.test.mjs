import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import nextConfig from "../next.config.ts";

/**
 * The MCP endpoint answers inside the console proxy's deadline
 * (ADR-0025).
 *
 * Every tool runs under the backend's `TOOL_DEADLINE_MS` and, when it hits it,
 * answers a `failed` result with an audit row. That only reaches the agent if
 * the rewrite proxy in front of `/mcp` is still waiting: were
 * `experimental.proxyTimeout` the shorter of the two, the proxy would cut the
 * socket first and the agent would see a dropped connection — which revision
 * 2026-07-28 reads as a cancellation — instead of the result. Raising one
 * without the other goes red here. Read from the backend's source by name,
 * because the two packages share no module (`proxy-timeout.test.mjs` does the
 * same for the AI deadline).
 */
describe("the MCP tool deadline", () => {
  it("is shorter than the proxy's wait for the backend", () => {
    const source = readFileSync(
      new URL("../../backend/src/mcp/mcp-limits.ts", import.meta.url),
      "utf8",
    );
    const match = source.match(/export const TOOL_DEADLINE_MS = ([\d_]+);/);
    expect(match).not.toBeNull();
    const toolDeadline = Number(match[1].replaceAll("_", ""));

    expect(toolDeadline).toBeGreaterThan(0);
    expect(toolDeadline).toBeLessThan(nextConfig.experimental.proxyTimeout);
  });

  it("is reached through one rewrite of the console's own /mcp", async () => {
    const { beforeFiles } = await nextConfig.rewrites();
    const mcp = beforeFiles.filter((rule) => rule.source === "/mcp");
    expect(mcp).toHaveLength(1);
    expect(mcp[0].destination).toMatch(/\/mcp$/);
  });
});

describe("the Gateway on an install with no console domain", () => {
  it("is reached through one rewrite of the console's own /ai/*", async () => {
    const { beforeFiles } = await nextConfig.rewrites();
    const gateway = beforeFiles.filter((rule) => rule.source === "/ai/:path*");
    expect(gateway).toHaveLength(1);
    expect(gateway[0].destination).toMatch(/\/ai\/:path\*$/);
  });
});
