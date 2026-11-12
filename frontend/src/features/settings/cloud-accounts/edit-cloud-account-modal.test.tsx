import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/api-error";
import type { CloudAccount } from "@/lib/api/endpoints/cloud-accounts";

const mutateAsync = vi.fn();

vi.mock("./use-cloud-accounts", () => ({
  useUpdateCloudAccount: () => ({ isPending: false, mutateAsync }),
}));

const { EditCloudAccountModal } = await import("./edit-cloud-account-modal");

const ACCOUNT: CloudAccount = {
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
 * An edit sends only what changed, so the backend keeps the rest — the
 * stored secret above all, which the console never has to send back.
 */
describe("EditCloudAccountModal", () => {
  it("sends a rename alone, leaving the stored secret out", async () => {
    const onClose = vi.fn();
    render(<EditCloudAccountModal account={ACCOUNT} onClose={onClose} />);

    fireEvent.change(field(/^Name/), { target: { value: "Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(mutateAsync).toHaveBeenCalledWith({ name: "Renamed" });
  });

  it("sends a new secret and says the role is checked first", async () => {
    render(<EditCloudAccountModal account={ACCOUNT} onClose={vi.fn()} />);

    fireEvent.change(field(/^Secret access key/), {
      target: { value: "new-secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Check and save" }));

    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        secretAccessKey: "new-secret",
      }),
    );
  });

  it("keeps the dialog open with the refusal when the re-check fails", async () => {
    mutateAsync.mockRejectedValue(
      new ApiError(
        400,
        "The deploy role is missing 1 action of policy version 1: ec2:CreateVpc",
      ),
    );
    const onClose = vi.fn();
    render(<EditCloudAccountModal account={ACCOUNT} onClose={onClose} />);

    fireEvent.change(field(/^Deploy role ARN/), {
      target: { value: "arn:aws:iam::123456789012:role/other" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Check and save" }));

    expect(await screen.findByText(/ec2:CreateVpc/)).toBeDefined();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("offers nothing to save until something changes, and shows the fixed ids", () => {
    render(<EditCloudAccountModal account={ACCOUNT} onClose={vi.fn()} />);

    expect(
      screen
        .getByRole("button", { name: "Save" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    expect(screen.getByText("123456789012")).toBeDefined();
    expect(screen.getByText("external-id-abc")).toBeDefined();
  });
});
