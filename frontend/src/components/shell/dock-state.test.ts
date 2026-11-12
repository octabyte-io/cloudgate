import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DOCK_INIT_SCRIPT,
  DOCK_MIN_HEIGHT,
  clampDockHeight,
  readDockHeight,
  readDockView,
  setDockHeight,
  setDockView,
} from "./dock-state";

/**
 * The Dock's height and minimised/maximised state are this browser's, and are
 * on `<html>` before first paint — the rail's mechanism, so a
 * reload restores the panel's shape without it jumping.
 */
const root = document.documentElement;

afterEach(() => {
  localStorage.clear();
  root.removeAttribute("data-dock");
  root.style.removeProperty("--dock-h");
  vi.restoreAllMocks();
});

const runInitScript = () => new Function(DOCK_INIT_SCRIPT)();

describe("DOCK_INIT_SCRIPT", () => {
  it("puts the stored height and view on <html>", () => {
    localStorage.setItem(
      "cloudgate.dock",
      JSON.stringify({ height: 420, view: "maximised" }),
    );

    runInitScript();

    expect(root.style.getPropertyValue("--dock-h")).toBe("420px");
    expect(root.getAttribute("data-dock")).toBe("maximised");
  });

  it("leaves the default for a value it did not write", () => {
    localStorage.setItem(
      "cloudgate.dock",
      JSON.stringify({ height: "tall", view: "sideways" }),
    );

    runInitScript();

    expect(root.style.getPropertyValue("--dock-h")).toBe("");
    expect(root.hasAttribute("data-dock")).toBe(false);
  });

  it("survives storage that throws, as private browsing's does", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(runInitScript).not.toThrow();
  });

  it("survives a value that is not JSON", () => {
    localStorage.setItem("cloudgate.dock", "{");
    expect(runInitScript).not.toThrow();
  });
});

describe("the view", () => {
  it("is written to <html> and stored, and read back from <html>", () => {
    setDockView("minimised");

    expect(root.getAttribute("data-dock")).toBe("minimised");
    expect(readDockView()).toBe("minimised");
    expect(JSON.parse(localStorage.getItem("cloudgate.dock") ?? "{}")).toMatchObject({
      view: "minimised",
    });

    setDockView("normal");
    expect(root.hasAttribute("data-dock")).toBe(false);
    expect(readDockView()).toBe("normal");
  });

  it("keeps the stored height when the view changes", () => {
    setDockHeight(300, { persist: true });
    setDockView("maximised");

    expect(JSON.parse(localStorage.getItem("cloudgate.dock") ?? "{}")).toEqual({
      height: 300,
      view: "maximised",
    });
  });
});

describe("the height", () => {
  it("follows a drag on <html> and is stored only when asked", () => {
    setDockHeight(310, { persist: false });
    expect(root.style.getPropertyValue("--dock-h")).toBe("310px");
    expect(readDockHeight()).toBe(310);
    expect(localStorage.getItem("cloudgate.dock")).toBeNull();

    setDockHeight(310, { persist: true });
    expect(JSON.parse(localStorage.getItem("cloudgate.dock") ?? "{}")).toMatchObject({
      height: 310,
    });
  });

  it("is never less than a few lines, and always leaves the masthead", () => {
    expect(clampDockHeight(10, 900)).toBe(DOCK_MIN_HEIGHT);
    // 900 less the 56px masthead.
    expect(clampDockHeight(5000, 900)).toBe(844);
    expect(clampDockHeight(400, 900)).toBe(400);
  });
});
