import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  AUDIT_ACTIONS,
  AUDIT_ACTORS,
  AUDIT_OUTCOMES,
  AUDIT_RESOURCE_TYPES,
  PLATFORM_ACTOR_ROLE,
} from "./audit-logs";
import { AGENT_ROLES } from "./roles";

/**
 * The console's copy of the trail's vocabulary against the backend's.
 *
 * The Kind and Action filters are built from these two lists. The backend's
 * census holds its lists equal to what is actually written; this holds the
 * console's equal to the backend's, so a kind the backend drops (or adds) is
 * not left offered (or missing) here.
 */
const SCHEMA = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../backend/src/enterprise/audit-logs/audit-log.schema.ts",
);

const DTO = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../backend/src/enterprise/audit-logs/dto/audit-log.dto.ts",
);

const PLATFORM_ACTOR = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../backend/src/enterprise/audit-logs/platform-actor.ts",
);

const ACCESS_CONTROL = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../backend/src/rbac/access-control.ts",
);

function backendList(name: string, file = SCHEMA): string[] {
  const source = readFileSync(file, "utf8");
  const body = new RegExp(`export const ${name} = \\[([^\\]]*)\\]`).exec(
    source,
  )?.[1];
  if (!body) throw new Error(`${name} not found in ${file}`);
  return [...body.matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

describe("AUDIT_RESOURCE_TYPES", () => {
  it("is the backend's list, verbatim and in order", () => {
    expect([...AUDIT_RESOURCE_TYPES]).toEqual(
      backendList("AUDIT_RESOURCE_TYPES"),
    );
  });
});

describe("AUDIT_ACTIONS", () => {
  it("is the backend's list, verbatim and in order", () => {
    expect([...AUDIT_ACTIONS]).toEqual(backendList("AUDIT_ACTIONS"));
  });
});

describe("AUDIT_OUTCOMES", () => {
  it("is the backend's list, verbatim and in order", () => {
    expect([...AUDIT_OUTCOMES]).toEqual(backendList("AUDIT_OUTCOMES"));
  });
});

describe("AUDIT_ACTORS", () => {
  it("is the backend's list, verbatim and in order", () => {
    expect([...AUDIT_ACTORS]).toEqual(backendList("AUDIT_ACTORS", DTO));
  });
});

/**
 * The console tells the platform's row from a person's by its role, so
 * a different word here would render the platform as a person with no address.
 */
describe("PLATFORM_ACTOR_ROLE", () => {
  it("is the backend's role, verbatim", () => {
    const source = readFileSync(PLATFORM_ACTOR, "utf8");
    expect(source).toContain(
      `export const PLATFORM_ACTOR_ROLE = '${PLATFORM_ACTOR_ROLE}';`,
    );
  });
});

/**
 * The audit log tells an Agent's row from a person's by its role, so a
 * role the backend makes Agent-only and this list lacks would render that
 * Agent's synthetic address as if it were a person's.
 */
describe("AGENT_ROLES", () => {
  it("is the backend's list, verbatim and in order", () => {
    expect([...AGENT_ROLES]).toEqual(
      backendList("AGENT_ROLES", ACCESS_CONTROL),
    );
  });
});
