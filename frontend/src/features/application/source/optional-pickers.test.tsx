import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Application } from "@/lib/api/endpoints/applications";

vi.mock("../use-application", () => ({
  useSshKeys: () => ({
    data: [
      { sshKeyId: "key-1", name: "ui-ed25519", description: "generated" },
    ],
    isPending: false,
  }),
  useRegistries: () => ({
    data: [
      { registryId: "reg-1", name: "ui-registry", url: "127.0.0.1:5000" },
    ],
    isPending: false,
  }),
}));

const { CustomGitForm } = await import("./custom-git-form");
const { BuildForm } = await import("./build-form");

afterEach(cleanup);

/**
 * Each form has one picker, and it is found by role alone: `Field` hands its id to
 * the `Controller` it wraps rather than to the trigger, so the trigger carries no
 * accessible name to find it by. Base UI's trigger opens on `mousedown`, so a
 * bare `click` is what opens it.
 */
async function openTheList() {
  fireEvent.click(screen.getByRole("combobox"));
  await waitFor(() =>
    expect(screen.queryAllByRole("option").length).toBeGreaterThan(0),
  );
}

function choose(name: RegExp) {
  const option = screen.getByRole("option", { name });
  fireEvent.pointerDown(option, { pointerType: "mouse" });
  fireEvent.click(option, { detail: 1 });
}

/**
 * An optional picker can be set back to nothing.
 *
 * The empty choice used to be the `placeholder` and nothing else, so it showed
 * only while nothing was chosen: once an SSH key or a push registry was saved,
 * the list offered the one that was chosen and no way back. The census in
 * `optional-picker-none.test.tsx` proves every optional picker offers `""`; this
 * proves what choosing it *does* at the two sites the ticket found — it saves
 * `null`, which is what unlinks the column.
 */
describe("an optional picker set back to none", () => {
  it("saves customGitSSHKeyId: null when Clone over HTTPS is chosen", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    render(
      <CustomGitForm
        row={
          {
            customGitUrl: "git@github.com:acme/api.git",
            customGitBranch: "main",
            customGitBuildPath: "/",
            customGitSSHKeyId: "key-1",
            enableSubmodules: false,
          } as unknown as Application
        }
        save={save}
        onDone={() => {}}
      />,
    );

    await openTheList();
    choose(/Clone over HTTPS/);
    await waitFor(() =>
      expect(screen.getByRole("combobox").textContent).toContain(
        "Clone over HTTPS",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save source" }));

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][0]).toMatchObject({ customGitSSHKeyId: null });
  });

  it("saves registryId: null when Keep it on the build Server is chosen", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    render(
      <BuildForm
        application={
          {
            buildType: "nixpacks",
            registryId: "reg-1",
          } as unknown as Application
        }
        save={save}
        onDone={() => {}}
      />,
    );

    await openTheList();
    choose(/Keep it on the build Server/);
    await waitFor(() =>
      expect(screen.getByRole("combobox").textContent).toContain(
        "Keep it on the build Server",
      ),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Save build settings" }),
    );

    await waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][0]).toMatchObject({ registryId: null });
  });
});
