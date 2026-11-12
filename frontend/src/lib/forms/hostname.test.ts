import { describe, expect, it } from "vitest";

import {
  hostnameField,
  hostnameMessage,
  hostnameValue,
  isHostname,
} from "./hostname";

/**
 * The shared rule's own tests, which it did not have while it was only a regex
 * and a sentence.
 *
 * They exist because the module makes a claim about the backend — that a host
 * this side refuses is a host that side refuses, in the same words — and one
 * input class escaped it: surrounding whitespace, which both forms removed
 * privately before applying the regex (X11-5). The whitespace policy is part of
 * the rule now, so it is asserted here rather than twice at the call sites.
 */

/** The messages a refusal carried, in the order the form would show them. */
function refusals(result: { error?: { issues: { message: string }[] } }) {
  return (result.error?.issues ?? []).map((issue) => issue.message);
}

describe("hostnameField", () => {
  it("hands on a host with its surrounding whitespace already removed", () => {
    // What makes the module's claim true rather than narrower: the value that
    // reaches the endpoint is the trimmed one, so `hostSchema`'s "cannot have
    // leading or trailing spaces" arm is unreachable from a form built here.
    const field = hostnameField({ example: "api.example.com" });

    expect(field.parse("  api.example.com  ")).toBe("api.example.com");
  });

  it("refuses a host outside the charset in the backend's words, with the caller's example", () => {
    const field = hostnameField({
      example: "api.example.com",
      empty: "Add a hostname.",
    });

    expect(refusals(field.safeParse("x11_app.example.com"))).toEqual([
      hostnameMessage("api.example.com"),
    ]);
  });

  it("refuses whitespace around a host that is malformed anyway, on the charset alone", () => {
    // Trim first, rule second, one issue: a person who pasted a bad host with a
    // space on it is told what is wrong with the host, not about the space.
    const field = hostnameField({ example: "console.example.com" });

    expect(refusals(field.safeParse(" console_1.example.com "))).toEqual([
      hostnameMessage("console.example.com"),
    ]);
  });

  it("refuses an empty box with the caller's own sentence and nothing about the charset", () => {
    const field = hostnameField({
      example: "api.example.com",
      empty: "Add a hostname.",
    });

    expect(refusals(field.safeParse(""))).toEqual(["Add a hostname."]);
  });

  it("accepts an empty box when the caller names no sentence for one", () => {
    // The console's unassign gesture: an empty host deletes
    // `dynamic/cloudgate.yml`, which the card's footer describes.
    const field = hostnameField({ example: "console.example.com" });

    expect(field.parse("")).toBe("");
  });

  it("reads a box holding nothing but spaces as an empty box", () => {
    expect(hostnameField({ example: "console.example.com" }).parse("   ")).toBe(
      "",
    );
    expect(
      refusals(
        hostnameField({
          example: "api.example.com",
          empty: "Add a hostname.",
        }).safeParse("   "),
      ),
    ).toEqual(["Add a hostname."]);
  });
});

describe("isHostname", () => {
  it("ignores the surrounding whitespace the field removes", () => {
    expect(isHostname("  api.example.com  ")).toBe(true);
  });

  it("refuses a label carrying an underscore", () => {
    expect(isHostname("x11_app.example.com")).toBe(false);
  });

  it("refuses a single label, which is not a hostname a Domain may have", () => {
    expect(isHostname("localhost")).toBe(false);
  });

  it("refuses an empty string, which is a box nobody has typed in yet", () => {
    expect(isHostname("")).toBe(false);
    expect(isHostname("   ")).toBe(false);
  });
});

describe("hostnameValue", () => {
  it("is the text a field sends: the same value the rule was applied to", () => {
    expect(hostnameValue(" api.example.com ")).toBe("api.example.com");
  });
});
