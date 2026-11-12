import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Gate, PermissionVerdict } from "@/lib/auth/use-permission";

const useInstanceGate = vi.hoisted(() => vi.fn<() => Gate>());
const usePermission = vi.hoisted(() => vi.fn<() => PermissionVerdict>());
const writeFile = vi.hoisted(() => ({
  mutateAsync: vi.fn(async () => true),
  isPending: false,
}));

const PATH = "/etc/cloudgate/traefik/dynamic/extra.yml";

// Both of the route's checks are boundaries: the caller's statements, and the
// instance-authority read (ADR-0013). The tree, the file and the write are
// replaced at the hooks. CodeMirror is a `next/dynamic` island jsdom cannot
// run, so a textarea stands in for it.
vi.mock("@/lib/auth/use-permission", async (original) => ({
  ...(await original<typeof import("@/lib/auth/use-permission")>()),
  usePermission,
}));
vi.mock("./use-platform", async (original) => ({
  ...(await original<typeof import("./use-platform")>()),
  useInstanceGate,
  useTraefikDirectories: () => ({
    data: [{ id: PATH, name: "extra.yml", type: "file" }],
    isPending: false,
    error: null,
  }),
  useTraefikFile: (path: string | null) => ({
    data: path === null ? undefined : "http: {}\n",
    isPending: false,
    error: null,
  }),
  usePlatformMutations: () => ({ writeFile }),
}));
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
    <textarea aria-label={label} value={value} onChange={(event) => onChange(event.target.value)} />
  ),
}));
vi.mock("@/components/console/toast", () => ({
  toast: { done: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

const { TraefikFilesCard } = await import("./traefik-files-card");
const { TRAEFIK_FILES_WRITE_REFUSAL } = await import("./use-platform");
const { roleRefusal } = await import("@/lib/auth/use-permission");

const INSTANCE_REFUSAL = "Only an administrator of this Cloudgate instance can do this.";
const EDITED = "http:\n  routers: {}\n";

afterEach(() => {
  cleanup();
  useInstanceGate.mockReset();
  usePermission.mockReset();
  writeFile.mutateAsync.mockClear();
});

function mount({ instance, statement }: { instance: boolean; statement: boolean }) {
  useInstanceGate.mockReturnValue({
    allowed: instance,
    refusal: instance ? "" : INSTANCE_REFUSAL,
  });
  usePermission.mockReturnValue({ allowed: statement, pending: false, role: "member" });
  render(<TraefikFilesCard />);
  fireEvent.click(screen.getByRole("button", { name: "extra.yml" }));
  fireEvent.change(screen.getByLabelText(PATH), { target: { value: EDITED } });
  return { button: screen.getByRole("button", { name: "Save file" }) };
}

function refusedWith(button: HTMLElement, reason: string) {
  expect(button.getAttribute("aria-disabled")).toBe("true");
  expect(button.getAttribute("title")).toBe(reason);
  const described = button.getAttribute("aria-describedby");
  expect(described).toBeTruthy();
  expect(document.getElementById(described as string)?.textContent).toBe(reason);
  fireEvent.click(button);
  expect(writeFile.mutateAsync).not.toHaveBeenCalled();
}

/**
 * Save file: `POST /settings/traefik/file` carries
 * `@RequirePermission('traefikFiles', 'write')`, and `traefikFileTarget` adds
 * `requireInstanceAuthority` for the platform host, which is the only target
 * this card writes. Both are refusals the route gives, so either one turns the
 * button off.
 */
describe("TraefikFilesCard — Save file", () => {
  it("says the role's reason in the words every gated control uses", () => {
    expect(TRAEFIK_FILES_WRITE_REFUSAL).toBe(roleRefusal("save Traefik's files"));
  });


  it("asks for traefikFiles:write", () => {
    mount({ instance: true, statement: true });
    expect(usePermission).toHaveBeenCalledWith({ traefikFiles: ["write"] });
  });

  it("is off with the role reason for a role without traefikFiles:write, and sends nothing", () => {
    const { button } = mount({ instance: true, statement: false });
    refusedWith(button, TRAEFIK_FILES_WRITE_REFUSAL);
  });

  it("is off with the backend's reason for a caller without instance authority, and sends nothing", () => {
    const { button } = mount({ instance: false, statement: true });
    refusedWith(button, INSTANCE_REFUSAL);
  });

  it("is live for an instance administrator who holds traefikFiles:write, and saves", async () => {
    const { button } = mount({ instance: true, statement: true });

    expect(button.getAttribute("aria-disabled")).not.toBe("true");
    expect(button.hasAttribute("title")).toBe(false);
    expect(document.body.textContent).not.toContain(INSTANCE_REFUSAL);
    expect(document.body.textContent).not.toContain(TRAEFIK_FILES_WRITE_REFUSAL);

    fireEvent.click(button);
    await waitFor(() =>
      expect(writeFile.mutateAsync).toHaveBeenCalledWith({ path: PATH, content: EDITED }),
    );
  });
});
