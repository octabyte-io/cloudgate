import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ResourceFormModal } from "@/components/console/resource-form-modal";
import { ApiError } from "@/lib/api/api-error";
import { registriesApi, type Registry } from "@/lib/api/endpoints/registries";

import { registrySpec } from "./registries-spec";

/**
 * **The dialog does not ask for a Kind**.
 *
 * "Hosted by someone else" / "One you run" was a required choice whose answer
 * nothing read: not the deployment engine, not `registry.utils.ts`, not the
 * table it saved into. `registry_type` still exists, defaulted to `cloud`, so
 * these also pin the other half — neither call mentions the column, so a row
 * that says `selfHosted` today keeps saying it through a rename.
 */

vi.mock("@/lib/api/endpoints/registries", () => ({
  registriesApi: {
    list: vi.fn(),
    create: vi.fn(async () => ({})),
    update: vi.fn(async () => ({})),
    remove: vi.fn(),
    testConnection: vi.fn(async () => undefined),
    testSavedConnection: vi.fn(async () => undefined),
  },
}));

const row: Registry = {
  registryId: "reg-1",
  name: "ui-registry",
  imagePrefix: "ui",
  username: "cgui",
  url: "127.0.0.1:5000",
  registryType: "selfHosted",
  createdAt: "2026-09-18T00:00:00Z",
  organizationId: "org-1",
};

const noop = async () => undefined;

function renderDialog(target: Registry | null) {
  render(
    <ResourceFormModal
      spec={registrySpec(noop)}
      row={target}
      open
      onOpenChange={() => {}}
    />,
  );
}

function type(label: string | RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

beforeEach(() => {
  vi.mocked(registriesApi.create).mockClear();
  vi.mocked(registriesApi.update).mockClear();
  vi.mocked(registriesApi.testConnection).mockReset();
  vi.mocked(registriesApi.testSavedConnection).mockReset();
});

afterEach(cleanup);

describe("the registry dialog", () => {
  it.each([
    ["connecting one", null],
    ["editing one", row],
  ])("asks no Kind question when %s", (_case, target) => {
    renderDialog(target as Registry | null);

    // The label's own text, not `queryByLabelText`: `Field` gives its id to the
    // `Controller` and not to a select's trigger, so a `kind: "select"` field
    // has no accessible name to miss.
    expect(screen.queryByText("Kind")).toBeNull();
    expect(screen.queryByText("Hosted by someone else")).toBeNull();
  });

  it("sends no registryType when connecting one", async () => {
    renderDialog(null);
    type("Name", "ui-hub");
    type("Username", "cgui");
    type("Password or access token", "hunter2");
    fireEvent.click(screen.getByRole("button", { name: "Connect a registry" }));

    await waitFor(() => expect(registriesApi.create).toHaveBeenCalledOnce());
    expect(registriesApi.create).toHaveBeenCalledWith({
      name: "ui-hub",
      url: "",
      imagePrefix: undefined,
      username: "cgui",
      password: "hunter2",
    });
  });

  it("sends no registryType when editing one, so the stored kind stands", async () => {
    renderDialog(row);
    type("Name", "ui-registry-renamed");
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(registriesApi.update).toHaveBeenCalledOnce());
    expect(registriesApi.update).toHaveBeenCalledWith("reg-1", {
      name: "ui-registry-renamed",
      url: "127.0.0.1:5000",
      imagePrefix: "ui",
      username: "cgui",
    });
  });
});

/**
 * **A credential is tested before a build finds out**. A wrong password
 * used to save as "Registry saved." and fail at the push; the dialog now asks
 * the registry, and a refusal is the registry's own sentence.
 */
describe("the registry dialog's Test connection", () => {
  const refusal =
    "Error response from daemon: login attempt to http://127.0.0.1:5000/v2/ failed with status: 401 Unauthorized";

  it("logs in with the values on screen when a password is typed", async () => {
    renderDialog(null);
    type(/^Hostname/, "127.0.0.1:5000");
    type("Username", "cgui");
    type("Password or access token", "hunter22");
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));

    await screen.findByText(
      "127.0.0.1:5000 accepted cgui with the password you typed.",
    );
    expect(registriesApi.testConnection).toHaveBeenCalledWith({
      url: "127.0.0.1:5000",
      username: "cgui",
      password: "hunter22",
    });
    expect(registriesApi.create).not.toHaveBeenCalled();
  });

  it("shows the registry's refusal and never the password", async () => {
    vi.mocked(registriesApi.testConnection).mockRejectedValue(
      new ApiError(400, `${refusal} for hunter22`),
    );
    renderDialog(null);
    type(/^Hostname/, "127.0.0.1:5000");
    type("Username", "cgui");
    type("Password or access token", "hunter22");
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));

    const said = await screen.findByText("Did not work.");
    const sentence = said.parentElement?.textContent ?? "";
    expect(sentence).toContain(refusal);
    expect(sentence).not.toContain("hunter22");
  });

  it("says the refusal in one line and keeps docker's output behind Details", async () => {
    const output = [
      'time="2026-11-03T17:47:03Z" level=info msg="Error logging in to endpoint, trying next endpoint" endpoint="{https://registry.example.com 0x643c66b0960}"',
      'Get "https://registry.example.com/v2/": Bad Gateway for hunter22',
    ].join("\n");
    vi.mocked(registriesApi.testConnection).mockRejectedValue(
      new ApiError(400, "Could not reach registry.example.com (Bad Gateway).", {
        output,
      }),
    );
    renderDialog(null);
    type(/^Hostname/, "registry.example.com");
    type("Username", "cgui");
    type("Password or access token", "hunter22");
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));

    const said = await screen.findByText("Did not work.");
    expect(said.parentElement?.textContent).toBe(
      "Did not work. Could not reach registry.example.com (Bad Gateway).",
    );
    const details = screen.getByText("Details").closest("details");
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain("0x643c66b0960");
    expect(details?.textContent).not.toContain("hunter22");
  });

  it("tests the saved registry when editing with the password left empty", async () => {
    renderDialog(row);
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));

    await waitFor(() =>
      expect(registriesApi.testSavedConnection).toHaveBeenCalledWith("reg-1"),
    );
    expect(registriesApi.testConnection).not.toHaveBeenCalled();
  });

  it("is off on an add until a password is typed, and says why", () => {
    renderDialog(null);

    expect(
      screen
        .getByRole("button", { name: "Test connection" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    expect(
      screen.getByText(/Fill in the password and the test logs in with it/),
    ).toBeTruthy();
  });
});
