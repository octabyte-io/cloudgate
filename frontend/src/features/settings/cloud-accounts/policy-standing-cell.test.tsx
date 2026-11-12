import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { CloudAccount } from "@/lib/api/endpoints/cloud-accounts";

vi.mock("./use-cloud-accounts", () => ({
  useCloudAccountTemplate: () => ({ isPending: false, mutateAsync: vi.fn() }),
  useGoogleCloudAccountTemplate: () => ({
    isPending: false,
    mutateAsync: vi.fn(),
  }),
}));
const mode = vi.hoisted(() => ({
  data: "self-hosted" as "hosted" | "self-hosted",
}));
vi.mock("@/lib/api/use-instance-mode", () => ({ useInstanceMode: () => mode }));

const { PolicyStandingCell } = await import("./policy-standing-cell");

const CHECKED_AT_2: CloudAccount = {
  cloudAccountId: "ca1",
  organizationId: "org1",
  name: "Production AWS",
  cloud: "aws",
  cloudId: "123456789012",
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  hasSecretAccessKey: true,
  deployRoleArn: "arn:aws:iam::123456789012:role/cloudgate-deploy",
  taskExecutionRoleArn:
    "arn:aws:iam::123456789012:role/cloudgate-task-execution",
  externalId: "external-id-abc",
  policyVersion: 2,
  lastCheckedAt: "2026-10-01T00:00:00.000Z",
  lastCheckResult: "passed",
  lastCheckReason: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  currentPolicyVersion: 2,
  permissionsOutOfDate: false,
  missingActions: [],
};

/** The same Cloud account as the Hosted instance's version 3 reads it. */
const OUT_OF_DATE: CloudAccount = {
  ...CHECKED_AT_2,
  currentPolicyVersion: 3,
  permissionsOutOfDate: true,
  missingActions: ["codebuild:CreateProject", "codebuild:StartBuild"],
};

/** A Google Cloud project checked at role version 5, as the Hosted instance's version 6 reads it. */
const GOOGLE_OUT_OF_DATE: CloudAccount = {
  cloudAccountId: "ca2",
  organizationId: "org1",
  name: "Production Google",
  cloud: "gcp",
  cloudId: "shop-prod",
  projectNumber: "123456789012",
  workloadIdentityProvider:
    "projects/123456789012/locations/global/workloadIdentityPools/cloudgate/providers/cloudgate",
  deployServiceAccount: "cloudgate-deploy@shop-prod.iam.gserviceaccount.com",
  signingKeyId: "key-1",
  signingPublicKey: "{}",
  hasSigningKey: true,
  hasPendingSigningKey: false,
  tokenIssuer: "https://cloudgate.example.com/shop-prod",
  policyVersion: 5,
  lastCheckedAt: "2026-10-01T00:00:00.000Z",
  lastCheckResult: "passed",
  lastCheckReason: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  currentPolicyVersion: 6,
  permissionsOutOfDate: true,
  missingActions: [
    "cloudbuild.builds.create",
    "cloudbuild.builds.get",
    "cloudbuild.builds.list",
    "cloudbuild.builds.update",
  ],
};

afterEach(() => {
  cleanup();
  mode.data = "self-hosted";
});

/**
 * A hosted cloud build needs a newer policy version, so on the Hosted
 * instance a Cloud account checked against the older one is told to re-run
 * its setup before it deploys, with the new template one click away. A
 * Self-hosted instance never needs the newer version and says nothing new.
 */
describe("PolicyStandingCell", () => {
  it("tells a Hosted instance's out-of-date Cloud account to re-run setup before its first cloud deploy", () => {
    mode.data = "hosted";
    render(<PolicyStandingCell account={OUT_OF_DATE} allowed />);

    expect(
      screen.getByText(
        "Re-run setup before this Cloud account's next cloud deploy (v2, needs v3)",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText("codebuild:CreateProject, codebuild:StartBuild"),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "New CloudFormation template" }),
    ).toBeTruthy();
  });

  it("keeps a Self-hosted instance's wording for an out-of-date one", () => {
    render(<PolicyStandingCell account={OUT_OF_DATE} allowed />);

    expect(
      screen.getByText("Permissions out of date (v2, needs v3)"),
    ).toBeTruthy();
    expect(screen.queryByText(/Re-run setup/)).toBeNull();
  });

  it("asks nothing of a Self-hosted instance's Cloud account at version 2", () => {
    render(<PolicyStandingCell account={CHECKED_AT_2} allowed />);

    expect(screen.getByText("Policy v2")).toBeTruthy();
    expect(screen.queryByText(/Re-run setup|out of date/)).toBeNull();
  });

  it("tells a Hosted instance's out-of-date Google Cloud account to re-run its setup script before its first cloud deploy", () => {
    mode.data = "hosted";
    render(<PolicyStandingCell account={GOOGLE_OUT_OF_DATE} allowed />);

    expect(
      screen.getByText(
        "Re-run setup before this Cloud account's next cloud deploy (v5, needs v6)",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "cloudbuild.builds.create, cloudbuild.builds.get, cloudbuild.builds.list, cloudbuild.builds.update",
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "New setup script" }),
    ).toBeTruthy();
  });

  it("asks nothing of a Self-hosted instance's Google Cloud account at version 5", () => {
    render(
      <PolicyStandingCell
        account={{
          ...GOOGLE_OUT_OF_DATE,
          currentPolicyVersion: 5,
          permissionsOutOfDate: false,
          missingActions: [],
        }}
        allowed
      />,
    );

    expect(screen.getByText("Role v5")).toBeTruthy();
    expect(screen.queryByText(/Re-run setup|out of date/)).toBeNull();
  });
});
