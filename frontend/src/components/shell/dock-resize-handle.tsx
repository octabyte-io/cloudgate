import { useRef, useState } from "react";

import {
  DOCK_MIN_HEIGHT,
  clampDockHeight,
  readDockHeight,
  setDockHeight,
} from "./dock-state";

/** One arrow-key press moves the edge by about a line and a half. */
const KEY_STEP = 24;

/**
 * The drag handle along the Dock's top edge.
 *
 * The height goes onto `<html>` on every pointer move and into storage once,
 * at the end of the drag (`dock-state.ts`). Nothing here refits the terminal:
 * the well's size follows the panel, and the emulator's observer refits the
 * grid and tells the gateway once the drag settles (`terminal-emulator.ts`).
 *
 * A separator with a value, so it is reachable and operable from the keyboard
 * — arrow keys move it — and says what it does to a screen reader. Hidden by
 * CSS while the Dock is minimised, maximised or full-screen.
 */
export function DockResizeHandle({
  panel,
}: {
  panel: React.RefObject<HTMLElement | null>;
}) {
  const drag = useRef<{ startY: number; startHeight: number } | null>(null);
  const [height, setHeight] = useState<number | null>(() =>
    typeof document === "undefined" ? null : readDockHeight(),
  );

  const apply = (next: number, persist: boolean) => {
    const clamped = clampDockHeight(next, window.innerHeight);
    setDockHeight(clamped, { persist });
    setHeight(clamped);
  };

  const current = () => panel.current?.getBoundingClientRect().height ?? 0;

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize the Dock"
      aria-valuemin={DOCK_MIN_HEIGHT}
      aria-valuenow={height ?? undefined}
      tabIndex={0}
      data-slot="dock-handle"
      className="dock-handle absolute inset-x-0 -top-1 z-10 h-2 cursor-row-resize touch-none outline-none hover:bg-brand/40 focus-visible:bg-brand"
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        drag.current = { startY: event.clientY, startHeight: current() };
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        if (!start) return;
        apply(start.startHeight + start.startY - event.clientY, false);
      }}
      onPointerUp={(event) => {
        const start = drag.current;
        if (!start) return;
        drag.current = null;
        apply(start.startHeight + start.startY - event.clientY, true);
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onKeyDown={(event) => {
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
        event.preventDefault();
        apply(
          current() + (event.key === "ArrowUp" ? KEY_STEP : -KEY_STEP),
          true,
        );
      }}
    />
  );
}
