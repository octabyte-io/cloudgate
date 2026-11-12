import type { AskedInput } from "@/lib/api/endpoints/templates";

/**
 * An asked value's one check, as the form applies it before Submit: the same
 * rules as the backend's `askedValueProblem` (`templates/check/template-inputs.ts`),
 * which setup applies again and whose word is final. Written out here because
 * the console cannot import the backend; the two read alike so the form says
 * what the setup would.
 */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Config name rules, as the setup name must follow them. */
export const SETUP_NAME = /^[a-z][a-z0-9-]{0,62}$/;

/** Why `value` cannot be this input's, or null when it can. */
export function askedValueProblem(
  input: AskedInput,
  value: string,
): string | null {
  if (value === "") {
    return input.required ? `${input.label} is required` : null;
  }
  switch (input.format) {
    case "email":
      return EMAIL.test(value)
        ? null
        : `${input.label} must be an email address`;
    case "url":
      return isHttpUrl(value)
        ? null
        : `${input.label} must be an http or https address`;
    case "number":
      return value.trim() !== "" && Number.isFinite(Number(value))
        ? null
        : `${input.label} must be a number`;
  }
  if (input.pattern !== null) {
    try {
      return new RegExp(`^(?:${input.pattern})$`, "u").test(value)
        ? null
        : `${input.label} must match ${input.pattern}`;
    } catch {
      // A pattern the browser cannot read: the setup checks it.
      return null;
    }
  }
  return null;
}

function isHttpUrl(value: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}
