import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/api-error";
import {
  applicationsApi,
  type Application,
} from "@/lib/api/endpoints/applications";

import { DockerSourceForm } from "./docker-source-form";

vi.mock("@/lib/api/endpoints/applications", () => ({
  applicationsApi: { testRegistryLogin: vi.fn(async () => undefined) },
}));

const refusal =
  "Error response from daemon: login attempt to http://127.0.0.1:5000/v2/ failed with status: 401 Unauthorized";

function renderForm(stored: { username: string | null }) {
  const application = {
    applicationId: "app-1",
    dockerImage: "127.0.0.1:5000/ui/app:latest",
    registryUrl: "127.0.0.1:5000",
    username: stored.username,
  } as Application;
  render(
    <DockerSourceForm
      application={application}
      save={async () => undefined}
      onDone={() => {}}
    />,
  );
}

function type(label: RegExp, value: string) {
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

beforeEach(() => {
  vi.mocked(applicationsApi.testRegistryLogin).mockReset();
});

afterEach(cleanup);

/**
 * The second place a registry credential is typed (U06 APP-03): a wrong
 * password saved without a word and failed at the pull.
 */
describe("DockerSourceForm's Test connection", () => {
  it("logs in with the password typed, before anything is saved", async () => {
    renderForm({ username: null });
    type(/^Registry username/, "cgui");
    type(/^Registry password or token/, "hunter22");
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));

    await screen.findByText(
      "127.0.0.1:5000 accepted cgui with the password you typed.",
    );
    expect(applicationsApi.testRegistryLogin).toHaveBeenCalledWith("app-1", {
      registryUrl: "127.0.0.1:5000",
      username: "cgui",
      password: "hunter22",
    });
  });

  it("shows the registry's refusal and never the password", async () => {
    vi.mocked(applicationsApi.testRegistryLogin).mockRejectedValue(
      new ApiError(400, `${refusal} for hunter22`),
    );
    renderForm({ username: "cgui" });
    type(/^Registry password or token/, "hunter22");
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));

    const said = await screen.findByText("Did not work.");
    const sentence = said.parentElement?.textContent ?? "";
    expect(sentence).toContain(refusal);
    expect(sentence).not.toContain("hunter22");
  });

  it("tests the stored password when the box is left empty", async () => {
    renderForm({ username: "cgui" });
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));

    await screen.findByText(
      "127.0.0.1:5000 accepted cgui with the password already stored.",
    );
    expect(applicationsApi.testRegistryLogin).toHaveBeenCalledWith("app-1", {
      registryUrl: "127.0.0.1:5000",
      username: "cgui",
    });
  });

  it("offers no test for a public image, which has no login", () => {
    renderForm({ username: null });

    expect(screen.queryByRole("button", { name: "Test connection" })).toBeNull();
  });

  it("is off with a reason when no password is typed and none is stored", () => {
    renderForm({ username: null });
    type(/^Registry username/, "cgui");

    expect(
      screen
        .getByRole("button", { name: "Test connection" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    expect(
      screen.getByText(/Fill in the password and the test logs in with it/),
    ).toBeTruthy();
  });

  it("will not offer the stored password to a hostname or username that differs from the saved one", () => {
    renderForm({ username: "cgui" });
    type(/^Registry(?! username| password)/, "attacker.example:5000");

    expect(
      screen
        .getByRole("button", { name: "Test connection" })
        .getAttribute("aria-disabled"),
    ).toBe("true");
    expect(
      screen.getByText(
        /The stored password is only tested against the registry and username it was saved with/,
      ),
    ).toBeTruthy();
  });
});
