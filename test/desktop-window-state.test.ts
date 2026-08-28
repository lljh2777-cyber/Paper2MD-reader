import { describe, expect, it } from "vitest";
import {
  clampWindowBounds,
  defaultWindowBounds,
  parseDesktopWindowState
} from "../apps/desktop/src/main/desktop-window-state";

describe("desktop window state", () => {
  const primary = { x: 0, y: 0, width: 1920, height: 1040 };

  it("centers the first window within the primary display work area", () => {
    expect(defaultWindowBounds(primary)).toEqual({ x: 210, y: 40, width: 1500, height: 960 });
    expect(clampWindowBounds(undefined, [primary], primary)).toEqual({ x: 210, y: 40, width: 1500, height: 960 });
  });

  it("clamps an off-screen saved window into the nearest current work area", () => {
    expect(clampWindowBounds(
      { x: 2500, y: 100, width: 1400, height: 900 },
      [primary],
      primary
    )).toEqual({ x: 520, y: 100, width: 1400, height: 900 });
  });

  it("uses the display with the greatest overlap and respects small work areas", () => {
    const secondary = { x: 1920, y: 0, width: 1280, height: 720 };
    expect(clampWindowBounds(
      { x: 2100, y: -200, width: 1600, height: 900 },
      [primary, secondary],
      primary
    )).toEqual({ x: 1920, y: 0, width: 1280, height: 720 });
  });

  it("rejects malformed state instead of trusting arbitrary persisted data", () => {
    expect(parseDesktopWindowState({ bounds: { x: 0, y: 0, width: 1200 }, maximized: false })).toBeUndefined();
    expect(parseDesktopWindowState({ bounds: { x: 0, y: 0, width: -1, height: 700 }, maximized: false })).toBeUndefined();
    expect(parseDesktopWindowState({ bounds: { x: 0, y: 0, width: 1200, height: 700 }, maximized: true })).toEqual({
      bounds: { x: 0, y: 0, width: 1200, height: 700 },
      maximized: true
    });
  });
});
