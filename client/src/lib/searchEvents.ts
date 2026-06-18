export const SEARCH_OPEN_EVENT = "alroya:open-search" as const;

export function openSearch(): void {
  window.dispatchEvent(new Event(SEARCH_OPEN_EVENT));
}
