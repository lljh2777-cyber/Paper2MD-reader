const ICON_PATHS: Record<string, string> = {
  expand: '<path d="M15 3h6v6"/><path d="M9 21H3v-6"/><path d="m21 3-7 7"/><path d="m3 21 7-7"/>',
  "arrow-up-to-line": '<path d="M5 3h14"/><path d="m18 13-6-6-6 6"/><path d="M12 7v14"/>',
  folder: '<path d="M3 6h6l2 2h10v11H3z"/>',
  document: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5"/><path d="M9 13h6"/><path d="M9 17h6"/>',
  upload: '<path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M5 20h14"/>',
  refresh: '<path d="M20 6v5h-5"/><path d="M4 18v-5h5"/><path d="M6.1 9a7 7 0 0 1 11.3-2.6L20 9"/><path d="m4 15 2.6 2.6A7 7 0 0 0 17.9 15"/>',
  "chevron-left": '<path d="m15 18-6-6 6-6"/>',
  "chevron-right": '<path d="m9 18 6-6-6-6"/>',
  minus: '<path d="M5 12h14"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
  close: '<path d="m6 6 12 12"/><path d="m18 6-12 12"/>'
};

export function setReaderIcon(element: HTMLElement, name: string): void {
  const paths = ICON_PATHS[name];
  if (!paths) return;
  element.insertAdjacentHTML(
    "afterbegin",
    `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`
  );
}
