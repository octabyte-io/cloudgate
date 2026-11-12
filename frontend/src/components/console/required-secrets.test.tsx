import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { ResourceSpec } from "@/components/console/resource-spec";
import { destinationSpec } from "@/features/integrations/destinations/destinations-spec";
import { channelSpec } from "@/features/integrations/notifications/channel-spec";
import { registrySpec } from "@/features/integrations/registries/registries-spec";
import { ApiError } from "@/lib/api/api-error";

import { ResourceFormModal } from "./resource-form-modal";

/**
 * **A required secret is refused with the other empty fields, on an add
 * **
 *
 * An empty create dialog flagged Name and the plain fields and let the secret
 * through, so the operator fixed those, submitted again, and only then heard
 * from the backend about the secret — once as "Invalid input: expected string,
 * received undefined" (a Slack webhook URL) and once as "secretAccessKey cannot
 * be empty", in the field's code name.
 */

const fetchSpy = vi.fn(async () => new Response("{}", { status: 500 }));

beforeEach(() => {
  fetchSpy.mockClear();
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const noop = async () => undefined;

function submit() {
  const button = document.querySelector<HTMLButtonElement>(
    'button[type="submit"]',
  );
  if (!button) throw new Error("no submit");
  fireEvent.click(button);
}

function erase<Row, Values extends Record<string, unknown>>(
  spec: ResourceSpec<Row, Values>,
) {
  return spec as unknown as ResourceSpec<unknown, Record<string, unknown>>;
}

describe("an add with every box empty", () => {
  it.each([
    ["Slack", erase(channelSpec("slack", noop)), "Enter the webhook URL."],
    ["a destination", erase(destinationSpec(noop)), "Enter the secret access key."],
    ["a registry", erase(registrySpec(noop)), "Enter the password."],
  ])("%s flags its secret beside the name, and sends nothing", async (_, spec, sentence) => {
    render(
      <ResourceFormModal spec={spec} row={null} open onOpenChange={() => {}} />,
    );
    submit();
    expect(await screen.findByText(sentence)).toBeDefined();
    expect(document.body.textContent).not.toMatch(/Invalid input|cannot be empty/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

type Row = { id: string };
type Values = { name: string; secretAccessKey: string };

function keySpec(create: () => Promise<unknown>): ResourceSpec<Row, Values> {
  return {
    noun: "key",
    plural: "keys",
    title: "Keys",
    icon: "key",
    addLabel: "Add a key",
    emptyTitle: "None",
    emptyBody: "None.",
    columns: [],
    getRowId: (row) => row.id,
    rowName: (row) => row.id,
    schema: z.object({ name: z.string(), secretAccessKey: z.string() }),
    fields: [
      { name: "name", label: "Name" },
      { name: "secretAccessKey", label: "Secret access key", kind: "password" },
    ],
    toDefaults: () => ({ name: "k", secretAccessKey: "" }),
    secrets: [
      { name: "secretAccessKey", label: "the secret access key", required: true },
    ],
    create,
    update: async () => undefined,
    remove: noop,
    permissions: "same-as-list",
  } as ResourceSpec<Row, Values>;
}

describe("a required secret", () => {
  it("is not refused on an edit, where empty keeps the stored one", async () => {
    const update = vi.fn(async () => undefined);
    const spec = { ...keySpec(noop), update };
    render(
      <ResourceFormModal spec={spec} row={{ id: "k" }} open onOpenChange={() => {}} />,
    );
    submit();
    await waitFor(() => expect(update).toHaveBeenCalled());
    expect(screen.queryByText("Enter the secret access key.")).toBeNull();
  });
});

describe("a backend refusal on a field", () => {
  it("is said in the field's label, not its code name", async () => {
    const create = vi.fn(async () => {
      throw new ApiError(400, "Validation failed", {
        issues: [
          { path: "secretAccessKey", message: "secretAccessKey cannot be empty" },
        ],
      });
    });
    const spec = { ...keySpec(create), secrets: [] };
    render(
      <ResourceFormModal spec={spec} row={null} open onOpenChange={() => {}} />,
    );
    submit();
    expect(
      await screen.findByText("Secret access key cannot be empty."),
    ).toBeDefined();
  });

  it("turns zod's own words for a missing value into the label's", async () => {
    const create = vi.fn(async () => {
      throw new ApiError(400, "Validation failed", {
        issues: [
          {
            path: "secretAccessKey",
            message: "Invalid input: expected string, received undefined",
          },
        ],
      });
    });
    const spec = { ...keySpec(create), secrets: [] };
    render(
      <ResourceFormModal spec={spec} row={null} open onOpenChange={() => {}} />,
    );
    submit();
    expect(await screen.findByText("Secret access key is needed.")).toBeDefined();
  });
});
