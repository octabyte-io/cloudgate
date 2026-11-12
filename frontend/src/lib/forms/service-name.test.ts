import { describe, expect, it } from "vitest";

import { createAiModelSchema } from "@/features/application/create/create-ai-model-values";
import { createApplicationSchema } from "@/features/application/create/create-application-values";
import { databaseSchema } from "@/features/database/kinds";

import { SERVICE_NAME_MAX_LENGTH, serviceNameField } from "./service-name";

const AT_CAP = "a".repeat(SERVICE_NAME_MAX_LENGTH);
const OVER = "a".repeat(SERVICE_NAME_MAX_LENGTH + 1);

/** The `name` issues a schema raises for a body holding only that name. */
function nameIssues(
  schema: { safeParse: (value: unknown) => { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } } },
  name: string,
) {
  const result = schema.safeParse({ name });
  return (result.error?.issues ?? [])
    .filter((issue) => issue.path[0] === "name")
    .map((issue) => issue.message);
}

/**
 * A Service's name had no maximum on either side. The backend's
 * `SERVICE_NAME_MAX_LENGTH` is 100 (`backend/src/common/service-name.ts`), and
 * the forms say so beside the field rather than letting the request 400.
 */
describe("serviceNameField", () => {
  it("holds the backend's number", () => {
    expect(SERVICE_NAME_MAX_LENGTH).toBe(100);
  });

  it("takes a name at the cap, refuses one past it, and keeps the form's own words for a blank one", () => {
    const field = serviceNameField("A stack needs a name.");
    expect(field.safeParse(AT_CAP).success).toBe(true);
    expect(field.safeParse(OVER).error?.issues[0].message).toBe(
      "Keep the name to 100 characters or fewer.",
    );
    expect(field.safeParse("  ").error?.issues[0].message).toBe("A stack needs a name.");
  });

  it.each([
    ["the Application create form", createApplicationSchema],
    ["the AI model create form", createAiModelSchema],
    ["the database create form", databaseSchema("postgres", "create")],
    ["the database update form", databaseSchema("postgres", "update")],
  ])("caps the name on %s", (_, schema) => {
    expect(nameIssues(schema, OVER)).toEqual([
      "Keep the name to 100 characters or fewer.",
    ]);
    expect(nameIssues(schema, AT_CAP)).toEqual([]);
  });
});
