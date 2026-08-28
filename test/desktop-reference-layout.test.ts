import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import {
  createReferencePaneController,
  maximumReferenceWidth,
  REFERENCE_LAYOUT_STORAGE_KEY
} from "../apps/desktop/src/renderer/desktop-reference-layout";

class MemoryStorage implements Pick<Storage, "getItem" | "setItem"> {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

function keyboardEvent(window: Window, key: string, shiftKey = false): Event {
  const EventConstructor = (window as unknown as { Event: typeof Event }).Event;
  const event = new EventConstructor("keydown", { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    key: { value: key },
    shiftKey: { value: shiftKey }
  });
  return event;
}

describe("desktop reference pane layout", () => {
  it("restores, clamps, and persists a keyboard-adjustable reference width", () => {
    const { document, window } = parseHTML("<div id='shell'><div id='separator'></div><aside id='pane'></aside></div>");
    const shell = document.querySelector<HTMLElement>("#shell")!;
    const separator = document.querySelector<HTMLElement>("#separator")!;
    const pane = document.querySelector<HTMLElement>("#pane")!;
    const storage = new MemoryStorage();
    storage.setItem(REFERENCE_LAYOUT_STORAGE_KEY, JSON.stringify({ width: 2000, collapsed: false }));
    const controller = createReferencePaneController({
      shell,
      separator,
      pane,
      storage,
      eventHost: window as unknown as Window,
      viewportWidth: () => 1280
    });

    expect(controller.getState()).toEqual({ width: maximumReferenceWidth(1280), collapsed: false });
    expect(shell.style.getPropertyValue("--p2md-reference-width")).toBe(`${maximumReferenceWidth(1280)}px`);
    separator.dispatchEvent(keyboardEvent(window as unknown as Window, "Home"));
    expect(controller.getState().width).toBe(260);
    separator.dispatchEvent(keyboardEvent(window as unknown as Window, "ArrowLeft", true));
    expect(controller.getState().width).toBe(332);
    expect(JSON.parse(storage.getItem(REFERENCE_LAYOUT_STORAGE_KEY)!)).toEqual({ width: 332, collapsed: false });
    controller.destroy();
  });

  it("collapses and restores the reference pane with Enter", () => {
    const { document, window } = parseHTML("<div id='shell'><div id='separator'></div><aside id='pane'></aside></div>");
    const shell = document.querySelector<HTMLElement>("#shell")!;
    const separator = document.querySelector<HTMLElement>("#separator")!;
    const pane = document.querySelector<HTMLElement>("#pane")!;
    const controller = createReferencePaneController({
      shell,
      separator,
      pane,
      eventHost: window as unknown as Window,
      viewportWidth: () => 1366
    });

    separator.dispatchEvent(keyboardEvent(window as unknown as Window, "Enter"));
    expect(controller.getState().collapsed).toBe(true);
    expect(shell.dataset.referenceCollapsed).toBe("true");
    expect(pane.hidden).toBe(true);
    expect(separator.getAttribute("aria-expanded")).toBe("false");
    separator.dispatchEvent(keyboardEvent(window as unknown as Window, "Enter"));
    expect(controller.getState().collapsed).toBe(false);
    expect(pane.hidden).toBe(false);
    const EventConstructor = (window as unknown as { Event: typeof Event }).Event;
    separator.dispatchEvent(new EventConstructor("click", { bubbles: true }));
    expect(controller.getState().collapsed).toBe(true);
    controller.destroy();
  });
});
