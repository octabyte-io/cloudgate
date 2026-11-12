import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TerminalChannel } from "@/lib/realtime/gateways";

import { TerminalEmulator, type XtermKit } from "./terminal-emulator";

/**
 * The emulator, owned outside React — what lets the Dock take a live
 * session from a page with its scrollback, rather than remounting a new one.
 *
 * xterm needs a canvas and a layout jsdom does not have, so the kit is a fake
 * with the handful of members the emulator calls. What these pin is the
 * emulator's own contract: frames before mount survive, a move between frames
 * keeps the same xterm, and a resize is refitted and told to the gateway once
 * it settles rather than on every pixel of a drag.
 */
class FakeTerm {
  cols = 80;
  rows = 24;
  opened: HTMLElement | null = null;
  written: string[] = [];
  keyHandler: ((event: KeyboardEvent) => boolean) | null = null;
  disposed = false;
  open(element: HTMLElement) {
    this.opened = element;
  }
  write(frame: string) {
    this.written.push(frame);
  }
  onData() {}
  resize(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
  }
  refresh = vi.fn();
  focus = vi.fn();
  attachCustomKeyEventHandler(handler: (event: KeyboardEvent) => boolean) {
    this.keyHandler = handler;
  }
  dispose() {
    this.disposed = true;
  }
}

let proposed = { cols: 100, rows: 30 };
let made: FakeTerm[] = [];

const kit: XtermKit = {
  create: () => {
    const term = new FakeTerm();
    made.push(term);
    return {
      term: term as never,
      fit: { proposeDimensions: () => proposed } as never,
    };
  },
  paint: () => {},
};

let observed: Array<() => void> = [];
class FakeObserver {
  constructor(private readonly callback: () => void) {}
  observe() {
    observed.push(this.callback);
  }
  disconnect() {
    observed = observed.filter((each) => each !== this.callback);
  }
}

function fakeChannel(status: "open" | "connecting" = "open") {
  let sink: ((frame: string) => void) | null = null;
  const listeners = new Set<() => void>();
  const channel = {
    snapshot: { status },
    attach: (write: (frame: string) => void) => {
      sink = write;
    },
    send: vi.fn(),
    resize: vi.fn(() => channel.snapshot.status === "open"),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => channel.snapshot,
    say: (frame: string) => sink?.(frame),
    become: (next: "open" | "connecting") => {
      channel.snapshot = { status: next };
      for (const listener of listeners) listener();
    },
  };
  return channel;
}

/** A frame with a width, which is what the emulator treats as laid out. */
function frame(): HTMLDivElement {
  const element = document.createElement("div");
  Object.defineProperty(element, "clientWidth", { value: 800 });
  document.body.append(element);
  return element;
}

beforeEach(() => {
  proposed = { cols: 100, rows: 30 };
  made = [];
  observed = [];
  vi.useFakeTimers();
  vi.stubGlobal("ResizeObserver", FakeObserver);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

const settle = () => vi.advanceTimersByTimeAsync(0);

describe("TerminalEmulator", () => {
  it("keeps the frames that arrive before xterm exists, and writes them on mount", async () => {
    const channel = fakeChannel();
    const emulator = new TerminalEmulator(
      channel as unknown as TerminalChannel,
      { label: "Shell on web-1", kit: async () => kit },
    );
    channel.say("Connecting...\r\n");

    emulator.mount(frame());
    await settle();

    expect(made).toHaveLength(1);
    expect(made[0]?.written).toEqual(["Connecting...\r\n"]);
    expect(emulator.getSnapshot()).toMatchObject({
      ready: true,
      grid: { cols: 100, rows: 30 },
    });
    expect(channel.resize).toHaveBeenCalledWith(100, 30);
  });

  it("moves to another frame with the same xterm — same scrollback, no new session", async () => {
    const channel = fakeChannel();
    const emulator = new TerminalEmulator(
      channel as unknown as TerminalChannel,
      { label: "Shell", kit: async () => kit },
    );
    const page = frame();
    const unmount = emulator.mount(page);
    await settle();
    channel.say("top\r\n");

    unmount();
    expect(page.contains(emulator.element)).toBe(false);

    const dock = frame();
    proposed = { cols: 160, rows: 12 };
    emulator.mount(dock);
    await settle();

    expect(made).toHaveLength(1);
    expect(dock.contains(emulator.element)).toBe(true);
    expect(made[0]?.written).toEqual(["top\r\n"]);
    expect(made[0]?.disposed).toBe(false);
    // The Dock is a different shape, and the pty is told so at once.
    expect(channel.resize).toHaveBeenLastCalledWith(160, 12);
  });

  it("refits and sends the resize frame once a drag settles, not on every step", async () => {
    const channel = fakeChannel();
    const emulator = new TerminalEmulator(
      channel as unknown as TerminalChannel,
      { label: "Shell", kit: async () => kit, debounceMs: 80 },
    );
    emulator.mount(frame());
    await settle();
    channel.resize.mockClear();

    for (const rows of [28, 26, 24, 22]) {
      proposed = { cols: 100, rows };
      for (const notify of observed) notify();
      await vi.advanceTimersByTimeAsync(20);
    }
    expect(channel.resize).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(80);
    expect(channel.resize).toHaveBeenCalledTimes(1);
    expect(channel.resize).toHaveBeenCalledWith(100, 22);
    expect(made[0]?.rows).toBe(22);
    expect(emulator.getSnapshot().grid).toEqual({ cols: 100, rows: 22 });
  });

  it("says the size again when the socket opens, which a connecting socket drops", async () => {
    const channel = fakeChannel("connecting");
    const emulator = new TerminalEmulator(
      channel as unknown as TerminalChannel,
      { label: "Shell", kit: async () => kit },
    );
    emulator.mount(frame());
    await settle();
    channel.resize.mockClear();

    channel.become("open");
    expect(channel.resize).toHaveBeenCalledWith(100, 30);
  });

  it("lets ⌃` past xterm, so the Dock's shortcut works with the terminal focused", async () => {
    const emulator = new TerminalEmulator(
      fakeChannel() as unknown as TerminalChannel,
      { label: "Shell", kit: async () => kit },
    );
    emulator.mount(frame());
    await settle();

    const handler = made[0]?.keyHandler;
    const backtick = new KeyboardEvent("keydown", {
      key: "`",
      code: "Backquote",
      ctrlKey: true,
    });
    const plain = new KeyboardEvent("keydown", { key: "a", code: "KeyA" });
    // `false` is xterm's "do not handle this key".
    expect(handler?.(backtick)).toBe(false);
    expect(handler?.(plain)).toBe(true);
  });

  it("dispose ends xterm and takes the element off the page", async () => {
    const emulator = new TerminalEmulator(
      fakeChannel() as unknown as TerminalChannel,
      { label: "Shell", kit: async () => kit },
    );
    const where = frame();
    emulator.mount(where);
    await settle();

    emulator.dispose();
    expect(made[0]?.disposed).toBe(true);
    expect(where.contains(emulator.element)).toBe(false);
  });
});
