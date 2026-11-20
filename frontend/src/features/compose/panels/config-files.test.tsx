import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { composeApi, type ComposeDetail } from "@/lib/api/endpoints/compose";
import { deploymentsApi } from "@/lib/api/endpoints/deployments";
import { mountsApi, type Mount } from "@/lib/api/endpoints/mounts";
import type { RequiredPermissions } from "@/lib/auth/use-permission";

/**
 * `usePermission`'s verdict, held by statement: everything is held unless a
 * case takes one away.
 */
const refused = vi.hoisted(() => ({ current: new Set<string>() }));
vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission: (required: RequiredPermissions) => ({
    allowed: !Object.entries(required).some(([resource, actions]) =>
      (actions as string[]).some((action) =>
        refused.current.has(`${resource}:${action}`),
      ),
    ),
    pending: false,
  }),
}));
vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useActiveOrganizationId: () => ({ organizationId: "org-1", pending: false }),
}));
// CodeMirror is a `next/dynamic` island jsdom cannot run.
vi.mock("@/components/console/code-editor", () => ({
  CodeEditor: ({
    label,
    value,
    onChange,
  }: {
    label: string;
    value: string;
    onChange: (next: string) => void;
  }) => (
    <textarea
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  ),
}));
vi.mock("@/components/console/toast", () => ({
  toast: { done: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const { default: Panel } = await import("./config-files");
const { CONFIG_FILE_SAVE_REFUSAL, CONFIG_FILE_RESTART_REFUSAL } =
  await import("../config-files/config-files-card");

const STACK = {
  composeId: "cmp-1",
  environmentId: "env-1",
  name: "grafana",
  composeType: "docker-compose",
  composeStatus: "done",
  environment: { name: "production", project: { name: "monitoring" } },
} as unknown as ComposeDetail;

function fileMount(id: string, filePath: string, content: string): Mount {
  return {
    mountId: id,
    type: "file",
    hostPath: null,
    volumeName: null,
    filePath,
    content,
    serviceType: "compose",
    mountPath: `/etc/grafana/${filePath}`,
    applicationId: null,
    composeId: "cmp-1",
  };
}

const VOLUME: Mount = {
  ...fileMount("m-vol", "", ""),
  type: "volume",
  filePath: null,
  content: null,
  volumeName: "grafana-data",
  mountPath: "/var/lib/grafana",
};

let mounts: Mount[];

beforeEach(() => {
  mounts = [
    fileMount("m-ini", "grafana.ini", "[server]\nhttp_port = 3000\n"),
    fileMount("m-yml", "datasources.yml", "apiVersion: 1\n"),
    VOLUME,
  ];
  vi.spyOn(composeApi, "findOne").mockResolvedValue(STACK);
  vi.spyOn(deploymentsApi, "listByCompose").mockResolvedValue([]);
  vi.spyOn(mountsApi, "listByService").mockImplementation(async () => mounts);
  vi.spyOn(mountsApi, "update").mockImplementation(async (id, input) => {
    mounts = mounts.map((mount) =>
      mount.mountId === id
        ? { ...mount, content: input.content ?? null }
        : mount,
    );
    return mounts.find((mount) => mount.mountId === id) as Mount;
  });
  vi.spyOn(composeApi, "restart").mockResolvedValue(
    undefined as unknown as Awaited<ReturnType<typeof composeApi.restart>>,
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  refused.current = new Set();
});

function show() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <Panel id="cmp-1" kind={null} label="Config files" icon="lines" />
    </QueryClientProvider>,
  );
}

const editor = (name: string) =>
  screen.findByLabelText(`The config file ${name} for grafana`);

async function edit(name: string, value: string) {
  fireEvent.change(await editor(name), { target: { value } });
}

describe("Config files tab (#135)", () => {
  it("lists every file by its path, never a volume, and opens the first", async () => {
    show();

    expect(((await editor("grafana.ini")) as HTMLTextAreaElement).value).toBe(
      "[server]\nhttp_port = 3000\n",
    );
    expect(mountsApi.listByService).toHaveBeenCalledWith("cmp-1", "compose");
    const tabs = screen.getAllByRole("tab").map((tab) => tab.textContent);
    expect(tabs).toEqual(["grafana.ini", "datasources.yml"]);

    fireEvent.click(screen.getByRole("tab", { name: "datasources.yml" }));
    expect(
      ((await editor("datasources.yml")) as HTMLTextAreaElement).value,
    ).toBe("apiVersion: 1\n");
  });

  it("saves only the content, then shows it and offers Restart to apply", async () => {
    show();
    await edit("grafana.ini", "[server]\nhttp_port = 4000\n");
    expect(screen.getByText(/Unsaved changes/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Save the file" }));

    await waitFor(() =>
      expect(mountsApi.update).toHaveBeenCalledWith("m-ini", {
        content: "[server]\nhttp_port = 4000\n",
      }),
    );
    // The list is read again, and the editor holds what was saved.
    await waitFor(() =>
      expect(mountsApi.listByService).toHaveBeenCalledTimes(2),
    );
    expect(((await editor("grafana.ini")) as HTMLTextAreaElement).value).toBe(
      "[server]\nhttp_port = 4000\n",
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "Restart to apply" }),
    );
    await waitFor(() =>
      expect(composeApi.restart).toHaveBeenCalledWith("cmp-1"),
    );
  });

  it("offers no Restart before a save", async () => {
    show();
    await editor("grafana.ini");
    expect(
      screen.queryByRole("button", { name: "Restart to apply" }),
    ).toBeNull();
  });

  it.each(["volume:create", "service:update"])(
    "turns Save off with its reason without %s",
    async (statement) => {
      refused.current = new Set([statement]);
      show();
      await edit("grafana.ini", "changed\n");

      const save = screen.getByRole("button", { name: "Save the file" });
      expect(save.getAttribute("aria-disabled")).toBe("true");
      expect(save.getAttribute("title")).toBe(CONFIG_FILE_SAVE_REFUSAL);
      fireEvent.click(save);
      expect(mountsApi.update).not.toHaveBeenCalled();
    },
  );

  it("turns Restart to apply off with its reason without deployment:create", async () => {
    refused.current = new Set(["deployment:create"]);
    show();
    await edit("grafana.ini", "changed\n");
    fireEvent.click(screen.getByRole("button", { name: "Save the file" }));

    const restart = await screen.findByRole("button", {
      name: "Restart to apply",
    });
    expect(restart.getAttribute("aria-disabled")).toBe("true");
    expect(restart.getAttribute("title")).toBe(CONFIG_FILE_RESTART_REFUSAL);
    fireEvent.click(restart);
    expect(composeApi.restart).not.toHaveBeenCalled();
  });

  it("asks before switching files with unsaved edits", async () => {
    show();
    await edit("grafana.ini", "changed\n");
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);

    fireEvent.click(screen.getByRole("tab", { name: "datasources.yml" }));

    expect(confirm).toHaveBeenCalled();
    expect(((await editor("grafana.ini")) as HTMLTextAreaElement).value).toBe(
      "changed\n",
    );
  });
});
