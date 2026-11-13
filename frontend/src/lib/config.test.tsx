import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useServerTerminal } from "@/lib/realtime/terminals";

import { apiOriginScript } from "./config";

/**
 * Every socket the page constructs, by the URL it was given. The socket never
 * opens: what is under test is where the browser was sent, not what answered.
 */
let dialled: string[] = [];

beforeEach(() => {
  dialled = [];
  vi.stubGlobal(
    "WebSocket",
    class {
      static readonly OPEN = 1;
      readyState = 0;
      constructor(url: string) {
        dialled.push(url);
      }
      addEventListener() {}
      removeEventListener() {}
      close() {}
      send() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (window as { __CLOUDGATE_API_URL__?: string }).__CLOUDGATE_API_URL__;
});

/**
 * What one start of the console does for a page: the server reads
 * `CLOUDGATE_API_URL` from its environment, and the root layout writes it into
 * the page ahead of every script, which the browser runs.
 */
function startWith(env: Record<string, string | undefined>) {
  new Function(apiOriginScript(env))();
}

function Terminal() {
  useServerTerminal({ serverId: "srv-1" });
  return null;
}

/**
 * ADR-0082: the address used to be inlined into the client bundle when it was
 * built, which tied a build to one box and made changing it a rebuild. The
 * same module graph here is one build; each start is only a different
 * environment.
 */
describe("apiOriginScript", () => {
  it("one build dials the WebSocket origin of whichever CLOUDGATE_API_URL it was started with", () => {
    startWith({ CLOUDGATE_API_URL: "http://203.0.113.10:4000" });
    render(<Terminal />);
    expect(dialled).toHaveLength(1);
    expect(dialled[0]).toMatch(/^ws:\/\/203\.0\.113\.10:4000\/terminal\?/);

    cleanup();
    startWith({ CLOUDGATE_API_URL: "https://console.example.com" });
    render(<Terminal />);
    expect(dialled).toHaveLength(2);
    expect(dialled[1]).toMatch(/^wss:\/\/console\.example\.com\/terminal\?/);
  });
});
