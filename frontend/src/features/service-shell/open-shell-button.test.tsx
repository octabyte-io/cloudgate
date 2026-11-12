import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { scopeNav } from "@/components/shell/nav";
import type { ScopeRoute } from "@/components/shell/scope";
import type { TabSubject } from "@/lib/shell/tab-registry";

const scope = vi.hoisted(() => ({ current: null as unknown }));
vi.mock("@/components/shell/scope-provider", () => ({
  useOptionalScope: () => scope.current,
}));

const { OpenShellButton } = await import("./open-shell-button");

afterEach(() => {
  cleanup();
  scope.current = null;
});

const STOREFRONT: ScopeRoute = {
  kind: "application",
  id: "app_1",
  variant: null,
  tab: "",
};

const at = (subject: TabSubject, pending = false) => {
  scope.current = {
    scope: STOREFRONT,
    nav: scopeNav(STOREFRONT, subject),
    pending,
  };
};

/** Overview's Open a shell appears exactly where the Shell tab does. */
describe("OpenShellButton", () => {
  it("goes to the Shell tab of a Service on a Server or this host", () => {
    at({ aiModel: null, cloudPlace: null });

    render(<OpenShellButton />);

    expect(
      screen.getByRole("link", { name: /Open a shell/ }).getAttribute("href"),
    ).toBe("/applications/app_1/shell");
  });

  it("is absent where the tab is: a Cloud account, or a role without service:update", () => {
    at({ cloudPlace: { cloudAccountId: "ca_1" } });
    render(<OpenShellButton />);
    expect(screen.queryByRole("link")).toBeNull();
    cleanup();

    at({ cloudPlace: null, shellAllowed: false });
    render(<OpenShellButton />);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("draws nothing outside a scope, or while the row loads", () => {
    render(<OpenShellButton />);
    expect(screen.queryByRole("link")).toBeNull();

    at({ cloudPlace: null }, true);
    render(<OpenShellButton />);
    expect(screen.queryByRole("link")).toBeNull();
  });
});
