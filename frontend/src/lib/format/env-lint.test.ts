import { describe, expect, it } from "vitest";

import { envIssues } from "./env-lint";

/** The block once saved as "4 variables are now set here", line by line. */
const AUDITED = [
  "GOOD=1",
  "bad line",
  "1BAD=x",
  "DUP=a",
  "DUP=b",
  "REF=${{environment.NOPE}}",
].join("\n");

const sources = { project: "", environment: "SET=1", wired: [] };

describe("envIssues", () => {
  it("names each mistake of the audited block on its own line", () => {
    const issues = envIssues(AUDITED, sources);
    expect(issues.map((issue) => [issue.line, issue.blocking])).toEqual([
      [2, true],
      [3, true],
      [4, true],
      [6, false],
    ]);
    expect(issues[0].message).toBe(
      "This is not KEY=value, so it would be dropped.",
    );
    expect(issues[1].message).toContain("1BAD is not a name");
    expect(issues[2].message).toBe(
      "DUP is set again on line 5, and only that later value is kept.",
    );
    expect(issues[3].message).toBe(
      "${{environment.NOPE}}: NOPE is not set on the Environment, so a deploy fails here until it is.",
    );
  });

  it("finds nothing in a clean block with comments, blank lines and a quoted multi-line value", () => {
    const env = [
      "# the database",
      "",
      "export A=1",
      'B="two',
      'lines"',
      "C: three",
      "D=${{environment.SET}}",
      "E=${{A}}",
      "F=${{LINKED}}",
    ].join("\n");
    expect(envIssues(env, { ...sources, wired: ["LINKED"] })).toEqual([]);
  });

  it("warns on a Project reference and a sibling that are not set", () => {
    const issues = envIssues("A=${{project.MISSING}}\nB=${{NOPE}}", sources);
    expect(issues).toEqual([
      {
        line: 1,
        message:
          "${{project.MISSING}}: MISSING is not set on the Project, so a deploy fails here until it is.",
        blocking: false,
      },
      {
        line: 2,
        message:
          "${{NOPE}}: NOPE is not set beside it, so a deploy fails here until it is.",
        blocking: false,
      },
    ]);
  });

  it("judges no reference whose source is not read yet, nor any without sources", () => {
    const env = "A=${{project.X}}\nB=${{environment.Y}}\nC=${{Z}}";
    expect(
      envIssues(env, { project: undefined, environment: undefined, wired: undefined }),
    ).toEqual([]);
    expect(envIssues(env)).toEqual([]);
  });
});
