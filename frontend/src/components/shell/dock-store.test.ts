import { describe, expect, it, vi } from "vitest";

import type { TerminalTarget } from "@/components/console/terminal-target";

import {
  MAX_DOCK_LOGS,
  MAX_DOCK_SHELLS,
  DockStore,
  dockLogsFull,
  dockShells,
  dockShellsFull,
  type DockableLog,
  type DockableShell,
} from "./dock-store";

/**
 * The console layout's terminal sessions.
 *
 * The decisions these pin are triage's: up to `MAX_DOCK_SHELLS` shells as
 * tabs, the next one refused rather than replacing one, docking moves a page's
 * session rather than building a new one, and closing a tab ends that shell
 * only — which is what makes the gateway reap it.
 */
const server: TerminalTarget = {
  kind: "server",
  serverId: "srv-1",
  name: "main-vps",
  address: "root@10.0.0.1:22",
};
const container: TerminalTarget = {
  kind: "container",
  containerId: "c-1",
  serverId: "srv-1",
  name: "app-9uiusu.1.x7",
  host: "main-vps",
};

let sequence = 0;

type Fake = Omit<DockableShell, "disposed"> & {
  disposed: boolean;
  dispose: ReturnType<typeof vi.fn>;
};

type FakeLog = Omit<DockableLog, "disposed"> & {
  disposed: boolean;
  dispose: ReturnType<typeof vi.fn>;
};

function log(key: string, owner: "page" | "dock" = "page"): FakeLog {
  const fake: FakeLog = {
    id: `l-${++sequence}`,
    key,
    owner,
    disposed: false,
    dispose: vi.fn(() => {
      fake.disposed = true;
    }),
  };
  return fake;
}

function session(
  target: TerminalTarget,
  owner: "page" | "dock" = "page",
): Fake {
  const fake: Fake = {
    id: `s-${++sequence}`,
    target,
    owner,
    disposed: false,
    dispose: vi.fn(() => {
      fake.disposed = true;
    }),
  };
  return fake;
}

function setup() {
  const created: Fake[] = [];
  const reveal = vi.fn();
  const store = new DockStore<Fake, FakeLog>({
    create: (target) => {
      const made = session(target, "dock");
      created.push(made);
      return made;
    },
    reveal,
  });
  return { store, created, reveal };
}

/** The tab ids in tab order — shells and logs alike. */
const ids = (store: DockStore<Fake, FakeLog>) =>
  store.getSnapshot().tabs.map((tab) => tab.id);
const closed = { tabs: [], activeId: null };

describe("DockStore", () => {
  it("opens a shell straight into the empty Dock, makes it the active tab, and shows the Dock", () => {
    const { store, created, reveal } = setup();

    expect(store.open(container)).toBe("docked");

    expect(created).toHaveLength(1);
    expect(dockShells(store.getSnapshot())).toEqual([created[0]]);
    expect(store.getSnapshot().activeId).toBe(created[0]?.id);
    expect(reveal).toHaveBeenCalledTimes(1);
  });

  it("docking takes the page's own session — the same one, not a new one", () => {
    const { store, created } = setup();
    const live = session(server);

    expect(store.dock(live)).toBe("docked");

    expect(created).toHaveLength(0);
    expect(dockShells(store.getSnapshot())).toEqual([live]);
    expect(store.getSnapshot().activeId).toBe(live.id);
    expect(live.owner).toBe("dock");
    expect(live.dispose).not.toHaveBeenCalled();
  });

  describe("several shells, as tabs", () => {
    it("a second shell is a second tab, made active, and the first keeps running", () => {
      const { store, created } = setup();
      store.open(server);
      const live = session(container);

      expect(store.dock(live)).toBe("docked");

      expect(dockShells(store.getSnapshot())).toEqual([created[0], live]);
      expect(store.getSnapshot().activeId).toBe(live.id);
      expect(created[0]?.dispose).not.toHaveBeenCalled();
    });

    it("activate shows another tab and ends nothing", () => {
      const { store, created } = setup();
      store.open(server);
      store.open(container);

      store.activate(created[0]!.id);

      expect(store.getSnapshot().activeId).toBe(created[0]?.id);
      expect(created[1]?.dispose).not.toHaveBeenCalled();
    });

    it("activating an id the Dock does not hold changes nothing", () => {
      const { store, created } = setup();
      store.open(server);

      store.activate("nope");

      expect(store.getSnapshot().activeId).toBe(created[0]?.id);
    });

    it("docking a session it already holds makes that tab active and adds nothing", () => {
      const { store } = setup();
      const live = session(server);
      store.dock(live);
      store.open(container);

      expect(store.dock(live)).toBe("docked");

      expect(dockShells(store.getSnapshot())).toHaveLength(2);
      expect(store.getSnapshot().activeId).toBe(live.id);
    });
  });

  describe(`a cap of ${MAX_DOCK_SHELLS}`, () => {
    it("is four", () => {
      expect(MAX_DOCK_SHELLS).toBe(4);
    });

    function fill() {
      const kit = setup();
      for (let i = 0; i < MAX_DOCK_SHELLS; i++) kit.store.open(server);
      return kit;
    }

    it("opening past it is refused, and builds nothing", () => {
      const { store, created } = fill();
      expect(dockShellsFull(store.getSnapshot())).toBe(true);

      expect(store.open(container)).toBe("full");

      expect(created).toHaveLength(MAX_DOCK_SHELLS);
      expect(created.some((made) => made.dispose.mock.calls.length > 0)).toBe(
        false,
      );
    });

    it("docking past it is refused, and the page keeps its session", () => {
      const { store } = fill();
      const live = session(container);

      expect(store.dock(live)).toBe("full");

      expect(live.owner).toBe("page");
      expect(dockShells(store.getSnapshot())).not.toContain(live);
    });

    it("closing one makes room again", () => {
      const { store, created } = fill();

      store.close(created[0]!.id);

      expect(dockShellsFull(store.getSnapshot())).toBe(false);
      expect(store.open(container)).toBe("docked");
    });
  });

  describe("close(id) ends that shell only", () => {
    it("disposes it — the gateway reaps it — and leaves the others running", () => {
      const { store, created } = setup();
      store.open(server);
      store.open(container);

      store.close(created[0]!.id);

      expect(created[0]?.dispose).toHaveBeenCalledTimes(1);
      expect(created[1]?.dispose).not.toHaveBeenCalled();
      expect(dockShells(store.getSnapshot())).toEqual([created[1]]);
    });

    it("closing a background tab keeps the active one active", () => {
      const { store, created } = setup();
      store.open(server);
      store.open(container);

      store.close(created[0]!.id);

      expect(store.getSnapshot().activeId).toBe(created[1]?.id);
    });

    it("closing the active tab activates its right-hand neighbour, or else its left", () => {
      const { store, created } = setup();
      store.open(server);
      store.open(container);
      store.open(server);
      store.activate(created[1]!.id);

      store.close(created[1]!.id);
      expect(store.getSnapshot().activeId).toBe(created[2]?.id);

      store.close(created[2]!.id);
      expect(store.getSnapshot().activeId).toBe(created[0]?.id);
    });

    it("closing the last one closes the Dock", () => {
      const { store, created } = setup();
      store.open(server);

      store.close(created[0]!.id);

      expect(store.getSnapshot()).toEqual(closed);
    });

    it("an id the Dock does not hold changes nothing", () => {
      const { store } = setup();
      store.open(server);
      const before = store.getSnapshot();

      store.close("nope");

      expect(store.getSnapshot()).toBe(before);
    });
  });

  it("closeAll ends every shell and closes the Dock", () => {
    const { store, created } = setup();
    store.open(server);
    store.open(container);
    store.open(server);

    store.closeAll();

    for (const made of created) expect(made.dispose).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toEqual(closed);
  });

  it("dispose — the layout going, an organization switch, a sign-out — ends every shell at once", () => {
    const { store, created } = setup();
    store.open(server);
    store.open(container);
    const live = session(container);
    store.dock(live);

    store.dispose();

    expect(created[0]?.dispose).toHaveBeenCalled();
    expect(created[1]?.dispose).toHaveBeenCalled();
    expect(live.dispose).toHaveBeenCalled();
    expect(store.getSnapshot()).toEqual(closed);
  });

  describe("logs, beside the shells", () => {
    it("docking a log takes the page's own Live log as a log tab, made active, and shows the Dock", () => {
      const { store, reveal } = setup();
      store.open(server);
      const deploy = log("deployment:d-1");

      expect(store.dockLog(deploy)).toBe("docked");

      const tab = store.getSnapshot().tabs[1];
      expect(tab?.kind).toBe("log");
      expect(tab?.kind === "log" && tab.log).toBe(deploy);
      expect(store.getSnapshot().activeId).toBe(deploy.id);
      expect(deploy.owner).toBe("dock");
      expect(deploy.dispose).not.toHaveBeenCalled();
      expect(reveal).toHaveBeenCalledTimes(2);
      expect(dockShells(store.getSnapshot())).toHaveLength(1);
    });

    it("a log already docked, under the same key, is shown again — one tab, and the page keeps its new one", () => {
      const { store, reveal } = setup();
      const first = log("container:c-1");
      store.dockLog(first);
      store.open(server);
      reveal.mockClear();
      const again = log("container:c-1");

      expect(store.dockLog(again)).toBe("docked");

      expect(ids(store)).toHaveLength(2);
      expect(store.getSnapshot().activeId).toBe(first.id);
      expect(reveal).toHaveBeenCalledTimes(1);
      expect(again.owner).toBe("page");
      expect(again.dispose).not.toHaveBeenCalled();
    });

    describe(`two caps of four, counted apart`, () => {
      it(`the logs cap is ${MAX_DOCK_LOGS}`, () => {
        expect(MAX_DOCK_LOGS).toBe(4);
      });

      it("docking a fifth log is refused, and the page keeps it", () => {
        const { store } = setup();
        for (let i = 0; i < MAX_DOCK_LOGS; i++) store.dockLog(log(`k-${i}`));
        expect(dockLogsFull(store.getSnapshot())).toBe(true);
        const fifth = log("k-5");

        expect(store.dockLog(fifth)).toBe("full");

        expect(fifth.owner).toBe("page");
        expect(ids(store)).not.toContain(fifth.id);
      });

      it("a full logs group never blocks a shell", () => {
        const { store } = setup();
        for (let i = 0; i < MAX_DOCK_LOGS; i++) store.dockLog(log(`k-${i}`));

        expect(dockShellsFull(store.getSnapshot())).toBe(false);
        expect(store.open(server)).toBe("docked");
      });

      it("a full shells group never blocks a log", () => {
        const { store } = setup();
        for (let i = 0; i < MAX_DOCK_SHELLS; i++) store.open(server);

        expect(dockLogsFull(store.getSnapshot())).toBe(false);
        expect(store.dockLog(log("k"))).toBe("docked");
      });

      it("a log already docked is shown even at the logs cap", () => {
        const { store } = setup();
        const first = log("k-0");
        store.dockLog(first);
        for (let i = 1; i < MAX_DOCK_LOGS; i++) store.dockLog(log(`k-${i}`));

        expect(store.dockLog(log("k-0"))).toBe("docked");
        expect(store.getSnapshot().activeId).toBe(first.id);
      });
    });

    it("closing a log tab ends that log only", () => {
      const { store, created } = setup();
      store.open(server);
      const deploy = log("deployment:d-1");
      store.dockLog(deploy);

      store.close(deploy.id);

      expect(deploy.dispose).toHaveBeenCalledTimes(1);
      expect(created[0]?.dispose).not.toHaveBeenCalled();
      expect(ids(store)).toEqual([created[0]?.id]);
    });

    it("closing the active tab passes to its neighbour whatever its kind", () => {
      const { store, created } = setup();
      store.open(server);
      const deploy = log("deployment:d-1");
      store.dockLog(deploy);
      store.open(container);
      store.activate(deploy.id);

      store.close(deploy.id);
      expect(store.getSnapshot().activeId).toBe(created[1]?.id);

      const runtime = log("container:c-1");
      store.dockLog(runtime);
      store.close(runtime.id);
      expect(store.getSnapshot().activeId).toBe(created[1]?.id);

      store.close(created[1]!.id);
      expect(store.getSnapshot().activeId).toBe(created[0]?.id);
    });

    it("closing the active shell passes to its neighbour on screen, not the next to arrive", () => {
      const { store, created } = setup();
      store.open(server);
      const deploy = log("deployment:d-1");
      store.dockLog(deploy);
      store.open(container);
      // Arrived as [A, log, B]; drawn as Shells [A, B] · Logs [log].
      store.activate(created[0]!.id);

      store.close(created[0]!.id);

      expect(store.getSnapshot().activeId).toBe(created[1]?.id);
    });

    it("closing the last tab closes the Dock, when it is a log", () => {
      const { store } = setup();
      const deploy = log("deployment:d-1");
      store.dockLog(deploy);

      store.close(deploy.id);

      expect(store.getSnapshot()).toEqual(closed);
    });

    it("closing a log makes room for another at the logs cap", () => {
      const { store } = setup();
      const docked = Array.from({ length: MAX_DOCK_LOGS }, (_, i) =>
        log(`k-${i}`),
      );
      for (const each of docked) store.dockLog(each);

      store.close(docked[0]!.id);

      expect(dockLogsFull(store.getSnapshot())).toBe(false);
      expect(store.dockLog(log("k-new"))).toBe("docked");
    });

    it("closeAll and dispose end every shell and every log", () => {
      for (const end of ["closeAll", "dispose"] as const) {
        const { store, created } = setup();
        store.open(server);
        const deploy = log("deployment:d-1");
        store.dockLog(deploy);

        store[end]();

        expect(created[0]?.dispose).toHaveBeenCalledTimes(1);
        expect(deploy.dispose).toHaveBeenCalledTimes(1);
        expect(store.getSnapshot()).toEqual(closed);
      }
    });

    it("the tabs stay in arrival order across both kinds", () => {
      const { store, created } = setup();
      const deploy = log("deployment:d-1");
      store.open(server);
      store.dockLog(deploy);
      store.open(container);

      expect(ids(store)).toEqual([created[0]?.id, deploy.id, created[1]?.id]);
      expect(store.getSnapshot().tabs.map((tab) => tab.kind)).toEqual([
        "shell",
        "log",
        "shell",
      ]);
    });
  });

  it("tells subscribers about every change, with a new snapshot each time", () => {
    const { store } = setup();
    const heard = vi.fn();
    store.subscribe(heard);
    const before = store.getSnapshot();

    store.open(server);

    expect(heard).toHaveBeenCalled();
    expect(store.getSnapshot()).not.toBe(before);
  });
});
