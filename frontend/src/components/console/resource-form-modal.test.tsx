import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { FieldValues } from "react-hook-form";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { ResourceSpec } from "@/components/console/resource-spec";
import { aiSpec } from "@/features/integrations/ai/ai-spec";
import { destinationSpec } from "@/features/integrations/destinations/destinations-spec";
import { channelSpec } from "@/features/integrations/notifications/channel-spec";
import { CHANNELS } from "@/features/integrations/notifications/channels";
import { registrySpec } from "@/features/integrations/registries/registries-spec";

import { ResourceFormModal } from "./resource-form-modal";

/**
 * **A test button that is off does not run the test**.
 *
 * The button was marked `aria-disabled` by hand, which bought the inert look and
 * the screen-reader announcement but not the thing Base UI does for `disabled`:
 * swallow the click. So "Send a test" with the webhook URL empty still sent the
 * request, and the dialog answered with the DTO's own "Invalid input: expected
 * string, received undefined" under a tooltip saying the test could not run.
 *
 * `fetch` is the boundary: a press that reaches it is a press that was not
 * refused, whichever endpoint module the spec happened to call.
 */

const fetchSpy = vi.fn(async () => new Response("{}", { status: 400 }));

beforeEach(() => {
  fetchSpy.mockClear();
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Lets a handler that was not refused get as far as its first `await`. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const noop = async () => undefined;

type Probe = { name: string };

const BLOCKED = "A test needs the probe filled in. Nothing is saved yet.";

function probeSpec(
  run: () => Promise<string>,
  blocked: string | null,
): ResourceSpec<Probe, { name: string }> {
  return {
    noun: "probe",
    plural: "probes",
    title: "Probes",
    icon: "spark",
    addLabel: "Add a probe",
    emptyTitle: "No probe",
    emptyBody: "None.",
    tableLabel: "Probes",
    columns: [],
    getRowId: (row: Probe) => row.name,
    rowName: (row: Probe) => row.name,
    schema: z.object({ name: z.string() }) as never,
    fields: [{ name: "name", label: "Name" }],
    toDefaults: () => ({ name: "" }),
    test: { label: "Probe it", blocked: () => blocked, run },
    create: noop,
    update: noop,
    remove: noop,
  } as unknown as ResourceSpec<Probe, { name: string }>;
}

describe("ResourceFormModal's test button", () => {
  it("does not run a blocked test, and says why in its own words", async () => {
    const run = vi.fn(async () => "sent");
    render(
      <ResourceFormModal
        spec={probeSpec(run, BLOCKED)}
        row={null}
        open
        onOpenChange={() => {}}
      />,
    );

    const button = screen.getByRole("button", { name: "Probe it" });
    fireEvent.click(button);
    await settle();

    expect(run).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toMatch(/Did not work|Worked\./);

    // Off, focusable, and pointing at the sentence that says why.
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(button.getAttribute("title")).toBe(BLOCKED);
    const reason = document.getElementById(
      button.getAttribute("aria-describedby") ?? "",
    );
    expect(reason?.textContent).toBe(BLOCKED);
  });

  it("runs an unblocked test", async () => {
    const run = vi.fn(async () => "it answered");
    render(
      <ResourceFormModal
        spec={probeSpec(run, null)}
        row={null}
        open
        onOpenChange={() => {}}
      />,
    );

    const button = screen.getByRole("button", { name: "Probe it" });
    expect(button.getAttribute("aria-disabled")).not.toBe("true");
    fireEvent.click(button);

    expect(await screen.findByText("it answered")).toBeTruthy();
    expect(run).toHaveBeenCalledOnce();
  });
});

/**
 * The census: every spec that declares a test, driven on an *add* with nothing
 * typed. Which of them are blocked there is read off the rendered button rather
 * than listed, and the three the ticket names are asserted to be among them, so
 * the loop cannot pass by finding nothing to press.
 */
describe("every spec's test, pressed while blocked", () => {
  // Each spec is generic over its own row and values; the dialog is too, so
  // the list forgets both rather than naming a union nothing reads.
  type AnySpec = ResourceSpec<unknown, FieldValues>;
  const erase = (spec: unknown) => spec as AnySpec;
  const specs: [string, AnySpec][] = [
    ...CHANNELS.map((channel): [string, AnySpec] => [
      `notifications: ${channel.label}`,
      erase(channelSpec(channel.type, noop)),
    ]),
    ["destinations", erase(destinationSpec(noop))],
    ["ai", erase(aiSpec(noop))],
    ["registries", erase(registrySpec(noop))],
  ];
  /** The files the list above is built from — held against the source below. */
  const DECLARING = [
    "features/integrations/ai/ai-spec.tsx",
    "features/integrations/destinations/destinations-spec.tsx",
    "features/integrations/notifications/channel-spec.tsx",
    "features/integrations/registries/registries-spec.tsx",
  ];
  const blocked = new Set<string>();

  it.each(specs)("%s sends nothing", async (name, spec) => {
    render(
      <ResourceFormModal spec={spec} row={null} open onOpenChange={() => {}} />,
    );

    const button = screen.getByRole("button", { name: spec.test!.label });
    if (button.getAttribute("aria-disabled") !== "true") return;
    blocked.add(name);

    fireEvent.click(button);
    await settle();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toMatch(
      /Did not work|expected string/,
    );
  });

  it("found the three known sites blocked", () => {
    expect(blocked).toContain("notifications: Microsoft Teams");
    expect(blocked).toContain("destinations");
    expect(blocked).toContain("ai");
    // A fourth, and blocked on an add for the same reason as a destination's:
    // nothing is saved, so there is no password to log in with but a typed one.
    expect(blocked).toContain("registries");
  });

  it("drives every file in src whose ResourceSpec declares a test", () => {
    // Site N+1 arrives through this: a spec that gains a `test` and is not
    // in the list above reds here rather than going unpressed.
    const src = join(process.cwd(), "src");
    const declaring: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
          const source = readFileSync(path, "utf8")
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/^\s*\/\/.*$/gm, "");
          if (/ResourceSpec</.test(source) && /^\s+test: \{/m.test(source)) {
            declaring.push(relative(src, path));
          }
        }
      }
    };
    walk(src);
    expect(declaring.sort()).toEqual(DECLARING);
  });
});
