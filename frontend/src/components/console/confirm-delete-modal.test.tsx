import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/api-error";

import { ConfirmDeleteModal } from "./confirm-delete-modal";

afterEach(cleanup);

const REFUSAL =
  'Server "ui-temp" still carries 1 service (application "u03-on-temp"). Move or delete them first.';

function renderRefusing() {
  render(
    <ConfirmDeleteModal
      open
      onOpenChange={() => {}}
      title="Delete ui-temp"
      confirmWord="ui-temp"
      mismatch="That does not match the Server's name."
      button="Delete this Server"
      onConfirm={() => Promise.reject(new ApiError(409, REFUSAL))}
    >
      {/* The Server dialog's length: enough reading to push anything placed
          after it below a short viewport. */}
      {Array.from({ length: 12 }, (_, i) => (
        <p key={i}>A consequence only this dialog knows, number {i + 1}.</p>
      ))}
    </ConfirmDeleteModal>,
  );
  fireEvent.change(screen.getByLabelText("Type ui-temp to confirm"), {
    target: { value: "ui-temp" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Delete this Server" }));
}

/**
 * **A refused delete is read where the button is**.
 *
 * The dialog scrolls inside itself and its footer is sticky, so anything placed
 * at the end of a long body sits *behind* the footer: on a 754px-tall window the
 * Server's refusal rendered at y 640–746 under a footer starting at 628, and the
 * press looked like it did nothing. jsdom lays nothing out, so this pins the
 * placement that makes that impossible instead of measuring it: the refusal is
 * in the sticky footer, beside the button that was pressed, so it is on screen
 * whenever the button is. This covers all seven dialogs built on the component.
 */
describe("ConfirmDeleteModal", () => {
  it("shows a refusal in the footer, beside the button that was pressed", async () => {
    renderRefusing();

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(REFUSAL);

    const button = screen.getByRole("button", { name: "Delete this Server" });
    const footer = button.closest(".sticky");
    expect(footer).not.toBeNull();
    expect(footer?.contains(alert)).toBe(true);
    // Above the buttons, not after them.
    expect(
      alert.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

/**
 * **First focus is the typed name**. Base UI focuses the first
 * tabbable element, and in the Compose dialog that was "Delete its volumes
 * too": one Space opted into data loss. A destructive control placed before
 * the field must never be what the dialog opens on.
 */
describe("ConfirmDeleteModal — initial focus", () => {
  it("lands on the confirm field, not a switch placed before it", async () => {
    render(
      <ConfirmDeleteModal
        open
        onOpenChange={() => {}}
        title="Delete ui-repo"
        confirmWord="ui-repo"
        mismatch="That does not match the stack's name."
        button="Delete stack"
        onConfirm={() => Promise.resolve()}
      >
        <button type="button" role="switch" aria-checked="false">
          Delete its volumes too
        </button>
      </ConfirmDeleteModal>,
    );

    const field = screen.getByLabelText("Type ui-repo to confirm");
    await waitFor(() => expect(document.activeElement).toBe(field));
    expect(document.activeElement).not.toBe(screen.getByRole("switch"));
  });
});

/**
 * **A Server Delete that kept the row can be forced from the dialog**.
 * The backend's 409 names its reason in `code`; the console says it in its own
 * words, never `?force=true`, and offers the forced Delete as a second step.
 */
describe("ConfirmDeleteModal — Remove from Cloudgate anyway", () => {
  const KEPT =
    "Cloudgate could not reach Docker to confirm swarm service app-x is gone, so the Application was kept — delete again when the server is reachable, or delete with ?force=true";

  function renderKept(
    code: string,
    force?: { onConfirm: () => Promise<void> },
  ) {
    const onConfirm = vi.fn(() =>
      Promise.reject(new ApiError(409, KEPT, { code })),
    );
    render(
      <ConfirmDeleteModal
        open
        onOpenChange={() => {}}
        title="Delete app-x"
        confirmWord="app-x"
        mismatch="That does not match the Application's name."
        button="Delete Application"
        onConfirm={onConfirm}
        forceRemove={
          force && {
            onConfirm: force.onConfirm,
            leftBehind: "Its Swarm service may keep running.",
          }
        }
      >
        <p>Body.</p>
      </ConfirmDeleteModal>,
    );
    fireEvent.change(screen.getByLabelText("Type app-x to confirm"), {
      target: { value: "app-x" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Delete Application" }));
    return { onConfirm };
  }

  it("offers the forced Delete on an unreachable Server, saying what it leaves and no API parameter", async () => {
    const forced = vi.fn(() => Promise.resolve());
    renderKept("WORKLOAD_PRESENCE_UNKNOWN", { onConfirm: forced });

    const anyway = await screen.findByRole("button", {
      name: "Remove from Cloudgate anyway",
    });
    const said = document.body.textContent ?? "";
    expect(said).toContain("could not reach its Server");
    expect(said).toContain("Its Swarm service may keep running.");
    expect(said).not.toContain("force=true");
    // The first step is still there, as a plain retry.
    expect(screen.getByRole("button", { name: "Delete again" })).toBeTruthy();

    fireEvent.click(anyway);
    await waitFor(() => expect(forced).toHaveBeenCalledTimes(1));
  });

  it("offers it too when Docker still reports the workload, telling the operator to stop it first", async () => {
    renderKept("WORKLOAD_STILL_PRESENT", { onConfirm: vi.fn() });

    await screen.findByRole("button", { name: "Remove from Cloudgate anyway" });
    expect(document.body.textContent).toContain("Docker still reports it");
  });

  it("offers nothing where the caller passes no force, as a cloud Delete does (ADR-0038)", async () => {
    renderKept("WORKLOAD_PRESENCE_UNKNOWN");

    await screen.findByRole("alert");
    expect(
      screen.queryByRole("button", { name: "Remove from Cloudgate anyway" }),
    ).toBeNull();
  });

  it("does not offer it on any other 409", async () => {
    renderKept("", { onConfirm: vi.fn() });

    await screen.findByRole("alert");
    expect(
      screen.queryByRole("button", { name: "Remove from Cloudgate anyway" }),
    ).toBeNull();
  });
});

describe("ConfirmDeleteModal with a long name", () => {
  it("wraps the name anywhere in its description and its Type-to-confirm label, so the buttons stay in view", () => {
    const name = "x".repeat(100);
    render(
      <ConfirmDeleteModal
        open
        onOpenChange={() => {}}
        title={`Delete ${name}`}
        description={`This removes ${name} for good.`}
        confirmWord={name}
        mismatch="That does not match."
        button="Delete"
        onConfirm={() => Promise.resolve()}
      >
        <p>What deleting it removes.</p>
      </ConfirmDeleteModal>,
    );

    expect(screen.getByRole("heading", { name: `Delete ${name}` }).className).toMatch(/\bwrap-anywhere\b/);
    expect(screen.getByText(`This removes ${name} for good.`).className).toMatch(/\bwrap-anywhere\b/);
    expect(screen.getByText(`Type ${name} to confirm`).className).toMatch(/\bwrap-anywhere\b/);
  });
});
