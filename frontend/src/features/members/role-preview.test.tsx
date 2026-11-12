import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { RoleVocabulary } from "@/lib/api/endpoints/roles";

import { RolePreview } from "./role-preview";

/**
 * Which of the three things this panel can say it says, and when.
 *
 * The defect was one branch doing two jobs: the fallback rendered *"Cloudgate
 * could not read the permission table"* whenever `vocabulary` was `undefined`,
 * and a read in flight is `undefined` too. So an operator opening the
 * change-role dialog on a cold cache was told a read had failed during the
 * round trip that was still happening. CODING_STANDARDS §3.5 orders the
 * terminal states `error` → `isPending` → `empty` for exactly this, and §3.10
 * makes picking the wrong one a defect in its own right.
 *
 * **Both directions are asserted, because a test for the pending render alone
 * cannot fail against the fix that deletes the error branch.** The pending case
 * has to show the skeleton *and* not the sentence; the failed case has to show
 * the sentence *and* not the skeleton.
 *
 * `RolePreview` takes plain props rather than reading the query itself, so these
 * are three renders of a pure component. That the dialog hands it the right
 * ones is `change-role-modal.test.tsx`' question.
 */

const VOCABULARY: RoleVocabulary = {
  statements: {
    service: ["create", "read", "update", "delete"],
    auditLog: ["read"],
    team: ["create", "update", "delete"],
  },
  staticRoles: { member: { service: ["read", "update"] } },
  enterpriseOnlyResources: ["auditLog"],
  internalResources: ["team"],
};

/** The sentence that must not appear while the read is still in flight. */
const REFUSAL = /could not read the permission table/i;

afterEach(cleanup);

describe("RolePreview", () => {
  it("renders the grid once the vocabulary has arrived", () => {
    const { container } = render(
      <RolePreview
        role="member"
        permissions={{ service: ["read", "update"] }}
        vocabulary={VOCABULARY}
        pending={false}
      />,
    );

    expect(screen.getByText("Audit log")).toBeDefined();
    expect(screen.queryByText(REFUSAL)).toBeNull();
    expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(
      0,
    );
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
  });

  /**
   * The case the issue is about. The panel is `aria-busy` and the bars stand in
   * for the rows, and the one thing it must not do is claim the read failed.
   */
  it("stands rows in while the vocabulary is still being read", () => {
    const { container } = render(
      <RolePreview
        role="member"
        permissions={{}}
        vocabulary={undefined}
        pending
      />,
    );

    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
    const bars = container.querySelectorAll('[data-slot="skeleton"]');
    expect(bars.length).toBeGreaterThan(0);
    // §3.10: a screen reader gets nothing from grey rectangles, so the region
    // carries the state and the bars are hidden.
    for (const bar of bars) {
      expect(bar.getAttribute("aria-hidden")).toBe("true");
    }
    expect(screen.queryByText(REFUSAL)).toBeNull();
    // And the heading stays, so the panel does not appear and disappear.
    expect(screen.getByText("What member is allowed to do")).toBeDefined();
  });

  /**
   * The half that keeps the case above honest: a read that has actually failed
   * still says so. Deleting the fallback would pass the pending test and fail
   * this one.
   */
  it("says the read failed once the read has finished without a vocabulary", () => {
    const { container } = render(
      <RolePreview
        role="member"
        permissions={{}}
        vocabulary={undefined}
        pending={false}
      />,
    );

    expect(screen.getByText(REFUSAL)).toBeDefined();
    expect(container.querySelectorAll('[data-slot="skeleton"]')).toHaveLength(
      0,
    );
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
  });
});
