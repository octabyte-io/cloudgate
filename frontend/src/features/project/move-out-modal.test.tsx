import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MovePreview, RepositoryLocation } from "@/lib/api/endpoints/project-config";

const TEXT = "services:\n  web:\n    kind: web\n";
const FILE_URL = "https://github.com/acme/shop/blob/main/cloudgate.yaml";
const TITLE = "Move the config out of the repository";
const LABEL = "The copy Cloudgate will keep";

const preview: MovePreview = {
  to: {
    kind: "cloudgate",
    fromEnvironmentId: null,
    copy: {
      repository: "acme/shop",
      path: "cloudgate.yaml",
      branch: "main",
      commitSha: "9b1d0c7ee2",
      fileUrl: FILE_URL,
      text: TEXT,
    },
  },
  reads: [],
  environments: [],
};

// The preview and the confirm are the boundary. CodeMirror is a
// `next/dynamic` island jsdom cannot run, so a textarea stands in for it.
vi.mock("./use-project-config", async (original) => ({
  ...(await original<typeof import("./use-project-config")>()),
  usePreviewMove: () => ({
    data: preview,
    isPending: false,
    error: null,
    mutate: vi.fn(),
    reset: vi.fn(),
  }),
  useConfirmMove: () => ({ isPending: false, error: null, mutate: vi.fn(), reset: vi.fn() }),
}));
vi.mock("@/components/console/code-editor", () => ({
  CodeEditor: ({
    label,
    value,
    onChange,
  }: {
    label: string;
    value: string;
    onChange?: (next: string) => void;
  }) => (
    <textarea
      aria-label={label}
      value={value}
      readOnly={onChange === undefined}
      onChange={(event) => onChange?.(event.target.value)}
    />
  ),
}));

const { MoveOutModal } = await import("./move-out-modal");

afterEach(cleanup);

const from: RepositoryLocation = {
  kind: "repository",
  gitProviderId: "gp-1",
  providerType: "github",
  connectionName: "acme",
  repository: "acme/shop",
  path: "cloudgate.yaml",
  updatedAt: "2026-11-01T00:00:00.000Z",
};

function expanded() {
  render(
    <MoveOutModal
      projectId="prj-1"
      open
      onOpenChange={vi.fn()}
      serverNames={{}}
      from={from}
      environments={[]}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Expand" }));
  const editor = screen
    .getAllByRole("dialog")
    .find((dialog) => within(dialog).queryByRole("button", { name: "Back to page" }));
  return editor as HTMLElement;
}

/**
 * Expand (spec #118) on the copy a move out would keep: it opens over the
 * move-out dialog, read-only, and closing it returns to that dialog.
 */
describe("MoveOutModal — Expand", () => {
  it("opens the kept copy read-only over the dialog, with where it is read from", () => {
    const editor = expanded();

    // The move-out dialog is still there under it, hidden from the tree while
    // the expanded editor is the one in front.
    const both = screen.getAllByRole("dialog", { hidden: true });
    expect(both).toHaveLength(2);
    expect(both.some((dialog) => dialog.textContent?.includes(TITLE))).toBe(true);
    expect(within(editor).getByRole("heading", { name: "Project config" })).toBeTruthy();
    expect(editor.textContent).toContain("acme/shop");
    expect(editor.textContent).toContain("9b1d0c7");
    const view = within(editor).getByLabelText(LABEL) as HTMLTextAreaElement;
    expect(view.value).toBe(TEXT);
    expect(view.readOnly).toBe(true);
    expect(within(editor).getByRole("link", { name: "Open the file" }).getAttribute("href")).toBe(
      FILE_URL,
    );
  });

  it("returns to the move-out dialog on Back to page", async () => {
    const editor = expanded();

    fireEvent.click(within(editor).getByRole("button", { name: "Back to page" }));

    await waitFor(() => expect(screen.getAllByRole("dialog", { hidden: true })).toHaveLength(1));
    expect(screen.getByRole("dialog").textContent).toContain(TITLE);
  });

  it("returns to the move-out dialog on Escape", async () => {
    const editor = expanded();

    fireEvent.keyDown(within(editor).getByLabelText(LABEL), { key: "Escape" });

    await waitFor(() => expect(screen.getAllByRole("dialog", { hidden: true })).toHaveLength(1));
    expect(screen.getByRole("dialog").textContent).toContain(TITLE);
  });
});
