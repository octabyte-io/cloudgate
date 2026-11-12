import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * **The census: a placeholder that looks like a value says "e.g.".**
 *
 * `storefront` in Database name, `nightly` in Prefix, `7` in Keep, `5432`
 * under a port no one had published and `Ops on-call` in a channel's Name all
 * looked typed in, and like defaults that would be used, until the submit said
 * the field was empty. So a placeholder that is a plain word, name, number or
 * sentence goes through `example()` ("e.g. nightly"). A format a value could not
 * be mistaken for — a URL, an address, a cron line, a path — may stay bare, and
 * so may a prompt ("Choose a destination").
 *
 * Read off the source, so placeholder N+1 arrives through this test.
 */
const SRC = join(__dirname, "..", "..");

/** A literal that reads like a value someone typed: words, digits, spaces. */
const PLAIN = /^[A-Za-z0-9][A-Za-z0-9 ,'-]*$/;
/**
 * A prompt for a picker or a search box, or a field's state ("Unchanged" on a
 * password an empty save keeps), which no one reads as a value.
 */
const PROMPT =
  /^(Choose|Search|Filter|No |This Cloudgate host|Keep it on|Clone over|Build where|Leave blank|Name, address|Unchanged$)/;

/** Whole files left out, and why. */
const EXEMPT: Record<string, string> = {
  "components/console/engine-limit-fields.tsx":
    "the CPU and memory limits, rewritten in human units, which own their copy",
  "features/application/source/":
    "the Application source form, whose placeholders are its own ticket's (and a builder's are the default an empty box takes)",
  "features/settings/account/enrol-two-factor-modal.tsx":
    "000000 is the shape of a one-time code",
  "features/enterprise/license/activate-license-form.tsx":
    "CG-XXXX-XXXX-XXXX is the shape of a licence key",
  "features/settings/cloud-accounts/connect-cloud-account-modal.tsx":
    "123456789012 is the shape of an AWS account id",
  "features/settings/cloud-accounts/connect-google-project.tsx":
    "my-project-123 is the shape of a Google project id",
  "features/service-health/uptime-check-spec.tsx":
    "2xx and Authorization are a status class and a header name, formats rather than values",
};

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !entry.name.includes(".test.")
      ? [path]
      : [];
  });
}

const LITERAL = /placeholder(?:=|: )"([^"]*)"/g;

describe("placeholders", () => {
  const files = sources(SRC)
    .map((path) => relative(SRC, path))
    .filter(
      (file) =>
        !file.startsWith(join("app", "dev")) &&
        !file.startsWith(join("components", "ui")) &&
        !Object.keys(EXEMPT).some((prefix) => file.startsWith(prefix)),
    );

  it("found the console's source to read", () => {
    expect(files.length).toBeGreaterThan(300);
  });

  it("write a value-like example with example(), never bare", () => {
    const bare = files.flatMap((file) =>
      [...readFileSync(join(SRC, file), "utf8").matchAll(LITERAL)]
        .map((match) => match[1])
        .filter((value) => PLAIN.test(value) && !PROMPT.test(value))
        .map((value) => `${file}: ${value}`),
    );
    expect(bare).toEqual([]);
  });

  it("exempt only paths that exist", () => {
    const all = sources(SRC).map((path) => relative(SRC, path));
    for (const prefix of Object.keys(EXEMPT)) {
      expect(all.some((file) => file.startsWith(prefix)), prefix).toBe(true);
    }
  });
});
