import {
  terminalKey,
  type TerminalTarget,
} from "@/components/console/terminal-target";

/**
 * A shell the current page can open into the Dock — one row of its `+` menu.
 * The row reads `terminalTitle(target)`, the same name the tab will
 * carry once it is open.
 *
 * **Register only what the caller may open.** The `+` lists offers as given;
 * the page that registers one is the place that knows the permission rule for
 * it (`useTerminalOffers` in `dock-context.ts` says how).
 */
export type TerminalOffer = { target: TerminalTarget };

/**
 * The union of what every mounted page, layout and card offers right now.
 *
 * A registration is a list, withdrawn as a whole by the function `register`
 * returns — a page leaving takes its offers with it. The same target offered
 * twice (a layout and one of its tabs, say) is listed once, by `terminalKey`.
 */
export class TerminalOfferRegistry {
  private readonly registrations = new Map<number, readonly TerminalOffer[]>();
  private sequence = 0;
  private snapshot: readonly TerminalOffer[] = [];
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): readonly TerminalOffer[] => this.snapshot;

  register = (offers: readonly TerminalOffer[]): (() => void) => {
    if (offers.length === 0) return () => {};
    const id = ++this.sequence;
    this.registrations.set(id, offers);
    this.rebuild();
    return () => {
      if (this.registrations.delete(id)) this.rebuild();
    };
  };

  private rebuild(): void {
    const seen = new Set<string>();
    const next: TerminalOffer[] = [];
    for (const offers of this.registrations.values()) {
      for (const offer of offers) {
        const key = terminalKey(offer.target);
        if (seen.has(key)) continue;
        seen.add(key);
        next.push(offer);
      }
    }
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}
