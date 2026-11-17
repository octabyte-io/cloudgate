import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeInfo } from "@/lib/api/endpoints/settings";
import type { SetupForm } from "@/lib/api/endpoints/templates";

/** Each host's kernel, by Server id; `""` is the platform host. */
const refuses = vi.hoisted(() => ({ byHost: {} as Record<string, string> }));
const asked = vi.hoisted(() => vi.fn());
// The one read is the system boundary: GET /settings/runtime-info.
vi.mock("@/lib/api/use-runtime-info", () => ({
  useRuntimeInfo: (
    serverId: string | null,
    { enabled = true }: { enabled?: boolean } = {},
  ) => {
    if (enabled) asked(serverId);
    const kernel = refuses.byHost[serverId ?? ""];
    return {
      data:
        enabled && kernel
          ? ({
              kernel: { observed: kernel },
              mongoRefusesKernel: true,
            } as unknown as RuntimeInfo)
          : undefined,
    };
  },
}));

const { SetupKernelNote } = await import("./setup-kernel-note");

afterEach(() => {
  cleanup();
  asked.mockReset();
  refuses.byHost = {};
});

/** Ackee, as found on #104: its own `mongo:8.0.38`, on two Environments. */
const ACKEE = {
  templateId: "ackee",
  templateName: "Ackee",
  images: ["electerious/ackee:3.4.2", "mongo:8.0.38"],
  environments: [
    { environmentId: "env-server", machine: { serverId: "srv-2604" } },
    { environmentId: "env-host", machine: { serverId: null } },
    { environmentId: "env-cloud", machine: null },
  ],
} as unknown as SetupForm;

function note() {
  return document.querySelector('[role="note"]')?.textContent ?? null;
}

describe("SetupKernelNote", () => {
  it("warns before Set up that the template's MongoDB 8 will not start on the picked Environment's Server", () => {
    refuses.byHost["srv-2604"] = "7.0.12";
    render(
      <SetupKernelNote
        setup={ACKEE}
        environmentId="env-server"
        newProjectTarget={null}
      />,
    );

    expect(note()).toContain(
      "MongoDB 8 will not start on this Server's kernel, Linux 7.0.12",
    );
    expect(note()).toContain("Ackee runs mongo:8.0.38.");
  });

  it("reads the platform host for a new Project on it, and nothing in a cloud", () => {
    refuses.byHost[""] = "7.0.12";
    render(
      <SetupKernelNote
        setup={ACKEE}
        environmentId=""
        newProjectTarget="platform-host"
      />,
    );
    expect(note()).toContain("the platform host's kernel");
    cleanup();

    render(
      <SetupKernelNote
        setup={ACKEE}
        environmentId="env-cloud"
        newProjectTarget={null}
      />,
    );
    expect(note()).toBeNull();
    expect(asked).not.toHaveBeenCalledWith(undefined);
  });

  it("asks no host anything for a template that runs no MongoDB 8", () => {
    refuses.byHost["srv-2604"] = "7.0.12";
    render(
      <SetupKernelNote
        setup={{ ...ACKEE, images: ["mongo:7.0.48", "ghost:5.96-alpine"] }}
        environmentId="env-server"
        newProjectTarget={null}
      />,
    );

    expect(note()).toBeNull();
    expect(asked).not.toHaveBeenCalled();
  });
});
