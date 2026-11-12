import type { FitAddon } from "@xterm/addon-fit";
import type { Terminal as XTerm } from "@xterm/xterm";

import type { TerminalChannel } from "@/lib/realtime/gateways";

import { fitToFrame } from "./terminal-fit";
import { isDockShortcut } from "./terminal-keys";
import { monoStack, resolveColor, wellTheme } from "./terminal-theme";

/** Big enough to read, small enough for a useful grid on a laptop. */
const FONT_SIZE = 13;

/**
 * How long a resize has to stop before the grid is refitted and the Server is
 * told. A drag of the Dock's edge is a resize per pointer event; refitting on
 * each would redraw xterm and send a control frame sixty times a second, and
 * every one of them is a SIGWINCH to whatever is running.
 */
const RESIZE_DEBOUNCE_MS = 80;

/** What the frame shows above the well: whether xterm is up, and its grid. */
export type EmulatorSnapshot = {
  ready: boolean;
  grid: { cols: number; rows: number } | null;
};

/**
 * Building xterm — the part that needs a canvas and a layout, and so the part
 * a test replaces.
 */
export type XtermKit = {
  create: () => { term: XTerm; fit: FitAddon };
  /** After `open`: put the well's colour on the surface. See {@link loadXterm}. */
  paint: (element: HTMLElement) => void;
};

/**
 * xterm and its fit addon, imported when the first emulator is made — they are
 * the largest thing in the console, and opening a Server must not download
 * them (`terminal.tsx`).
 */
async function loadXterm(): Promise<XtermKit> {
  const [{ Terminal }, { FitAddon }] = await Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-fit"),
  ]);

  return {
    create() {
      const fit = new FitAddon();
      const term = new Terminal({
        fontSize: FONT_SIZE,
        fontFamily: monoStack(),
        lineHeight: 1.25,
        cursorBlink: true,
        // A pty echoes already; converting or echoing here would double it.
        convertEol: false,
        scrollback: 2_000,
        theme: wellTheme(),
        // The wrapper carries the accessible name and the status is in words
        // beneath it; xterm's own live region would announce every frame twice.
        screenReaderMode: false,
      });
      term.loadAddon(fit);
      return { term, fit };
    },

    /**
     * **Put the well on the surface, because `theme.background` cannot.**
     *
     * Found by measuring it: the viewport was reading `rgb(0,0,0)` while
     * `--well` is `rgb(20,20,20)`. `xterm.css` ships
     * `.xterm .xterm-viewport { background-color: #000 }` — specificity 0-2-0
     * and, decisively, **unlayered** — and the DOM renderer leaves a default
     * cell transparent, so that rule is the surface an operator looks at. A
     * Tailwind utility can never beat it, layered as they are; this is the same
     * trap `design-system.md` records for the disabled rule, from the other
     * side. An inline style is the one thing that wins without editing
     * `globals.css` for one component's benefit.
     *
     * The gap is imperceptible and still wrong: every contrast figure in the
     * design system is measured against `--well`, and this was the only surface
     * not on it. `theme.background` stays set too — xterm reads it to compute
     * inverse video and to blend a selection.
     */
    paint(element) {
      const viewport = element.querySelector<HTMLElement>(".xterm-viewport");
      if (viewport)
        viewport.style.backgroundColor = resolveColor("var(--well)");
    },
  };
}

/**
 * xterm, owned outside React — and the two things the emulator owes the Server.
 *
 * ## Why a class and not a hook
 *
 * The docked panel takes a live session off a page and into the console
 * layout: same socket, same scrollback, same running `top`. A hook's emulator
 * is built in an effect and disposed in its cleanup, so moving it would mean
 * building a new one, and a new xterm is an empty screen. This owns one xterm
 * for the session's whole life and an element it is opened in; `mount` puts
 * that element into whichever frame is showing it now, and the previous frame
 * simply lets go. Moving a DOM node keeps everything xterm drew.
 *
 * ## The grid follows the frame, and the Server is told
 *
 * The gateways used to treat every frame the browser sent as terminal input, so
 * there was no way to say the window had changed and every session lived and
 * died at 80 × 24. The socket now has a control frame, so the pty on the other
 * end takes the size of the box on this end. Two things this then owes the
 * Server:
 *
 * - **Say the size when the socket opens, not only when it changes.** A resize
 *   sent while the socket is still connecting goes nowhere (`resize` answers
 *   `false`), so the size is re-sent on every transition into `open` — which is
 *   also what makes a reconnected session come back the right shape.
 * - **Let the frame decide, never the terminal.** The well has a height in CSS
 *   and the emulator fills it. If the emulator sized the box instead, fitting
 *   would measure the thing it had just changed — see the note by the observer.
 *
 * A resize while mounted is debounced ({@link RESIZE_DEBOUNCE_MS}); arriving in
 * a new frame is fitted at once, since that is one change and not a drag.
 */
export class TerminalEmulator {
  /** What xterm is opened in, and what moves between frames. */
  readonly element: HTMLDivElement;

  private readonly listeners = new Set<() => void>();
  private snapshot: EmulatorSnapshot = { ready: false, grid: null };
  private term: XTerm | null = null;
  private fit: FitAddon | null = null;
  private kit: XtermKit | null = null;
  /**
   * Frames that arrived before xterm existed. The gateways speak first —
   * "Connecting…", "Setting up private SSH key…", the `\x1bc` that clears the
   * screen once the channel is up — and xterm loads asynchronously, so there is
   * a real window in which the socket is open and nothing to write to.
   */
  private pending: string[] = [];
  private frame: HTMLElement | null = null;
  private observer: ResizeObserver | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private focusOnOpen = false;
  private readonly unsubscribe: () => void;
  private readonly debounceMs: number;
  private lastStatus: string;

  constructor(
    private readonly channel: TerminalChannel,
    options: {
      /** The emulator's accessible name: "Shell on web-1". */
      label: string;
      kit?: () => Promise<XtermKit>;
      debounceMs?: number;
    },
  ) {
    this.debounceMs = options.debounceMs ?? RESIZE_DEBOUNCE_MS;
    this.element = document.createElement("div");
    this.element.className = "h-full";
    this.element.setAttribute("role", "group");
    this.element.setAttribute("aria-label", options.label);
    this.element.setAttribute("aria-busy", "true");

    channel.attach(this.write);
    this.lastStatus = channel.getSnapshot().status;
    this.unsubscribe = channel.subscribe(this.onChannel);

    void (options.kit ?? loadXterm)().then((kit) => {
      if (this.disposed) return;
      this.kit = kit;
      this.openIfMounted();
    });
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): EmulatorSnapshot => this.snapshot;

  /**
   * Show the emulator in `frame`, which must have its size from layout.
   * Returns the way to let go of it; the emulator lives on until `dispose`.
   */
  mount(frame: HTMLElement): () => void {
    this.release();
    this.frame = frame;
    frame.append(this.element);

    if (this.term) {
      // Redraw what was drawn while the element was detached, at the new size.
      this.term.refresh(0, this.term.rows - 1);
      this.refit();
      if (this.focusOnOpen) {
        this.focusOnOpen = false;
        this.term.focus();
      }
    } else {
      this.openIfMounted();
    }

    this.observe(frame);

    return () => {
      if (this.frame === frame) this.release();
    };
  }

  /**
   * Put the keyboard in the terminal — now, or the moment it is next on the
   * page. A shell opened straight into the Dock is asked for focus before its
   * chunk has arrived, and a docked one between leaving the page's frame and
   * arriving in the Dock's — and moving a focused element blurs it anyway.
   */
  focus(): void {
    if (this.term && this.element.isConnected) this.term.focus();
    else this.focusOnOpen = true;
  }

  /** Ends xterm. The socket is the channel's, closed by its owner. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.release();
    this.unsubscribe();
    this.term?.dispose();
    this.term = null;
    this.element.remove();
  }

  private write = (frame: string): void => {
    if (this.term) this.term.write(frame);
    else this.pending.push(frame);
  };

  /**
   * The Server hears the size when there is a Server to hear it — on every
   * arrival at `open`, which covers the first connection and every reconnection,
   * each a fresh pty at the default size until told otherwise.
   */
  private onChannel = (): void => {
    const { status } = this.channel.getSnapshot();
    const arrived = status === "open" && this.lastStatus !== "open";
    this.lastStatus = status;
    const grid = this.snapshot.grid;
    if (arrived && grid) this.channel.resize(grid.cols, grid.rows);
  };

  private openIfMounted(): void {
    if (!this.kit || !this.frame || this.term || this.disposed) return;

    const { term, fit } = this.kit.create();
    term.open(this.element);
    term.onData(this.channel.send);
    term.attachCustomKeyEventHandler((event) => !isDockShortcut(event));
    this.kit.paint(this.element);

    this.term = term;
    this.fit = fit;
    for (const frame of this.pending) term.write(frame);
    this.pending = [];
    this.element.removeAttribute("aria-busy");
    this.emit({ ready: true });
    this.refit();
    if (this.focusOnOpen) {
      this.focusOnOpen = false;
      term.focus();
    }
  }

  /** One place the new grid is recorded, shown and sent. */
  private refit(): void {
    const next = fitToFrame(this.term, this.fit);
    if (!next) return;
    const was = this.snapshot.grid;
    if (was?.cols === next.cols && was?.rows === next.rows) return;
    this.emit({ grid: next });
    // Ignored when the socket is not open yet; `onChannel` sends it the
    // moment it is.
    this.channel.resize(next.cols, next.rows);
  }

  /**
   * **Observe the frame, not the emulator.**
   *
   * Found by driving it, back when the type was scaled instead of the grid: the
   * observer watched the element xterm is mounted in, a new font size
   * re-measured the rows, the host changed height, the observer fired again,
   * and Chrome stopped delivering notifications for the cycle — freezing the tab
   * hard enough to time out a devtools evaluation. The frame is sized by layout
   * and never by the terminal, so watching it cannot feed back, and `refit` is
   * idempotent, which is the belt to that braces.
   */
  private observe(frame: HTMLElement): void {
    this.observer = new ResizeObserver(() => {
      if (!frame.clientWidth) return;
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = setTimeout(() => {
        this.timer = null;
        this.refit();
      }, this.debounceMs);
    });
    this.observer.observe(frame);
  }

  private release(): void {
    this.observer?.disconnect();
    this.observer = null;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.frame && this.element.parentNode === this.frame) {
      this.element.remove();
    }
    this.frame = null;
  }

  private emit(change: Partial<EmulatorSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...change };
    for (const listener of this.listeners) listener();
  }
}
