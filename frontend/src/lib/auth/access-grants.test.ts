import { describe, expect, it } from "vitest";

import type { MemberWithUser } from "@/lib/api/endpoints/organizations";

import {
  entitlementsBody,
  grantsDiffer,
  seedGrants,
  strandedGrants,
  toggleEnvironment,
  toggleProject,
  toggleService,
  type AccessInventory,
} from "./access-grants";

/**
 * The three rules `PATCH /organizations/members/:id/entitlements` puts on its
 * caller, as assertions.
 *
 * The route **replaces per column** — an absent key leaves the column alone,
 * `[]` clears it — so a client that PATCHes a diff silently revokes everything
 * it did not mention. And `assertGrantsResolve` refuses the *whole* write with a
 * 404 if any submitted id no longer resolves, while a `member` row keeps ids for
 * deleted rows. "Send the whole set you read" and "send only ids that still
 * exist" are therefore both required, and this module is where they are
 * reconciled — which is why it is pure and tested here rather than living inside
 * the dialog's `useState`.
 */

const member = {
  id: "m1",
  accessedProjects: ["p1"],
  accessedEnvironments: ["e1"],
  accessedServices: ["s1"],
} as MemberWithUser;

/** Two Projects, two Environments each side, one Service under `e1`. */
function inventory(over: Partial<AccessInventory> = {}): AccessInventory {
  return {
    projects: ["p1", "p2"],
    environmentParent: new Map([
      ["e1", "p1"],
      ["e2", "p2"],
    ]),
    serviceParent: new Map([
      ["s1", "e1"],
      ["s2", "e2"],
    ]),
    projectsLoaded: new Set(["p1", "p2"]),
    environmentsLoaded: new Set(["e1", "e2"]),
    ...over,
  };
}

describe("seedGrants", () => {
  it("reads the member row's three columns as the dialog's defaults", () => {
    expect(seedGrants(member)).toEqual({
      projects: ["p1"],
      environments: ["e1"],
      services: ["s1"],
    });
  });
});

describe("the cascade", () => {
  it("ticks a Service's Environment and Project with it", () => {
    const inv = inventory();
    const start = { projects: [], environments: [], services: [] };

    expect(toggleService(start, "s2", true, inv)).toEqual({
      projects: ["p2"],
      environments: ["e2"],
      services: ["s2"],
    });
  });

  it("ticks an Environment's Project with it", () => {
    const inv = inventory();
    const start = { projects: [], environments: [], services: [] };

    expect(toggleEnvironment(start, "e2", true, inv)).toEqual({
      projects: ["p2"],
      environments: ["e2"],
      services: [],
    });
  });

  it("takes an unticked Project's Environments and Services with it", () => {
    const inv = inventory();
    const start = {
      projects: ["p1", "p2"],
      environments: ["e1", "e2"],
      services: ["s1", "s2"],
    };

    expect(toggleProject(start, "p1", false, inv)).toEqual({
      projects: ["p2"],
      environments: ["e2"],
      services: ["s2"],
    });
  });

  it("takes an unticked Environment's Services with it", () => {
    const inv = inventory();
    const start = {
      projects: ["p1"],
      environments: ["e1"],
      services: ["s1"],
    };

    expect(toggleEnvironment(start, "e1", false, inv)).toEqual({
      projects: ["p1"],
      environments: [],
      services: [],
    });
  });
});

describe("entitlementsBody", () => {
  it("sends all three keys every time, so no column is left to the server", () => {
    const body = entitlementsBody(
      { projects: ["p1"], environments: [], services: [] },
      inventory(),
    );

    // An absent key means "leave this column alone", which is the one thing
    // this dialog never wants to say — `[]` is how a column is cleared.
    expect(Object.keys(body).sort()).toEqual([
      "accessedEnvironments",
      "accessedProjects",
      "accessedServices",
    ]);
    expect(body.accessedEnvironments).toEqual([]);
    expect(body.accessedServices).toEqual([]);
  });

  it("sends the whole set it read, not the part that changed", () => {
    const inv = inventory();
    const after = toggleService(seedGrants(member), "s2", true, inv);
    const body = entitlementsBody(after, inv);

    // `s1` was never touched. A diff would omit it and the replace would
    // revoke it.
    expect(body.accessedServices.sort()).toEqual(["s1", "s2"]);
    expect(body.accessedProjects.sort()).toEqual(["p1", "p2"]);
  });

  it("drops a grant whose row no longer resolves, once its scope has loaded", () => {
    const grants = {
      projects: ["p1", "gone"],
      environments: ["e1"],
      services: ["s1"],
    };
    const inv = inventory();

    expect(strandedGrants(grants, inv).projects).toEqual(["gone"]);
    // The whole PATCH is refused `404 Project not found: gone` otherwise.
    expect(entitlementsBody(grants, inv).accessedProjects).toEqual(["p1"]);
  });

  it("does not call an id stranded while its scope is still unread", () => {
    const grants = {
      projects: ["p1"],
      environments: ["e1", "unread"],
      services: ["s1"],
    };
    // `p1`'s Environment list has not answered, so nothing here proves
    // `unread` is gone — absence of evidence is not a deleted Environment.
    const inv = inventory({
      environmentParent: new Map(),
      projectsLoaded: new Set(),
      environmentsLoaded: new Set(),
    });

    expect(strandedGrants(grants, inv).environments).toEqual([]);
    expect(entitlementsBody(grants, inv).accessedEnvironments.sort()).toEqual([
      "e1",
      "unread",
    ]);
  });
});

describe("grantsDiffer", () => {
  it("is false for the set the member already holds, whatever the order", () => {
    const body = entitlementsBody(
      { projects: ["p1"], environments: ["e1"], services: ["s1"] },
      inventory(),
    );
    expect(grantsDiffer(body, member)).toBe(false);
  });

  it("is true once a column is cleared", () => {
    const body = entitlementsBody(
      { projects: ["p1"], environments: ["e1"], services: [] },
      inventory(),
    );
    expect(grantsDiffer(body, member)).toBe(true);
  });
});
