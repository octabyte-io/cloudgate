import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "@/lib/api/api-error";
import {
  composeApi,
  type Compose,
  type ComposeDetail,
} from "@/lib/api/endpoints/compose";
import { deploymentsApi } from "@/lib/api/endpoints/deployments";
import { mountsApi, type Mount } from "@/lib/api/endpoints/mounts";
import type { RequiredPermissions } from "@/lib/auth/use-permission";

const toast = vi.hoisted(() => ({
  done: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/components/console/toast", () => ({ toast }));

vi.mock("@/lib/auth/client", async (original) => ({
  ...(await original<typeof import("@/lib/auth/client")>()),
  useActiveOrganizationId: () => ({ organizationId: "org-1", pending: false }),
}));

// The caller's effective statements are the boundary, refused one by one.
const refused = vi.hoisted(() => ({ statements: [] as string[] }));
vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission: (required: RequiredPermissions) => ({
    allowed: !Object.entries(required).some(([resource, actions]) =>
      actions.some((action) =>
        refused.statements.includes(`${resource}:${action}`),
      ),
    ),
    pending: false,
  }),
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

const { COMPOSE_RESTART_REFUSAL } = await import("../use-compose");
const { CONFIG_FILE_SAVE_REFUSAL, CONFIG_FILE_UNSAVED } = await import(
  "../config-files/config-files-card"
);
const { default: Panel } = await import("./config-files");

const STACK = {
  composeId: "cmp-1",
  environmentId: "env-1",
  serverId: null,
  cloudAccountId: null,
  name: "grafana",
  appName: "grafana-a1b2c3",
  composeType: "docker-compose",
  composeStatus: "done",
  sourceType: "raw",
  composeFile: "services:\n  grafana:\n    image: grafana/grafana\n",
} as unknown as ComposeDetail;

const fileMount = (mountId: string, filePath: string, content: string) =>
  ({
    mountId,
    type: "file",
    filePath,
    content,
    hostPath: null,
    volumeName: null,
    mountPath: "",
    serviceType: "compose",
    applicationId: null,
    composeId: "cmp-1",
  }) as Mount;

const GRAFANA_INI = fileMount(
  "mnt-1",
  "grafana.ini",
  "[server]\nhttp_port = 3000\n",
);
const DATASOURCES = fileMount(
  "mnt-2",
  "provisioning/datasources.yml",
  "apiVersion: 1\ndatasources: []\n",
);
const EDITED = "[server]\nhttp_port = 4000\n";

beforeEach(() => {
  refused.statements = [];
  vi.spyOn(composeApi, "findOne").mockResolvedValue(STACK);
  vi.spyOn(deploymentsApi, "listByCompose").mockResolvedValue([]);
  vi.spyOn(mountsApi, "listByService").mockResolvedValue([
    GRAFANA_INI,
    DATASOURCES,
  ]);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  for (const fn of Object.values(toast)) fn.mockReset();
});

function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <Panel id="cmp-1" kind={null} label="Config files" icon="lines" />
    </QueryClientProvider>,
  );
}

const editor = (path: string) =>
  screen.findByLabelText(`The config file ${path}`) as Promise<HTMLTextAreaElement>;
const saveButton = () => screen.getByRole("button", { name: "Save the file" });

/** Opens grafana.ini, types the edit, and presses Save. */
async function saveEdit() {
  const update = vi
    .spyOn(mountsApi, "update")
    .mockResolvedValue({ ...GRAFANA_INI, content: EDITED });
  mount();
  fireEvent.change(await editor("grafana.ini"), { target: { value: EDITED } });
  vi.mocked(mountsApi.listByService).mockResolvedValue([
    { ...GRAFANA_INI, content: EDITED },
    DATASOURCES,
  ]);
  fireEvent.click(saveButton());
  return update;
}

describe("Config files: the list and the editor", () => {
  it("lists each file by its path and opens the first", async () => {
    mount();

    expect(
      await screen.findByRole("button", { name: "grafana.ini" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "provisioning/datasources.yml" }),
    ).toBeTruthy();
    expect((await editor("grafana.ini")).value).toBe(GRAFANA_INI.content);
    expect(mountsApi.listByService).toHaveBeenCalledWith("cmp-1", "compose");
  });

  it("shows a file's current content when it is opened", async () => {
    mount();
    fireEvent.click(
      await screen.findByRole("button", {
        name: "provisioning/datasources.yml",
      }),
    );

    expect((await editor("provisioning/datasources.yml")).value).toBe(
      DATASOURCES.content,
    );
    expect(screen.queryByLabelText("The config file grafana.ini")).toBeNull();
  });
});

describe("Config files: Save", () => {
  it("sends only the new content, says so, and shows the content read back", async () => {
    const update = await saveEdit();

    await waitFor(() =>
      expect(update).toHaveBeenCalledWith("mnt-1", { content: EDITED }),
    );
    await waitFor(() => expect(toast.done).toHaveBeenCalled());
    expect(toast.done.mock.calls[0][0]).toBe("grafana.ini saved.");
    // The list is read again, and the editor shows what it answered.
    await waitFor(() =>
      expect(mountsApi.listByService).toHaveBeenCalledTimes(2),
    );
    expect((await editor("grafana.ini")).value).toBe(EDITED);
    expect(document.body.textContent).not.toContain("Unsaved changes");
  });

  it("shows the refusal in place and keeps the edit", async () => {
    vi.spyOn(mountsApi, "update").mockRejectedValue(
      new ApiError(409, "The Server is in maintenance", {
        path: "/mounts/mnt-1",
      }),
    );
    mount();
    fireEvent.change(await editor("grafana.ini"), {
      target: { value: EDITED },
    });
    fireEvent.click(saveButton());

    expect(await screen.findByText(/The Server is in maintenance/)).toBeTruthy();
    expect((await editor("grafana.ini")).value).toBe(EDITED);
    expect(screen.queryByRole("button", { name: "Restart to apply" })).toBeNull();
  });

  it.each(["volume:create", "service:update"])(
    "is off with the reason for a role without %s, and sends nothing",
    async (statement) => {
      refused.statements = [statement];
      const update = vi.spyOn(mountsApi, "update");
      mount();
      fireEvent.change(await editor("grafana.ini"), {
        target: { value: EDITED },
      });

      const button = saveButton();
      expect(button.getAttribute("aria-disabled")).toBe("true");
      expect(button.getAttribute("title")).toBe(CONFIG_FILE_SAVE_REFUSAL);
      const described = button.getAttribute("aria-describedby");
      expect(document.getElementById(described as string)?.textContent).toBe(
        CONFIG_FILE_SAVE_REFUSAL,
      );
      fireEvent.click(button);
      expect(update).not.toHaveBeenCalled();
    },
  );
});

describe("Config files: Restart to apply", () => {
  it("is offered only after a save, and runs the stack's Restart", async () => {
    mount();
    await editor("grafana.ini");
    expect(screen.queryByRole("button", { name: "Restart to apply" })).toBeNull();
    cleanup();

    const restart = vi
      .spyOn(composeApi, "restart")
      .mockResolvedValue(STACK as Compose);
    await saveEdit();
    const button = await screen.findByRole("button", {
      name: "Restart to apply",
    });

    fireEvent.click(button);

    await waitFor(() => expect(restart).toHaveBeenCalledWith("cmp-1"));
    await waitFor(() =>
      expect(toast.done).toHaveBeenCalledWith(
        "grafana's containers are restarting.",
      ),
    );
  });

  it("is off with the reason for a role that may not deploy", async () => {
    refused.statements = ["deployment:create"];
    const restart = vi.spyOn(composeApi, "restart");
    await saveEdit();

    const button = await screen.findByRole("button", {
      name: "Restart to apply",
    });
    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("title")).toBe(COMPOSE_RESTART_REFUSAL);
    const described = button.getAttribute("aria-describedby");
    expect(described).toBeTruthy();
    expect(document.getElementById(described as string)?.textContent).toBe(
      COMPOSE_RESTART_REFUSAL,
    );
    fireEvent.click(button);
    expect(restart).not.toHaveBeenCalled();
  });

  it("is not offered on a Swarm stack, which is told to deploy instead", async () => {
    vi.mocked(composeApi.findOne).mockResolvedValue({
      ...STACK,
      composeType: "stack",
    } as ComposeDetail);
    const restart = vi.spyOn(composeApi, "restart");
    await saveEdit();

    expect(
      await screen.findByText(/deploy the stack to apply it/i),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Restart to apply" })).toBeNull();
    expect(restart).not.toHaveBeenCalled();
  });
});

describe("Config files: leaving with unsaved edits", () => {
  it("asks before a link leaves the page, and stays when the answer is no", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    mount();
    fireEvent.change(await editor("grafana.ini"), {
      target: { value: EDITED },
    });

    const anchor = document.createElement("a");
    anchor.href = "/compose/cmp-1/logs";
    document.body.append(anchor);
    const followed = fireEvent.click(anchor);
    anchor.remove();

    expect(confirm).toHaveBeenCalledWith(CONFIG_FILE_UNSAVED);
    expect(followed).toBe(false);
  });

  it("asks before opening another file over the edit, and keeps it when the answer is no", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    mount();
    fireEvent.change(await editor("grafana.ini"), {
      target: { value: EDITED },
    });

    fireEvent.click(
      screen.getByRole("button", { name: "provisioning/datasources.yml" }),
    );

    expect(confirm).toHaveBeenCalledWith(CONFIG_FILE_UNSAVED);
    expect((await editor("grafana.ini")).value).toBe(EDITED);
  });

  it("asks nothing once the edit is saved", async () => {
    const confirm = vi.spyOn(window, "confirm");
    await saveEdit();
    await waitFor(() => expect(toast.done).toHaveBeenCalled());

    const anchor = document.createElement("a");
    anchor.href = "/compose/cmp-1/logs";
    document.body.append(anchor);
    anchor.addEventListener("click", (event) => event.preventDefault());
    fireEvent.click(anchor);
    anchor.remove();

    expect(confirm).not.toHaveBeenCalled();
  });
});
