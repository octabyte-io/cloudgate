import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ResourceFormModal } from "@/components/console/resource-form-modal";
import { ApiError } from "@/lib/api/api-error";
import type { Mount } from "@/lib/api/endpoints/mounts";

import { mountsSpec } from "./mounts-spec";

/**
 * **Editing a mount saves**.
 *
 * All three kinds were uneditable, and silently: Save changes sent the columns
 * the kind does not use as `""`, `updateMountSchema` refuses `""` for
 * `volumeName` and `filePath`, and the 400's field issues named fields this
 * dialog does not render for that kind — so nothing was marked, no toast fired,
 * and the dialog sat there.
 *
 * The bodies below are pinned key for key, because "no `""`" is not a property
 * of the values but of what is sent: `backend/test/mounts/mounts.e2e-spec.ts`
 * PATCHes these same literals and expects 200.
 */

afterEach(cleanup);

const rowOf = (over: Partial<Mount>): Mount =>
  ({
    mountId: "m1",
    type: "volume",
    hostPath: null,
    volumeName: null,
    filePath: null,
    content: null,
    serviceType: "application",
    mountPath: "/etc/ui",
    applicationId: "app-1",
    composeId: null,
    ...over,
  }) as Mount;

function editing(row: Mount, update: (id: string, input: object) => Promise<unknown>) {
  const noop = async () => undefined;
  return render(
    <ResourceFormModal
      spec={mountsSpec({
        applicationId: "app-1",
        create: noop,
        update: update as never,
        remove: noop,
      })}
      row={row}
      open
      onOpenChange={() => {}}
    />,
  );
}

describe("mountsSpec's edit dialog", () => {
  it.each([
    [
      "volume",
      rowOf({ type: "volume", volumeName: "ui-vol" }),
      { type: "volume", mountPath: "/etc/ui", volumeName: "ui-vol" },
    ],
    [
      "bind",
      rowOf({ type: "bind", hostPath: "/root/cg-ui/u06/bind" }),
      { type: "bind", mountPath: "/etc/ui", hostPath: "/root/cg-ui/u06/bind" },
    ],
    [
      "file",
      rowOf({ type: "file", filePath: "app.conf", content: "ui=1" }),
      {
        type: "file",
        mountPath: "/etc/ui",
        filePath: "app.conf",
        content: "ui=1",
      },
    ],
  ])("sends a %s mount's own columns and no others", async (_kind, row, body) => {
    const update = vi.fn(async () => undefined);
    editing(row, update);

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(update).toHaveBeenCalled());
    const sent = JSON.parse(
      JSON.stringify((update.mock.calls[0] as unknown[])[1]),
    ) as Record<string, unknown>;
    // Through `JSON.stringify`, which is what the request goes through: the
    // columns this kind does not own are gone rather than `""`.
    expect(sent).toEqual(body);
    expect(update).toHaveBeenCalledWith("m1", expect.anything());
  });

  it("saves a new content for a file mount", async () => {
    const update = vi.fn(async () => undefined);
    editing(rowOf({ type: "file", filePath: "app.conf", content: "ui=1" }), update);

    fireEvent.change(screen.getByLabelText(/^Content/), {
      target: { value: "ui=2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(update).toHaveBeenCalledWith("m1", {
      type: "file",
      mountPath: "/etc/ui",
      filePath: "app.conf",
      content: "ui=2",
      volumeName: undefined,
      hostPath: undefined,
    });
  });

  /**
   * The other half: whatever the body, a refusal naming a field this kind does
   * not render has to be read out somewhere. `volumeName` is in every mount's
   * form values, so it used to be marked on an input that is not on screen.
   */
  it("reads out a refusal on a field this kind does not show", async () => {
    const update = vi.fn(async () => {
      throw new ApiError(400, "Validation failed", {
        issues: [
          {
            path: "volumeName",
            message: "Too small: expected string to have >=1 characters",
          },
        ],
      });
    });
    editing(rowOf({ type: "file", filePath: "app.conf", content: "ui=1" }), update);

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Too small/);
  });

  it("still marks a refused field that is on screen", async () => {
    const update = vi.fn(async () => {
      throw new ApiError(400, "Validation failed", {
        issues: [{ path: "volumeName", message: "that name is taken" }],
      });
    });
    editing(rowOf({ type: "volume", volumeName: "ui-vol" }), update);

    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(screen.getByLabelText(/^Volume name/).getAttribute("aria-invalid")).toBe(
        "true",
      ),
    );
    expect(document.body.textContent).not.toMatch(/this form does not show/);
  });
});

/**
 * **What a file mount's two paths mean, said where they are typed**.
 *
 * `generateFileMounts` binds the file onto `mountPath` itself — `Target` is the
 * mount path verbatim, and `filePath` only names the copy kept on the Server —
 * so Mount path `/etc/ui` with File name `app.conf` puts the content *at*
 * `/etc/ui`. The form used to say the file was "written inside the mount path
 * under this name", which is the path an app would then read and find nothing
 * at. The backend half is pinned in `backend/test/docker/docker.utils.spec.ts`.
 */
describe("mountsSpec's file mount copy", () => {
  const descriptionOf = (label: RegExp) => {
    const ids = screen.getByLabelText(label).getAttribute("aria-describedby") ?? "";
    return ids
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ");
  };

  it("says the mount path is the file's own full path in the container", () => {
    editing(rowOf({ type: "file", filePath: "app.conf", content: "ui=1" }), vi.fn());

    const hint = descriptionOf(/^Mount path/);
    expect(hint).toMatch(/for a file, the full path of the file itself/i);
    expect(hint).toMatch(/\/etc\/app\/config\.yml/);
  });

  it("says the file name only names the copy on the Server", () => {
    editing(rowOf({ type: "file", filePath: "app.conf", content: "ui=1" }), vi.fn());

    const hint = descriptionOf(/^File name/);
    expect(hint).toMatch(/copy kept on the Server/);
    expect(hint).not.toMatch(/inside the mount path/);
  });
});
