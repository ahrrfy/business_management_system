/** حالة تحديث PWA المشتركة بين الشريط العلوي ولوحة التحديث. */
let pending = false;
const statusListeners = new Set<(value: boolean) => void>();
const openListeners = new Set<() => void>();

export function isPwaUpdatePending(): boolean {
  return pending;
}

export function setPwaUpdatePending(value: boolean): void {
  pending = value;
  Array.from(statusListeners).forEach((listener) => listener(value));
}

export function subscribePwaUpdateStatus(listener: (value: boolean) => void): () => void {
  statusListeners.add(listener);
  return () => { statusListeners.delete(listener); };
}

export function openPwaUpdatePanel(): void {
  Array.from(openListeners).forEach((listener) => listener());
}

export function subscribePwaUpdateOpen(listener: () => void): () => void {
  openListeners.add(listener);
  return () => { openListeners.delete(listener); };
}
