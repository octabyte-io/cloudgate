import { describe, expect, it } from "vitest";
import { z } from "zod";

import { schemaIssues } from "./schema-issues";

describe("schemaIssues", () => {
  const schema = z.object({
    name: z.string().trim().min(1, "Name it."),
    id: z.string().regex(/^\d{3}$/, "Three digits."),
  });

  it("is null when the values pass", () => {
    expect(schemaIssues(schema, { name: "a", id: "123" })).toBeNull();
  });

  it("gives each refused field its first sentence", () => {
    expect(schemaIssues(schema, { name: " ", id: "12" })).toEqual({
      name: "Name it.",
      id: "Three digits.",
    });
  });
});
