import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Server } from "@/lib/api/endpoints/servers";

/**
 * The Server facts card's ID row (#1410) and its Same-machine warning (#149),
 * with the browser and the network as the boundaries: `fetch` answers the
 * session read, `GET /settings/about` and `GET /ssh-keys`, which
 * run through the real auth client, API client and `useSshKeys`; the clipboard
 * is `navigator.clipboard`, stubbed as `copy-button.test.tsx` does.
 *
 * **"No toast" is read off the page, not off a mocked module.** The app's own
 * `Toaster` (the one `Providers` mounts) renders beside the card, so a toast
 * raised by anything on the copy path would be a `[data-sonner-toast]` element
 * here. An earlier version of this file mocked `@/components/console/toast`
 * and asserted it went uncalled, which could not fail: `CopyButton` never
 * imports that module.
 */

// jsdom has no `matchMedia`, and sonner's `Toaster` asks it for the colour
// scheme. A browser API, so it is the thing stubbed.
vi.stubGlobal(
  "matchMedia",
  (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList,
);

/** The instance mode `GET /settings/about` answers with. */
let instanceMode: "hosted" | "self-hosted" = "self-hosted";

function answer(input: RequestInfo | URL): Promise<Response> {
  const url = String(input instanceof Request ? input.url : input);
  const path = new URL(url, "http://console.test").pathname;
  const json = (body: unknown) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  if (path.endsWith("/ssh-keys")) {
    return json([
      {
        sshKeyId: "key-1",
        name: "fleet",
        description: null,
        publicKey: "ssh-ed25519 AAAA cloudgate:fleet",
        createdAt: "2026-09-01T10:00:00.000Z",
        lastUsedAt: null,
        organizationId: "org-1",
      },
    ]);
  }
  if (path.endsWith("/settings/about")) {
    return json({ mode: instanceMode });
  }
  if (path.endsWith("/get-session")) {
    return json({
      session: { id: "session-1", activeOrganizationId: "org-1" },
      user: { id: "user-1", email: "operator@example.test" },
    });
  }
  return Promise.resolve(new Response("{}", { status: 404 }));
}

// Before the card is imported: `createAuthClient` captures `fetch` as its
// module evaluates, so a stub installed later would never be called.
const fetchStub = vi.fn(answer);
vi.stubGlobal("fetch", fetchStub);

const { ServerFactsCard } = await import("./server-facts-card");
const { Toaster } = await import("@/components/console/toast");

const SERVER_ID = "8f3c2a71-5d4e-4b9a-a0c6-2e7f19d3b845";

const server = {
  serverId: SERVER_ID,
  name: "edge-1",
  ipAddress: "203.0.113.42",
  port: 22,
  username: "root",
  sshKeyId: "key-1",
  serverType: "deploy",
  serverStatus: "active",
  reachCheckedAt: null,
  reachOk: null,
  sameMachine: false,
  createdAt: "2026-09-17T10:00:00.000Z",
} as unknown as Server;

/** jsdom's own, put back after a test that stubbed the clipboard. */
const jsdomNavigator = globalThis.navigator;

afterEach(() => {
  cleanup();
  // Only the clipboard is per test; `fetch` and `matchMedia` stay for the file,
  // which is why this is not `vi.unstubAllGlobals()`.
  vi.stubGlobal("navigator", jsdomNavigator);
  instanceMode = "self-hosted";
});

function mount(shown: Server = server) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={client}>
      <ServerFactsCard server={shown} />
      <Toaster />
    </QueryClientProvider>,
  );
}

/** The facts card's rows, in order, each as its label and its `<dd>`. */
function rows() {
  return Array.from(document.querySelectorAll('[data-slot="kv-row"]')).map(
    (row) => ({
      label: row.querySelector("dt")?.textContent,
      value: row.querySelector("dd"),
    }),
  );
}

describe("ServerFactsCard, the ID row", () => {
  it("ends with an ID row showing the Server's id, after Added", async () => {
    mount();
    // The Key row names the key once the real `GET /ssh-keys` has answered.
    await screen.findByText("fleet");

    const labels = rows().map((row) => row.label);
    expect(labels.slice(-2)).toEqual(["Added", "ID"]);
    expect(rows().at(-1)?.value?.textContent).toBe(SERVER_ID);
  });

  it("sets the id in mono, with the full id as its tooltip", () => {
    mount();

    const id = rows().at(-1)?.value;
    expect(id?.classList.contains("font-mono")).toBe(true);
    expect(id?.getAttribute("title")).toBe(SERVER_ID);
  });

  it("puts a copy control named for the Server id in the ID row", () => {
    mount();

    const copy = screen.getByRole("button", { name: "Copy the Server id" });
    expect(
      copy.closest('[data-slot="kv-row"]')?.querySelector("dt")?.textContent,
    ).toBe("ID");
  });

  it("copies exactly the Server's id and confirms in place, with no toast", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    mount();

    fireEvent.click(screen.getByRole("button", { name: "Copy the Server id" }));
    expect(
      await screen.findByRole("button", { name: "Server id copied" }),
    ).toBeDefined();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(SERVER_ID);
    // The Toaster is mounted and nothing reached it.
    expect(document.querySelectorAll("[data-sonner-toast]")).toHaveLength(0);
  });
});

/** The Same-machine warning's sentence (spec #146). */
const WARNING = /Cloudgate itself runs on this machine/;

/**
 * The Same-machine warning on a Server whose address is Cloudgate's own
 * machine (#149), so it shows as soon as the Server is saved.
 */
describe("ServerFactsCard, the Same-machine warning", () => {
  const onTheBox = {
    ...server,
    ipAddress: "127.0.0.1",
    sameMachine: true,
  } as Server;

  it("warns for a Server on Cloudgate's own machine", async () => {
    mount(onTheBox);

    expect(await screen.findByText(WARNING)).toBeDefined();
  });

  it("does not warn for a Server on another machine", async () => {
    mount();
    await screen.findByText("fleet");

    expect(screen.queryByText(WARNING)).toBeNull();
  });

  it("never warns on the Hosted instance", async () => {
    instanceMode = "hosted";
    mount(onTheBox);
    await screen.findByText("fleet");
    // The mode has been answered, so nothing is held back for want of it.
    await waitFor(() =>
      expect(
        fetchStub.mock.calls.some(([input]) =>
          String(input instanceof Request ? input.url : input).endsWith(
            "/settings/about",
          ),
        ),
      ).toBe(true),
    );
    await new Promise((settle) => setTimeout(settle, 0));

    expect(screen.queryByText(WARNING)).toBeNull();
  });
});
