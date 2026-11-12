import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ResourceFormModal } from "@/components/console/resource-form-modal";
import { certificatesApi, type Certificate } from "@/lib/api/endpoints/certificates";

import { certificateSpec } from "./certificates-spec";

/**
 * **A blank private key on an edit means keep**, and a rename is a rename.
 *
 * The key is never returned, so the edit dialog opens with that box empty and
 * the hint says to leave it that way. The schema used to require it on both
 * dialogs, so Save changes was refused in the form and no `PATCH` was sent.
 * And `update` sent the stored certificate back on every save, which the service
 * reads as new material: a rename rewrote the files on disk.
 */

vi.mock("@/lib/api/endpoints/certificates", () => ({
  certificatesApi: {
    list: vi.fn(),
    create: vi.fn(async () => ({})),
    update: vi.fn(async () => ({})),
    remove: vi.fn(),
  },
}));

const PEM = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----";
const KEY = "-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----";

const row: Certificate = {
  certificateId: "cert-1",
  name: "old-name",
  certificateData: PEM,
  certificatePath: "cert-1",
  certificateType: "custom",
  createdAt: "2026-09-18T00:00:00Z",
  organizationId: "org-1",
  serverId: null,
};

const noop = async () => undefined;

function renderDialog(target: Certificate | null) {
  render(
    <ResourceFormModal
      spec={certificateSpec(noop)}
      row={target}
      open
      onOpenChange={() => {}}
    />,
  );
}

function type(label: string, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

beforeEach(() => {
  vi.mocked(certificatesApi.create).mockClear();
  vi.mocked(certificatesApi.update).mockClear();
});

afterEach(cleanup);

describe("editing a certificate", () => {
  it("saves a rename with the private key left empty, and sends neither half", async () => {
    renderDialog(row);
    type("Name", "new-name");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(certificatesApi.update).toHaveBeenCalledOnce());
    expect(certificatesApi.update).toHaveBeenCalledWith("cert-1", {
      name: "new-name",
    });
  });

  it("sends a changed certificate without a key, which keeps the stored key", async () => {
    const next = PEM.replace("MIIB", "MIIC");
    renderDialog(row);
    type("Certificate", next);
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(certificatesApi.update).toHaveBeenCalledOnce());
    expect(certificatesApi.update).toHaveBeenCalledWith("cert-1", {
      name: "old-name",
      certificateData: next,
    });
  });

  it("still refuses a key that is not PEM", async () => {
    renderDialog(row);
    type("Private key", "not a key");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(
      await screen.findByText(/That does not look like PEM/),
    ).toBeTruthy();
    expect(certificatesApi.update).not.toHaveBeenCalled();
  });
});

describe("adding a certificate", () => {
  it("still requires the private key", async () => {
    renderDialog(null);
    type("Name", "fresh");
    type("Certificate", PEM);
    fireEvent.click(screen.getByRole("button", { name: "Add a certificate" }));

    expect(
      await screen.findByText(
        "Paste the private key, including the BEGIN and END lines.",
      ),
    ).toBeTruthy();
    expect(certificatesApi.create).not.toHaveBeenCalled();
  });

  it("names the missing key alongside every other empty box, not after them", async () => {
    renderDialog(null);
    fireEvent.click(screen.getByRole("button", { name: "Add a certificate" }));

    expect(await screen.findByText("A certificate needs a name.")).toBeTruthy();
    expect(
      screen.getByText("Paste the private key, including the BEGIN and END lines."),
    ).toBeTruthy();
  });

  it("sends the pair and nothing the form keeps for itself", async () => {
    renderDialog(null);
    type("Name", "fresh");
    type("Certificate", PEM);
    type("Private key", KEY);
    fireEvent.click(screen.getByRole("button", { name: "Add a certificate" }));

    await waitFor(() => expect(certificatesApi.create).toHaveBeenCalledOnce());
    expect(certificatesApi.create).toHaveBeenCalledWith({
      name: "fresh",
      certificateData: PEM,
      privateKey: KEY,
    });
  });
});

describe("certificateSpec's empty state", () => {
  it("says how a domain uses a stored certificate, and that it wins over Let's Encrypt", () => {
    const body = certificateSpec(async () => {}).emptyBody;
    expect(body).toContain("choose Stored certificate");
    expect(body).toContain("even one set to Let's Encrypt");
  });
});
