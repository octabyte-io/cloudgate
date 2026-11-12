import { describe, expect, it } from "vitest";

import { addServerSchema } from "./add-server-values";
import { isServerAddress } from "./server-address";

/**
 * The same cases as `backend/test/servers/server-address.spec.ts`, so the
 * dialog and the route refuse the same strings.
 */
describe("isServerAddress", () => {
  it.each([
    "203.0.113.10",
    "10.0.0.1",
    "2001:db8::1",
    "::1",
    "localhost",
    "vps.example.com",
    "vps-1.example.com.",
    "host-with-digits-123",
  ])("accepts %s", (address) => {
    expect(isServerAddress(address)).toBe(true);
  });

  it.each([
    "bad host!!",
    "ssh://203.0.113.10",
    "203.0.113.10:22",
    "root@203.0.113.10",
    "-leading.example.com",
    "trailing-.example.com",
    "double..dot",
    `${"a".repeat(64)}.example.com`,
    "",
  ])("refuses %j", (address) => {
    expect(isServerAddress(address)).toBe(false);
  });
});

describe("Add a Server's address field", () => {
  it("refuses bad host!! beside the field, before anything is sent", () => {
    const parsed = addServerSchema.safeParse({
      name: "vps-a",
      description: "",
      ipAddress: "bad host!!",
      port: 22,
      username: "root",
      sshKeyId: "key-1",
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.path).toEqual(["ipAddress"]);
  });
});
