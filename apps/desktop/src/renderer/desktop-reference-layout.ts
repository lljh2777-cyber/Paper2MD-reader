export const REFERENCE_LAYOUT_STORAGE_KEY = "paper2md.desktop.reference-layout.v1";
export const REFERENCE_PANE_MIN_WIDTH = 260;
export const REFERENCE_PANE_MAX_WIDTH = 720;
export const REFERENCE_PANE_DEFAULT_WIDTH = 420;
export const REFERENCE_PANE_STEP = 24;

const TASK_RAIL_RESERVE = 250;
const ARTICLE_MIN_WIDTH = 420;
const SEPARATOR_WIDTH = 10;

export interface ReferencePaneState {
  width: number;
  collapsed: boolean;
}

interface ReferenceLayoutEventHost {
  readonly innerWidth: number;
  addEventListener(type: string, listener: EventListener): void;
  removeEventListener(type: string, listener: EventListener): void;
}

export interface ReferencePaneController {
  getState(): ReferencePaneState;
  setWidth(width: number): void;
  toggle(): void;
  destroy(): void;
}

export interface ReferencePaneControllerOptions {
  shell: HTMLElement;
  separator: HTMLElement;
  pane: HTMLElement;
  storage?: Pick<Storage, "getItem" | "setItem">;
  eventHost?: ReferenceLayoutEventHost;
  viewportWidth?: () => number;
}

function numericWidth(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : undefined;
}

export function maximumReferenceWidth(viewportWidth: number): number {
  const available = Math.floor(viewportWidth - TASK_RAIL_RESERVE - ARTICLE_MIN_WIDTH - SEPARATOR_WIDTH);
  return Math.max(REFERENCE_PANE_MIN_WIDTH, Math.min(REFERENCE_PANE_MAX_WIDTH, available));
}

export function clampReferenceWidth(width: number, viewportWidth: number): number {
  return Math.min(Math.max(Math.round(width), REFERENCE_PANE_MIN_WIDTH), maximumReferenceWidth(viewportWidth));
}

export function parseReferencePaneState(value: unknown, viewportWidth: number): ReferencePaneState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const width = numericWidth(record.width);
  if (width === undefined || typeof record.collapsed !== "boolean") return undefined;
  return { width: clampReferenceWidth(width, viewportWidth), collapsed: record.collapsed };
}

function restoreReferencePaneState(
  storage: Pick<Storage, "getItem" | "setItem"> | undefined,
  viewportWidth: number
): ReferencePaneState {
  try {
    const value = storage?.getItem(REFERENCE_LAYOUT_STORAGE_KEY);
    const restored = value ? parseReferencePaneState(JSON.parse(value), viewportWidth) : undefined;
    if (restored) return restored;
  } catch {
    // Preferences are optional; a denied or malformed store must not block Reader startup.
  }
  return {
    width: clampReferenceWidth(REFERENCE_PANE_DEFAULT_WIDTH, viewportWidth),
    collapsed: false
  };
}

export function createReferencePaneController(options: ReferencePaneControllerOptions): ReferencePaneController {
  const eventHost = options.eventHost ?? window;
  const viewportWidth = options.viewportWidth ?? (() => eventHost.innerWidth);
  let state = restoreReferencePaneState(options.storage, viewportWidth());
  let pointerStartX = 0;
  let pointerStartWidth = state.width;
  let pointerActive = false;
  let pointerMoved = false;

  const persist = (): void => {
    try {
      options.storage?.setItem(REFERENCE_LAYOUT_STORAGE_KEY, JSON.stringify(state));
    } catch {
      // The pane remains usable when browser storage is unavailable.
    }
  };

  const apply = (shouldPersist = true): void => {
    state = {
      width: clampReferenceWidth(state.width, viewportWidth()),
      collapsed: state.collapsed
    };
    options.shell.style.setProperty("--p2md-reference-width", `${state.width}px`);
    options.shell.dataset.referenceCollapsed = String(state.collapsed);
    options.pane.hidden = state.collapsed;
    options.separator.setAttribute("aria-valuemin", String(REFERENCE_PANE_MIN_WIDTH));
    options.separator.setAttribute("aria-valuemax", String(maximumReferenceWidth(viewportWidth())));
    options.separator.setAttribute("aria-valuenow", String(state.width));
    options.separator.setAttribute("aria-valuetext", state.collapsed ? "Collapsed" : `${state.width} pixels`);
    options.separator.setAttribute("aria-expanded", String(!state.collapsed));
    if (shouldPersist) persist();
  };

  const setWidth = (width: number, shouldPersist = true): void => {
    state = { width: clampReferenceWidth(width, viewportWidth()), collapsed: false };
    apply(shouldPersist);
  };

  const toggle = (): void => {
    state = { ...state, collapsed: !state.collapsed };
    apply();
  };

  const onKeyDown = (rawEvent: Event): void => {
    const event = rawEvent as KeyboardEvent;
    const step = event.shiftKey ? REFERENCE_PANE_STEP * 3 : REFERENCE_PANE_STEP;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggle();
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setWidth(state.width + step);
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      setWidth(state.width - step);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setWidth(REFERENCE_PANE_MIN_WIDTH);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      setWidth(maximumReferenceWidth(viewportWidth()));
    }
  };

  const onPointerDown = (rawEvent: Event): void => {
    const event = rawEvent as PointerEvent;
    if (event.button !== 0) return;
    event.preventDefault();
    pointerActive = true;
    pointerMoved = false;
    pointerStartX = event.clientX;
    pointerStartWidth = state.width;
    options.separator.setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (rawEvent: Event): void => {
    if (!pointerActive) return;
    const event = rawEvent as PointerEvent;
    const delta = pointerStartX - event.clientX;
    if (Math.abs(delta) <= 2) return;
    pointerMoved = true;
    setWidth(pointerStartWidth + delta, false);
  };

  const finishPointer = (): void => {
    if (!pointerActive) return;
    pointerActive = false;
    persist();
  };

  const onClick = (): void => {
    if (pointerMoved) {
      pointerMoved = false;
      return;
    }
    toggle();
  };

  const onResize = (): void => apply();

  options.separator.addEventListener("keydown", onKeyDown);
  options.separator.addEventListener("pointerdown", onPointerDown);
  options.separator.addEventListener("click", onClick);
  eventHost.addEventListener("pointermove", onPointerMove);
  eventHost.addEventListener("pointerup", finishPointer);
  eventHost.addEventListener("pointercancel", finishPointer);
  eventHost.addEventListener("resize", onResize);
  apply(false);

  return {
    getState: () => ({ ...state }),
    setWidth: (width) => setWidth(width),
    toggle,
    destroy: () => {
      options.separator.removeEventListener("keydown", onKeyDown);
      options.separator.removeEventListener("pointerdown", onPointerDown);
      options.separator.removeEventListener("click", onClick);
      eventHost.removeEventListener("pointermove", onPointerMove);
      eventHost.removeEventListener("pointerup", finishPointer);
      eventHost.removeEventListener("pointercancel", finishPointer);
      eventHost.removeEventListener("resize", onResize);
    }
  };
}
