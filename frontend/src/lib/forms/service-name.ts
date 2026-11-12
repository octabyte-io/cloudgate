import { z } from "zod";

/**
 * The longest name a Service may carry, and the field that holds it.
 *
 * A copy of the backend's `SERVICE_NAME_MAX_LENGTH`
 * (`backend/src/common/service-name.ts`), which every Application, Compose and
 * database create and update DTO now holds `name` to. Why 100 is written there:
 * the display name is not what Docker sees (that is `appName`, a 63-character
 * DNS label), and 100 fits a descriptive label while still rendering in a table
 * cell, a dialog title and a toast. A 300-character name had pushed every other
 * column of the Services table about 2,000px off-screen.
 *
 * Checked here as well as there so the form says it beside the field instead
 * of the request coming back a 400.
 */
export const SERVICE_NAME_MAX_LENGTH = 100;

/** A Service's name field: trimmed, required in the form's own words, and capped. */
export function serviceNameField(required: string) {
  return z
    .string()
    .trim()
    .min(1, required)
    .max(
      SERVICE_NAME_MAX_LENGTH,
      `Keep the name to ${SERVICE_NAME_MAX_LENGTH} characters or fewer.`,
    );
}
