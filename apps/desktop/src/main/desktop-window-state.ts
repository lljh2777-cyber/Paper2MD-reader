import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface DesktopBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DesktopWindowState {
  bounds: DesktopBounds;
  maximized: boolean;
}

export const DESKTOP_WINDOW_STATE_FILE = "desktop-window-state-v1.json";
export const DESKTOP_WINDOW_MIN_WIDTH = 980;
export const DESKTOP_WINDOW_MIN_HEIGHT = 680;
export const DESKTOP_WINDOW_DEFAULT_WIDTH = 1500;
export const DESKTOP_WINDOW_DEFAULT_HEIGHT = 960;

function finiteInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : undefined;
}

function validBounds(value: unknown): DesktopBounds | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const x = finiteInteger(record.x);
  const y = finiteInteger(record.y);
  const width = finiteInteger(record.width);
  const height = finiteInteger(record.height);
  if (x === undefined || y === undefined || width === undefined || height === undefined) return undefined;
  if (width < 1 || height < 1) return undefined;
  return { x, y, width, height };
}

export function parseDesktopWindowState(value: unknown): DesktopWindowState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const bounds = validBounds(record.bounds);
  if (!bounds || typeof record.maximized !== "boolean") return undefined;
  return { bounds, maximized: record.maximized };
}

function overlapArea(a: DesktopBounds, b: DesktopBounds): number {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return width * height;
}

function squaredCenterDistance(a: DesktopBounds, b: DesktopBounds): number {
  const x = a.x + a.width / 2 - (b.x + b.width / 2);
  const y = a.y + a.height / 2 - (b.y + b.height / 2);
  return x * x + y * y;
}

function targetWorkArea(bounds: DesktopBounds, workAreas: readonly DesktopBounds[], fallback: DesktopBounds): DesktopBounds {
  if (workAreas.length === 0) return fallback;
  return [...workAreas].sort((left, right) => {
    const overlap = overlapArea(bounds, right) - overlapArea(bounds, left);
    if (overlap !== 0) return overlap;
    return squaredCenterDistance(bounds, left) - squaredCenterDistance(bounds, right);
  })[0] ?? fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

export function defaultWindowBounds(workArea: DesktopBounds): DesktopBounds {
  const width = Math.min(DESKTOP_WINDOW_DEFAULT_WIDTH, workArea.width);
  const height = Math.min(DESKTOP_WINDOW_DEFAULT_HEIGHT, workArea.height);
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    width,
    height
  };
}

export function clampWindowBounds(
  requested: DesktopBounds | undefined,
  workAreas: readonly DesktopBounds[],
  primaryWorkArea: DesktopBounds
): DesktopBounds {
  if (!requested) return defaultWindowBounds(primaryWorkArea);
  const area = targetWorkArea(requested, workAreas, primaryWorkArea);
  const width = Math.min(Math.max(requested.width, Math.min(DESKTOP_WINDOW_MIN_WIDTH, area.width)), area.width);
  const height = Math.min(Math.max(requested.height, Math.min(DESKTOP_WINDOW_MIN_HEIGHT, area.height)), area.height);
  return {
    x: clamp(requested.x, area.x, area.x + area.width - width),
    y: clamp(requested.y, area.y, area.y + area.height - height),
    width,
    height
  };
}

export class DesktopWindowStateStore {
  readonly path: string;

  constructor(userDataPath: string) {
    this.path = join(userDataPath, DESKTOP_WINDOW_STATE_FILE);
  }

  async load(): Promise<DesktopWindowState | undefined> {
    try {
      return parseDesktopWindowState(JSON.parse(await readFile(this.path, "utf8")));
    } catch {
      return undefined;
    }
  }

  async save(state: DesktopWindowState): Promise<void> {
    const normalized = parseDesktopWindowState(state);
    if (!normalized) return;
    await writeFile(this.path, `${JSON.stringify(normalized, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
  }
}
