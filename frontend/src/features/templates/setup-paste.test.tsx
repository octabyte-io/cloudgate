import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { PastedSetup } from "./setup-paste";
import { SetupPasteView } from "./setup-paste";

afterEach(cleanup);

const YAML = `services:
  ghost-app: { kind: compose, managed: console }
  ghost-db:
    kind: postgres
`;

const RESULT: PastedSetup = {
  setupName: "ghost",
  configNames: ["ghost-app", "ghost-db"],
  pendingSetup: {
    pendingSetupId: "ps-1",
    environmentId: "env-prod",
    values: [
      {
        configName: "ghost-app",
        variable: "DB_PASSWORD",
        made: "generated (password, 32 characters)",
        hasValue: true,
      },
    ],
  },
  setupRecord: {
    setupRecordId: "sr-1",
    projectId: "p-1",
    templateId: "ghost",
    revision: "abc1234",
    setupName: "ghost",
    configNames: ["ghost-app", "ghost-db"],
  },
  plan: null,
  paste: {
    yaml: YAML,
    repository: "acme/blog",
    path: "cloudgate.yaml",
    branch: null,
  },
};

describe("SetupPasteView", () => {
  it("shows the renamed entries to paste, with a copy control", () => {
    render(<SetupPasteView result={RESULT} templateName="Ghost" />);

    expect(
      screen.getByLabelText("Entries to paste into cloudgate.yaml").textContent,
    ).toBe(YAML.replace(/\n$/, ""));
    expect(
      screen.getByRole("button", { name: /copy the entries/i }),
    ).toBeTruthy();
  });

  it("names the file, the repository and the default branch, and says Cloudgate writes nothing there", () => {
    render(<SetupPasteView result={RESULT} templateName="Ghost" />);

    const page = document.body.textContent ?? "";
    expect(page).toContain("cloudgate.yaml");
    expect(page).toContain("acme/blog");
    expect(page).toContain("its default branch");
    expect(page).toContain("Cloudgate does not write to your repository");
  });

  it("names the Environment's Config branch when it reads one", () => {
    render(
      <SetupPasteView
        result={{
          ...RESULT,
          paste: { ...RESULT.paste, branch: "staging" },
        }}
        templateName="Ghost"
      />,
    );

    expect(document.body.textContent).toContain("staging");
  });

  it("says the next push makes the Plan, matching each entry by its Config name and kind, so a renamed one gets nothing", () => {
    render(<SetupPasteView result={RESULT} templateName="Ghost" />);

    const page = document.body.textContent ?? "";
    expect(page).toContain("The next push");
    expect(page).toMatch(/ghost-app.*ghost-db/);
    expect(page).toMatch(/renamed .* gets none of the setup’s values/);
    expect(page).toContain("30 days");
  });

  it("links to the Environment's Plan on the Project's Config tab", () => {
    render(<SetupPasteView result={RESULT} templateName="Ghost" />);

    expect(
      screen.getByRole("link", { name: /config tab/i }).getAttribute("href"),
    ).toBe("/projects/p-1/config#plan-env-prod");
  });
});
