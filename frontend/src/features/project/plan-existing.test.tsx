import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { CloudRead, Plan } from "@/lib/api/endpoints/project-config";

import { ExistingLookups, isLookupOnly } from "./plan-existing";

afterEach(cleanup);

function planWith(
  cloudRead: CloudRead,
  fields: { field: string; from: unknown; to: unknown }[] = [],
): Plan {
  return {
    planId: "plan-1",
    environmentId: "env-1",
    source: "save",
    textHash: "sha256:abc",
    commitSha: null,
    branch: null,
    baseTextHash: "sha256:abc",
    settingsFingerprint: "sha256:def",
    status: "open",
    results: null,
    requestedBy: "user-1",
    createdAt: "2026-10-17T09:00:00.000Z",
    appliedBy: null,
    appliedAt: null,
    dismissedBy: null,
    dismissedAt: null,
    notes: [],
    steps: [
      {
        action: "change",
        configName: "pg-1",
        kind: "postgres",
        serviceType: "postgres",
        serviceId: "pg-id",
        name: "pg-1",
        fields,
        existing: { identifier: "acme-prod", version: "postgres:17" },
        cloudRead,
      },
    ],
  } as Plan;
}

const found: CloudRead = {
  status: "read",
  summary: [
    "pg-1: existing database acme-prod, PostgreSQL 16.4, at acme-prod.example:5432; used as given, Cloudgate changes nothing in it",
    "pg-1: acme-prod runs PostgreSQL 16.4, and the config's version is 17; the version is not applied to an existing database",
  ],
  raw: [],
  counts: {
    create: 0,
    change: 0,
    destroy: 0,
    replace: 0,
    drift: 0,
    adopt: 0,
    briefDowntime: 0,
  },
  drift: [],
  adopt: [],
  noState: [],
  imageOnly: false,
  stateId: "ed-1",
  readAt: "2026-10-17T09:00:00.000Z",
};

describe("ExistingLookups", () => {
  it("shows what the lookup found, its notes included, though nothing changes", () => {
    const plan = planWith(found);
    render(<ExistingLookups plan={plan} />);

    expect(
      screen.getByRole("region", { name: "Existing databases" }),
    ).toBeTruthy();
    expect(screen.getByText(found.summary[1])).toBeTruthy();
    expect(isLookupOnly(plan.steps[0])).toBe(true);
  });

  it("shows why the plan is refused when the lookup failed", () => {
    render(
      <ExistingLookups
        plan={planWith({
          status: "failed",
          reason:
            "pg-1 uses the existing database acme-prod, but AWS has no RDS instance acme-prod",
        })}
      />,
    );

    expect(screen.getByText(/AWS has no RDS instance acme-prod/)).toBeTruthy();
  });

  it("is not a lookup only when the config changes what Cloudgate keeps", () => {
    const plan = planWith(found, [
      { field: "description", from: null, to: "orders" },
    ]);

    expect(isLookupOnly(plan.steps[0])).toBe(false);
  });
});

describe("ExistingLookups, an existing bucket", () => {
  it("names the section for buckets and shows what the lookup found", () => {
    const plan = planWith({
      ...found,
      summary: [
        "uploads: existing bucket acme-prod-uploads in eu-west-1; used as given, Cloudgate changes nothing in it — no CORS, versioning or encryption — and makes nothing in it",
      ],
    });
    const bucketPlan = {
      ...plan,
      steps: plan.steps.map((step) => ({
        ...step,
        configName: "uploads",
        kind: "bucket",
        serviceType: "bucket",
        existing: { identifier: "acme-prod-uploads", version: null },
      })),
    } as Plan;
    render(<ExistingLookups plan={bucketPlan} />);

    expect(
      screen.getByRole("region", { name: "Existing buckets" }),
    ).toBeTruthy();
    expect(screen.getByText(/no CORS, versioning or encryption/)).toBeTruthy();
    expect(isLookupOnly(bucketPlan.steps[0])).toBe(true);
  });
});
