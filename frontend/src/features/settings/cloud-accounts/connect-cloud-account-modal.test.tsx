import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/api-error";
import type { GoogleCloudAccountSetup } from "@/lib/api/endpoints/cloud-accounts";

const awsSetup = vi.fn();
const googleSetup = vi.fn();
const connect = vi.fn();

vi.mock("./use-cloud-accounts", () => ({
  useCloudAccountSetup: () => ({ isPending: false, mutateAsync: awsSetup }),
  useGoogleCloudAccountSetup: () => ({
    isPending: false,
    mutateAsync: googleSetup,
  }),
  useConnectCloudAccount: () => ({ isPending: false, mutateAsync: connect }),
}));

const { ConnectCloudAccountModal } =
  await import("./connect-cloud-account-modal");

const SETUP: GoogleCloudAccountSetup = {
  cloud: "gcp",
  setupToken: "enc:v1:sealed",
  cloudAccountId: "ca1",
  signingKeyId: "key-abc",
  signingPublicKey: '{"kty":"RSA","kid":"key-abc"}',
  template: {
    policyVersion: 1,
    script: "#!/usr/bin/env bash\n",
    jwks: '{"keys":[]}\n',
    roleDefinition: "title: Cloudgate deploy\n",
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

const PROVIDER =
  "projects/123456789012/locations/global/workloadIdentityPools/cloudgate-abc/providers/cloudgate-abc";

function field(name: RegExp) {
  return screen.getByLabelText(name);
}

beforeEach(() => {
  awsSetup.mockReset();
  googleSetup.mockReset();
  connect.mockReset();
  googleSetup.mockResolvedValue(SETUP);
  connect.mockResolvedValue({});
});

afterEach(cleanup);

/**
 * Slice 6: the console connects a Google Cloud project — the cloud
 * chooser, the setup script with its warning, and the connect check's
 * refusal kept in the dialog.
 */
describe("ConnectCloudAccountModal on Google Cloud", () => {
  async function toSetup() {
    render(<ConnectCloudAccountModal open onOpenChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Google Cloud" }));
    fireEvent.change(field(/^Name/), {
      target: { value: "Production Google" },
    });
    fireEvent.change(field(/^Project id/), { target: { value: "shop-prod" } });
    fireEvent.click(
      screen.getByRole("button", { name: "Get the setup script" }),
    );
    await screen.findByLabelText(/^Workload identity provider/);
  }

  it("hands out the script with the project-of-its-own warning, then connects with what the script printed", async () => {
    const onOpenChange = vi.fn();
    render(<ConnectCloudAccountModal open onOpenChange={onOpenChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Google Cloud" }));
    fireEvent.change(field(/^Name/), {
      target: { value: "Production Google" },
    });
    fireEvent.change(field(/^Project id/), { target: { value: "shop-prod" } });
    fireEvent.click(
      screen.getByRole("button", { name: "Get the setup script" }),
    );

    await screen.findByLabelText(/^Workload identity provider/);
    expect(googleSetup).toHaveBeenCalledWith({
      cloudId: "shop-prod",
      setupToken: undefined,
    });
    expect(awsSetup).not.toHaveBeenCalled();
    expect(
      screen.getByText(
        /Cloudgate can act as any service account in this project/,
      ),
    ).toBeTruthy();
    for (const name of [
      "Download the setup script",
      "Download the JWKS",
      "Download the role",
    ]) {
      expect(screen.getByRole("button", { name })).toBeTruthy();
    }
    expect(screen.getByText("key-abc")).toBeTruthy();
    // The service account the script makes is filled in.
    expect((field(/^Deploy service account/) as HTMLInputElement).value).toBe(
      "cloudgate-deploy-abc@shop-prod.iam.gserviceaccount.com",
    );

    fireEvent.change(field(/^Workload identity provider/), {
      target: { value: PROVIDER },
    });
    fireEvent.click(screen.getByRole("button", { name: "Check and connect" }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(connect).toHaveBeenCalledWith({
      cloud: "gcp",
      setupToken: "enc:v1:sealed",
      name: "Production Google",
      cloudId: "shop-prod",
      workloadIdentityProvider: PROVIDER,
      deployServiceAccount:
        "cloudgate-deploy-abc@shop-prod.iam.gserviceaccount.com",
    });
  });

  it("keeps the dialog and every value when the connect check refuses, naming what to fix", async () => {
    connect.mockRejectedValue(
      new ApiError(
        400,
        "2 APIs Cloudgate needs are off in project shop-prod: certificatemanager.googleapis.com, secretmanager.googleapis.com. Turn them on, as the setup script does",
      ),
    );
    await toSetup();
    fireEvent.change(field(/^Workload identity provider/), {
      target: { value: PROVIDER },
    });

    fireEvent.click(screen.getByRole("button", { name: "Check and connect" }));

    expect(
      await screen.findByText(/certificatemanager\.googleapis\.com/),
    ).toBeTruthy();
    expect(
      (field(/^Workload identity provider/) as HTMLInputElement).value,
    ).toBe(PROVIDER);
  });

  it("asks again with the same token after Back, keeping the key the script uploads", async () => {
    await toSetup();

    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Get the setup script" }),
    );

    await waitFor(() =>
      expect(googleSetup).toHaveBeenLastCalledWith({
        cloudId: "shop-prod",
        setupToken: "enc:v1:sealed",
      }),
    );
  });

  it("refuses a project id Google would not take before asking", () => {
    render(<ConnectCloudAccountModal open onOpenChange={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Google Cloud" }));
    fireEvent.change(field(/^Name/), { target: { value: "Prod" } });
    fireEvent.change(field(/^Project id/), { target: { value: "Shop_Prod" } });

    // Said under the field with the button on, not by an off button.
    fireEvent.click(
      screen.getByRole("button", { name: "Get the setup script" }),
    );
    expect(
      screen.getByText(
        "A project id is 6 to 30 lower case letters, digits and dashes, starting with a letter.",
      ),
    ).toBeDefined();
    expect(googleSetup).not.toHaveBeenCalled();
  });

  it("says an empty AWS step's fields are needed, under each, before asking", () => {
    render(<ConnectCloudAccountModal open onOpenChange={vi.fn()} />);
    fireEvent.click(
      screen.getByRole("button", { name: "Get the setup template" }),
    );
    expect(screen.getByText("Name this Cloud account.")).toBeDefined();
    expect(screen.getByText("An AWS account id is 12 digits.")).toBeDefined();
    expect(awsSetup).not.toHaveBeenCalled();
  });
});
