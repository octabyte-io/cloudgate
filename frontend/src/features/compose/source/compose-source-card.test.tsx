import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ComposeDetail } from "@/lib/api/endpoints/compose";

/**
 * `usePermission`'s verdict — held unless a case takes it away. The decision
 * itself is pinned in `use-permission.test.ts`.
 */
const held = () => ({ allowed: true, pending: false, role: "member" });
const usePermission = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission,
}));

const { COMPOSE_UPDATE_REFUSAL } = await import("../use-compose");
const { ComposeSourceCard } = await import("./compose-source-card");
const { composeSourceSummary } = await import("./compose-source");

beforeEach(() => {
  usePermission.mockImplementation(held);
});
afterEach(() => {
  cleanup();
  usePermission.mockReset();
});

/** A stack created "From a repository": the create route sends no source, so
 *  the row keeps `source_type`'s `github` default and nothing else. */
const fromRepository = {
  composeId: "cmp-1",
  name: "ui-repo",
  sourceType: "github",
  repository: null,
  owner: null,
  branch: null,
  customGitUrl: null,
  composePath: "./docker-compose.yml",
  autoDeploy: true,
  triggerType: "push",
} as unknown as ComposeDetail;

/**
 * **A stack with no source says so, on both cards that named one**.
 *
 * The Source card rendered Type GitHub, Deploys on a push, automatic, and the
 * Stack card Source GitHub — for a row with no repository on an instance with
 * no GitHub connection. The Stack card reads `composeSourceSummary`'s label, so
 * the summary is pinned alongside the card.
 */
describe("ComposeSourceCard — no source yet", () => {
  it("claims no GitHub and no automatic deploy for a stack created from a repository", () => {
    render(<ComposeSourceCard compose={fromRepository} save={async () => undefined} />);
    const text = document.body.textContent ?? "";

    expect(text).not.toContain("A push to the branch");
    expect(text).not.toContain("GitHub");
    expect(text).toContain("No source yet");
    expect(screen.getByRole("button", { name: "Change source" })).toBeTruthy();
  });

  it("gives the Stack card Not set rather than GitHub", () => {
    expect(composeSourceSummary(fromRepository).label).toBe("Not set");
  });

  it("still reads a chosen repository, and a raw stack, as what they are", () => {
    expect(
      composeSourceSummary({
        ...fromRepository,
        owner: "acme",
        repository: "shop",
      } as ComposeDetail),
    ).toMatchObject({ label: "GitHub", detail: "acme/shop" });
    expect(
      composeSourceSummary({
        ...fromRepository,
        sourceType: "raw",
      } as ComposeDetail).label,
    ).toBe("A file written here");
  });
});

/**
 * **A Compose stack deploys on nothing but a person**.
 *
 * No route deploys a stack on a push: the GitHub App's webhook deploys
 * Applications only, no other provider has a push route, and there is no
 * deploy-webhook URL for a custom git URL to call. The card used to read "A
 * push to the branch · automatic" whatever the source.
 */
describe("ComposeSourceCard — what deploys it", () => {
  it.each([
    ["an Any git URL source", { sourceType: "git", customGitUrl: "https://github.com/docker/awesome-compose" }],
    ["a GitHub source", { owner: "acme", repository: "shop", branch: "main" }],
  ])("says %s deploys on nothing", (_, source) => {
    render(
      <ComposeSourceCard
        compose={{ ...fromRepository, ...source } as ComposeDetail}
        save={async () => undefined}
      />,
    );
    const text = document.body.textContent ?? "";

    expect(text).toContain("Nothing — deploys are manual");
    expect(text).not.toContain("A push to the branch");
    expect(text).not.toContain("automatic");
  });
});

/**
 * **Change source is off, with the reason, for a role that cannot change the
 * stack**. Every form behind it saves through `PATCH /compose/:id`,
 * which `findOwnedForUpdate` holds to `service: ['update']`; before this a role
 * without it picked a provider, filled the form and met a bare 403.
 */
describe("ComposeSourceCard — Change source", () => {
  const raw = { ...fromRepository, sourceType: "raw" } as ComposeDetail;

  it("asks for service:update", () => {
    render(<ComposeSourceCard compose={raw} save={async () => undefined} />);
    expect(usePermission).toHaveBeenCalledWith({ service: ["update"] });
  });

  it("is off with the reason for a role without it, and opens nothing", () => {
    usePermission.mockReturnValue({ allowed: false, pending: false, role: "member" });
    render(<ComposeSourceCard compose={raw} save={async () => undefined} />);
    const change = screen.getByRole("button", { name: "Change source" });

    expect(change.getAttribute("aria-disabled")).toBe("true");
    expect(change.getAttribute("title")).toBe(COMPOSE_UPDATE_REFUSAL);
    const described = change.getAttribute("aria-describedby");
    expect(described).toBeTruthy();
    expect(document.getElementById(described as string)?.textContent).toBe(
      COMPOSE_UPDATE_REFUSAL,
    );

    fireEvent.click(change);
    expect(screen.queryByRole("button", { name: "Save source" })).toBeNull();
  });

  it("is live for a role that holds it, and opens the choice", () => {
    render(<ComposeSourceCard compose={raw} save={async () => undefined} />);
    const change = screen.getByRole("button", { name: "Change source" });

    expect(change.getAttribute("aria-disabled")).not.toBe("true");
    expect(change.hasAttribute("title")).toBe(false);
    expect(document.body.textContent).not.toContain(COMPOSE_UPDATE_REFUSAL);

    fireEvent.click(change);
    // A raw stack opens on its own choice: one sentence and a Save.
    expect(screen.getByRole("button", { name: "Save source" })).toBeTruthy();
  });
});
