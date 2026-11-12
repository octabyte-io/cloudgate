import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/api-error";
import type { GcpCloudAccount } from "@/lib/api/endpoints/cloud-accounts";

const mutateAsync = vi.fn();

vi.mock("./use-cloud-accounts", () => ({
  useUpdateCloudAccount: () => ({ isPending: false, mutateAsync }),
}));

const { EditGoogleCloudAccountModal } =
  await import("./edit-google-cloud-account-modal");

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

function field(name: RegExp) {
  return screen.getByLabelText(name);
}

beforeEach(() => {
  mutateAsync.mockReset();
  mutateAsync.mockResolvedValue(ACCOUNT);
});

afterEach(cleanup);

/**
 * A Google Cloud account's edit sends only what changed, and a
 * changed provider or service account is checked before it is saved.
 */
describe("EditGoogleCloudAccountModal", () => {
  it("sends a rename alone, naming the cloud", async () => {
    const onClose = vi.fn();
    render(<EditGoogleCloudAccountModal account={ACCOUNT} onClose={onClose} />);

    fireEvent.change(field(/^Name/), { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mutateAsync).toHaveBeenCalledWith({ cloud: "gcp", name: "Renamed" });
  });

  it("checks a new service account before saving it", async () => {
    render(<EditGoogleCloudAccountModal account={ACCOUNT} onClose={vi.fn()} />);

    fireEvent.change(field(/^Deploy service account/), {
      target: { value: "other-sa@shop-prod.iam.gserviceaccount.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Check and save" }));

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        cloud: "gcp",
        deployServiceAccount: "other-sa@shop-prod.iam.gserviceaccount.com",
      }),
    );
  });

  it("keeps the dialog open with the refusal when the re-check fails", async () => {
    mutateAsync.mockRejectedValue(
      new ApiError(400, "Cloudgate cannot act as the deploy service account"),
    );
    const onClose = vi.fn();
    render(<EditGoogleCloudAccountModal account={ACCOUNT} onClose={onClose} />);

    fireEvent.change(field(/^Workload identity provider/), {
      target: { value: `${PROVIDER}-2` },
    });
    fireEvent.click(screen.getByRole("button", { name: "Check and save" }));

    expect(await screen.findByText(/cannot act as/)).toBeDefined();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("offers nothing to save until something changes, and shows what never changes", () => {
    render(<EditGoogleCloudAccountModal account={ACCOUNT} onClose={vi.fn()} />);

    expect(
      screen
        .getByRole("button", { name: "Save" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    expect(screen.getByText("shop-prod")).toBeDefined();
    expect(screen.getByText("key-1")).toBeDefined();
    expect(screen.getByText("https://cloudgate.example.com/ca1")).toBeDefined();
  });
});
