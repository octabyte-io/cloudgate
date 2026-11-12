import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/api-error";
import type {
  GcpCloudAccount,
  GoogleKeyChanged,
  GoogleNewKey,
} from "@/lib/api/endpoints/cloud-accounts";

const makeKey = vi.fn();
const checkKey = vi.fn();
const downloadGoogleSetup = vi.fn();
const downloadNewOnlyJwks = vi.fn();

vi.mock("./use-cloud-accounts", () => ({
  useNewCloudAccountKey: () => ({ isPending: false, mutateAsync: makeKey }),
  useCheckNewCloudAccountKey: () => ({
    isPending: false,
    mutateAsync: checkKey,
  }),
}));

vi.mock("./download-template", () => ({
  downloadGoogleSetup: (...args: unknown[]) => downloadGoogleSetup(...args),
  downloadNewOnlyJwks: (...args: unknown[]) => downloadNewOnlyJwks(...args),
}));

const { NewKeyModal } = await import("./new-key-modal");

const PROVIDER =
  "projects/123456789012/locations/global/workloadIdentityPools/cloudgate-abc/providers/cloudgate-abc";

const ACCOUNT: GcpCloudAccount = {
  cloudAccountId: "ca1",
  organizationId: "org1",
  name: "Production Google",
  cloud: "gcp",
  cloudId: "shop-prod",
  projectNumber: "123456789012",
  workloadIdentityProvider: PROVIDER,
  deployServiceAccount:
    "cloudgate-deploy-abc@shop-prod.iam.gserviceaccount.com",
  signingKeyId: "key-1",
  signingPublicKey: '{"kid":"key-1"}',
  hasSigningKey: true,
  hasPendingSigningKey: false,
  tokenIssuer: "https://cloudgate.example.com/ca1",
  policyVersion: 1,
  lastCheckedAt: "2026-10-01T00:00:00.000Z",
  lastCheckResult: "passed",
  lastCheckReason: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  currentPolicyVersion: 1,
  permissionsOutOfDate: false,
  missingActions: [],
};

const MADE: GoogleNewKey = {
  signingKeyId: "key-2",
  signingPublicKey: '{"kid":"key-2"}',
  template: {
    policyVersion: 1,
    script: "#!/usr/bin/env bash",
    jwks: '{"keys":[{"kid":"key-1"},{"kid":"key-2"}]}',
    roleDefinition: "title: Cloudgate deploy",
    names: {
      pool: "cloudgate-abc",
      provider: "cloudgate-abc",
      role: "cloudgate_deploy_abc",
      serviceAccount: "cloudgate-deploy-abc",
      serviceAccountEmail:
        "cloudgate-deploy-abc@shop-prod.iam.gserviceaccount.com",
    },
  },
};

const CHANGED: GoogleKeyChanged = {
  cloudAccount: { ...ACCOUNT, signingKeyId: "key-2" },
  jwks: '{"keys":[{"kid":"key-2"}]}',
  message: `Cloud account Production Google now signs with key key-2. Upload the JWKS that holds only the new key to provider ${PROVIDER}, so the old key is no longer trusted`,
};

beforeEach(() => {
  makeKey.mockReset().mockResolvedValue(MADE);
  checkKey.mockReset().mockResolvedValue(CHANGED);
  downloadGoogleSetup.mockReset();
  downloadNewOnlyJwks.mockReset();
});

afterEach(cleanup);

/**
 * A new key is offered beside the old one, checked, and only
 * then switched to, with the reminder to upload the new-only JWKS.
 */
describe("NewKeyModal", () => {
  it("offers the JWKS with both keys, then switches and offers the new-only one", async () => {
    render(<NewKeyModal account={ACCOUNT} onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Make a new key" }));
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Download the JWKS with both keys",
      }),
    );
    expect(makeKey).toHaveBeenCalledWith("ca1");
    expect(downloadGoogleSetup).toHaveBeenCalledWith(
      "ca1",
      MADE.template,
      "jwks",
    );
    expect(screen.getByText("key-2")).toBeDefined();

    fireEvent.click(
      screen.getByRole("button", { name: "Check with the new key" }),
    );
    expect(
      await screen.findByText(/Upload the JWKS that holds only the new key/),
    ).toBeDefined();
    fireEvent.click(
      screen.getByRole("button", { name: "Download the new-only JWKS" }),
    );
    expect(downloadNewOnlyJwks).toHaveBeenCalledWith(
      "ca1",
      "key-2",
      CHANGED.jwks,
    );
  });

  it("keeps the dialog on the waiting key when its check fails", async () => {
    checkKey.mockRejectedValue(
      new ApiError(400, "Google's STS refused this Cloud account's token"),
    );
    render(
      <NewKeyModal
        account={{ ...ACCOUNT, hasPendingSigningKey: true }}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Check with the new key" }),
    );

    expect(await screen.findByText(/STS refused/)).toBeDefined();
    expect(makeKey).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: "Check with the new key" }),
    ).toBeDefined();
  });
});
