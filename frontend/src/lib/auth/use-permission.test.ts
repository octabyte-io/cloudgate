import { describe, expect, it } from "vitest";

import type { CustomRole, RoleVocabulary } from "@/lib/api/endpoints/roles";

import { ApiError } from "@/lib/api/api-error";

import { permissionVerdict, readGate } from "./use-permission";

/**
 * Whether the console offers a control, decided from the caller's role and the
 * statements a surface needs.
 *
 * Pinned as a table for `console-gate.test.ts`'s reason: both ways of getting
 * it wrong are quiet. Too generous and the gate buys nothing — the member still
 * fills the form and still meets the 403. Too strict and an
 * owner loses Save with nothing to explain it, which is strictly worse than the
 * bug being fixed, because a refusal at least says something.
 *
 * The mirror this has to hold is `PermissionService.checkPermission`: static
 * roles from the served vocabulary's `staticRoles`, custom roles from
 * `GET /custom-roles` with their rows already unioned, and the enterprise-only
 * bypass for owner and admin.
 *
 * ## The vocabulary is a fixture here, and that is the point
 *
 * The static
 * roles' grants once were a module constant this file imported, so these cases were
 * testing the function *and* asserting the constant's contents at the same time
 * — and when the constant drifted the tests went on passing, which
 * is how a table of thirteen cases missed two releases of wrong answers. The
 * grants arrive over the wire now, so {@link VOCABULARY} below is a hand-written
 * fixture (§1.7) and these cases are about the decision alone. Whether the real
 * vocabulary says what it should is asserted where both sides of that comparison
 * exist, in `test/enterprise/custom-roles/custom-role.e2e-spec.ts`.
 *
 * **The three cases at the end are the served vocabulary's own risk.** A static
 * role's verdict now waits on a request, and an unread grant map has the same
 * shape as an empty one — so answering "not allowed" from the first would take
 * Save off an owner for a round trip and reintroduce the old symptom in the fix
 * for it (§3.5, "a refusal is not an empty list").
 */

/**
 * What `GET /custom-roles/statements` serves, hand-written.
 *
 * Only what the cases below ask about, and deliberately not the whole
 * catalogue: a fixture that tried to be the real vocabulary would be the fourth
 * copy, deleted, wearing a test's clothes.
 */
const VOCABULARY: RoleVocabulary = {
  statements: {
    project: ["create", "update", "delete"],
    service: ["create", "read", "update", "delete"],
    environment: ["create", "read", "update", "delete"],
    server: ["read", "create", "delete"],
    auditLog: ["read"],
  },
  staticRoles: {
    owner: {
      project: ["create", "update", "delete"],
      service: ["create", "read", "update", "delete"],
      environment: ["create", "read", "update", "delete"],
      server: ["read", "create", "delete"],
      auditLog: ["read"],
    },
    admin: {
      project: ["create", "update", "delete"],
      service: ["create", "read", "update", "delete"],
      environment: ["create", "read", "update", "delete"],
      server: ["read", "create", "delete"],
      auditLog: ["read"],
    },
    member: {
      project: [],
      service: ["read", "update"],
      environment: ["read", "update"],
      server: [],
      auditLog: [],
    },
  },
  enterpriseOnlyResources: ["server", "auditLog"],
  internalResources: ["organization", "invitation", "team", "ac"],
};

const UNREAD = {
  role: null,
  pending: true,
  customRoles: undefined,
  vocabulary: undefined,
};

/** The two statements the first gated surfaces use. */
const PROJECT_UPDATE = { project: ["update"] };
const SERVICE_CREATE = { service: ["create"] };

function asRole(role: string, customRoles?: CustomRole[]) {
  return { role, pending: false, customRoles, vocabulary: VOCABULARY };
}

function custom(role: string, permissions: Record<string, string[]>) {
  return {
    role,
    permissions,
    createdAt: "2026-01-01T00:00:00.000Z",
    ids: ["r1"],
    memberCount: 1,
  } satisfies CustomRole;
}

describe("permissionVerdict", () => {
  it("offers the control while the caller's role is unread, and says it is a guess", () => {
    const verdict = permissionVerdict(UNREAD, PROJECT_UPDATE);

    // Fail open, deliberately: the backend is the authorization and it will
    // refuse if this guess is wrong. Guessing the other way takes Save off an
    // owner for a round trip and has no refusal to explain itself with.
    expect(verdict.allowed).toBe(true);
    expect(verdict.pending).toBe(true);
    expect(verdict.role).toBe(null);
  });

  it("refuses a base member the Project write it no longer holds", () => {
    const verdict = permissionVerdict(asRole("member"), PROJECT_UPDATE);

    expect(verdict.allowed).toBe(false);
    // Not pending: the answer is known and the surface may act on it.
    expect(verdict.pending).toBe(false);
    expect(verdict.role).toBe("member");
  });

  it("refuses a base member the Service create a template preview asks for", () => {
    expect(permissionVerdict(asRole("member"), SERVICE_CREATE).allowed).toBe(
      false,
    );
  });

  it("allows an owner and an admin both writes", () => {
    for (const role of ["owner", "admin"]) {
      expect(permissionVerdict(asRole(role), PROJECT_UPDATE).allowed).toBe(true);
      expect(permissionVerdict(asRole(role), SERVICE_CREATE).allowed).toBe(true);
    }
  });

  it("keeps the member's own grants intact", () => {
    // The negative assertion the two above are worth little without: this is
    // reading the real grant map and not answering "member ⇒ no".
    expect(permissionVerdict(asRole("member"), { service: ["read"] }).allowed).toBe(
      true,
    );
    expect(
      permissionVerdict(asRole("member"), { environment: ["update"] }).allowed,
    ).toBe(true);
  });

  it("requires every action of every resource asked about", () => {
    // A second statement beside the first, which a surface adds by
    // adding a key. A role holding one half of the pair is refused the pair.
    const both = { service: ["create"], server: ["read"] };

    expect(permissionVerdict(asRole("owner"), both).allowed).toBe(true);
    expect(permissionVerdict(asRole("member"), both).allowed).toBe(false);
    expect(
      permissionVerdict(asRole("member"), { service: ["read", "create"] }).allowed,
    ).toBe(false);
  });

  it("reads a licensed custom role's own grants rather than a role name", () => {
    const roles = [custom("auditor", { project: ["update"], service: ["read"] })];

    expect(permissionVerdict(asRole("auditor", roles), PROJECT_UPDATE).allowed).toBe(
      true,
    );
    // `service: ['read']` no longer authorizes a definition write, and it
    // never authorized minting one. The same role, refused the other statement.
    expect(permissionVerdict(asRole("auditor", roles), SERVICE_CREATE).allowed).toBe(
      false,
    );
  });

  it("holds while a custom role's grants are still being read", () => {
    const verdict = permissionVerdict(
      {
        role: "auditor",
        pending: true,
        customRoles: undefined,
        vocabulary: VOCABULARY,
      },
      PROJECT_UPDATE,
    );

    expect(verdict.allowed).toBe(true);
    expect(verdict.pending).toBe(true);
  });

  it("offers the control for a custom role this console cannot resolve", () => {
    // What a lapsed enterprise licence looks like from here: the
    // `organization_role` rows survive the lapse, `GET /custom-roles` still
    // answers, and `resolveRole` refuses the holder outright. Nothing on this
    // side can see the licence, so the caller meets that refusal — which every
    // gated surface now renders as a sentence — rather than being locked out of
    // a control by a guess.
    const verdict = permissionVerdict(asRole("auditor", []), PROJECT_UPDATE);

    expect(verdict.allowed).toBe(true);
    expect(verdict.pending).toBe(false);
  });

  it("skips the check for an owner asking only about enterprise-only resources", () => {
    // `checkPermission`'s own first branch, mirrored: those statements constrain
    // licensed custom roles and a static role never has them checked at all.
    expect(permissionVerdict(asRole("owner"), { auditLog: ["read"] }).allowed).toBe(
      true,
    );
    // And not for a member, who is not privileged — the grant map answers, and
    // `member` holds no `auditLog`.
    expect(permissionVerdict(asRole("member"), { auditLog: ["read"] }).allowed).toBe(
      false,
    );
  });

  it("refuses an unknown resource for a role whose grants are known", () => {
    // A misspelled statement is refused rather than waved through: the grant map
    // has no key for it, so nothing authorizes it. It fails towards the refusal
    // the backend would give a resource that does not exist either.
    expect(permissionVerdict(asRole("owner"), { projects: ["update"] }).allowed).toBe(
      false,
    );
  });

  /**
   * The served vocabulary's own three cases. A static role's grants used to be
   * a module constant and are now a request, so there is a moment — the first
   * paint of every gated surface — where the role is known and its grants are
   * not. An unread grant map and an empty one are the same shape, and answering
   * "not allowed" from the first is exactly the wrong answer once shipped, in
   * the change that removes its cause.
   */
  it("offers a base member the control while the served grants are still in flight", () => {
    const verdict = permissionVerdict(
      {
        role: "member",
        pending: true,
        customRoles: undefined,
        vocabulary: undefined,
      },
      PROJECT_UPDATE,
    );

    // `member` really is refused this by the backend — the case above asserts
    // it — so this is the one place the hook is knowingly generous, and it says
    // so through `pending` rather than by pretending to know.
    expect(verdict.allowed).toBe(true);
    expect(verdict.pending).toBe(true);
    expect(verdict.role).toBe("member");
  });

  it("offers an owner every control when the vocabulary read failed outright", () => {
    // Not pending any more: the read is over and answered nothing. Failing
    // closed here would leave Save off an owner's screen for the rest of the
    // session with no refusal to explain it.
    for (const role of ["owner", "admin", "member"]) {
      const verdict = permissionVerdict(
        {
          role,
          pending: false,
          customRoles: undefined,
          vocabulary: undefined,
        },
        PROJECT_UPDATE,
      );

      // The whole verdict, so the role it echoes back names the failing case.
      expect(verdict).toEqual({ role, allowed: true, pending: false });
    }
  });

  it("does not refuse an enterprise-only question before the bypass set has arrived", () => {
    // The owner/admin bypass reads `enterpriseOnlyResources`, so an unread
    // vocabulary makes that branch unreachable. Both paths have to agree in the
    // allowing direction, or the branch's absence would become a refusal.
    expect(
      permissionVerdict(
        {
          role: "owner",
          pending: true,
          customRoles: undefined,
          vocabulary: undefined,
        },
        { auditLog: ["read"] },
      ).allowed,
    ).toBe(true);
  });
});

/**
 * The rule's case 2: a surface no statement names is gated by the read
 * beside it that takes the same authority. Only a 403 turns it off — anything
 * else says nothing about the caller, and the control stays live.
 */
describe("readGate", () => {
  it("turns a control off with the backend's own sentence on a 403", () => {
    const gate = readGate({
      error: new ApiError(403, "Only an owner or admin of the instance organization can configure the platform host"),
    });
    expect(gate.allowed).toBe(false);
    expect(gate.refusal).not.toBe("");
  });

  it("leaves it live while the read is in flight or failed for another reason", () => {
    expect(readGate({ error: null }).allowed).toBe(true);
    expect(readGate({ error: new ApiError(500, "boom") }).allowed).toBe(true);
    expect(readGate({ error: new TypeError("Failed to fetch") }).allowed).toBe(true);
  });
});
