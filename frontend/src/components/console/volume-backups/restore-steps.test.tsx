import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ConfirmVolumeStep, ReplaceContentsStep } from "./restore-steps";

/**
 * A stack's tarball path is long, and its end — the file name, with the
 * moment it was taken — is what says which backup is about to be restored.
 * The row cut the path short at its end, so it hid exactly that. It now
 * keeps the file name whole on its own line, puts the folder above it, and
 * carries the full path on hover.
 */
const KEY =
  "compose-syrmhv_n8n/n8n-files/compose-syrmhv_n8n-data-2026-11-26T17-48-14-894Z.tar";
const TARBALL = `walk-backups/${KEY}`;
const FILE = "compose-syrmhv_n8n-data-2026-11-26T17-48-14-894Z.tar";
const FOLDER = "walk-backups/compose-syrmhv_n8n/n8n-files/";

afterEach(cleanup);

describe("ConfirmVolumeStep", () => {
  it("shows the tarball's file name whole under its folder, with the full path on hover", () => {
    render(
      <ConfirmVolumeStep
        volumeName="compose-syrmhv_n8n-data"
        onVolumeNameChange={() => undefined}
        serviceName="n8n"
        tarball={TARBALL}
      />,
    );

    const file = screen.getByText(FILE);
    expect(screen.getByText(FOLDER)).toBeTruthy();
    expect(file.closest("dd")?.getAttribute("title")).toBe(TARBALL);
    expect(file.className).not.toMatch(/truncate/);
  });
});

describe("ReplaceContentsStep", () => {
  it("shows the tarball's file name whole under its folder, with the full path on hover", () => {
    render(
      <ReplaceContentsStep
        volumeName="compose-syrmhv_n8n-data"
        serviceName="n8n"
        tarball={TARBALL}
        typed=""
        onTypedChange={() => undefined}
      />,
    );

    const file = screen.getByText(FILE);
    expect(screen.getByText(FOLDER)).toBeTruthy();
    expect(file.closest("dd")?.getAttribute("title")).toBe(TARBALL);
  });

  it("shows a key with no folder as its file name alone", () => {
    render(
      <ReplaceContentsStep
        volumeName="uploads"
        serviceName="shop"
        tarball="uploads-2026-11-26.tar"
        typed=""
        onTypedChange={() => undefined}
      />,
    );

    expect(screen.getByText("uploads-2026-11-26.tar")).toBeTruthy();
  });
});
