import { describe, expect, it } from "vitest";

import { composeFileIsEmpty, yamlProblem } from "./yaml-check";

/**
 * The two questions the editor asks about a compose file before anything on the
 * server has seen it, and they are not the same question — which is the whole
 * point. `yamlProblem`
 * answers "would the parser refuse this", and it deliberately says *no problem*
 * for the empty file, because an empty document is valid YAML. That is correct
 * for the editor's error line and useless for the strip beside it, which was
 * reading the absence of a problem as "the file parses and declares no
 * services" — of a file nothing on the platform will accept.
 */
describe("composeFileIsEmpty", () => {
  it("is true for a file nothing has been written to", () => {
    expect(composeFileIsEmpty("")).toBe(true);
    expect(composeFileIsEmpty("   ")).toBe(true);
    expect(composeFileIsEmpty("\n\n  \n")).toBe(true);
  });

  it("is false for a file that parses to no services", () => {
    // The state the old sentence was written for, and the only one it was true
    // of: a document the backend accepts and finds nothing in.
    expect(composeFileIsEmpty("name: nothing-here\n")).toBe(false);
    expect(composeFileIsEmpty("services: {}\n")).toBe(false);
    // Comments are content as far as the parser is concerned…
    expect(composeFileIsEmpty("# nothing yet\n")).toBe(false);
  });

  it("is false for a real file", () => {
    expect(composeFileIsEmpty("services:\n  web:\n    image: nginx\n")).toBe(
      false,
    );
  });

  it("splits the empty file off from what yamlProblem can see", () => {
    // Both are `null` to the parser. Only one of them is deployable, and the
    // strip under the editor needs the difference.
    expect(yamlProblem("")).toBeNull();
    expect(yamlProblem("services: {}\n")).toBeNull();
    expect(composeFileIsEmpty("")).not.toBe(composeFileIsEmpty("services: {}\n"));
  });
});
