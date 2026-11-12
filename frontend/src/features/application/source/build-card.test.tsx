import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Application } from "@/lib/api/endpoints/applications";

/**
 * **The resting Build card says where the image is pushed**.
 *
 * "Push the image to" was a control with no read-out: after saving it, no screen
 * on the Application said the image left the build Server, and the only way back
 * to the answer was to open Edit again. These render the card for a row with a
 * registry and for one without, and read the row.
 */

/**
 * `usePermission`'s verdict, held by statement. Everything is held
 * unless a case takes it away; the decision itself is pinned in
 * `use-permission.test.ts`.
 */
const refused = vi.hoisted(() => ({ current: new Set<string>() }));
vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission: (required: Record<string, string[]>) => ({
    allowed: Object.entries(required).every(([resource, actions]) =>
      actions.every((action) => !refused.current.has(`${resource}:${action}`)),
    ),
    pending: false,
    role: "member",
  }),
}));

vi.mock("../use-application", () => ({
  useRegistries: () => ({
    data: [
      {
        registryId: "reg-1",
        name: "ui-registry",
        url: "127.0.0.1:5000",
      },
      { registryId: "reg-hub", name: "ui-hub", url: "" },
    ],
    isPending: false,
  }),
  // `build-card` pulls in `build-form`, which picks an SSH key from the same
  // module; a factory mock replaces all of it, so this export has to be here.
  useSshKeys: () => ({ data: [], isPending: false }),
}));

/** The lock a repository-kept config puts on the card; none unless a case sets one. */
const lock = vi.hoisted(() => ({
  current: null as null | Record<string, string | null>,
}));
vi.mock("@/components/console/config-lock", async (original) => ({
  ...(await original<typeof import("@/components/console/config-lock")>()),
  useConfigLock: () => lock.current,
}));

const { BuildCard } = await import("./build-card");

afterEach(() => {
  cleanup();
  lock.current = null;
});

function renderCard(registryId: string | null) {
  render(
    <BuildCard
      application={
        {
          applicationId: "app-1",
          sourceType: "github",
          buildType: "dockerfile",
          dockerfile: null,
          dockerContextPath: null,
          dockerBuildStage: null,
          registryId,
        } as unknown as Application
      }
      save={async () => undefined}
    />,
  );
}

/** The `<dd>` beside a label, as text. */
function rowValue(label: string): string {
  const row = screen.getByText(label).closest("[data-slot='kv-row']");
  return row?.querySelector("dd")?.textContent ?? "";
}

describe("the Build card's push registry", () => {
  it("names the registry and its host when one is linked", () => {
    renderCard("reg-1");

    expect(rowValue("Pushes to")).toBe("ui-registry 127.0.0.1:5000");
  });

  it("says the image stays put when none is linked", () => {
    renderCard(null);

    expect(rowValue("Pushes to")).toBe("Stays on the build Server");
  });

  it("reads a registry with no hostname as Docker Hub's", () => {
    renderCard("reg-hub");

    expect(rowValue("Pushes to")).toBe("ui-hub docker.io");
  });
});

describe("the Build card on a repository-kept config", () => {
  it("locks Edit and points at the file, the branch and the commit last applied", () => {
    lock.current = {
      repository: "acme/shop",
      path: "cloudgate.yaml",
      branch: "main",
      fileUrl: "https://github.com/acme/shop/blob/abc/cloudgate.yaml",
      appliedCommit: "abcdef0123456",
    };
    renderCard(null);

    const edit = screen.getByRole("button", { name: /Edit/ });
    expect(edit.getAttribute("title")).toBe(
      "Set by the Project config. Change it in cloudgate.yaml in acme/shop on branch main, then check for changes.",
    );
    expect(
      edit.hasAttribute("disabled") ||
        edit.getAttribute("aria-disabled") === "true",
    ).toBe(true);
    expect(
      screen.getByText(/The build settings are set by the Project config/),
    ).toBeTruthy();
    expect(screen.getByText("abcdef0")).toBeTruthy();
  });

  it("leaves Edit live when the file does not own them", () => {
    renderCard(null);

    expect(
      screen.getByRole("button", { name: /Edit/ }).getAttribute("title"),
    ).toBeNull();
    expect(screen.queryByText(/set by the Project config/)).toBeNull();
  });
});
