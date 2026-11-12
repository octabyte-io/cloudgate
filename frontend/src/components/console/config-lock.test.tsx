import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { EnvironmentConfigCopy } from "@/lib/api/endpoints/project-config";

import {
  ConfigLockNote,
  configLockOf,
  lockRefusal,
  statesField,
  variableNameLock,
} from "./config-lock";

/**
 * US56: a repository-kept config's file owns a Service's config-owned
 * fields, and the Service's pages say where to change them — the file and
 * the branch — and which commit they were last applied from.
 */

afterEach(cleanup);

const copy = (
  services: Extract<EnvironmentConfigCopy, { kind: "repository" }>["services"],
  read: Partial<Extract<EnvironmentConfigCopy, { kind: "repository" }>> = {},
): EnvironmentConfigCopy => ({
  kind: "repository",
  environmentId: "env-1",
  repository: "acme/shop",
  path: "cloudgate.yaml",
  configBranch: null,
  copy: {
    text: "version: 1\n",
    commitSha: "c0ffee1234567",
    branch: "main",
    fileUrl: "https://github.com/acme/shop/blob/c0ffee1234567/cloudgate.yaml",
  },
  refusal: null,
  services,
  ...read,
});

const web = {
  serviceType: "application" as const,
  serviceId: "app-1",
  configName: "web-shop",
  owned: true,
  stated: ["size"],
  listed: { env: ["API_KEY"], build_args: [], build_secrets: [] },
  appliedFrom: {
    planId: "plan-1",
    commitSha: "abcdef0123456",
    branch: "main",
    appliedAt: "2026-10-01T00:00:00.000Z",
  },
};

describe("configLockOf", () => {
  it("locks a Service the file owns, pointing at the file, the branch read and the commit last applied", () => {
    expect(configLockOf(copy([web]), "application", "app-1")).toEqual({
      repository: "acme/shop",
      path: "cloudgate.yaml",
      branch: "main",
      fileUrl: "https://github.com/acme/shop/blob/c0ffee1234567/cloudgate.yaml",
      appliedCommit: "abcdef0123456",
      stated: new Set(["size"]),
      listed: { env: ["API_KEY"], build_args: [], build_secrets: [] },
    });
  });

  it("leaves a Service the file lists as console-managed, or does not list, unlocked", () => {
    expect(
      configLockOf(copy([{ ...web, owned: false }]), "application", "app-1"),
    ).toBeNull();
    expect(configLockOf(copy([]), "application", "app-1")).toBeNull();
  });

  it("leaves everything unlocked on a Cloudgate-kept config, and before the copy has loaded", () => {
    expect(
      configLockOf(
        { kind: "cloudgate", environmentId: "env-1" },
        "application",
        "app-1",
      ),
    ).toBeNull();
    expect(configLockOf(undefined, "application", "app-1")).toBeNull();
  });

  it("names the Config branch when the file cannot be read", () => {
    expect(
      configLockOf(
        copy([{ ...web, appliedFrom: null }], {
          configBranch: "staging",
          copy: null,
          refusal: {
            reason: "branch-missing",
            branch: "staging",
            message: "no branch",
          },
        }),
        "application",
        "app-1",
      ),
    ).toMatchObject({
      repository: "acme/shop",
      path: "cloudgate.yaml",
      branch: "staging",
      fileUrl: null,
      appliedCommit: null,
    });
  });
});

describe("ConfigLockNote", () => {
  it("says what the file sets, where, and the commit it was last applied from, with a link to the file", () => {
    const lock = configLockOf(copy([web]), "application", "app-1")!;
    render(<ConfigLockNote lock={lock} what="The build settings are" />);

    expect(
      screen.getByText(/The build settings are set by the Project config/),
    ).toBeTruthy();
    expect(screen.getByText("acme/shop")).toBeTruthy();
    expect(screen.getByText(/on branch main/)).toBeTruthy();
    expect(screen.getByText("abcdef0")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Open the file" }).getAttribute("href"),
    ).toBe("https://github.com/acme/shop/blob/c0ffee1234567/cloudgate.yaml");
  });

  it("says when no commit has been applied yet", () => {
    const lock = configLockOf(
      copy([{ ...web, appliedFrom: null }]),
      "application",
      "app-1",
    )!;
    render(<ConfigLockNote lock={lock} what="The build settings are" />);

    expect(screen.getByText(/not been applied from a commit yet/)).toBeTruthy();
  });

  it("refuses an edit with the file and branch in the sentence", () => {
    const lock = configLockOf(copy([web]), "application", "app-1")!;
    expect(lockRefusal(lock)).toBe(
      "Set by the Project config. Change it in cloudgate.yaml in acme/shop on branch main, then check for changes.",
    );
  });
});

describe("what a lock covers", () => {
  it("locks a field set only when stated only when the file states it", () => {
    const lock = configLockOf(copy([web]), "application", "app-1");
    expect(statesField(lock, "size")).toBe(true);
    expect(statesField(lock, "database")).toBe(false);
    expect(statesField(null, "size")).toBe(false);
  });

  it("allows the names held and the names the file lists, and no other new name", () => {
    const lock = configLockOf(copy([web]), "application", "app-1");
    const names = variableNameLock(lock, "env", ["DEBUG"])!;
    expect([...names.allowed].sort()).toEqual(["API_KEY", "DEBUG"]);
    expect(names.refusal).toContain("cloudgate.yaml in acme/shop on branch main");
    expect(variableNameLock(null, "env", [])).toBeNull();
  });
});
